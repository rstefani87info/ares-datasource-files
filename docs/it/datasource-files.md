# Documentazione @ares/datasource-files

## Scopo

Descrizione e obiettivi del modulo `@ares/datasource-files`.

## Installazione

```bash
yarn add @ares/datasource-files
```

In un monorepo Yarn Workspaces:

```bash
yarn workspace <app> add @ares/datasource-files
```

## Quickstart

Questo modulo fornisce integrazioni/driver per il runtime datasource del `core`.

Esempio tipico (concettuale) di uso di una connection class:

```js
import { aReSInitialize } from "@ares/core";
import { /* driver */ } from "@ares/datasource-files";

const aReS = aReSInitialize({ name: "my-app", environments: [{ selected: true, type: "development" }] });

// In un datasource aReS, la connection class viene istanziata dal runtime datasource in base alla configurazione.
```

## API pubbliche (exports)

Questa sezione documenta la superficie pubblica reale a livello di entrypoint e simboli principali.

Entrypoint root:

- `@ares/datasource-files`

File principali nel root del package (indicativi):

- `index.js`

Export individuati in `index.*`:

- `assembleDatasource`
- `datasourceRoot`
- `datasources`
- `initAllDatasources`
- `serializeDatasource`

## Configurazione (appSetup / config / policies)

Questo modulo viene tipicamente usato dentro un datasource aReS. Le chiavi effettive dipendono dalla definizione del datasource e dal runtime `@ares/core`.

Indicazioni pratiche:

- definire gli ambienti (`environments`) e selezionare production/development tramite `aReS.isProduction`
- centralizzare segreti in `config` o variabili d’ambiente (mai hard-coded)

## Test

Esecuzione test del modulo (se presenti):

```bash
yarn workspace @ares/datasource-files test
```

## Note

- Questo documento è mantenuto in parallelo ai ticket del modulo.
