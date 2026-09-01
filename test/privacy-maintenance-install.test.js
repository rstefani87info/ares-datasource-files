import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleDatasource } from "../index.js";
import { Datasource, INDEX_DEFINITION_TYPES } from "@ares/core/datasources.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..", "..");
const ECOSYSTEM_DIR = join(rootDir, "ecosystem");

function buildRecordingDriver(ops, { schemaExists } = {}) {
  class RecordingDriver {
    constructor(connectionParameters, datasource, sessionId, connectionSettingName) {
      this.connectionParameters = connectionParameters;
      this.datasource = datasource;
      this.sessionId = sessionId;
      this.connectionSettingName = connectionSettingName;
    }
    async exists(datasource, schemaName, entityName) {
      ops.push({ kind: "exists", schemaName, entityName: entityName ?? null });
      if (!entityName) {
        return schemaExists?.(schemaName) ?? true;
      }
      return false;
    }
    createSchema(schemaDefinition) {
      ops.push({ kind: "createSchema", schemaName: schemaDefinition.name });
      return { installed: true, kind: "createSchema", schemaName: schemaDefinition.name };
    }
    createEntity(entityDefinition, options = {}) {
      ops.push({
        kind: "createEntity",
        schemaName: entityDefinition.schemaName ?? entityDefinition.schemaDefinition?.name,
        entityName: entityDefinition.name,
        minimal: options.minimal === true,
      });
      return {
        installed: true,
        kind: "createEntity",
        schemaName: entityDefinition.schemaName ?? entityDefinition.schemaDefinition?.name,
        entityName: entityDefinition.name,
      };
    }
    async getSchemasUsing() { return []; }
    async getEntitiesUsing() { return []; }
    async getPropertiesUsing() { return []; }
    async getIndexesUsing() { return {}; }
    async executeMigration(datasourceOrAction, ...rest) {
      let action = datasourceOrAction;
      if (Array.isArray(rest[0]?.actions)) {
        action = rest[0];
      }
      if (action && Array.isArray(action.actions)) {
        for (const a of action.actions) {
          ops.push(normalizeAction(a));
        }
        return action.actions.map((a) => ({ ...normalizeAction(a), installed: true }));
      }
      if (rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])) {
        const a = normalizeAction(rest[0]);
        ops.push(a);
        return [{ ...a, installed: true }];
      }
      if (action && typeof action === "object") {
        const a = normalizeAction(action);
        ops.push(a);
        return [{ ...a, installed: true }];
      }
      return [];
    }
    prepareMigrationActionStatement(a) { return a; }
  }
  return RecordingDriver;
}

function normalizeAction(a) {
  const opts = a.options || a;
  const idx = opts.indexDefinition || {};
  const entityDef = opts.entityDefinition || {};
  const schemaDef = opts.schemaDefinition || {};
  const schemaName =
    idx.schemaName ?? entityDef.schemaName ?? schemaDef.name ?? null;
  const entityName = idx.entityName ?? entityDef.name ?? null;
  const type =
    a.type ??
    opts.type ??
    (idx.type === INDEX_DEFINITION_TYPES.LINK ? "LINK" : typeof a.execute === "function" ? "CREATE_INDEX" : "CREATE_INDEX");
  return {
    kind:
      a.type === "CREATE_INDEX" || opts.type === "CREATE_INDEX" || typeof a.execute === "function" || idx.name
        ? "CREATE_INDEX"
        : type,
    migrationType: a.type ?? opts.type ?? null,
    indexName: idx.name ?? null,
    indexType: idx.type ?? null,
    schemaName,
    entityName,
    referenceSchemaName: idx.referenceSchemaName ?? null,
    referenceEntityName: idx.referenceEntityName ?? null,
    references: idx.references
      ? idx.references.map((r) => {
          if (typeof r === "string") return r;
          return `${r.propertyName ?? r.column ?? r.name}@${r.referenceSchemaName ?? r.schemaName ?? ""}.${r.referenceEntityName ?? r.entityName ?? ""}`;
        })
      : [],
  };
}

