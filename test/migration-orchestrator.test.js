import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  assembleDatasource,
  installDatasourceWithMigrations,
  registerSchemaInstallerHook,
} from "../index.js";
import {
  Datasource,
  MIGRATION_STATUS,
  STANDARD_MIGRATIONS_ENTITY_NAME,
} from "@ares/core/datasources.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..", "..");
const ECOSYSTEM_DIR = join(rootDir, "ecosystem");

function buildRecordingDriver(ops, options = {}) {
  const {
    failOnMigrationIndex,
    failOnInstallAfter = Infinity,
    ledger,
  } = options;
  class RecordingDriver {
    constructor(connectionParameters, datasource, sessionId, connectionSettingName) {
      this.connectionParameters = connectionParameters;
      this.datasource = datasource;
      this.sessionId = sessionId;
      this.connectionSettingName = connectionSettingName;
      this.pendingTransactions = new Map();
    }
    startTransaction(name) {
      ops.push({ kind: "startTransaction", name, sessionId: this.sessionId });
      this.pendingTransactions.set(name, true);
    }
    commit(name) {
      ops.push({ kind: "commitTransaction", name, sessionId: this.sessionId });
      this.pendingTransactions.delete(name);
    }
    rollback(name) {
      ops.push({ kind: "rollbackTransaction", name, sessionId: this.sessionId });
      this.pendingTransactions.delete(name);
    }
    async exists(datasource, schemaName, entityName) {
      ops.push({ kind: "exists", schemaName, entityName: entityName ?? null });
      if (!entityName) {
        return options.schemaExists?.(schemaName) ?? true;
      }
      if (entityName === STANDARD_MIGRATIONS_ENTITY_NAME) {
        return !!options.ledgerTableCreated?.[schemaName];
      }
      return options.entityExists?.(schemaName, entityName) ?? false;
    }
    createSchema(schemaDefinition) {
      ops.push({ kind: "createSchema", schemaName: schemaDefinition.name });
      return { installed: true };
    }
    createEntity(entityDefinition, opts = {}) {
      const schemaName = entityDefinition.schemaName ??
        entityDefinition.schemaDefinition?.name;
      const entityName = entityDefinition.name;
      ops.push({
        kind: "createEntity",
        schemaName,
        entityName,
        minimal: opts.minimal === true,
      });
      if (entityName === STANDARD_MIGRATIONS_ENTITY_NAME) {
        options.ledgerTableCreated = options.ledgerTableCreated ?? {};
        options.ledgerTableCreated[schemaName] = true;
      }
      return { installed: true };
    }
    async getSchemasUsing() { return []; }
    async getEntitiesUsing() { return []; }
    async getPropertiesUsing() { return []; }
    async getIndexesUsing() { return {}; }
    async executeMigration(...migrations) {
      const results = [];
      for (const migration of migrations.filter(Boolean)) {
        const directStatements = Array.isArray(migration.actions)
          ? migration.actions.filter(Boolean)
          : [];
        const statements = directStatements.length > 0
          ? directStatements
          : [migration];
        for (const statement of statements) {
          const isRawSql =
            typeof statement === "string" || statement instanceof String ||
            (typeof statement === "object" && statement !== null && typeof statement.valueOf === "function" && typeof statement.valueOf() === "string");
          if (isRawSql) {
            const normalized = String(statement).trim();
            const rawObj =
              (statement && typeof statement === "object") ? statement : null;
            const schemaHint = rawObj?._schema ?? null;
            ops.push({ kind: "sql", sql: normalized });
            if (normalized.toUpperCase().startsWith("SELECT")) {
              const ledgerStore = ledger[schemaHint ?? "__default"] ?? {};
              const rows = handleSelectLedger(normalized, ledgerStore);
              results.push([{ results: rows.results }]);
              continue;
            }
            if (normalized.toUpperCase().startsWith("INSERT")) {
              handleInsertLedger(normalized, ledger, schemaHint);
              results.push([{ results: { affectedRows: 1 } }]);
              continue;
            }
            if (normalized.toUpperCase().startsWith("UPDATE")) {
              handleUpdateLedger(normalized, ledger, schemaHint);
              results.push([{ results: { affectedRows: 1 } }]);
              continue;
            }
            results.push([{ results: {}, query: statement }]);
            continue;
          }
          if (statement && typeof statement === "object" && typeof statement.type === "string") {
            const type = statement.type;
            const schemaName = statement.schemaName ?? null;
            const entityName = statement.entityName ?? null;
            const indexName = statement.indexDefinition?.name ?? null;
            const actionCount = ops.filter((x) => x.kind === "executeAction").length;
            if (actionCount >= failOnInstallAfter) {
              const err = new Error(
                `Simulated failure at install step ${actionCount} >= ${failOnInstallAfter} (${type} ${schemaName ?? ""} ${entityName ?? ""} ${indexName ?? ""})`,
              );
              throw err;
            }
            ops.push({
              kind: "executeAction",
              type,
              schemaName,
              entityName,
              indexName,
            });
            results.push([{ installed: true, type, schemaName, entityName, indexName }]);
            continue;
          }
          results.push([{ results: statement ?? {} }]);
        }
      }
      return results;
    }
    prepareMigrationActionStatement(a) { return a; }
  }
  return RecordingDriver;
}

