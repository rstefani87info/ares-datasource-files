# @ares/datasource-files Documentation

## Purpose

Description and goals of the `@ares/datasource-files` module.

## Installation

```bash
yarn add @ares/datasource-files
```

In a Yarn Workspaces monorepo:

```bash
yarn workspace <app> add @ares/datasource-files
```

## Quickstart

This module provides integrations/drivers for the `core` datasource runtime.

Typical (conceptual) usage of a connection class:

```js
import { aReSInitialize } from "@ares/core";
import { /* driver */ } from "@ares/datasource-files";

const aReS = aReSInitialize({ name: "my-app", environments: [{ selected: true, type: "development" }] });

// In an aReS datasource, the connection class is usually instantiated by the datasource runtime based on config.
```

## Public API (exports)

This section documents the actual public surface at entrypoint level and main exported symbols.

Root entrypoint:

- `@ares/datasource-files`

Main files at package root (indicative):

- `index.js`

Exports detected in `index.*`:

- `assembleDatasource`
- `datasourceRoot`
- `datasources`
- `initAllDatasources`
- `serializeDatasource`

## Configuration (appSetup / config / policies)

This module is typically used inside an aReS datasource. Actual keys depend on the datasource definition and the `@ares/core` runtime.

Practical guidelines:

- define environments and select production/development via `aReS.isProduction`
- keep secrets in `config` or environment variables (never hard-coded)

## Test

Run module tests (if present):

```bash
yarn workspace @ares/datasource-files test
```

## Notes

- This document is maintained alongside the module tickets.
