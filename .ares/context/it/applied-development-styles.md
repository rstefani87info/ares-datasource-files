# Stile di sviluppo applicato — `@ares/datasource-files`

## Standard di programmazione

- **JavaScript ESM** (`"type": "module"`), import statici in cima e import dinamici (`await import(...)`) per i file davvero volatili (es. le migrazioni manuali e i datasource caricati via URL con version tag).
- **Convenzioni del framework aReS**: si riusano i servizi del core (`aReS`, `asyncConsole` dal canale `datasources`, `loadDatasource`/`refreshDatasource` da `@ares/core/datasources.js`, `datasourceRuntime` da `@ares/core/datasource-runtime.js`) invece di reinventarli.
- **Helper file**: funzioni riusabili di file/tree da `@ares/files` (`getFilesRecursively`, `getParent`, `getFileContent`, `getFile`, `setJsonFileContentAsync`, ...).
- **Pattern di naming**: costanti SCREAMING_SNAKE (`CURRENT_SCHEMAS_FILE_NAME`, `CURRENT_SCHEMAS_TIMESTAMP_KEY`, `STANDARD_MIGRATIONS_ENTITY_NAME`), funzioni camelCase, costanti simboliche via `Symbol.for(...)` per lo stato runtime `__datasourceRuntime`.
- **Serializzazione**: si costruiscono descriptor "puliti" da oggetti runtime (funzioni e riferimenti circolari esclusi: `toSerializableValue`, `getSerializableEntries`) per produrre JSON sicuri.
- **Idempotenza** e **rollback**: contratto operativo su cui si costruisce tutto (skip se `DONE`, pre-retry se `FAILED`, rollback automatico).

## Contratto directory/file

Il repository del modulo non contiene build proibite; è interamente sorgente. Gli artefatti "generati" nascono però **fuori dal modulo**, nelle directory dei datasource consumer.

```
datasource-files/
├─ .ares/                # MANUALE  (contesto + docs obbligatorie; README del context)
├─ .git/                 # GENERATO (controllo versione locale)
├─ node_modules/         # GENERATO (yarn workspace, mai versionato)
├─ test/                 # MANUALE  (test di modulo con node --test)
├─ .gitignore            # MANUALE
├─ cli.js                # MANUALE  (bin ares-datasource-current-schemas)
├─ index.js              # MANUALE  (tutta la logica, exports pubblici)
├─ package.json          # MANUALE
└─ README.md             # MANUALE
```

**In un datasource consumer** (generato da questo modulo a runtime, NON nel repo di questo modulo):

```
<datasource-root>/
├─ datasource.js             # MANUALE (scritto dallo sviluppatore)
├─ current-schemas.json      # GENERATO (reverse engineering / assemblaggio)
├─ migrations/
│  ├─ <timestamp>-<nome>.js    # MANUALE (scritte dallo sviluppatore)
│  └─ <timestamp>-<nome>.json  # GENERATO (serializzazione stato migrazioni)
└─ queries/<path>/...         # MISTO (mapper .js MANUALI + query .json)
```

## MACRO-SUDDIVISIONE: GENERATO vs MANUALE

| Elemento | Categoria | Note |
|---|---|---|
| `index.js`, `cli.js`, `test/`, `package.json`, `README.md` | **MANUALE** | codice sorgente, mai rigenerato |
| `.ares/context/`, `.ares/docs/`, `.ares/tasks/` | **MANUALE** | documentazione di contesto, scritta a mano (i file `it/` qui creati non vanno sovrascritti) |
| `.git/`, `node_modules/` | **GENERATO** | mai versionato (vedi `.gitignore`) |
| `current-schemas.json` | **GENERATO** | prodotto dal reverse engineering; può essere rigenerato con la CLI |
| `migrations/*.json` | **GENERATO** | serializzazione dello stato delle migrazioni |
| `migrations/*.js` | **MANUALE** | acquistano significato solo se scritti dallo sviluppatore |

**Regola pratica**: tutto ciò che vive nel sorgente del modulo è manuale; tutto ciò che riempie la directory del datasource consumer durante l'esecuzione (snapshot schema, stato migrazioni, backup `current-schemas-<timestamp>.json`) è generato e quindi rigenerabile.