function handleSelectLedger(sql, ledgerStore) {
  const rows = Object.values(ledgerStore ?? {});
  const whereName = /WHERE\s+`name`\s*=\s*'([^']+)'/i.exec(sql);
  const simpleWhere = /WHERE\s+name\s*=\s*'([^']+)'/i.exec(sql);
  const targetName = whereName?.[1] ?? simpleWhere?.[1];
  if (targetName) {
    const byName = rows.filter((r) => r.name === targetName);
    return { results: byName };
  }
  return { results: rows };
}

function handleInsertLedger(sql, ledger, schemaHint) {
  const cols = sql.match(/\(([^)]+)\)\s*VALUES/i);
  const vals = sql.match(/VALUES\s*\(([^)]*)\)\s*;?\s*$/i);
  if (!cols || !vals) return;
  const colNames = [...cols[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const rawVals = splitValues(vals[1]);
  const rec = {};
  colNames.forEach((c, i) => {
    rec[c] = parseSqlLiteral(rawVals[i]);
  });
  const schema =
    schemaHint ??
    extractSchemaFromQualifiedTable(sql);
  if (!schema) return;
  ledger[schema] = ledger[schema] ?? {};
  ledger[schema][rec.name] = rec;
}

function handleUpdateLedger(sql, ledger, schemaHint) {
  const schema =
    schemaHint ??
    extractSchemaFromQualifiedTable(sql);
  if (!schema) return;
  const setClause = /SET\s+(.+?)\s+WHERE\s+`name`\s*=\s*'([^']+)'/is.exec(sql);
  if (!setClause) return;
  const [, assignments, name] = setClause;
  ledger[schema] = ledger[schema] ?? {};
  const existing = ledger[schema][name] ?? { name };
  const assigns = assignments.split(/\s*,\s*/);
  for (const a of assigns) {
    const mm = /^`([^`]+)`\s*=\s*(.+?)\s*$/s.exec(a.trim());
    if (!mm) continue;
    existing[mm[1]] = parseSqlLiteral(mm[2].trim());
  }
  ledger[schema][name] = existing;
}

function extractSchemaFromQualifiedTable(sql) {
  const m = /(?:INTO|UPDATE|FROM)\s+`([^`]+)`\.`ares_db_migrations`/i.exec(sql);
  if (m) return m[1];
  return null;
}

function splitValues(raw) {
  const out = [];
  let cur = "";
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inStr && (ch === "'" || ch === '"')) {
      inStr = true;
      strChar = ch;
      cur += ch;
      continue;
    }
    if (inStr && ch === strChar) {
      if (raw[i + 1] === strChar) {
        cur += strChar + strChar;
        i++;
        continue;
      }
      inStr = false;
      cur += ch;
      continue;
    }
    if (!inStr && ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseSqlLiteral(token) {
  if (token === "NULL" || token === "null") return null;
  if (token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(token)) return Number(token);
  return token;
}

test("buildInstallMigrations + installDatasourceWithMigrations: first run creates ledger, marks DONE, writes JSON files; second run skips DONE; on failure marks FAILED with actionIndex, next run auto-rollback to ROLLED_BACK", async () => {
  const privacyDsFile = join(
    ECOSYSTEM_DIR,
    "datasources",
    "privacy",
    "datasource.js",
  );
  const assembled = await assembleDatasource(privacyDsFile, {
    isProduction: false,
    generateCurrentSchemasIfMissing: false,
  });
  const tmpRoot = await mkdtemp(join(tmpdir(), "ares-migs-"));
  const dsDir = join(tmpRoot, assembled.name);
  await mkdir(dsDir, { recursive: true });
  assembled.path = dsDir;
  const ledger = {};
  const schemaExistsMap = { ares_privacy: true };
  const ledgerTableCreated = {};
  const options1 = {
    schemaExists: (s) => schemaExistsMap[s] ?? true,
    ledger,
    ledgerTableCreated,
  };
  const ops1 = [];
  const Driver1 = buildRecordingDriver(ops1, options1);
  const testEnv = {
    test: {
      main: {
        driver: Driver1,
        host: "localhost",
        port: 3306,
        database: "ares_privacy",
      },
    },
  };
  const datasourceSettings = { ...assembled, environments: testEnv };
  const aReSStub = {
    isProduction: false,
    getConfig: () => null,
    getPolicy: () => null,
  };
  const ds1 = new Datasource(aReSStub, datasourceSettings);
  ds1.path = dsDir;
  await ds1.loadQueries();
  const allMigrations = ds1.buildInstallMigrations();
  assert.ok(
    allMigrations.length > 0,
    "buildInstallMigrations must return non-empty list for privacy schema",
  );
  const schemaMigs = allMigrations.filter((m) => m.migrationKind === "CREATE_SCHEMA");
  const entityMigs = allMigrations.filter((m) => m.migrationKind === "CREATE_ENTITY");
  const idxMigs = allMigrations.filter((m) => m.migrationKind === "CREATE_INDEX");
  assert.ok(schemaMigs.length >= 1, "at least one CREATE_SCHEMA migration");
  assert.ok(entityMigs.some((m) => m.targetEntityName === "users"), "users CREATE_ENTITY present");
  assert.ok(entityMigs.some((m) => m.targetEntityName === STANDARD_MIGRATIONS_ENTITY_NAME), "ares_db_migrations CREATE_ENTITY present (standard ledger)");
  for (const m of allMigrations) {
    assert.ok(
      Array.isArray(m.rollBack),
      `migration ${m.name} must have rollBack array (order of creation)`,
    );
    assert.equal(
      m.rollBack.length,
      m.actionsRaw.length,
      `migration ${m.name} has 1 rollback per forward action`,
    );
  }

  const results = await installDatasourceWithMigrations(ds1, dsDir);
  assert.ok(Array.isArray(results), "install must return array");
  const allDone = results.every((r) => r.status === MIGRATION_STATUS.DONE);
  assert.ok(allDone, "first install: all migrations must be DONE");
  const ledgerEntries = Object.values(ledger.ares_privacy ?? {});
  assert.ok(
    ledgerEntries.length >= allMigrations.length,
    `ledger ares_privacy must have ${allMigrations.length}+ records, got ${ledgerEntries.length}`,
  );
  const doneCount = ledgerEntries.filter((r) => r.status === MIGRATION_STATUS.DONE).length;
  assert.equal(doneCount, allMigrations.length, "all records DONE");

  const files = await readdir(join(dsDir, "migrations"));
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  assert.ok(
    jsonFiles.length >= allMigrations.length,
    `migrations/ must contain ${allMigrations.length}+ JSON files (got ${jsonFiles.length})`,
  );
  for (const fileName of jsonFiles) {
    assert.ok(
      /^\d{14}-/.test(fileName),
      `filename ${fileName} must start with YYYYMMDDHHMMSS timestamp prefix`,
    );
    const content = JSON.parse(await readFile(join(dsDir, "migrations", fileName), "utf8"));
    assert.equal(content.status, MIGRATION_STATUS.DONE, `${fileName} status must be DONE`);
    assert.ok(Array.isArray(content.actions), `${fileName} must have actions array`);
    assert.ok(Array.isArray(content.rollBack), `${fileName} must have rollBack array`);
  }

  const ops2 = [];
  const Driver2 = buildRecordingDriver(ops2, {
    schemaExists: (s) => schemaExistsMap[s] ?? true,
    ledger,
    ledgerTableCreated: { ares_privacy: true },
  });
  const datasourceSettings2 = { ...assembled, environments: {
    test: { main: { driver: Driver2, host: "localhost", database: "ares_privacy" } },
  } };
  const ds2 = new Datasource(aReSStub, datasourceSettings2);
  ds2.path = dsDir;
  await ds2.loadQueries();
  const results2 = await installDatasourceWithMigrations(ds2, dsDir);
  const details = results2.slice(0, 5).map((r) => ({
    migrationName: r.migrationName,
    status: r.status,
    skipped: r.skipped,
    alreadyDone: r.alreadyDone,
    err: r.error?.message?.slice?.(0, 80) ?? null,
    ledgerStatus: ledger.ares_privacy?.[r.migrationName]?.status ?? null,
  }));
  const ops2selects = ops2.filter((o) => o.kind === "sql" && o.sql.toUpperCase().startsWith("SELECT")).map((o) => o.sql.slice(0, 250)).slice(0, 5);
  const sampleSel = ops2selects[0] ?? "";
  const ledgerSample = ledger.ares_privacy?.["privacy-CREATE_SCHEMA-ares_privacy"] ?? null;
  const parseTestWhere = /WHERE\s+`name`\s*=\s*'([^']+)'/i.exec(sampleSel)?.[1];
  const parseTestFilter = ledgerSample?.name === parseTestWhere;
  assert.ok(
    results2.every((r) => r.skipped === true && r.status === MIGRATION_STATUS.DONE),
    "second install: all migrations SKIPPED because already DONE in ledger. details=" +
      JSON.stringify({
        details,
        ledgerKeys: Object.keys(ledger.ares_privacy ?? {}).slice(0, 5),
        ops2selects,
        parseTestWhere,
        parseTestFilter,
        ledgerSampleName: ledgerSample?.name ?? null,
        ledgerSampleStatus: ledgerSample?.status ?? null,
      }, null, 2),
  );

  const ledger3 = {};
  for (const k of Object.keys(ledger)) ledger3[k] = { ...ledger[k] };
  Object.keys(ledger3.ares_privacy ?? {}).forEach((k) => {
    delete ledger3.ares_privacy[k];
  });
  const ops3 = [];
  const Driver3 = buildRecordingDriver(ops3, {
    schemaExists: (s) => schemaExistsMap[s] ?? true,
    ledger: ledger3,
    ledgerTableCreated: { ares_privacy: true },
    failOnInstallAfter: 0,
  });
  const datasourceSettings3 = { ...assembled, environments: {
    test: { main: { driver: Driver3, host: "localhost", database: "ares_privacy" } },
  } };
  const ds3 = new Datasource(aReSStub, datasourceSettings3);
  ds3.path = dsDir;
  await ds3.loadQueries();
  const results3 = await installDatasourceWithMigrations(ds3, dsDir);
  const failedOne = results3.find((r) =>
    r.status === MIGRATION_STATUS.FAILED || r.status === MIGRATION_STATUS.ROLLED_BACK,
  );
  const ops3Counts = {
    total: ops3.length,
    kinds: ops3.reduce((acc, o) => { acc[o.kind] = (acc[o.kind] ?? 0) + 1; return acc; }, {}),
    actionsSlice: ops3.filter(o => o.kind !== 'sql').slice(0, 10),
  };
  const mig3Summary = results3.slice(0,6).map(r => ({ name: r.migrationName, status: r.status, skip: r.skipped, err: r.error?.message?.slice?.(0, 60) }));
  assert.ok(failedOne, "at least one migration FAILED or ROLLED_BACK after injected failure. ops3Counts=" + JSON.stringify(ops3Counts, null, 2) + " migSummary=" + JSON.stringify(mig3Summary, null, 2));
  const failedRecord = Object.values(ledger3.ares_privacy ?? {}).find(
    (r) => r.status === MIGRATION_STATUS.FAILED || r.status === MIGRATION_STATUS.ROLLED_BACK,
  );
  assert.ok(failedRecord, "ledger contains failed/rolled_back record");
  if (failedRecord.status === MIGRATION_STATUS.FAILED) {
    assert.ok(
      Number.isInteger(failedRecord.exception_action_index),
      `FAILED state: exception_action_index must be integer, got ${JSON.stringify(failedRecord.exception_action_index)} on record with status=${failedRecord.status}, name=${failedRecord.name}. Full record: ${JSON.stringify(failedRecord)}`,
    );
  }
  const hadExceptionAfterDs3 = Object.values(ledger3.ares_privacy ?? {}).some(
    (r) => Number.isInteger(r.exception_action_index),
  );
  assert.ok(hadExceptionAfterDs3, "after FAILED run, at least 1 migration should have exception_action_index stored in ledger (before next run clears it)");

  const ops4 = [];
  const Driver4 = buildRecordingDriver(ops4, {
    schemaExists: (s) => schemaExistsMap[s] ?? true,
    ledger: ledger3,
    ledgerTableCreated: { ares_privacy: true },
  });
  const datasourceSettings4 = { ...assembled, environments: {
    test: { main: { driver: Driver4, host: "localhost", database: "ares_privacy" } },
  } };
  const ds4 = new Datasource(aReSStub, datasourceSettings4);
  ds4.path = dsDir;
  await ds4.loadQueries();
  await installDatasourceWithMigrations(ds4, dsDir);
  const afterRerun = Object.values(ledger3.ares_privacy ?? {});
  const rollbackTxSeen = ops4.some((o) => o.kind === "rollbackTransaction");
  const beginTxSeen = ops4.some((o) => o.kind === "startTransaction");
  const commitTxSeen = ops4.some((o) => o.kind === "commitTransaction");
  const ds4AllDone = afterRerun.every((r) => r.status === MIGRATION_STATUS.DONE);
  const rollbackTypesSeen = new Set(
    ops4
      .filter((o) => o.kind === "executeAction")
      .map((t) => t.type)
      .filter((t) =>
        ["DROP_ENTITY","DROP_INDEX","DROP_SCHEMA","ALTER_COLUMN_DROP","ALTER_INDEX_DROP"].includes(t),
      ),
  );
  const rollbackHappened = rollbackTypesSeen.size > 0;
  assert.ok(
    rollbackHappened && ds4AllDone,
    "next run: should first rollback FAILED migrations (emit DROP_* actions), then re-run them fresh to DONE. startTx=" + beginTxSeen +
      " commitTx=" + commitTxSeen + " rollbackTx=" + rollbackTxSeen + " rollbackTypes=" + [...rollbackTypesSeen].join(",") +
      " statuses=" + [...new Set(afterRerun.map(r => r.status))].join(","),
  );

  await rm(tmpRoot, { recursive: true, force: true });
});
