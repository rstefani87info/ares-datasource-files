import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assembleDatasource,
  generateCurrentSchemasFile,
  generateCurrentSchemasFileFromDatasourceFile,
  ensureCurrentSchemasFile,
  buildCurrentSchemasDescriptor,
} from "../index.js";

const execFileAsync = promisify(execFile);

function buildMockDatasourceSource(datasourceName) {
  return `
export const name = ${JSON.stringify(datasourceName)};
export const environments = {
  test: {
    mysql_mock: {
      driver: {
        exists: async () => true,
        getSchemasUsing: async (_datasource, schemaName = null) =>
          [{ name: "public" }].filter((schemaDefinition) =>
            !schemaName || schemaDefinition.name === schemaName
          ),
        getEntitiesUsing: async (_datasource, schemaName, entityName = null) =>
          [
            { name: "roles", schemaName, entityType: "TABLE" },
            { name: "users", schemaName, entityType: "TABLE" },
          ].filter((entityDefinition) =>
            !entityName || entityDefinition.name === entityName
          ),
        getPropertiesUsing: async (_datasource, schemaName, entityName, columnName = null) =>
          ({
            roles: [
              {
                name: "id",
                schemaName,
                entityName,
                type: { name: "bigint", length: 20, unsigned: true },
                notNull: true,
                ordinalPosition: 1,
              },
            ],
            users: [
              {
                name: "id",
                schemaName,
                entityName,
                type: { name: "bigint", length: 20, unsigned: true },
                notNull: true,
                ordinalPosition: 1,
              },
              {
                name: "role_id",
                schemaName,
                entityName,
                type: { name: "bigint", length: 20, unsigned: true },
                notNull: true,
                ordinalPosition: 2,
              },
              {
                name: "status_label",
                schemaName,
                entityName,
                type: { name: "varchar", length: 32 },
                notNull: true,
                ordinalPosition: 3,
              },
            ],
          }[entityName] ?? []).filter((propertyDefinition) =>
            !columnName || propertyDefinition.name === columnName
          ),
        getIndexesUsing: async (_datasource, schemaName, entityName) => ({
          [schemaName]: {
            [entityName]: entityName === "users"
              ? {
                  fk_users_role: {
                    name: "fk_users_role",
                    type: "LINK",
                    schemaName,
                    entityName,
                    referenceSchemaName: schemaName,
                    referenceEntityName: "roles",
                    properties: [{ columnName: "role_id", ordinalPosition: 1 }],
                    references: [
                      {
                        columnName: "id",
                        schemaName,
                        entityName: "roles",
                        ordinalPosition: 1,
                      },
                    ],
                  },
                  chk_users_status: {
                    name: "chk_users_status",
                    type: "VALIDATOR",
                    schemaName,
                    entityName,
                    properties: [],
                    references: [],
                    expression: "status_label in ('active','disabled')",
                  },
                }
              : {
                  pk_roles: {
                    name: "pk_roles",
                    type: "PRIMARY_KEY",
                    schemaName,
                    entityName,
                    properties: [{ columnName: "id", ordinalPosition: 1 }],
                    references: [],
                  },
                },
          },
        }),
      },
    },
  },
};
`;
}

function buildUnsupportedDatasourceSource(datasourceName) {
  return `
export const name = ${JSON.stringify(datasourceName)};
export const environments = {
  test: {
    rest_mock: {
      driver: {
        exists: async () => true,
      },
    },
  },
};
`;
}

async function createMockDatasourceWorkspace() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ares-datasource-files-"));
  const datasourceDir = join(workspaceDir, "datasource");
  const datasourceFile = join(datasourceDir, "datasource.js");
  const datasourceName = `MockDatasource${Date.now()}`;

  await mkdir(datasourceDir, { recursive: true });
  await writeFile(
    datasourceFile,
    buildMockDatasourceSource(datasourceName),
    "utf-8"
  );

  return {
    workspaceDir,
    datasourceDir,
    datasourceFile,
    datasourceName,
    currentSchemasFile: join(datasourceDir, "current-schemas.json"),
  };
}

async function createUnsupportedDatasourceWorkspace() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ares-datasource-files-unsupported-"));
  const datasourceDir = join(workspaceDir, "datasource");
  const datasourceFile = join(datasourceDir, "datasource.js");
  const datasourceName = `UnsupportedDatasource${Date.now()}`;

  await mkdir(datasourceDir, { recursive: true });
  await writeFile(
    datasourceFile,
    buildUnsupportedDatasourceSource(datasourceName),
    "utf-8"
  );

  return {
    workspaceDir,
    datasourceDir,
    datasourceFile,
    datasourceName,
    currentSchemasFile: join(datasourceDir, "current-schemas.json"),
  };
}

