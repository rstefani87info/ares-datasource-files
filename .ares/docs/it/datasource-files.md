# Documentazione @ares/datasource-files

## Scopo

`@ares/datasource-files` fornisce **integrazioni file-system** per il runtime `Datasource` di `@ares/core`: assemblaggio dei datasource da file (`datasource.js`, `current-schemas.json`), generazione di current-schema tramite reverse-engineering, orchestrazione migrationi (auto + manuali) con ledger SQL `ares_db_migrations` e serializzazione JSON sul filesystem.

È il modulo "collegamento" tra la definizione statica del datasource (JSON/JS su disco) e il runtime `Datasource` vivo, inclusa la gestione ripetibile delle installazioni schema.

## Installazione

```bash
yarn add @ares/datasource-files
```

In monorepo Yarn Workspaces:

```bash
yarn workspace <app> add @ares/datasource-files
```

## Quickstart

Caricare tutti i datasources presenti in una root, applicare le migrationi auto (CREATE_SCHEMA/CREATE_ENTITY/CREATE_COLUMN/CREATE_INDEX) e quelle manuali `.js`:

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

## Struttura tipica di un datasource

```
<datasource-root>/
  users/
    datasource.js       oppure index.js / ds.js
    current-schemas.json   (opzionale, generato via assembler se manca)
    migrations/
      <timestamp>-<nome_snake>.js   (migrationi manuali)
      <timestamp>-<nome_migrazione>.json   (serializzazione stato)
    queries/
      <path>/
        <nome-mapper>.js
        <nome-mapper>.json
```

## API pubbliche (exports)

