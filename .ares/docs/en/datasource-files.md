# @ares/datasource-files Documentation

## Purpose

`@ares/datasource-files` provides **filesystem integrations** for the `Datasource` runtime from `@ares/core`: assembling datasources from on-disk files (`datasource.js`, `current-schemas.json`), generating current-schema snapshots via reverse engineering, orchestrating migrations (auto + manual) with an `ares_db_migrations` SQL ledger, and JSON serialization to disk.

It is the "bridge module" between the static datasource definition (JSON/JS on disk) and the live `Datasource` runtime — including repeatable schema installation workflows.

## Installation

```bash
yarn add @ares/datasource-files
```

In a Yarn Workspaces monorepo:

```bash
yarn workspace <app> add @ares/datasource-files
```

## Quickstart

Load every datasource under a root folder, then apply auto migrations (CREATE_SCHEMA/CREATE_ENTITY/CREATE_COLUMN/CREATE_INDEX) plus manual `.js` migrations:

```js
import aReSInitialize from "@ares/core";
import {
  initAllDatasources,
  loadManualMigrations,
  installDatasourceWithMigrations,
} from "@ares/datasource-files";

const aReS = aReSInitialize(
  { name: "my-app", config: {}, policies: {} },
  { isProduction: false, logEnabled: true },
);

const allDatasources = await initAllDatasources(resolve(process.cwd(), "datasources"));
for (const ds of allDatasources) {
  const dsDir = ds.path;
  const auto = ds.buildInstallMigrations?.() ?? [];
  const manual = await loadManualMigrations(dsDir, ds, {});
  await installDatasourceWithMigrations(ds, dsDir, {
    migrations: [...auto, ...manual],
    loadManualMigrations: false,
  });
}
```

## Typical datasource folder layout

```
<datasource-root>/
  users/
    datasource.js       or index.js / ds.js
    current-schemas.json   (optional, auto-created by the assembler)
    migrations/
      <timestamp>-<snake_name>.js     (manual migration sources)
      <serializeTs>-<migration_name>.json  (status serialization)
    queries/
      <path>/
        <mapper-name>.js
        <mapper-name>.json
```

## Public API (exports)