async function readCurrentSchemas(filePath) {
  return JSON.parse(await readFile(filePath, "utf-8"));
}

test("assembleDatasource auto-generates current-schemas.json when missing", async () => {
  const { datasourceFile, currentSchemasFile, datasourceName } =
    await createMockDatasourceWorkspace();

  await assembleDatasource(datasourceFile);
  const descriptor = await readCurrentSchemas(currentSchemasFile);
  const users = descriptor.schemaDefinitions[0].entities.find(
    (entityDefinition) => entityDefinition.name === "users"
  );

  assert.equal(descriptor.datasource.name, datasourceName);
  assert.ok(users);
  assert.deepEqual(
    users.properties.map((propertyDefinition) => propertyDefinition.name),
    ["id", "role_id", "status_label"]
  );
  assert.equal(
    users.indexes.some((indexDefinition) => indexDefinition.type === "VALIDATOR"),
    true
  );
  assert.equal(
    users.indexes.some((indexDefinition) => indexDefinition.type === "LINK"),
    true
  );
});

test("generateCurrentSchemasFileFromDatasourceFile writes a reverse-engineered descriptor", async () => {
  const { datasourceFile, currentSchemasFile } = await createMockDatasourceWorkspace();

  const result = await generateCurrentSchemasFileFromDatasourceFile(datasourceFile, {
    force: true,
  });
  const descriptor = await readCurrentSchemas(currentSchemasFile);
  const users = descriptor.schemaDefinitions[0].entities.find(
    (entityDefinition) => entityDefinition.name === "users"
  );
  const link = users.indexes.find((indexDefinition) => indexDefinition.name === "fk_users_role");

  assert.equal(result.filePath, currentSchemasFile);
  assert.equal(descriptor.schemaDefinitions.length, 1);
  assert.equal(link.referenceEntityName, "roles");
  assert.deepEqual(link.references.map((reference) => reference.columnName), ["id"]);
});

test("CLI generates current-schemas.json for a datasource file", async () => {
  const { datasourceFile, currentSchemasFile } = await createMockDatasourceWorkspace();
  const cliFile = fileURLToPath(new URL("../cli.js", import.meta.url));

  const { stdout } = await execFileAsync(process.execPath, [cliFile, datasourceFile], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  const descriptor = await readCurrentSchemas(currentSchemasFile);

  assert.match(stdout, /current-schemas\.json/);
  assert.equal(descriptor.schemaDefinitions[0].name, "public");
});

test("assembleDatasource skips current-schemas.json auto-generation when reverse engineering is unsupported", async () => {
  const { datasourceFile, currentSchemasFile } = await createUnsupportedDatasourceWorkspace();

  const datasourceObject = await assembleDatasource(datasourceFile);
  const ensureResult = await ensureCurrentSchemasFile(datasourceObject);

  await assert.rejects(
    () => readFile(currentSchemasFile, "utf-8"),
    /ENOENT/
  );
  assert.equal(ensureResult.created, false);
  assert.equal(ensureResult.skipped, true);
  assert.equal(ensureResult.reason, "datasource_reverse_engineering_not_supported");
});

test("CLI fails clearly when reverse engineering is unsupported", async () => {
  const { datasourceFile, currentSchemasFile } = await createUnsupportedDatasourceWorkspace();
  const cliFile = fileURLToPath(new URL("../cli.js", import.meta.url));

  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [cliFile, datasourceFile], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      }),
    /datasource_reverse_engineering_not_supported/
  );
  await assert.rejects(
    () => readFile(currentSchemasFile, "utf-8"),
    /ENOENT/
  );
});

test("generated current-schemas descriptor includes a numeric timestamp constant", async () => {
  const fixedTimestamp = 1700000000000;
  const mockDatasource = {
    name: "ts-ds",
    path: tmpdir(),
    driver: {
      getSchemasUsing: async () => [],
      getEntitiesUsing: async () => [],
      getPropertiesUsing: async () => [],
      getIndexesUsing: async () => ({}),
    },
    getSchemaDefinitions: () => [],
  };
  const descriptor = buildCurrentSchemasDescriptor(mockDatasource, {
    timestamp: fixedTimestamp,
  });

  assert.equal(typeof descriptor.timestamp, "number");
  assert.equal(descriptor.timestamp, fixedTimestamp);

  const autoDescriptor = buildCurrentSchemasDescriptor(mockDatasource);
  assert.equal(typeof autoDescriptor.timestamp, "number");
  assert.ok(autoDescriptor.timestamp > 0);
  assert.ok(Number.isFinite(autoDescriptor.timestamp));
});

