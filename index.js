import { statSync, watch } from "node:fs";
import { basename, extname, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getFilesRecursively,
  getParent,
  getFileContent,
  getFile,
  getFileName,
  getRelativePathFrom,
} from "@ares/files";
import { loadDatasource, refreshDatasource } from "@ares/core/datasources.js";
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

function getFileVersion(filePath, fallbackValue = Date.now()) {
  try {
    return Math.trunc(statSync(filePath).mtimeMs);
  } catch {
    return fallbackValue;
  }
}

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

  return setRuntimeMetadata(datasourceObject, {
    datasourceFile: normalizedDatasourceFile,
    path: normalizePath(datasourceObject.path),
    watchedFiles: [...watchedFiles],
    queryExtensions,
    datasourcesRoot: options.datasourcesRoot
      ? normalizePath(options.datasourcesRoot)
      : undefined,
  });
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
// const projectRoot = getParent(getParent(getParent(getParent(import.meta.url).replace('file:\\',''))));
// export const datasourceRoot = getFile(projectRoot, "datasources");
// export function datasources =  initAllDatasources(datasourceRoot);