All exported by `@ares/datasource-files` → [index.js](file:///c:/Users/rstef/workspace/rs/aReS/datasource-files/index.js).

### Assembly

- **`assembleDatasource(datasourceFile, options)`** → instantiates a `Datasource` from a JS file on disk.
  - Options: `aReS`, `isProduction`, `generateCurrentSchemasIfMissing` (default `true`), `autoInstallSchema`.
  - Side effects: creates or reloads `current-schemas.json`, registers `registerSchemaInstallerHook`, wires JS+JSON query/mapper pairs.
- **`initAllDatasources(datasourcesRoot)`** → recursive scan for `**/datasource.js` and calls `assembleDatasource` on each match.
- **`enableDatasourceHotReload(aReS, datasourceList, options)`** → development file watcher (requires an active FS watcher), triggering re-assembly on changes.
- **`serializeDatasource(datasource, opts)`** → serialize current state (if implemented).

### Migrations — Ledger + Rollback

The operational contract is built around 3 main functions:

- **`installDatasourceWithMigrations(datasource, datasourceDirectory, options)`** → full orchestration.
  - For each migration (passed or auto+manual by default):
    - Skip if ledger marks it `DONE`.
    - **Pre-retry**: if `FAILED` → `executeRollbackActionsSequentially(datasource, migration)` (reads `migration.rollBack` in **reverse** order) and transitions to `ROLLED_BACK`.
    - Run actions: attempt `startMigrationTransaction` + `executeMigrationActionsSequentially` + `commitMigrationTransaction`; on failure mark `FAILED` with exception trace, then run **again** `executeRollbackActionsSequentially`; if rollback succeeds → `ROLLED_BACK`.
    - Always write a JSON serialization file to `<datasourceDirectory>/migrations/<serializeTs>-<name>.json`.
  - Ledger: `ares_db_migrations` table (auto-created per schema if missing via `ensureLedgerTableExists`).
  - Options: `migrations?: Migration[]` (explicit list), `loadManualMigrations?: boolean` (default `true` — concatenates manual ones when list is not explicit).

- **`loadManualMigrations(datasourceDirectory, datasource, options)`** → scans `<datasourceDirectory>/migrations/*.js` with pattern:
  ```
  ^[0-9]{14}-[A-Za-z0-9_-]+\.js$
  ```
  For each file:
  1. `snapshotSchemas(datasource)` (pre-call).
  2. `import(file.js)`, calls `default(datasource, options)`.
  3. `buildDiffMigrationFromSnapshots(datasource, preSnap, migrationName, fileName)` → produces a migration with CREATE_* actions (CREATE_SCHEMA / CREATE_ENTITY / CREATE_COLUMN / CREATE_INDEX) plus the corresponding auto-generated DROP_* rollback.
  4. If no structural diffs → an empty `MANUAL` migration (still tracked in the ledger for future operations / data seeding).
  Returns a `Migration[]` ready to be passed to `installDatasourceWithMigrations`.

- **`runManualMigrations(datasourceDirectory, datasource, options)`** → shortcut `loadManualMigrations` + `installDatasourceWithMigrations`.

### File / Schema generation

- `ensureCurrentSchemasFile`, `getCurrentSchemasFilePath`, `reverseEngineerCapabilities` — reverse-engineer schema from live DB and write snapshot JSON.
- SQL ledger:
  - `ensureLedgerTableExists(datasource, schemaName)` — creates `ares_db_migrations` if missing via `buildStandardMigrationsEntityDescriptor(schemaName)` (12 standard columns).
  - `insertMigrationRecord`, `selectMigrationRecord`, `updateMigrationRecord`, `listMigrationLedgerRecords` — ledger CRUD.
- Migration directory: `getOrCreateMigrationsDir(datasourceDirectory)` → `mkdir -p <dsDir>/migrations`.
- JSON serialization: `serializeMigrationToFile(datasourceDirectory, migration, extras)` → `<dsDir>/migrations/<serializeTs>-<sanitizedName>.json` with actions, rollback, status, exceptions, datasource.

## Migration status and `rollBack`

### Constants (from `@ares/core/datasources.js`)

- `MIGRATION_STATUS.PENDING` / `RUNNING` / `DONE` / `FAILED` / `ROLLED_BACK`.
- `MIGRATION_TYPES` includes `CREATE_SCHEMA | CREATE_ENTITY | CREATE_COLUMN | ALTER_COLUMN | DROP_COLUMN | CREATE_INDEX | DROP_INDEX | ...`.
- `STANDARD_MIGRATIONS_ENTITY_NAME = "ares_db_migrations"`.

### Complementary DDL actions generation (`migration.rollBack`)

When `Migration.addAction(action)` is called, the `Migration` class invokes `Migration.createRollbackAction(entityDefinition, action)` to produce the inverse action:

| Original action | Auto-generated rollback |
| --- | --- |
| `CREATE_ENTITY` | `DROP_ENTITY` |
| `CREATE_COLUMN` / `INSERT_COLUMN` | `DROP_COLUMN` |
| `ALTER_COLUMN` (with `previousProperty`) | inverse `ALTER_COLUMN` |
| `CREATE_INDEX` | `DROP_INDEX` |
| `DROP_ENTITY` / `DROP_COLUMN` / `DROP_INDEX` | inverse `CREATE_*` |
| `FILL_COLUMN` | inverse `FILL_COLUMN` (swap `property ↔ sourceProperty`) |
| `MOVE_COLUMN` / `ALTER_INDEX_DROP` | symmetrical action |

Execution order: `executeRollbackActionsSequentially` iterates `[...rollBack].reverse()`.

### DB transactions as an additional layer

- `@ares/core/datasource-runtime.js` exposes `startMigrationTransaction`, `commitMigrationTransaction`, `rollbackMigrationTransaction`.
- If the driver supports `connection.startTransaction(name)` it is used; otherwise it silently fails and execution continues "transactionless".
- **IMPORTANT**: transactions **do NOT replace** explicit DDL rollback, because many DBs (MySQL/MariaDB) perform an implicit commit on every DDL statement (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`). Transactions remain useful for data-migration DML.

## Logging / i18n

- This module uses `asyncConsole` from `@ares/core/console.js` (channel `datasources`) for all diagnostic messages.
- The companion CLIs in `@ares/core-dev` (which build on top of these APIs) use bilingual it/en messages plus `@ares/os → getCurrentOSLanguage()`.

## Configuration (appSetup / config / policies)

This module does NOT read `appSetup / config / policies` directly. Operational keys live in the datasource definition:

- `environments.<env>.<connName>.driver` (required): driver class/instance (e.g. `@ares/datasource-mysql`).
- `schemas`: array of `SchemaDefinition` (otherwise hydrated from `current-schemas.json` when present).
- Driver capability flags: reverse engineering checks `isUsableDatasourceDriver` → `getSchemasUsing/getEntitiesUsing/getPropertiesUsing/getIndexesUsing`.

Environment variables:
- `ARES_DATASOURCES_ROOT` (cross-module convention; read by `@ares/core-dev` and often by the host app).

## Testing

```bash
# datasource-files package (~14 tests):
node --test ./datasource-files/test

# Includes migration-orchestrator.test.js:
#   - run 1: create ledger + mark DONE + serialize JSON
#   - run 2: skip DONE
#   - failing run: mark FAILED with exception_action_index
#   - next run: pre-retry DROP_* (rollBack actions) → ROLLED_BACK, then re-run → DONE
```

Related suites:
```bash
node --test ./core/test          # datasource runtime + Migration class
node --test ./datasource-mysql   # MySQL driver + lambda-sql compiler
```

## Notes

- **Idempotency**: driver-side `CREATE_SCHEMA/CREATE_ENTITY/CREATE_COLUMN/CREATE_INDEX` MUST be no-ops when the target already exists (`IF NOT EXISTS` or equivalent). This lets you safely re-run a `ROLLED_BACK` or even a `DONE` migration without destroying data.
- **Empty MANUAL migrations**: useful to run arbitrary data-seeding user code without producing structural diffs; they are still ledger-tracked and serialized.
- **Manual migration naming convention**: the migration name is set to `<snake_name>-<timestamp>` to make `--name` filters in `@ares/core-dev/migrate.js` easier (match modes: exact / snake / timestamp-stripped).