test("re-generating current-schemas backs up existing file using its timestamp in filename", async () => {
  const { datasourceFile, datasourceDir, currentSchemasFile } =
    await createMockDatasourceWorkspace();

  const firstResult = await generateCurrentSchemasFileFromDatasourceFile(
    datasourceFile,
    { force: true },
  );
  const firstDescriptor = await readCurrentSchemas(currentSchemasFile);
  assert.equal(typeof firstDescriptor.timestamp, "number");
  assert.equal(firstResult.backupFilePath, null);
  const firstTimestamp = firstDescriptor.timestamp;

  const beforeRegen = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondResult = await generateCurrentSchemasFileFromDatasourceFile(
    datasourceFile,
    { force: true },
  );
  const afterRegen = Date.now();

  const secondDescriptor = await readCurrentSchemas(currentSchemasFile);
  assert.equal(typeof secondDescriptor.timestamp, "number");
  assert.ok(
    secondDescriptor.timestamp >= firstTimestamp,
    "new timestamp must be >= previous one"
  );

  assert.equal(typeof secondResult.backupFilePath, "string");
  assert.notEqual(secondResult.backupFilePath, null);
  const backupContent = await readCurrentSchemas(secondResult.backupFilePath);
  assert.equal(backupContent.timestamp, firstTimestamp);

  const backupBase = basename(secondResult.backupFilePath);
  assert.match(backupBase, /current-schemas-/);
  assert.match(backupBase, new RegExp(String(firstTimestamp)));
  assert.match(backupBase, /\.json$/);
});

test("regenerating current-schemas uses mtime as fallback timestamp for legacy files with no timestamp field", async () => {
  const { datasourceFile, datasourceDir, currentSchemasFile } =
    await createMockDatasourceWorkspace();

  const legacyDescriptor = {
    datasource: { name: "legacy" },
    schemaDefinitions: [],
  };
  await writeFile(
    currentSchemasFile,
    JSON.stringify(legacyDescriptor, null, 2),
    "utf-8",
  );
  const { stat } = await import("node:fs/promises");
  const { mtimeMs } = await stat(currentSchemasFile);
  const legacyMtime = Math.trunc(mtimeMs);

  const regenResult = await generateCurrentSchemasFileFromDatasourceFile(
    datasourceFile,
    { force: true, skipBackup: false },
  );

  assert.equal(typeof regenResult.backupFilePath, "string");
  const backupBase = basename(regenResult.backupFilePath);
  assert.match(backupBase, /current-schemas-/);
  assert.match(backupBase, new RegExp(String(legacyMtime)));
});

function buildCustomMockDatasourceSource(datasourceName, schemasExportSnippet) {
  const baseDriverSource = `
export const name = ${JSON.stringify(datasourceName)};
${schemasExportSnippet}
export const environments = {
  test: {
    mysql_mock: {
      driver: {
        exists: async () => true,
        getSchemasUsing: async (_datasource, schemaName = null) =>
          [{ name: "public" }].filter((schemaDefinition) =>
            !schemaName || schemaDefinition.name === schemaName
          ),
        getEntitiesUsing: async (_datasource, schemaName, entityName = null) =>
          [
            { name: "roles", schemaName, entityType: "TABLE" },
            { name: "users", schemaName, entityType: "TABLE" },
          ].filter((entityDefinition) =>
            !entityName || entityDefinition.name === entityName
          ),
        getPropertiesUsing: async (_datasource, schemaName, entityName, columnName = null) =>
          ({
            roles: [
              {
                name: "id",
                schemaName,
                entityName,
                type: { name: "bigint", length: 20, unsigned: true },
                notNull: true,
                ordinalPosition: 1,
              },
            ],
            users: [
              {
                name: "id",
                schemaName,
                entityName,
                type: { name: "bigint", length: 20, unsigned: true },
                notNull: true,
                ordinalPosition: 1,
              },
              {
                name: "role_id",
                schemaName,
                entityName,
                type: { name: "bigint", length: 20, unsigned: true },
                notNull: true,
                ordinalPosition: 2,
              },
            ],
          }[entityName] ?? []).filter((propertyDefinition) =>
            !columnName || propertyDefinition.name === columnName
          ),
        getIndexesUsing: async () => ({}),
      },
      multipleStatements: true,
      queryExtensions: ["sql"],
    },
  },
};
`.trim();
  return baseDriverSource;
}