test("privacy datasource - assemble hydrates schemas + new Datasource save() creates SCHEMAS/ENTITIES/NONLINK/LINKS in order", async () => {
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
  assert.equal(assembled.name, "privacy", "assembleDatasource returns name=privacy");
  assert.ok(
    Array.isArray(assembled.schemas) && assembled.schemas.length > 0,
    "schemas must be hydrated from current-schemas.json (falsy export)",
  );
  assert.equal(
    assembled.schemas[0].name,
    "ares_privacy",
    "schema name must be ares_privacy",
  );
  const entityNames = assembled.schemas[0].entities.map((e) => e.name).sort();
  assert.deepEqual(
    entityNames,
    ["profile_data", "profiles", "users"],
    "expected 3 entities in privacy schema",
  );

  const ops = [];
  const DriverClass = buildRecordingDriver(ops, { schemaExists: () => true });
  const testEnv = {
    test: {
      main: {
        driver: DriverClass,
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

  const ds = new Datasource(aReSStub, datasourceSettings);
  await ds.loadQueries();
  const saveResults = await ds.save();
  assert.ok(Array.isArray(saveResults), "save() must return an array");

  const createEntities = ops.filter((o) => o.kind === "createEntity");
  const entityOrder = createEntities.map((o) => o.entityName);
  const expectedEntityOrder = ["users", "profiles", "profile_data"];
  for (let i = 0; i < expectedEntityOrder.length; i++) {
    assert.equal(
      entityOrder[i],
      expectedEntityOrder[i],
      `entity creation order: expected ${expectedEntityOrder[i]} at position ${i}, got ${entityOrder[i]}`,
    );
  }
  assert.ok(
    createEntities.every((o) => o.minimal === true),
    "every createEntity call must use {minimal: true} (no inline FK)",
  );

  const firstCreateEntity = ops.findIndex((o) => o.kind === "createEntity");
  const firstNonLinkIndex = ops.findIndex(
    (o) =>
      o.kind === "CREATE_INDEX" &&
      o.indexType &&
      o.indexType !== INDEX_DEFINITION_TYPES.LINK,
  );
  const firstLink = ops.findIndex(
    (o) =>
      o.kind === "CREATE_INDEX" &&
      o.indexType === INDEX_DEFINITION_TYPES.LINK,
  );
  assert.ok(
    firstCreateEntity !== -1 &&
      firstNonLinkIndex !== -1 &&
      firstLink !== -1,
    "expected entities + non-link indexes + links",
  );
  assert.ok(
    firstCreateEntity < firstNonLinkIndex && firstNonLinkIndex < firstLink,
    `must be SCHEMAS/ENTITIES < NON-LINK < LINKS (got entity=${firstCreateEntity}, nonlink=${firstNonLinkIndex}, link=${firstLink})`,
  );

  const profileDataFK = ops.find(
    (o) =>
      o.kind === "CREATE_INDEX" &&
      o.indexType === INDEX_DEFINITION_TYPES.LINK &&
      o.entityName === "profile_data",
  );
  assert.ok(profileDataFK, "expected FK fk_profile_data_profile");
  assert.equal(
    profileDataFK.referenceEntityName ??
      (profileDataFK.references ?? [])[0]?.split("@")[1]?.split(".")[1],
    "profiles",
    "profile_data FK must reference profiles",
  );
});

test("maintenance datasource - schemas hydrated + cross-schema FK on tickets.profile_id REFERENCES ares_privacy.profiles(id)", async () => {
  const maintenanceDsFile = join(
    ECOSYSTEM_DIR,
    "datasources",
    "maintenance",
    "datasource.js",
  );
  const assembled = await assembleDatasource(maintenanceDsFile, {
    isProduction: false,
    generateCurrentSchemasIfMissing: false,
  });
  assert.equal(assembled.name, "maintenance");
  assert.ok(
    Array.isArray(assembled.schemas) && assembled.schemas.length > 0,
    "schemas hydrated for maintenance (undefined export)",
  );
  assert.equal(assembled.schemas[0].name, "ares_maintenance");

  const ops = [];
  const DriverClass = buildRecordingDriver(ops, { schemaExists: () => true });
  const testEnv = {
    test: {
      main: {
        driver: DriverClass,
        host: "localhost",
        port: 3306,
        database: "ares_maintenance",
      },
    },
  };
  const datasourceSettings = { ...assembled, environments: testEnv };
  const aReSStub = {
    isProduction: false,
    getConfig: () => null,
    getPolicy: () => null,
  };
  const ds = new Datasource(aReSStub, datasourceSettings);
  await ds.loadQueries();
  await ds.save();

  const crossSchemaFK = ops.find(
    (o) =>
      o.kind === "CREATE_INDEX" &&
      o.indexType === INDEX_DEFINITION_TYPES.LINK &&
      o.entityName === "tickets" &&
      (o.referenceSchemaName === "ares_privacy" ||
        (o.references ?? []).some((r) => r.includes("ares_privacy.profiles"))),
  );
  assert.ok(
    crossSchemaFK,
    "expected cross-schema FK fk_tickets_profile referencing ares_privacy.profiles (got " +
      JSON.stringify(
        ops.filter(
          (o) =>
            o.kind === "CREATE_INDEX" &&
            o.indexType === INDEX_DEFINITION_TYPES.LINK &&
            o.entityName === "tickets",
        ),
      ) +
      ")",
  );
  const refFromReferences = crossSchemaFK.references?.find((r) =>
    r.includes("ares_privacy"),
  );
  if (crossSchemaFK.referenceSchemaName) {
    assert.equal(crossSchemaFK.referenceSchemaName, "ares_privacy");
    assert.equal(crossSchemaFK.referenceEntityName, "profiles");
  } else {
    assert.ok(
      refFromReferences,
      "references must mention ares_privacy.profiles",
    );
  }

  const allLinks = ops.filter(
    (o) =>
      o.kind === "CREATE_INDEX" &&
      o.indexType === INDEX_DEFINITION_TYPES.LINK,
  );
  const lastLink = allLinks[allLinks.length - 1];
  assert.ok(
    lastLink.entityName === "tickets" &&
      (lastLink.referenceSchemaName === "ares_privacy" ||
        (lastLink.references ?? []).some((r) => r.includes("ares_privacy"))),
    "cross-schema FK fk_tickets_profile MUST be executed LAST in link phase (so dependency ares_privacy.profiles is online first)",
  );
});