Tutte esportate da `@ares/datasource-files` → [index.js](file:///c:/Users/rstef/workspace/rs/aReS/datasource-files/index.js).

### Assemblaggio

- **`assembleDatasource(datasourceFile, options)`** → costruisce un'istanza `Datasource` a partire da un file JS su disco.
  - Opzioni: `aReS`, `isProduction`, `generateCurrentSchemasIfMissing` (default `true`), `autoInstallSchema`.
  - Effetti collaterali: crea o ricarica `current-schemas.json`, registra `registerSchemaInstallerHook`, wire dei mapper/query JS+JSON.
- **`initAllDatasources(datasourcesRoot)`** → scansione ricorsiva di `**/datasource.js` e `assembleDatasource` su ogni match.
- **`enableDatasourceHotReload(aReS, datasourceList, options)`** → watch file per ambiente di sviluppo (richiede watcher FS attivo), trigger re-assemblaggio.
- **`serializeDatasource(datasource, opts)`** → serializza stato corrente (se implementata).

### Migrazioni — Ledger + Rollback

Il contratto operativo si basa su 3 funzioni principali:

- **`installDatasourceWithMigrations(datasource, datasourceDirectory, options)`** → orchestrazione completa.
  - Per ogni migration passata (o auto + manual di default):
    - Skip se il ledger la marca `DONE`.
    - **Pre-retry**: se `FAILED` → esegue `executeRollbackActionsSequentially(datasource, migration)` (leggendo `migration.rollBack` in ordine **reverse**) e poi transizione a `ROLLED_BACK`.
    - Esegue le azioni: tenta `startMigrationTransaction` + `executeMigrationActionsSequentially` + `commitMigrationTransaction`; su fallimento passa a `FAILED` con exception trace e poi esegue **nuovamente** `executeRollbackActionsSequentially`; se rollback ok → `ROLLED_BACK`.
    - In ogni caso scrive serializzazione JSON in `<datasourceDirectory>/migrations/<serializeTs>-<name>.json`.
  - Ledger: tabella `ares_db_migrations` (viene auto-creata per schema se non esiste tramite `ensureLedgerTableExists`).
  - Opzioni: `migrations?: Migration[]` (lista esplicita), `loadManualMigrations?: boolean` (default `true` — concatena quelle manuali se non passi esplicite).

- **`loadManualMigrations(datasourceDirectory, datasource, options)`** → scansione `<datasourceDirectory>/migrations/*.js` con pattern:
  ```
  ^[0-9]{14}-[A-Za-z0-9_-]+\.js$
  ```
  Per ogni file:
  1. `snapshotSchemas(datasource)` (pre-call).
  2. `import(file.js)`, chiama `default(datasource, options)`.
  3. `buildDiffMigrationFromSnapshots(datasource, preSnap, migrationName, fileName)` → genera una migration con azioni CREATE_* (CREATE_SCHEMA / CREATE_ENTITY / CREATE_COLUMN / CREATE_INDEX) più il corrispondente rollback DROP_* auto-generato.
  4. Se nessuna diff strutturale → migration vuota `MANUAL` (tracciata comunque nel ledger per future operazioni).
  Restituisce array di `Migration` pronte per essere passate a `installDatasourceWithMigrations`.

- **`runManualMigrations(datasourceDirectory, datasource, options)`** → shortcut `loadManualMigrations` + `installDatasourceWithMigrations`.

### File / Schema generazione

- `ensureCurrentSchemasFile`, `getCurrentSchemasFilePath`, `reverseEngineerCapabilities` — reverse engineering schema da DB vivo e scrittura JSON.
- Ledger SQL:
  - `ensureLedgerTableExists(datasource, schemaName)` — crea `ares_db_migrations` se non esiste, usando `buildStandardMigrationsEntityDescriptor(schemaName)` (12 colonne standard).
  - `insertMigrationRecord`, `selectMigrationRecord`, `updateMigrationRecord`, `listMigrationLedgerRecords` — CRUD sul ledger.
- Migration directory: `getOrCreateMigrationsDir(datasourceDirectory)` → `mkdir -p <dsDir>/migrations`.
- Serializzazione JSON: `serializeMigrationToFile(datasourceDirectory, migration, extras)` → `<dsDir>/migrations/<serializeTs>-<sanitizedName>.json` contenente azioni, rollback, status, eccezioni, datasource.

## Stato Migration e `rollBack`

### Constanti (da `@ares/core/datasources.js`)

- `MIGRATION_STATUS.PENDING` / `RUNNING` / `DONE` / `FAILED` / `ROLLED_BACK`.
- `MIGRATION_TYPES` include `CREATE_SCHEMA | CREATE_ENTITY | CREATE_COLUMN | ALTER_COLUMN | DROP_COLUMN | CREATE_INDEX | DROP_INDEX | ...`.
- `STANDARD_MIGRATIONS_ENTITY_NAME = "ares_db_migrations"`.

### Costruzione delle azioni DDL complementari (`migration.rollBack`)

Quando viene creato un `Migration.addAction(action)`, la classe `Migration` richiama `Migration.createRollbackAction(entityDefinition, action)` che produce l'azione inversa:

| Azione originale | Rollback auto-generato |
| --- | --- |
| `CREATE_ENTITY` | `DROP_ENTITY` |
| `CREATE_COLUMN` / `INSERT_COLUMN` | `DROP_COLUMN` |
| `ALTER_COLUMN` (con `previousProperty`) | `ALTER_COLUMN` inversa |
| `CREATE_INDEX` | `DROP_INDEX` |
| `DROP_ENTITY` / `DROP_COLUMN` / `DROP_INDEX` | `CREATE_*` inversa |
| `FILL_COLUMN` | `FILL_COLUMN` invertito (swap `property ↔ sourceProperty`) |
| `MOVE_COLUMN` / `ALTER_INDEX_DROP` | azione simmetrica |

Ordine di esecuzione: `executeRollbackActionsSequentially` processa `[...rollBack].reverse()`.

### Transazioni DB come strato aggiuntivo

- `@ares/core/datasource-runtime.js` espone `startMigrationTransaction`, `commitMigrationTransaction`, `rollbackMigrationTransaction`.
- Se il driver supporta `connection.startTransaction(name)` viene usato; altrimenti fallisce silenziosamente e l'esecuzione procede "transactionless".
- **NOTA BENE**: le transazioni **non sostituiscono** il rollback DDL esplicito perché molti DB (MySQL/MariaDB) eseguono commit implicito su ogni istruzione DDL (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`). Le transazioni rimangono utili per la parte DML di data-migration.

## Messaggi di log / i18n

- Il modulo usa `asyncConsole` da `@ares/core/console.js` (canale `datasources`) per tutti i messaggi diagnostici.
- Le CLI CLI di `@ares/core-dev` (che si appoggiano a queste API) usano invece i messaggi bilingui it/en più `@ares/os → getCurrentOSLanguage()`.

## Configurazione (appSetup / config / policies)

Questo modulo non legge direttamente `appSetup / config / policies`. Le chiavi operative sono invece nella definizione del datasource:

- `environments.<env>.<connName>.driver` (obbligatorio): driver classe/istanza (es. `@ares/datasource-mysql`).
- `schemas`: array di `SchemaDefinition` (oppure vengono idratati da `current-schemas.json` se presente).
- Driver capability flags: `reverseEngineer` usa `isUsableDatasourceDriver` → `getSchemasUsing/getEntitiesUsing/getPropertiesUsing/getIndexesUsing`.

Variabili d'ambiente:
- `ARES_DATASOURCES_ROOT` (convenzione tra moduli, letta da `@ares/core-dev` e spesso da app host).

## Test

```bash
# Modulo datasource-files (14 test circa):
node --test ./datasource-files/test

# Comprende migration-orchestrator.test.js:
#   - prima run: crea ledger + segna DONE + serializza JSON
#   - seconda run: skip DONE
#   - run fallimento: marca FAILED con exception_action_index
#   - run successivo: pre-retry DROP_* (rollBack actions) → ROLLED_BACK, poi riesecuzione → DONE
```

Correlati:
```bash
node --test ./core/test          # runtime datasource + Migration class
node --test ./datasource-mysql   # driver + lambda-sql
```

## Note

- **Idempotenza**: `CREATE_SCHEMA/CREATE_ENTITY/CREATE_COLUMN/CREATE_INDEX` — lato driver — devono essere no-op se l'oggetto esiste già (pattern `IF NOT EXISTS` o equivalente). Questo consente di rieseguire una migration `ROLLED_BACK` o `DONE` senza distruggere dati.
- **Migration MANUAL vuote**: sono utili per eseguire data-seeding arbitrario tramite la funzione utente senza produrre diff strutturali; esse sono comunque tracciate nel ledger e serializzate.
- **Convenzione naming migration manuali**: il nome è impostato a `<snake_name>-<timestamp>` per facilitare i filtri `--name` nella CLI `@ares/core-dev/migrate.js` (match: esatto / snake / strip timestamp).
