# Panoramica CLI — `@ares/datasource-files`

Il modulo espone **una sola CLI di supporto** per la generazione dello snapshot schema; la logica principale (migrazioni, assemblaggio, hot-reload) è usata come libreria, non come CLI.

## Bin entrypoint

| Bin | File | Scopo |
|---|---|---|
| `ares-datasource-current-schemas` | `cli.js` | Genera/aggiorna i file `current-schemas.json` |

## Comandi

### `ares-datasource-current-schemas <datasource.js|datasources-root> [--missing-only]`

Genera lo snapshot `current-schemas.json` di un datasource.

- **Argomento posizionale**: percorso di un singolo file `datasource.js` oppure di una cartella root contenente molti `datasource.js` (scansione ricorsiva).
- `--missing-only` / `--help` / `-h`: con `--missing-only` genera **solo** i file mancanti (senza forzare la rigenerazione); `--help` stampa l'uso.
- Senza flag → forza la rigenerazione di tutti i file trovati.
- Output: stampa i percorsi dei file generati.

Esempi:

```bash
ares-datasource-current-schemas ./datasources/app/datasource.js
ares-datasource-current-schemas ./datasources --missing-only
```

## Script npm

| Script | Comando eseguito |
|---|---|
| `test` | `node --test ./test/current-schemas.test.js ./test/privacy-maintenance-install.test.js` |
| `ares-datasource-current-schemas` | `ares-datasource-current-schemas` |

## Note

- Non esiste alcuna CLI per migrazioni: l'esecuzione delle migrazioni è orchestrata via API (`installDatasourceWithMigrations` / `runManualMigrations`) e, a livello di progetto, è esposta dalle CLI di `@ares/core-dev` (es. `migrate.js`) che si appoggiano a queste funzioni.
- Il modulo non ha subcomandi aggiuntivi: l'unico entrypoint CLI è quello sopra.
