import { basename, extname, normalize, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import aReSInitialize from "@ares/core";
import {
  getFilesRecursively,
  getParent,
  getFileContent,
  getFile,
  getFileName,
  getRelativePathFrom,
  fileExists,
  setJsonFileContentAsync,
  getFileVersion,
  createDirectoryAsync,
  copyFileSyncEx,
  getFileContentAsync,
  watch,
} from "@ares/files";
import {
  loadDatasource,
  refreshDatasource,
  MIGRATION_STATUS,
  STANDARD_MIGRATIONS_ENTITY_NAME,
  buildStandardMigrationsEntityDescriptor,
  INDEX_DEFINITION_TYPES,
  MIGRATION_TYPES,
  Migration,
} from "@ares/core/datasources.js";
import * as datasourceRuntime from "@ares/core/datasource-runtime.js";
import { asyncConsole } from "@ares/core/console.js";
const extensionMapping = {
  mariadb: "sql",
  mysql: "sql",
  mssql: "sql",
  oracle: "sql",
  postgres: "sql",
  sqlite: "sql",
  rest: "url",
};
const HOT_RELOAD_STATE_KEY = Symbol.for("aReS.datasourceFiles.hotReloadState");
const CURRENT_SCHEMAS_FILE_NAME = "current-schemas.json";
const CURRENT_SCHEMAS_TIMESTAMP_KEY = "timestamp";

function createVersionedImportUrl(filePath, versionTag = getFileVersion(filePath)) {
  const fileUrl = pathToFileURL(resolve(filePath)).href;
  return `${fileUrl}?v=${encodeURIComponent(String(versionTag))}`;
}

function normalizePath(filePath) {
  return normalize(resolve(filePath));
}

function setRuntimeMetadata(target, metadata) {
  Object.defineProperty(target, "__datasourceRuntime", {
    value: metadata,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  return target;
}

function getRuntimeMetadata(datasourceObject) {
  return datasourceObject?.__datasourceRuntime ?? null;
}

function getActiveDatasourceEnvironment(datasourceObject) {
  return datasourceObject?.environments?.[
    datasourceObject?.aReS?.isProduction ? "production" : "test"
  ];
}

function isUsableDatasourceDriver(driver) {
  if (!driver) {
    return false;
  }
  return [
    "getSchemasUsing",
    "getEntitiesUsing",
    "getPropertiesUsing",
    "getIndexesUsing",
  ].some((methodName) => typeof driver?.[methodName] === "function");
}

function resolveDatasourceDriver(datasourceObject) {
  if (isUsableDatasourceDriver(datasourceObject?.driver)) {
    return datasourceObject.driver;
  }

  const environment = getActiveDatasourceEnvironment(datasourceObject);
  if (!environment || typeof environment !== "object") {
    return null;
  }

  const connectionSettings = Object.values(environment).find(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  return connectionSettings?.driver ?? null;
}

function getReverseEngineeringCapabilities(datasourceObject) {
  const driver = resolveDatasourceDriver(datasourceObject);
  return {
    schemas: typeof driver?.getSchemasUsing === "function",
    entities: typeof driver?.getEntitiesUsing === "function",
    properties: typeof driver?.getPropertiesUsing === "function",
    indexes: typeof driver?.getIndexesUsing === "function",
  };
}

function canReverseEngineerDatasource(datasourceObject) {
  const capabilities = getReverseEngineeringCapabilities(datasourceObject);
  return capabilities.schemas === true;
}

function createTemporaryAReS(datasourceName = "datasource") {
  return aReSInitialize(
    {
      name: `datasource-files-${datasourceName}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      environments: [],
    },
    { onDuplicate: "replace" }
  );
}

function toSerializableValue(value) {
  if (value === undefined || typeof value === "function") return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => toSerializableValue(item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const normalizedObject = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedItem = toSerializableValue(item);
      if (normalizedItem !== undefined) {
        normalizedObject[key] = normalizedItem;
      }
    }
    return normalizedObject;
  }
  return value;
}

function getSerializableEntries(source, excludedKeys = []) {
  const excludedKeySet = new Set(excludedKeys);
  return Object.fromEntries(
    Object.entries(source ?? {})
      .filter(([key]) => !excludedKeySet.has(key))
      .map(([key, value]) => [key, toSerializableValue(value)])
      .filter(([, value]) => value !== undefined)
  );
}

function buildCurrentSchemasPropertyDescriptor(propertyDefinition) {
  return getSerializableEntries(propertyDefinition, ["_entityDefinitionFallback"]);
}

function buildCurrentSchemasIndexDescriptor(indexDefinition) {
  const descriptor = {
    ...getSerializableEntries(indexDefinition, [
      "datasource",
      "indexDefinition",
      "_properties",
      "originalDefinedProperties",
      "originalDefinedReferences",
      "references",
      "referenceSchemaName",
      "referenceEntityName",
      "schemaName",
      "entityName",
    ]),
    properties:
      typeof indexDefinition?.getProperties === "function"
        ? indexDefinition.getProperties().map((propertyDefinition) =>
            getSerializableEntries(propertyDefinition, [
              "indexDefinition",
              "schemaName",
              "entityName",
            ])
          )
        : [],
  };

  if (typeof indexDefinition?.getReferences === "function") {
    descriptor.referenceSchemaName =
      indexDefinition.referenceSchemaName ?? descriptor.referenceSchemaName;
    descriptor.referenceEntityName =
      indexDefinition.referenceEntityName ?? descriptor.referenceEntityName;
    descriptor.references = indexDefinition.getReferences().map((referenceDefinition) =>
      getSerializableEntries(referenceDefinition, ["linkDefinition"])
    );
  }

  return descriptor;
}

function buildCurrentSchemasEntityDescriptor(entityDefinition) {
  return {
    name: entityDefinition.name,
    schemaName: entityDefinition.schemaName,
    ...getSerializableEntries(entityDefinition, [
      "datasource",
      "schemaDefinition",
      "propertyDefinitions",
      "indexes",
      "migrations",
      "_isInitializingProperties",
      "name",
      "schemaName",
    ]),
    properties:
      typeof entityDefinition?.getProperties === "function"
        ? entityDefinition
            .getProperties()
            .map(buildCurrentSchemasPropertyDescriptor)
        : [],
    indexes:
      typeof entityDefinition?.getIndexes === "function"
        ? entityDefinition
            .getIndexes()
            .map(buildCurrentSchemasIndexDescriptor)
        : [],
  };
}

function buildCurrentSchemasSchemaDescriptor(schemaDefinition) {
  return {
    name: schemaDefinition.name,
    ...getSerializableEntries(schemaDefinition, [
      "datasource",
      "entityDefinitions",
      "migrations",
      "name",
    ]),
    entities:
      typeof schemaDefinition?.getEntityDefinitions === "function"
        ? schemaDefinition
            .getEntityDefinitions()
            .map(buildCurrentSchemasEntityDescriptor)
        : [],
  };
}

export function buildCurrentSchemasDescriptor(datasource, options = {}) {
  const runtimeMetadata = getRuntimeMetadata(datasource);
  const timestamp =
    typeof options?.timestamp === "number" && Number.isFinite(options.timestamp)
      ? options.timestamp
      : Date.now();
  return {
    [CURRENT_SCHEMAS_TIMESTAMP_KEY]: timestamp,
    datasource: {
      name: datasource?.name,
      path: normalizePath(
        datasource?.path ??
          runtimeMetadata?.path ??
          getParent(runtimeMetadata?.datasourceFile ?? process.cwd())
      ),
      ...(runtimeMetadata?.datasourceFile
        ? { datasourceFile: runtimeMetadata.datasourceFile }
        : {}),
    },
    reverseEngineeringCapabilities: getReverseEngineeringCapabilities(datasource),
    schemaDefinitions:
      typeof datasource?.getSchemaDefinitions === "function"
        ? datasource
            .getSchemaDefinitions()
            .map(buildCurrentSchemasSchemaDescriptor)
        : [],
  };
}

function buildCurrentSchemasBackupFilePath(currentFilePath, timestamp) {
  const currentBaseName = basename(currentFilePath);
  const dotIndex = currentBaseName.lastIndexOf(".");
  const safeTimestamp =
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
      ? String(timestamp)
      : String(Date.now());
  let backupBaseName;
  if (dotIndex > 0) {
    backupBaseName = `${currentBaseName.slice(0, dotIndex)}-${safeTimestamp}${currentBaseName.slice(dotIndex)}`;
  } else {
    backupBaseName = `${currentBaseName}-${safeTimestamp}`;
  }
  return getFile(getParent(currentFilePath), backupBaseName);
}

async function backupExistingCurrentSchemasFile(filePath) {
  if (!filePath || !fileExists(filePath)) {
    return null;
  }
  let existingTimestamp = null;
  try {
    const raw = await getFileContentAsync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const candidate = parsed?.[CURRENT_SCHEMAS_TIMESTAMP_KEY];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      existingTimestamp = candidate;
    }
  } catch {}
  if (existingTimestamp == null) {
    try {
      const stats = getFileVersion(filePath);
      if (Number.isFinite(stats) && stats > 0) {
        existingTimestamp = stats;
      }
    } catch {}
  }
  const backupPath = buildCurrentSchemasBackupFilePath(filePath, existingTimestamp);
  try {
    copyFileSyncEx(filePath, backupPath);
    return backupPath;
  } catch (error) {
    asyncConsole.log("datasources", {
      message: "Current schemas backup failed",
      filePath,
      backupPath,
      error,
    });
    return null;
  }
}

function getCurrentSchemasFilePath(datasourceObject, options = {}) {
  const runtimeMetadata = getRuntimeMetadata(datasourceObject);
  const basePath = normalizePath(
    options.outputDirectory ??
      datasourceObject?.path ??
      runtimeMetadata?.path ??
      getParent(runtimeMetadata?.datasourceFile ?? process.cwd())
  );
  return getFile(basePath, options.fileName ?? CURRENT_SCHEMAS_FILE_NAME);
}

async function reverseEngineerDatasource(datasourceObject, options = {}) {
  if (typeof datasourceObject?.reverseEngineer === "function") {
    await datasourceObject.reverseEngineer({
      schemaName: options.schemaName ?? null,
      includeEntities: options.includeEntities ?? true,
      includeProperties: options.includeProperties ?? true,
      includeIndexes: options.includeIndexes ?? true,
      reset: options.reset ?? true,
    });
    return datasourceObject;
  }

  const datasourceSettings = datasourceObject;
  const temporaryAReS = createTemporaryAReS(datasourceSettings?.name ?? "datasource");
  const datasource = await loadDatasource(
    temporaryAReS,
    datasourceSettings,
    options.onMapperLoaded,
    true
  );
  await datasource.reverseEngineer({
    schemaName: options.schemaName ?? null,
    includeEntities: options.includeEntities ?? true,
    includeProperties: options.includeProperties ?? true,
    includeIndexes: options.includeIndexes ?? true,
    reset: options.reset ?? true,
  });
  return datasource;
}

export async function generateCurrentSchemasFile(datasourceObject, options = {}) {
  if (!datasourceObject || typeof datasourceObject !== "object") {
    throw new Error("datasource_object_is_required");
  }
  if (!canReverseEngineerDatasource(datasourceObject)) {
    throw new Error("datasource_reverse_engineering_not_supported");
  }

  const filePath = getCurrentSchemasFilePath(datasourceObject, options);
  const backupFilePath = options.skipBackup === true
    ? null
    : await backupExistingCurrentSchemasFile(filePath);
  const reverseEngineeredDatasource = await reverseEngineerDatasource(
    datasourceObject,
    options
  );
  const descriptor = buildCurrentSchemasDescriptor(reverseEngineeredDatasource, {
    timestamp: options.timestamp,
  });

  await setJsonFileContentAsync(filePath, descriptor, options.spaces ?? 2);
  return {
    filePath,
    backupFilePath: backupFilePath ?? null,
    descriptor,
    datasource: reverseEngineeredDatasource,
  };
}

export async function ensureCurrentSchemasFile(datasourceObject, options = {}) {
  const filePath = getCurrentSchemasFilePath(datasourceObject, options);
  if (options.force !== true && fileExists(filePath)) {
    return {
      created: false,
      filePath,
    };
  }
  if (!canReverseEngineerDatasource(datasourceObject)) {
    return {
      created: false,
      skipped: true,
      filePath,
      reason: "datasource_reverse_engineering_not_supported",
      capabilities: getReverseEngineeringCapabilities(datasourceObject),
    };
  }

  const generationResult = await generateCurrentSchemasFile(datasourceObject, options);
  return {
    created: true,
    ...generationResult,
  };
}

export async function generateCurrentSchemasFileFromDatasourceFile(
  datasourceFile,
  options = {}
) {
  const datasourceObject = await assembleDatasource(datasourceFile, {
    ...options,
    generateCurrentSchemasIfMissing: false,
  });
  return generateCurrentSchemasFile(datasourceObject, options);
}

export async function generateCurrentSchemasFilesFromRoot(
  datasourcesRoot,
  options = {}
) {
  const normalizedDatasourceRoot = normalizePath(datasourcesRoot);
  const datasourceFiles = getFilesRecursively(
    normalizedDatasourceRoot,
    /(.*[\/\\]){0,1}datasource\.js/i,
    true
  );
  const results = [];
  for (const datasourceFile of datasourceFiles) {
    results.push(
      await generateCurrentSchemasFileFromDatasourceFile(datasourceFile, {
        ...options,
        datasourcesRoot: normalizedDatasourceRoot,
      })
    );
  }
  return results;
}

function getQueryExtensions(datasourceObject) {
  const extensions = new Set();
  for (const databases of Object.values(datasourceObject?.environments ?? {})) {
    for (const value of Object.values(databases ?? {})) {
      const queryExtensions = value?.queryExtensions;
      if (!queryExtensions) continue;
      String(queryExtensions)
        .split("|")
        .map((item) => item.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean)
        .forEach((item) => extensions.add(item));
    }
  }
  return [...extensions];
}

function buildQueryFilePattern(extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) return null;
  const escapedExtensions = extensions.map((extension) =>
    extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`.*\\.(${escapedExtensions.join("|")})$`, "i");
}

function isPathWithinDirectory(filePath, directoryPath) {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedDirectoryPath = normalizePath(directoryPath);
  return (
    normalizedFilePath === normalizedDirectoryPath ||
    normalizedFilePath.startsWith(`${normalizedDirectoryPath}\\`) ||
    normalizedFilePath.startsWith(`${normalizedDirectoryPath}/`)
  );
}

function shouldReloadDatasource(metadata, changedPath) {
  if (!metadata || !changedPath) return false;
  const normalizedChangedPath = normalizePath(changedPath);
  const watchedFiles = metadata.watchedFiles ?? [];
  if (watchedFiles.includes(normalizedChangedPath)) return true;

  const changedExtension = extname(normalizedChangedPath).replace(/^\./, "").toLowerCase();
  if (
    changedExtension &&
    Array.isArray(metadata.queryExtensions) &&
    metadata.queryExtensions.includes(changedExtension) &&
    isPathWithinDirectory(normalizedChangedPath, metadata.path)
  ) {
    return true;
  }

  if (
    changedExtension === "js" &&
    isPathWithinDirectory(normalizedChangedPath, metadata.path)
  ) {
    return true;
  }

  return basename(normalizedChangedPath).toLowerCase() === "datasource.js";
}

export async function assembleDatasource(datasourceFile, options = {}) {
  const normalizedDatasourceFile = normalizePath(datasourceFile);
  const datasourceVersionTag = options.versionTag ?? getFileVersion(normalizedDatasourceFile);
  const datasourceObject = {
    ...(await import(createVersionedImportUrl(normalizedDatasourceFile, datasourceVersionTag))),
  };

  if (!datasourceObject.path) {
    datasourceObject.path = getParent(normalizedDatasourceFile);
  }
  datasourceObject.path = normalizePath(datasourceObject.path);

  if (options.generateCurrentSchemasIfMissing !== false) {
    try {
      const currentSchemasResult = await ensureCurrentSchemasFile(datasourceObject, {
        ...options,
        datasourceFile: normalizedDatasourceFile,
        force: false,
      });
      if (currentSchemasResult?.skipped === true) {
        asyncConsole.log("datasources", {
          message: "Current schemas generation skipped",
          datasource: datasourceObject?.name,
          datasourceFile: normalizedDatasourceFile,
          reason: currentSchemasResult.reason,
          capabilities: currentSchemasResult.capabilities,
        });
      }
    } catch (error) {
      asyncConsole.log("datasources", {
        message: "Current schemas generation failed",
        datasource: datasourceObject?.name,
        datasourceFile: normalizedDatasourceFile,
        error,
      });
    }
  }

  const currentSchemasFilePath = getCurrentSchemasFilePath(datasourceObject);
  const schemasIsFalsy =
    datasourceObject.schemas === undefined ||
    datasourceObject.schemas === null ||
    datasourceObject.schemas === false ||
    datasourceObject.schemas === 0 ||
    datasourceObject.schemas === "" ||
    (typeof datasourceObject.schemas === "number" &&
      Number.isNaN(datasourceObject.schemas));
  if (fileExists(currentSchemasFilePath) && schemasIsFalsy) {
    try {
      const rawContent = await getFileContentAsync(currentSchemasFilePath, "utf8");
      const currentSchemasContent = JSON.parse(rawContent);
      if (
        currentSchemasContent &&
        Array.isArray(currentSchemasContent.schemaDefinitions)
      ) {
        datasourceObject.schemas = currentSchemasContent.schemaDefinitions;
        asyncConsole.log("datasources", {
          message: "Current schemas hydrated into datasourceObject.schemas",
          datasource: datasourceObject?.name,
          schemaCount: datasourceObject.schemas.length,
          filePath: currentSchemasFilePath,
        });
      }
    } catch (error) {
      asyncConsole.log("datasources", {
        message: "Current schemas file parsing failed",
        datasource: datasourceObject?.name,
        datasourceFile: normalizedDatasourceFile,
        filePath: currentSchemasFilePath,
        error,
      });
    }
  }

  const queryExtensions = getQueryExtensions(datasourceObject);
  const queryPattern = buildQueryFilePattern(queryExtensions);
  const watchedFiles = new Set([normalizedDatasourceFile]);

  if (queryPattern) {
    for (const file of getFilesRecursively(
      datasourceObject.path,
      queryPattern,
      true
    )) {
      const normalizedQueryFile = normalizePath(file);
      watchedFiles.add(normalizedQueryFile);
      datasourceObject.queries = datasourceObject.queries || {};
      const completeFilePath = normalizedQueryFile.replaceAll(/\.\w+$/gi, "");
      const mapperModuleFile = `${completeFilePath}.js`;
      const fileName = getFileName(completeFilePath);
      const mapperFileObject = (
        await import(
          createVersionedImportUrl(
            mapperModuleFile,
            `${getFileVersion(mapperModuleFile)}-${getFileVersion(normalizedQueryFile)}`
          )
        )
      ).default;
      watchedFiles.add(normalizePath(mapperModuleFile));
      if (mapperFileObject) {
        datasourceObject.queries[fileName] = mapperFileObject;
        datasourceObject.queries[fileName].query = getFileContent(normalizedQueryFile);
      }
    }
  }

  return registerSchemaInstallerHook(
    setRuntimeMetadata(datasourceObject, {
      datasourceFile: normalizedDatasourceFile,
      path: normalizePath(datasourceObject.path),
      watchedFiles: [...watchedFiles],
      queryExtensions,
      datasourcesRoot: options.datasourcesRoot
        ? normalizePath(options.datasourcesRoot)
        : undefined,
    }),
  );
}

/**
 * @return {array} The exported data sources
 *
 * Initialyze db object
 *
 */
export async function initAllDatasources(datasourcesRoot) {
  const normalizedDatasourceRoot = normalizePath(datasourcesRoot);
  const files = getFilesRecursively(
    normalizedDatasourceRoot,
    /(.*[\/\\]){0,1}datasource\.js/i,
    true
  );
  const array = [];
  for (const file of files) {
    asyncConsole.log("datasources", 'connection file found: "' + file + ";");
    array.push(
      await assembleDatasource(file, {
        datasourcesRoot: normalizedDatasourceRoot,
      })
    );
  }
  asyncConsole.output("datasources", array);
  return array;
}

export function enableDatasourceHotReload(aReS, datasourceList = [], options = {}) {
  const enabled =
    options.enabled ??
    aReS?.getConfig?.("datasources.watch", !aReS?.isProduction) ??
    !aReS?.isProduction;

  if (!enabled || !aReS || !Array.isArray(datasourceList) || datasourceList.length === 0) {
    return () => {};
  }

  const datasourceFiles = datasourceList
    .map((datasourceObject) => getRuntimeMetadata(datasourceObject))
    .filter(Boolean);
  const datasourcesRoot =
    options.datasourcesRoot ??
    datasourceFiles.find((metadata) => metadata?.datasourcesRoot)?.datasourcesRoot;

  if (!datasourcesRoot) {
    asyncConsole.log(
      "datasources",
      "hot reload skipped: datasource root metadata not available"
    );
    return () => {};
  }

  const debounceMs =
    options.debounceMs ??
    aReS?.getConfig?.("datasources.watchDebounceMs", 150) ??
    150;
  const state = (aReS[HOT_RELOAD_STATE_KEY] = aReS[HOT_RELOAD_STATE_KEY] ?? {
    cleanup: null,
  });

  state.cleanup?.();

  const pendingReloads = new Map();

  const reloadDatasource = async (datasourceFile, changedPath) => {
    try {
      const nextDatasource = await assembleDatasource(datasourceFile, {
        datasourcesRoot,
        versionTag: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      const datasourceName = nextDatasource?.name?.toLowerCase?.();
      const currentDatasource =
        datasourceName && aReS?.datasourceMap ? aReS.datasourceMap[datasourceName] : null;
      const onMapperLoaded = currentDatasource?.onMapperLoaded;

      if (currentDatasource) {
        await refreshDatasource(aReS, nextDatasource, onMapperLoaded);
      } else {
        await loadDatasource(aReS, nextDatasource, onMapperLoaded, true);
      }

      const datasourceIndex = datasourceList.findIndex((item) => {
        const metadata = getRuntimeMetadata(item);
        return metadata?.datasourceFile === datasourceFile;
      });
      if (datasourceIndex >= 0) {
        datasourceList[datasourceIndex] = nextDatasource;
      } else {
        datasourceList.push(nextDatasource);
      }

      asyncConsole.log("datasources", {
        message: "Datasource hot reloaded",
        datasource: nextDatasource?.name,
        file: getRelativePathFrom(changedPath ?? datasourceFile, datasourcesRoot),
      });
      if (typeof options.onReload === "function") {
        await options.onReload(nextDatasource, changedPath);
      }
    } catch (error) {
      asyncConsole.log("datasources", {
        message: "Datasource hot reload failed",
        datasourceFile,
        changedPath,
        error,
      });
    }
  };

  const scheduleReload = (datasourceFile, changedPath) => {
    const previousTimeout = pendingReloads.get(datasourceFile);
    if (previousTimeout) clearTimeout(previousTimeout);
    pendingReloads.set(
      datasourceFile,
      setTimeout(async () => {
        pendingReloads.delete(datasourceFile);
        await reloadDatasource(datasourceFile, changedPath);
      }, debounceMs)
    );
  };

  const watcher = watch(datasourcesRoot, { recursive: true }, (_eventType, fileName) => {
    const normalizedChangedPath = fileName
      ? normalizePath(resolve(datasourcesRoot, String(fileName)))
      : null;
    for (const datasourceObject of datasourceList) {
      const metadata = getRuntimeMetadata(datasourceObject);
      if (!metadata) continue;
      if (!normalizedChangedPath || shouldReloadDatasource(metadata, normalizedChangedPath)) {
        scheduleReload(metadata.datasourceFile, normalizedChangedPath ?? metadata.datasourceFile);
      }
    }
  });

  const cleanup = () => {
    for (const timeoutId of pendingReloads.values()) {
      clearTimeout(timeoutId);
    }
    pendingReloads.clear();
    watcher.close();
  };

  state.cleanup = cleanup;
  asyncConsole.log("datasources", `hot reload enabled on ${datasourcesRoot}`);
  return cleanup;
}

export function serializeDatasource(datasource, serializationDir) {
  const serializedFile = getFile(
    serializationDir,
    datasource.name + ".datasource.js"
  );
  let serializedContent = `import * form '@ares/datasource.js';\nconst datasource = {\n`;
  for (const key in datasource) {
    if (typeof datasource[key] === "function") {
      serializedContent += `\t"${key}": ${datasource[key].toString()}},\n`;
    } else {
      serializedContent += `"\t${key}": ${JSON.stringify(datasource[key])},\n`;
    }
  }
  serializedContent += `},\n`;
}

function _clone(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value);
  if (typeof value === "function") return undefined;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((it) => _clone(it, seen));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (k === "parent" || k === "children" || k === "datasource") continue;
    if (k.startsWith("__")) continue;
    const v = value[k];
    if (typeof v === "function") continue;
    try {
      out[k] = _clone(v, seen);
    } catch {
      out[k] = null;
    }
  }
  return out;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mi = String(value.getMinutes()).padStart(2, "0");
    const ss = String(value.getSeconds()).padStart(2, "0");
    return `'${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}'`;
  }
  const str = String(value);
  const escaped = str.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `'${escaped}'`;
}

function quoteIdentifier(identifier) {
  if (!identifier) return "";
  return "`" + String(identifier).replace(/`/g, "``") + "`";
}

function quoteQualifiedEntity(schemaName, entityName) {
  if (schemaName) return `${quoteIdentifier(schemaName)}.${quoteIdentifier(entityName)}`;
  return quoteIdentifier(entityName);
}

function sanitizeForFileSystem(text) {
  return String(text ?? "migration")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function formatSerializationTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function getOrCreateMigrationsDir(datasourceDirectory) {
  const dir = normalize(join(datasourceDirectory, "migrations"));
  await createDirectoryAsync(dir, true);
  return dir;
}

async function executeRawSqlStatements(datasource, statements, options = {}) {
  const schemas = Array.isArray(options._schemas) ? options._schemas : null;
  const normalized = (
    Array.isArray(statements)
      ? statements.filter((s) => s != null && s !== "")
      : [statements]
  ).map((s, i) =>
    schemas && schemas[i] ? Object.assign(String(s), { _schema: schemas[i] }) : s,
  );
  if (normalized.length === 0) return [];
  const result = await datasourceRuntime.executeMigration(datasource, {
    actions: normalized,
  });
  return Array.isArray(result) ? result.flat() : [];
}

async function ensureLedgerTableExists(datasource, schemaName) {
  if (!schemaName) return null;
  const entityDescriptor = buildStandardMigrationsEntityDescriptor(schemaName);
  let ledgerEntity = datasource.getEntityDefinition?.(
    STANDARD_MIGRATIONS_ENTITY_NAME,
    schemaName,
  );
  let schemaDefinition = datasource.getSchemaDefinition?.(schemaName);
  if (!schemaDefinition) {
    const exists =
      typeof datasourceRuntime.exists === "function"
        ? await datasourceRuntime.exists(datasource, schemaName)
        : true;
    if (!exists && typeof datasourceRuntime.createSchema === "function") {
      try {
        await datasourceRuntime.createSchema({
          datasource,
          name: schemaName,
        });
      } catch (e) {
        // schema may exist already — ignore
      }
    }
    datasource.ensureSchemaDefinition?.(schemaName);
    schemaDefinition = datasource.getSchemaDefinition(schemaName);
  }
  if (!ledgerEntity) {
    ledgerEntity = schemaDefinition.getEntityDefinition?.(
      STANDARD_MIGRATIONS_ENTITY_NAME,
    );
    if (!ledgerEntity) {
      const { EntityDefinition } = await import("@ares/core/datasources.js");
      ledgerEntity = new EntityDefinition(schemaDefinition, entityDescriptor);
    }
  }
  const tableExists =
    typeof datasourceRuntime.exists === "function"
      ? await datasourceRuntime.exists(
          datasource,
          schemaName,
          STANDARD_MIGRATIONS_ENTITY_NAME,
        )
      : false;
  if (!tableExists && typeof datasourceRuntime.createEntity === "function") {
    try {
      await datasourceRuntime.createEntity(ledgerEntity, { minimal: true });
    } catch (e) {
      // Could already exist in race conditions — ignore
    }
    const nonLinkIndexes = [];
    const linkIndexes = [];
    for (const indexDefinition of ledgerEntity.getIndexes?.() ?? []) {
      if (indexDefinition.type === INDEX_DEFINITION_TYPES.LINK) {
        linkIndexes.push(indexDefinition);
      } else {
        nonLinkIndexes.push(indexDefinition);
      }
    }
    const { Migration, Migration: MigrationClass } =
      await import("@ares/core/datasources.js");
    for (const idx of nonLinkIndexes) {
      try {
        const action = MigrationClass.createEntityAction(
          ledgerEntity,
          MIGRATION_TYPES.CREATE_INDEX,
          {
            datasource,
            schemaDefinition,
            entityDefinition: ledgerEntity,
            indexDefinition: _clone(idx.indexDefinition ?? idx),
          },
        );
        await datasourceRuntime.executeMigration(datasource, action);
      } catch (e) {}
    }
    for (const idx of linkIndexes) {
      try {
        const action = MigrationClass.createEntityAction(
          ledgerEntity,
          MIGRATION_TYPES.CREATE_INDEX,
          {
            datasource,
            schemaDefinition,
            entityDefinition: ledgerEntity,
            indexDefinition: _clone(idx.indexDefinition ?? idx),
          },
        );
        await datasourceRuntime.executeMigration(datasource, action);
      } catch (e) {}
    }
  }
  return { schemaDefinition, ledgerEntity };
}

async function selectMigrationRecord(datasource, schemaName, migrationName) {
  const sql =
    "SELECT * FROM " +
    quoteQualifiedEntity(schemaName, STANDARD_MIGRATIONS_ENTITY_NAME) +
    " WHERE `name` = " +
    sqlLiteral(migrationName) +
    " LIMIT 1";
  try {
    const results = await executeRawSqlStatements(datasource, [sql], { _schemas: [schemaName] });
    const first = results?.[0];
    const rows = first?.results ?? first?.rows ?? (Array.isArray(first) ? first : null);
    if (!Array.isArray(rows)) return null;
    return rows[0] ?? null;
  } catch (e) {
    return null;
  }
}

async function insertMigrationRecord(datasource, schemaName, record) {
  if (!record || typeof record !== "object") return null;
  const columns = Object.keys(record);
  if (columns.length === 0) return null;
  const sql =
    "INSERT INTO " +
    quoteQualifiedEntity(schemaName, STANDARD_MIGRATIONS_ENTITY_NAME) +
    " (" +
    columns.map((c) => quoteIdentifier(c)).join(", ") +
    ") VALUES (" +
    columns.map((c) => sqlLiteral(record[c])).join(", ") +
    ")";
  try {
    return await executeRawSqlStatements(datasource, [sql], { _schemas: [schemaName] });
  } catch (e) {
    return null;
  }
}

async function updateMigrationRecord(datasource, schemaName, migrationName, record) {
  if (!record || typeof record !== "object") return null;
  const assignments = Object.keys(record)
    .filter((k) => k !== "name")
    .map((k) => `${quoteIdentifier(k)} = ${sqlLiteral(record[k])}`)
    .join(", ");
  if (!assignments) return null;
  const sql =
    "UPDATE " +
    quoteQualifiedEntity(schemaName, STANDARD_MIGRATIONS_ENTITY_NAME) +
    " SET " +
    assignments +
    " WHERE `name` = " +
    sqlLiteral(migrationName) +
    " LIMIT 1";
  try {
    return await executeRawSqlStatements(datasource, [sql], { _schemas: [schemaName] });
  } catch (e) {
    return null;
  }
}

async function serializeMigrationToFile(
  datasourceDirectory,
  migration,
  extras = {},
) {
  try {
    const dir = await getOrCreateMigrationsDir(datasourceDirectory);
    const serializationTs = extras.serializedAt ? new Date(extras.serializedAt) : new Date();
    const prefix = formatSerializationTimestamp(serializationTs);
    const baseName = sanitizeForFileSystem(migration?.name ?? "migration");
    const fileName = `${prefix}-${baseName}.json`;
    const filePath = normalize(join(dir, fileName));
    const payload = {
      migrationName: migration?.name ?? null,
      description: migration?.description ?? null,
      migrationKind: migration?.migrationKind ?? null,
      migrationPhase: migration?.migrationPhase ?? null,
      targetSchemaName: migration?.targetSchemaName ?? null,
      targetEntityName: migration?.targetEntityName ?? null,
      targetIndexName: migration?.targetIndexName ?? null,
      sentAt: extras.sentAt ?? migration?.sentAt ?? new Date().toISOString(),
      serializedAt: serializationTs.toISOString(),
      actions: Array.isArray(migration?.actionsRaw)
        ? migration.actionsRaw.map((a) => _clone(a))
        : Array.isArray(migration?.originalActions)
          ? migration.originalActions.map((a) => _clone(a))
          : [],
      rollBack: Array.isArray(migration?.rollBack)
        ? migration.rollBack.map((a) => _clone(a))
        : Array.isArray(migration?.originalRollBackActions)
          ? migration.originalRollBackActions.map((a) => _clone(a))
          : [],
      status: extras.status ?? migration?.status ?? null,
      sender: extras.sender ?? migration?.sender ?? null,
      completedAt: extras.completedAt ?? null,
      exception: extras.exception ?? null,
      rollbackException: extras.rollbackException ?? null,
      datasourceName: extras.datasourceName ?? null,
      ...extras,
    };
    await setJsonFileContentAsync(filePath, payload, 2);
    return filePath;
  } catch (error) {
    asyncConsole.log("datasources", {
      message: "Failed to serialize migration file",
      migrationName: migration?.name,
      datasourceDirectory,
      error,
    });
    return null;
  }
}

function buildMigrationExceptionInfo(error, actionIndex = null) {
  const idx = actionIndex;
  return {
    message: error?.message ?? String(error ?? "unknown"),
    trace: error?.stack ?? null,
    actionIndex: Number.isInteger(idx) ? idx : error?.actionIndex ?? null,
  };
}

async function executeMigrationActionsSequentially(datasource, migration) {
  const actions = Array.isArray(migration?.actionsRaw)
    ? migration.actionsRaw
    : migration?.originalActions ?? [];
  const results = [];
  let actionIndex = 0;
  for (const action of actions) {
    try {
      const r = await datasourceRuntime.executeMigration(datasource, action);
      results.push(Array.isArray(r) ? r : [r]);
      actionIndex++;
    } catch (error) {
      error.actionIndex = actionIndex;
      error.migrationName = migration?.name ?? null;
      throw error;
    }
  }
  return results;
}

async function executeRollbackActionsSequentially(datasource, migration) {
  const rollBack = Array.isArray(migration?.rollBack)
    ? migration.rollBack
    : migration?.originalRollBackActions ?? [];
  const reversed = [...rollBack].reverse();
  let actionIndex = 0;
  for (const rbAction of reversed) {
    if (rbAction == null) {
      actionIndex++;
      continue;
    }
    try {
      await datasourceRuntime.executeMigration(datasource, rbAction);
      actionIndex++;
    } catch (error) {
      error.actionIndex =
        rollBack.length > 0 ? rollBack.length - 1 - actionIndex : actionIndex;
      error.migrationName = migration?.name ?? null;
      throw error;
    }
  }
  return true;
}

async function runMigrationWithLedgerTracking(
  datasource,
  datasourceDirectory,
  schemaName,
  migration,
  options = {},
) {
  const now = new Date();
  const sender = options.sender ?? "aReS-datasource-files-install";
  const existingRecord = await selectMigrationRecord(
    datasource,
    schemaName,
    migration.name,
  );
  if (existingRecord) {
    const status = String(existingRecord.status ?? "").toUpperCase();
    if (status === MIGRATION_STATUS.DONE) {
      asyncConsole.log("datasources", {
        message: "Migration skipped (already DONE in ledger)",
        datasource: datasource.name,
        migrationName: migration.name,
        schemaName,
      });
      return {
        migrationName: migration.name,
        status: MIGRATION_STATUS.DONE,
        skipped: true,
        alreadyDone: true,
      };
    }
    if (status === MIGRATION_STATUS.FAILED) {
      asyncConsole.log("datasources", {
        message: "Migration found in FAILED state — attempting rollback before retry",
        datasource: datasource.name,
        migrationName: migration.name,
        schemaName,
      });
      try {
        await executeRollbackActionsSequentially(datasource, migration);
        const completedAt = new Date().toISOString();
        await updateMigrationRecord(
          datasource,
          schemaName,
          migration.name,
          {
            status: MIGRATION_STATUS.ROLLED_BACK,
            completed_at: completedAt,
          },
        );
        await serializeMigrationToFile(datasourceDirectory, migration, {
          status: MIGRATION_STATUS.ROLLED_BACK,
          completedAt,
          sender,
          datasourceName: datasource.name,
          previousStatus: MIGRATION_STATUS.FAILED,
        });
      } catch (rollbackError) {
        const info = buildMigrationExceptionInfo(
          rollbackError,
          rollbackError.actionIndex,
        );
        await updateMigrationRecord(
          datasource,
          schemaName,
          migration.name,
          {
            status: MIGRATION_STATUS.FAILED,
            rollback_exception_message: info.message,
            rollback_exception_trace: info.trace,
            rollback_exception_action_index: info.actionIndex,
          },
        );
        await serializeMigrationToFile(datasourceDirectory, migration, {
          status: MIGRATION_STATUS.FAILED,
          sender,
          datasourceName: datasource.name,
          rollbackException: info,
          exception: existingRecord.exception_message
            ? {
                message: existingRecord.exception_message ?? null,
                trace: existingRecord.exception_trace ?? null,
                actionIndex: existingRecord.exception_action_index ?? null,
              }
            : null,
        });
        return {
          migrationName: migration.name,
          status: MIGRATION_STATUS.FAILED,
          error: rollbackError,
          rolledBack: false,
          rollbackException: info,
        };
      }
    } else if (status === MIGRATION_STATUS.ROLLED_BACK) {
      // Already ROLLED_BACK: allowed to re-run fresh
    }
  }

  if (!existingRecord) {
    await insertMigrationRecord(datasource, schemaName, {
      name: migration.name,
      description: migration.description ?? "",
      sent_at: now.toISOString(),
      status: MIGRATION_STATUS.RUNNING,
      sender,
      completed_at: null,
    });
  } else {
    await updateMigrationRecord(
      datasource,
      schemaName,
      migration.name,
      {
        status: MIGRATION_STATUS.RUNNING,
        sent_at: existingRecord.sent_at ?? now.toISOString(),
        sender: existingRecord.sender ?? sender,
        exception_message: null,
        exception_trace: null,
        exception_action_index: null,
        rollback_exception_message: null,
        rollback_exception_trace: null,
        rollback_exception_action_index: null,
        completed_at: null,
      },
    );
  }

  let tx = null;
  try {
    try {
      tx = await datasourceRuntime.startMigrationTransaction(
        datasource,
        migration.connectionName ?? null,
        `ares-migration:${migration.name}`,
      );
    } catch (txErr) {
      tx = null;
      asyncConsole.log("datasources", {
        message:
          "Migration transaction not supported by driver — continuing without transaction (rollback via explicit rollBack actions)",
        datasource: datasource.name,
        migrationName: migration.name,
        schemaName,
        error: txErr,
      });
    }
    await executeMigrationActionsSequentially(datasource, migration);
    if (tx && tx.isOpen) {
      try {
        await datasourceRuntime.commitMigrationTransaction(datasource, tx);
      } catch (commitErr) {
        asyncConsole.log("datasources", {
          message: "Commit of migration transaction failed — proceeding to explicit rollback actions",
          datasource: datasource.name,
          migrationName: migration.name,
          schemaName,
          error: commitErr,
        });
        tx.isOpen = false;
        throw commitErr;
      }
    }
    const completedAt = new Date().toISOString();
    await updateMigrationRecord(
      datasource,
      schemaName,
      migration.name,
      {
        status: MIGRATION_STATUS.DONE,
        completed_at: completedAt,
      },
    );
    await serializeMigrationToFile(datasourceDirectory, migration, {
      status: MIGRATION_STATUS.DONE,
      completedAt,
      sender,
      datasourceName: datasource.name,
    });
    return {
      migrationName: migration.name,
      status: MIGRATION_STATUS.DONE,
      installed: true,
      targetSchemaName: migration.targetSchemaName,
      targetEntityName: migration.targetEntityName,
      targetIndexName: migration.targetIndexName,
      migrationKind: migration.migrationKind,
      usedTransaction: !!tx,
    };
  } catch (error) {
    const info = buildMigrationExceptionInfo(error, error.actionIndex);
    if (tx && tx.isOpen) {
      try {
        await datasourceRuntime.rollbackMigrationTransaction(datasource, tx);
      } catch {
        // ignore — fallback to explicit rollback actions below
      }
      tx.isOpen = false;
    }
    await updateMigrationRecord(
      datasource,
      schemaName,
      migration.name,
      {
        status: MIGRATION_STATUS.FAILED,
        exception_message: info.message,
        exception_trace: info.trace,
        exception_action_index: info.actionIndex,
      },
    );
    await serializeMigrationToFile(datasourceDirectory, migration, {
      status: MIGRATION_STATUS.FAILED,
      sender,
      datasourceName: datasource.name,
      exception: info,
    });
    try {
      await executeRollbackActionsSequentially(datasource, migration);
      const rolledAt = new Date().toISOString();
      await updateMigrationRecord(
        datasource,
        schemaName,
        migration.name,
        {
          status: MIGRATION_STATUS.ROLLED_BACK,
          completed_at: rolledAt,
        },
      );
      await serializeMigrationToFile(datasourceDirectory, migration, {
        status: MIGRATION_STATUS.ROLLED_BACK,
        completedAt: rolledAt,
        sender,
        datasourceName: datasource.name,
        exception: info,
      });
      return {
        migrationName: migration.name,
        status: MIGRATION_STATUS.ROLLED_BACK,
        error,
        exception: info,
        rolledBack: true,
        usedTransaction: !!tx,
      };
    } catch (rollbackError) {
      const rinfo = buildMigrationExceptionInfo(
        rollbackError,
        rollbackError.actionIndex,
      );
      await updateMigrationRecord(
        datasource,
        schemaName,
        migration.name,
        {
          status: MIGRATION_STATUS.FAILED,
          rollback_exception_message: rinfo.message,
          rollback_exception_trace: rinfo.trace,
          rollback_exception_action_index: rinfo.actionIndex,
        },
      );
      await serializeMigrationToFile(datasourceDirectory, migration, {
        status: MIGRATION_STATUS.FAILED,
        sender,
        datasourceName: datasource.name,
        exception: info,
        rollbackException: rinfo,
      });
      return {
        migrationName: migration.name,
        status: MIGRATION_STATUS.FAILED,
        error,
        exception: info,
        rollbackException: rinfo,
        rolledBack: false,
        usedTransaction: !!tx,
      };
    }
  }
}

export async function installDatasourceWithMigrations(
  datasource,
  datasourceDirectory,
  options = {},
) {
  if (!datasource || typeof datasource !== "object") {
    throw new Error("installDatasourceWithMigrations: datasource is required");
  }
  if (!datasourceDirectory || typeof datasourceDirectory !== "string") {
    throw new Error(
      "installDatasourceWithMigrations: datasourceDirectory is required",
    );
  }
  const autoMigrations = Array.isArray(options.migrations)
    ? options.migrations
    : (datasource.buildInstallMigrations?.(options) ?? []);
  let allMigrations = autoMigrations;
  if (options.loadManualMigrations !== false) {
    try {
      const manualMigrations = await loadManualMigrations(
        datasourceDirectory,
        datasource,
        options,
      );
      allMigrations = autoMigrations.concat(manualMigrations);
    } catch (err) {
      asyncConsole.log("datasources", {
        message: "Failed to load manual migrations — proceeding with auto-migrations only",
        datasource: datasource?.name ?? null,
        datasourceDirectory,
        error: err,
      });
    }
  }
  const migrations = allMigrations;
  await getOrCreateMigrationsDir(datasourceDirectory);
  const schemaNamesSeen = new Set();
  for (const migration of migrations) {
    if (migration.targetSchemaName) schemaNamesSeen.add(migration.targetSchemaName);
  }
  (datasource.getSchemaDefinitions?.() ?? []).forEach((s) =>
    schemaNamesSeen.add(s.name),
  );
  for (const schemaName of schemaNamesSeen) {
    try {
      await ensureLedgerTableExists(datasource, schemaName);
    } catch (e) {
      asyncConsole.log("datasources", {
        message: "Failed to ensure ledger table (migrations tracking will be file-only)",
        datasource: datasource.name,
        schemaName,
        error: e,
      });
    }
  }
  const results = [];
  for (const migration of migrations) {
    const schemaName =
      migration.targetSchemaName ??
      (schemaNamesSeen.size === 1 ? [...schemaNamesSeen][0] : null) ??
      ((datasource.getSchemaDefinitions?.() ?? [])[0]?.name) ??
      null;
    if (!schemaName) {
      results.push({
        migrationName: migration.name,
        status: MIGRATION_STATUS.FAILED,
        error: new Error("migration_target_schema_missing"),
      });
      continue;
    }
    const r = await runMigrationWithLedgerTracking(
      datasource,
      datasourceDirectory,
      schemaName,
      migration,
      options,
    );
    results.push(r);
  }
  return results;
}

export function registerSchemaInstallerHook(datasourceObject) {
  if (!datasourceObject || typeof datasourceObject !== "object") return datasourceObject;
  datasourceObject._schemaInstaller = async (datasourceInstance, options) => {
    const directory =
      options?.datasourceDirectory ??
      datasourceInstance.path ??
      datasourceObject.path ??
      null;
    if (!directory) {
      return datasourceInstance.save?.(options) ?? [];
    }
    return installDatasourceWithMigrations(datasourceInstance, directory, options);
  };
  return datasourceObject;
}

export async function loadManualMigrations(datasourceDirectory, datasource, options = {}) {
  if (!datasourceDirectory || typeof datasourceDirectory !== "string") {
    throw new Error("loadManualMigrations: datasourceDirectory is required");
  }
  if (!datasource || typeof datasource !== "object") {
    throw new Error("loadManualMigrations: datasource is required");
  }
  const dir = await getOrCreateMigrationsDir(datasourceDirectory);
  let allFiles = [];
  try {
    allFiles = getFiles(dir, /.*/, "f", false);
  } catch {
    allFiles = [];
  }
  const manualJsFiles = allFiles.map(f => basename(f)).filter((f) => /^[0-9]{14}-[A-Za-z0-9_-]+\.js$/.test(f));
  const results = [];
  for (const fileName of manualJsFiles) {
    const filePath = resolve(dir, fileName);
    const match = fileName.match(/^(\d{14})-([A-Za-z0-9_-]+)\.js$/);
    const timestamp = match ? match[1] : String(Date.now());
    const sanitizedName = match ? match[2] : fileName.replace(/\.js$/, "");
    const migrationName = `${sanitizedName}-${timestamp}`;
    try {
      const preSchemasSnapshot = snapshotSchemas(datasource);
      const userModule = await import(
        createVersionedImportUrl(filePath, timestamp + "_" + getFileVersion(filePath))
      );
      const userFn =
        userModule && typeof userModule.default === "function"
          ? userModule.default
          : typeof userModule === "function"
            ? userModule
            : null;
      if (!userFn) {
        asyncConsole.log("datasources", {
          message: "Manual migration file has no default export function — skipping",
          filePath,
          datasource: datasource.name,
        });
        continue;
      }
      await userFn(datasource, options);
      const migration = await buildDiffMigrationFromSnapshots(
        datasource,
        preSchemasSnapshot,
        migrationName,
        fileName,
        options,
      );
      if (migration) {
        results.push(migration);
      }
    } catch (err) {
      asyncConsole.log("datasources", {
        message: "Failed to load manual migration",
        filePath,
        datasource: datasource.name,
        error: err,
      });
      throw err;
    }
  }
  return results;
}

export async function runManualMigrations(datasourceDirectory, datasource, options = {}) {
  const manual = await loadManualMigrations(datasourceDirectory, datasource, options);
  if (manual.length === 0) return [];
  const combinedMigrations = Array.isArray(options?.migrations)
    ? options.migrations.concat(manual)
    : manual;
  return installDatasourceWithMigrations(datasource, datasourceDirectory, {
    ...options,
    migrations: combinedMigrations,
  });
}

function snapshotSchemas(datasource) {
  const schemas = datasource.getSchemaDefinitions?.() ?? [];
  const out = new Map();
  for (const s of schemas) {
    const entMap = new Map();
    for (const e of s.getEntityDefinitions?.() ?? []) {
      entMap.set(e.name, {
        properties: new Set((e.getPropertyDefinitions?.() ?? []).map((p) => p.name)),
        indexes: new Set((e.getIndexes?.() ?? []).map((i) => i.name ?? String(i))),
        links: new Set((e.getLinkDefinitions?.() ?? []).map((l) => l.name ?? String(l))),
      });
    }
    out.set(s.name, entMap);
  }
  return out;
}

async function buildDiffMigrationFromSnapshots(
  datasource,
  preSnap,
  migrationName,
  fileName,
  options = {},
) {
  const { Migration, MIGRATION_TYPES } = await import("@ares/core/datasources.js");
  const postSchemas = datasource.getSchemaDefinitions?.() ?? [];
  const actions = [];
  const rollBackActions = [];
  let targetSchemaName = null;
  let targetEntityName = null;
  for (const schema of postSchemas) {
    const preEntMap = preSnap.get(schema.name);
    targetSchemaName = targetSchemaName ?? schema.name;
    if (!preEntMap) {
      const act = Migration.createSchemaAction(
        schema,
        MIGRATION_TYPES.CREATE_SCHEMA,
        { schemaDefinition: schema },
      );
      if (act) actions.push(act);
      continue;
    }
    for (const entity of schema.getEntityDefinitions?.() ?? []) {
      const preEnt = preEntMap.get(entity.name);
      targetEntityName = targetEntityName ?? entity.name;
      if (!preEnt) {
        const act = Migration.createEntityAction(
          entity,
          MIGRATION_TYPES.CREATE_ENTITY,
          { entityDefinition: entity, schemaDefinition: schema, minimal: true },
        );
        if (act) actions.push(act);
        continue;
      }
      const postProps = new Set(
        (entity.getPropertyDefinitions?.() ?? []).map((p) => p.name),
      );
      const postIndexes = entity.getIndexes?.() ?? [];
      for (const propName of postProps) {
        if (!preEnt.properties.has(propName)) {
          const prop = (entity.getPropertyDefinitions?.() ?? []).find(
            (p) => p.name === propName,
          );
          const act = Migration.createEntityAction(
            entity,
            MIGRATION_TYPES.CREATE_COLUMN,
            {
              entityDefinition: entity,
              schemaDefinition: schema,
              propertyDefinition: cloneMigrationPayload(prop),
            },
          );
          if (act) actions.push(act);
        }
      }
      for (const idx of postIndexes) {
        const idxName = idx.name ?? String(idx);
        if (
          !preEnt.indexes.has(idxName) &&
          !preEnt.links.has(idxName) &&
          idx.type !== "LINK"
        ) {
          const act = Migration.createEntityAction(
            entity,
            MIGRATION_TYPES.CREATE_INDEX,
            {
              datasource,
              entityDefinition: entity,
              schemaDefinition: schema,
              indexDefinition: cloneMigrationPayload(
                idx.indexDefinition ?? idx,
              ),
            },
          );
          if (act) actions.push(act);
        }
      }
    }
  }
  if (actions.length === 0) {
    const emptyMigration = new Migration(null);
    emptyMigration.name = migrationName;
    emptyMigration.sourceFileName = fileName;
    emptyMigration.description = `Manual migration ${fileName} (no structural diff actions detected — user-only logic)`;
    emptyMigration.isManual = true;
    emptyMigration.migrationKind = "MANUAL";
    emptyMigration.targetSchemaName = targetSchemaName;
    emptyMigration.targetEntityName = targetEntityName;
    return emptyMigration;
  }
  const migration = new Migration(null);
  migration.name = migrationName;
  migration.sourceFileName = fileName;
  migration.description = `Manual migration ${fileName} (${actions.length} diff action(s))`;
  migration.isManual = true;
  migration.migrationKind = "MANUAL_DIFF";
  migration.targetSchemaName = targetSchemaName;
  migration.targetEntityName = targetEntityName;
  for (const action of actions) migration.addAction(action);
  for (const action of rollBackActions) {
    migration.originalRollBackActions =
      migration.originalRollBackActions ?? [];
    migration.originalRollBackActions.push(action);
  }
  return migration;
}
// const projectRoot = getParent(getParent(getParent(getParent(import.meta.url).replace('file:\\',''))));
// export const datasourceRoot = getFile(projectRoot, "datasources");
// export function datasources =  initAllDatasources(datasourceRoot);