async function createCustomDatasourceWorkspaceWithSchemasFile(schemasExportSnippet) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ares-datasource-files-hydration-"));
  const datasourceDir = join(workspaceDir, "datasource");
  const datasourceFile = join(datasourceDir, "datasource.js");
  const datasourceName = `HydratedDatasource${Date.now()}`;
  const currentSchemasFile = join(datasourceDir, "current-schemas.json");

  await mkdir(datasourceDir, { recursive: true });
  await writeFile(
    datasourceFile,
    buildCustomMockDatasourceSource(datasourceName, schemasExportSnippet),
    "utf-8",
  );

  // Pre-populate a deterministic current-schemas.json (NOT coming from reverse engineering)
  const schemasPayload = [
    {
      name: "hydrated_schema",
      entities: [
        {
          name: "alpha",
          schemaName: "hydrated_schema",
          entityType: "TABLE",
          properties: [
            {
              name: "id",
              _type: { name: "bigint", unsigned: true, length: 19 },
              notNull: true,
              primaryKey: true,
              autoIncrement: true,
              ordinalPosition: 1,
            },
            {
              name: "label",
              _type: { name: "varchar", length: 64 },
              notNull: true,
              ordinalPosition: 2,
            },
          ],
          indexes: [
            {
              type: "PRIMARY_KEY",
              name: "primary",
              properties: [{ columnName: "id", ordinalPosition: 1 }],
            },
          ],
        },
      ],
    },
  ];
  await writeFile(
    currentSchemasFile,
    JSON.stringify(
      {
        timestamp: Date.now(),
        datasource: { name: datasourceName, path: datasourceDir },
        schemaDefinitions: schemasPayload,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    workspaceDir,
    datasourceDir,
    datasourceFile,
    datasourceName,
    currentSchemasFile,
    expectedSchemas: schemasPayload,
  };
}

test("assembleDatasource hydrates schemas from current-schemas.json when schemas export is undefined (not declared)", async () => {
  const { datasourceFile, datasourceName, expectedSchemas } =
    await createCustomDatasourceWorkspaceWithSchemasFile("");

  const assembled = await assembleDatasource(datasourceFile, {
    isProduction: true,
    generateCurrentSchemasIfMissing: false,
  });

  assert.equal(assembled.name, datasourceName);
  assert.ok(Array.isArray(assembled.schemas), "schemas must be an array after hydration");
  assert.equal(assembled.schemas.length, expectedSchemas.length);
  const schema = assembled.schemas[0];
  assert.equal(schema.name, "hydrated_schema");
  const entities = schema.entities ?? schema.getEntities?.() ?? [];
  const entity = Array.isArray(entities)
    ? entities.find((e) => e.name === "alpha")
    : null;
  assert.ok(entity, "entity alpha must exist (schemas were hydrated from file)");
});

test("assembleDatasource hydrates schemas from current-schemas.json when schemas export is explicit falsy (false)", async () => {
  const { datasourceFile, datasourceName, expectedSchemas } =
    await createCustomDatasourceWorkspaceWithSchemasFile(
      "export const schemas = false;\n",
    );

  const assembled = await assembleDatasource(datasourceFile, {
    isProduction: true,
    generateCurrentSchemasIfMissing: false,
  });

  assert.equal(assembled.name, datasourceName);
  assert.ok(Array.isArray(assembled.schemas));
  assert.equal(assembled.schemas.length, expectedSchemas.length);
  assert.equal(assembled.schemas[0].name, "hydrated_schema");
});

test("assembleDatasource preserves explicit schemas array even when current-schemas.json exists", async () => {
  const explicitSchema = {
    name: "custom_schema",
    entities: [
      {
        name: "custom_entity",
        schemaName: "custom_schema",
        entityType: "TABLE",
        properties: [],
        indexes: [],
      },
    ],
  };
  const exportSnippet =
    "export const schemas = " +
    JSON.stringify([explicitSchema], null, 2) +
    ";\n";
  const { datasourceFile, datasourceName } =
    await createCustomDatasourceWorkspaceWithSchemasFile(exportSnippet);

  const assembled = await assembleDatasource(datasourceFile, {
    isProduction: true,
    generateCurrentSchemasIfMissing: false,
  });

  assert.equal(assembled.name, datasourceName);
  assert.ok(Array.isArray(assembled.schemas));
  assert.equal(assembled.schemas.length, 1);
  assert.equal(
    assembled.schemas[0].name,
    "custom_schema",
    "explicit schemas export must NOT be overwritten by current-schemas.json",
  );
  const entities = assembled.schemas[0].entities ?? [];
  assert.ok(entities.some((e) => e.name === "custom_entity"));
  assert.equal(
    entities.some((e) => e.name === "alpha"),
    false,
    "the alpha entity from current-schemas.json must NOT leak in (explicit export preserved)",
  );
});
