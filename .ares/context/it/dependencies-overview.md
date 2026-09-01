# Dipendenze aReS — `@ares/datasource-files`

## Dipendenze runtime (da `package.json`)

| Modulo | Perché (uso reale) |
|---|---|
| `@ares/core` | È il cuore: fornisce `aReSInitialize`, il runtime datasource (`loadDatasource`, `refreshDatasource`), le classi `Datasource`/`SchemaDefinition`/`EntityDefinition`/`Migration`, le costanti `MIGRATION_STATUS`, `MIGRATION_TYPES`, `STANDARD_MIGRATIONS_ENTITY_NAME`, e `datasource-runtime.js` per `executeMigration` / `startMigrationTransaction` / `commitMigrationTransaction` / `rollbackMigrationTransaction`. Usato anche `console.js` → `asyncConsole` per la diagnostica (canale `datasources`). |
| `@ares/files` | Helper di file-system riutilizzati ovunque: `getFilesRecursively`, `getParent`, `getFileContent`, `getFile`, `getFileName`, `getRelativePathFrom`, `fileExists`, `setJsonFileContentAsync`. |
| `@ares/scd` | Toolchain di supporto del progetto (convenzione workspace); dichiarato come dipendenza del modulo (non usato direttamente nel codice di `index.js`/`cli.js`). |

## Chi dipende da questo modulo

Dai `package.json` del monorepo risultano dipendenze da `@ares/datasource-files`:

- `@ares/core-dev` (strumenti di sviluppo datasource/migrazione)
- `@ares/db-client` e `@ares/db-client-api` (workbench datasource, via `assembleDatasource`/snapshot)
- `@ares/dev-test-server` (caricamento del datasource `maintenance`)
- `@ares/ecosystem`, `@ares/language-interpreter`, `P4P/api` (app/assemblaggio dei datasource a runtime)

## Note

- Il modulo gira sui driver concreti (`@ares/datasource-mysql`, ecc.) ma **non li importa direttamente**: li risolve a runtime tramite l'istanza `Datasource` del core. Per questo non compaiono come dipendenze di `package.json`.
- `@ares/scd` non è importato nel sorgente del modulo: è una dipendenza di convenzione/tooling del workspace.
