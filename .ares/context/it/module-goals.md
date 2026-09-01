# Obiettivi del modulo `@ares/datasource-files`

## Introduzione

`@ares/datasource-files` è il modulo di integrazione **file-system** per il runtime `Datasource` di `@ares/core`. Fa da "ponte" tra la definizione statica e dichiarativa di un datasource posizionata su disco (JSON/JS) e il runtime `Datasource` vivo, gestendo assemblaggio, reverse-engineering di schema e l'orchestrazione ripetibile delle migrazioni con un ledger SQL e serializzazione JSON.

## Obiettivi principali

- **Assemblare i datasource** partendo da file `datasource.js` presenti in una root, caricandoli come istanze `Datasource` reali del core.
- **Generare e idratare `current-schemas.json`**: reverse-engineering dello schema da un DB vivo e scrittura di una snapshot JSON riutilizzabile quando lo schema statico non è definito.
- **Orchestrare le migrazioni** (auto-generate + manuali `.js`) applicandole in modo **idempotente** e **tracciato**, con stato salvato nel ledger SQL `ares_db_migrations` e copie JSON su file.
- **Abilitare hot-reload** dei datasource in sviluppo (watch del filesystem e ri-assemblaggio automatico).
- **Collegare mapper/query** `*.js + *.json` ai datasource tramite convenzioni di naming.

## Responsabilità

- `assembleDatasource(datasourceFile, options)` → costruisce un'istanza `Datasource` a partire da un file JS su disco, incluse side-effect su `current-schemas.json` e wiring dei mapper/query.
- `initAllDatasources(datasourcesRoot)` → scansione ricorsiva di `**/datasource.js` ed assemblaggio di tutti i datasource trovati.
- `enableDatasourceHotReload(aReS, datasourceList, options)` → watch FS per ri-caricare i datasource quando cambiano.
- `generateCurrentSchemasFile` / `ensureCurrentSchemasFile` / `generateCurrentSchemasFilesFromRoot` → reverse engineering schema → file JSON.
- `installDatasourceWithMigrations` → orchestrazione completa di auto + manuali migrazioni con ledger e rollback.
- `loadManualMigrations` / `runManualMigrations` → lettura di migrazioni manuali `*.js` e generazione diff strutturale di azioni `CREATE_*`/`DROP_*`.
- `registerSchemaInstallerHook` → aggancio `_schemaInstaller` sul datasource per l'installazione automatica dello schema.
- `serializeMigrationToFile` / snapshot → serializzazione dello stato delle migrazioni su JSON.

## Cosa il modulo NON fa (esplicitamente)

- **Non** è un driver di connessione: non dialoga direttamente con i database. Ogni operazione DDL/DML è delegata ai driver concreti (`@ares/datasource-mysql`, ecc.) tramite il runtime `@ares/core` (`datasource-runtime.js`).
- **Non** definisce classi `Connection`: usa il runtime datasource e la classe `Migration` / `Datasource` già esistenti in `@ares/core`.
- **Non** fornisce una CLI di uso generale: espone una sola CLI di supporto (`ares-datasource-current-schemas`) limitata alla generazione dello snapshot schema.
- **Non** gestisce autenticazione/sessioni utente.
