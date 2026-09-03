import { Hono } from "hono";
import sql from "../db/db.ts";
import { assertReadOnlySqlQuery, buildSafeSqlFilter } from "../sqlSafety.ts";
import {
  applyPgBackupRetention,
  convertLocalDateTimeInTimeZoneToUtcIso,
  getConfiguredTimeZone,
  getPgBackupSettings,
  listPgBackupFiles,
  normalizePgBackupFrequency,
  normalizeRetainCount,
  quoteIdentifier,
  restorePgDumpBackup,
  runPgDumpBackupOnce,
  safeTimeZone,
  sanitizeBackupFilename,
  savePgBackupSettings,
  type PgBackupSettings,
} from "../services/collectionsBackend.ts";
import {
  deleteCustomEndpointFile,
  getRegisteredEndpointPaths,
  isCustomEndpointsEnabled,
  listCustomEndpointFiles,
  loadCustomScripts,
  readCustomEndpointFile,
  reloadCustomScripts,
  setCustomEndpointsEnabled,
  writeCustomEndpointFile,
} from "../services/customScriptsBackend.ts";
import { invalidateRateLimitCache } from "../middleware/rateLimit.ts";
import {
  buildFieldChecks,
  buildFieldColumnDefinition,
  buildSqlConstraintName,
  syncFieldSqlConstraints,
} from "./collectionDdl.ts";

// JSON admin API for the Vue SPA. Mounted at /internal/api/admin behind
// requireAuth (cookie + same-origin header gate).
const adminApi = new Hono();

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

const COLLECTION_NAME_REGEX = /^[a-zA-Z0-9_]+$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_PAGE = 40;

async function readJsonBody(c: any): Promise<Record<string, any> | null> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
}

function parseMaybeJson(value: any) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeCollection(row: any) {
  return {
    name: row.name,
    type: row.type,
    schema: parseMaybeJson(row.schema),
    oauth2: parseMaybeJson(row.oauth2),
    view_query: row.view_query ?? null,
    list_rule: row.list_rule ?? null,
    view_rule: row.view_rule ?? null,
    create_rule: row.create_rule ?? null,
    update_rule: row.update_rule ?? null,
    delete_rule: row.delete_rule ?? null,
  };
}

// Match the legacy UI: password material is never exposed. Note that
// token_key (auth collections) IS still exposed, exactly like the old UI.
function sanitizeRecord(record: any) {
  const clean = { ...record };
  delete clean.password;
  delete clean.password_hash;
  return clean;
}

function assertValidCollectionName(name: string) {
  if (!name || !COLLECTION_NAME_REGEX.test(name)) {
    throw new ApiError("Invalid collection name.", 400);
  }
}

function mapDbError(err: any): ApiError {
  switch (err?.code) {
    case "22P02": // invalid text representation (e.g. bad UUID)
    case "22007":
    case "22008":
      return new ApiError("Invalid value format.", 400);
    case "42703": // undefined column
      return new ApiError(`Bad request: ${err.message}`, 400);
    case "42P01": // undefined table
      return new ApiError("Collection not found.", 404);
    case "23505":
      return new ApiError(`Unique constraint violation: ${err.message}`, 422);
    case "23502":
      return new ApiError(`Not-null violation: ${err.message}`, 422);
    case "23503":
      return new ApiError(`Foreign-key violation: ${err.message}`, 422);
    case "23514":
      return new ApiError(`Check violation: ${err.message}`, 422);
    default:
      return new ApiError(
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : err?.message || "Internal server error",
        500,
      );
  }
}

function handleRouteError(c: any, err: any, prefix: string) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message }, err.status);
  }
  const mapped = mapDbError(err);
  return c.json({ error: `${prefix}: ${mapped.message}` }, mapped.status);
}

async function getCollectionMeta(name: string) {
  const rows =
    await sql`SELECT * FROM _collections WHERE name = ${name} LIMIT 1`;
  return rows[0] || null;
}

function isBlankValue(value: any) {
  return value === undefined || value === null || String(value).trim() === "";
}

function validateFieldValue(fieldDef: any, fieldName: string, body: any) {
  const hasValue = Object.prototype.hasOwnProperty.call(body, fieldName);
  const rawValue = body[fieldName];

  if (fieldDef.required && (!hasValue || isBlankValue(rawValue))) {
    throw new ApiError(`Field "${fieldName}" is required.`);
  }

  if (!hasValue || isBlankValue(rawValue)) return;

  const fieldType = String(fieldDef.type || "text").toLowerCase();
  const stringValue = String(rawValue);

  switch (fieldType) {
    case "number": {
      const numericValue = Number(rawValue);
      if (!Number.isFinite(numericValue)) {
        throw new ApiError(`Field "${fieldName}" must be a valid number.`);
      }
      if (fieldDef.nonzero && numericValue === 0) {
        throw new ApiError(`Field "${fieldName}" must be non-zero.`);
      }
      if (
        fieldDef.min !== undefined &&
        fieldDef.min !== null &&
        fieldDef.min !== ""
      ) {
        const minValue = Number(fieldDef.min);
        if (numericValue < minValue) {
          throw new ApiError(`Field "${fieldName}" must be at least ${minValue}.`);
        }
      }
      if (
        fieldDef.max !== undefined &&
        fieldDef.max !== null &&
        fieldDef.max !== ""
      ) {
        const maxValue = Number(fieldDef.max);
        if (numericValue > maxValue) {
          throw new ApiError(`Field "${fieldName}" must be at most ${maxValue}.`);
        }
      }
      break;
    }
    case "email": {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(stringValue)) {
        throw new ApiError(`Field "${fieldName}" must be a valid email.`);
      }
      break;
    }
    case "url": {
      try {
        new URL(stringValue);
      } catch {
        throw new ApiError(`Field "${fieldName}" must be a valid URL.`);
      }
      break;
    }
    case "boolean": {
      if (
        typeof rawValue !== "boolean" &&
        stringValue !== "true" &&
        stringValue !== "false"
      ) {
        throw new ApiError(`Field "${fieldName}" must be a boolean.`);
      }
      break;
    }
    case "date":
    case "datetime": {
      if (isNaN(Date.parse(stringValue))) {
        throw new ApiError(`Field "${fieldName}" must be a valid date.`);
      }
      break;
    }
    case "date_only": {
      const format = fieldDef.date_format || "YYYY-MM-DD";
      if (format === "YYYY-MM-DD" && !/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
        throw new ApiError(`Field "${fieldName}" must be in YYYY-MM-DD format.`);
      }
      break;
    }
    case "json":
    case "jsonb": {
      if (typeof rawValue === "string") {
        try {
          JSON.parse(stringValue);
        } catch {
          throw new ApiError(`Field "${fieldName}" must be valid JSON.`);
        }
      }
      break;
    }
    case "uuid":
    case "relation": {
      if (!UUID_REGEX.test(stringValue)) {
        throw new ApiError(`Field "${fieldName}" must be a valid UUID.`);
      }
      break;
    }
    default: {
      if (fieldDef.regex && String(fieldDef.regex).trim()) {
        const regex = new RegExp(fieldDef.regex);
        if (!regex.test(stringValue)) {
          throw new ApiError(
            `Field "${fieldName}" does not match the required pattern.`,
          );
        }
      }
    }
  }
}

function shouldTrimTextInput(fieldDef: any) {
  const fieldType = String(fieldDef?.type || "").toLowerCase();
  return (
    fieldDef &&
    fieldDef.trim_input === true &&
    (fieldType === "text" || fieldType === "richtext")
  );
}

async function getTableColumnTypes(collectionName: string) {
  const tableColumns = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = ${collectionName}
      AND table_schema = 'public'
  `;
  return new Map<string, string>(
    (tableColumns as any[]).map((col) => [
      String(col.column_name),
      String(col.data_type || "").toLowerCase(),
    ]),
  );
}

// Normalizes one inbound key/value into cleanBody/finalKeys, mirroring the
// legacy per-type coercion (date_only formats, trim, local datetime -> UTC).
function coerceFieldIntoBody(
  k: string,
  body: any,
  definedSchema: any[],
  columnTypeByName: Map<string, string>,
  cleanBody: Record<string, any>,
  finalKeys: string[],
  configuredTimeZone: string,
) {
  const fieldDef = definedSchema.find((f) => f.name === k);
  const columnType = columnTypeByName.get(k) || "";

  if (k.endsWith("_lat")) {
    const baseName = k.replace("_lat", "");
    if (!cleanBody[baseName]) cleanBody[baseName] = {};
    cleanBody[baseName].lat = parseFloat(String(body[k]));
    if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
  } else if (k.endsWith("_lon")) {
    const baseName = k.replace("_lon", "");
    if (!cleanBody[baseName]) cleanBody[baseName] = {};
    cleanBody[baseName].lon = parseFloat(String(body[k]));
    if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
  } else if (fieldDef && fieldDef.type === "date_only") {
    let val = String(body[k] ?? "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
    if (m) {
      const [, yyyy, mm, dd] = m;
      const fmt = fieldDef.date_format || "YYYY-MM-DD";
      if (fmt === "DD-MM-YYYY") val = `${dd}-${mm}-${yyyy}`;
      else if (fmt === "DD/MM/YYYY") val = `${dd}/${mm}/${yyyy}`;
      else if (fmt === "YYYY/MM/DD") val = `${yyyy}/${mm}/${dd}`;
      else val = `${yyyy}-${mm}-${dd}`;
    }
    cleanBody[k] = val;
    finalKeys.push(k);
  } else if (fieldDef && shouldTrimTextInput(fieldDef)) {
    cleanBody[k] =
      typeof body[k] === "string" ? body[k].trim() : String(body[k]).trim();
    finalKeys.push(k);
  } else if (
    columnType.includes("timestamp") &&
    typeof body[k] === "string" &&
    /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(body[k] as string)
  ) {
    cleanBody[k] = convertLocalDateTimeInTimeZoneToUtcIso(
      body[k] as string,
      configuredTimeZone,
    );
    finalKeys.push(k);
  } else if (fieldDef && fieldDef.type === "number") {
    cleanBody[k] = Number(body[k]);
    finalKeys.push(k);
  } else if (
    (fieldDef && String(fieldDef.type).toLowerCase() === "boolean") ||
    k === "verified"
  ) {
    cleanBody[k] = body[k] === true || String(body[k]) === "true";
    finalKeys.push(k);
  } else {
    cleanBody[k] = body[k];
    finalKeys.push(k);
  }
}

function escapeSqlLiteral(value: any) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date)
    return `'${value.toISOString().replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

async function getCurrentAdminRecord(c: any) {
  const sessionUser = c.get("user");
  if (!sessionUser?.id) return null;
  const rows = await sql`
    SELECT id, owner
    FROM _users
    WHERE id = ${sessionUser.id}
    LIMIT 1
  `;
  return rows[0] || null;
}

function truthy(value: any) {
  return value === true || value === "true";
}

function assertViewQuery(query: string) {
  try {
    assertReadOnlySqlQuery(query);
  } catch (err: any) {
    throw new ApiError(err.message, 422);
  }
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

adminApi.get("/collections", async (c) => {
  try {
    const rows = await sql`SELECT * FROM _collections ORDER BY name`;
    return c.json({ collections: rows.map(serializeCollection) });
  } catch (err: any) {
    return handleRouteError(c, err, "Error listing collections");
  }
});

adminApi.post("/collections", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  const rawName = typeof body.name === "string" ? body.name : "";
  const name = rawName.trim().toLowerCase().replace(/\s+/g, "_");
  const type = typeof body.type === "string" ? body.type : "base";
  const viewQuery = typeof body.view_query === "string" ? body.view_query : null;

  const rule = (key: string) =>
    typeof body[key] === "string" ? body[key] : null;
  const list_rule = rule("list_rule");
  const view_rule = rule("view_rule");
  const create_rule = rule("create_rule");
  const update_rule = rule("update_rule");
  const delete_rule = rule("delete_rule");

  try {
    if (!name || !COLLECTION_NAME_REGEX.test(name))
      throw new ApiError("Invalid collection name.", 422);
    if (name.startsWith("_"))
      throw new ApiError(
        "Collection names cannot start with an underscore (reserved for system).",
        422,
      );
    if (!["base", "auth", "view"].includes(type))
      throw new ApiError(
        `Invalid collection type: ${type}. Must be base, auth or view.`,
        422,
      );

    if (type === "view") {
      if (!viewQuery)
        throw new ApiError("View Collection requires a SELECT query.", 422);
      assertViewQuery(viewQuery);
      const query = `CREATE OR REPLACE VIEW "${name}" AS ${viewQuery}`;
      await sql.unsafe(query);

      await sql`
        INSERT INTO _collections
          (name, type, view_query, list_rule, view_rule, create_rule, update_rule, delete_rule)
        VALUES
          (${name}, ${type}, ${viewQuery}, ${list_rule}, ${view_rule}, ${create_rule}, ${update_rule}, ${delete_rule})
      `;

      const created = await getCollectionMeta(name);
      return c.json({ collection: serializeCollection(created) }, 201);
    }

    let fields: any[] = [];
    if (Array.isArray(body.fields)) fields = body.fields;
    else if (typeof body.fields === "string" && body.fields.trim())
      fields = JSON.parse(body.fields);
    fields = fields.map((f: any) => {
      if (f && f.name) {
        f.name = String(f.name).trim().toLowerCase().replace(/\s+/g, "_");
      }
      // Tolerate the alternate key names used by some clients.
      if (f && !f.relation_collection && typeof f.collectionId === "string" && COLLECTION_NAME_REGEX.test(f.collectionId)) {
        f.relation_collection = f.collectionId;
      }
      if (f && !f.date_format && typeof f.dateFormat === "string") {
        f.date_format = f.dateFormat;
      }
      if (f && f.trim_input === undefined && f.trim !== undefined) {
        f.trim_input = truthy(f.trim);
      }
      return f;
    });

    let indexes: any[] = [];
    if (Array.isArray(body.indexes)) indexes = body.indexes;
    else if (typeof body.indexes === "string" && body.indexes.trim())
      indexes = JSON.parse(body.indexes);

    let query = `CREATE TABLE IF NOT EXISTS "${name}" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid()`;

    let finalFields: any[] = [];
    if (type === "base") {
      finalFields.push(
        { name: "id", type: "text", system: true, required: false },
        { name: "created", type: "date", system: true, required: false },
        { name: "updated", type: "date", system: true, required: false },
      );
    }

    const authOptions = {
      google_enabled: truthy(body.google_enabled),
      auth_method: typeof body.auth_method === "string" ? body.auth_method : "email",
    };

    if (type === "auth") {
      query += `, "username" VARCHAR(255) UNIQUE${authOptions.auth_method === "username" || authOptions.auth_method === "both" ? " NOT NULL" : ""}, email VARCHAR(255) UNIQUE${authOptions.auth_method === "email" || authOptions.auth_method === "both" ? " NOT NULL" : ""}, verified BOOLEAN NOT NULL DEFAULT FALSE, password_hash VARCHAR(255) NOT NULL, token_key VARCHAR(255) NOT NULL DEFAULT gen_random_uuid()`;

      finalFields.push({ name: "id", type: "text", system: true, required: false });
      if (authOptions.auth_method === "username") {
        finalFields.push({ name: "username", type: "text", system: true, required: false });
      } else {
        finalFields.push({ name: "email", type: "email", system: true, required: false });
      }
      finalFields.push(
        { name: "verified", type: "boolean", system: true, required: false },
        { name: "password", type: "password", system: true, required: false },
        { name: "passwordConfirm", type: "password", system: true, required: false },
        { name: "created", type: "date", system: true, required: false },
        { name: "updated", type: "date", system: true, required: false },
      );
    }

    const forbiddenNames = [
      "id",
      "created",
      "updated",
      "email",
      "username",
      "password",
      "password_hash",
      "verified",
      "passwordconfirm",
      "created_at",
      "updated_at",
      "token_key",
    ];
    const cleanUserFields = fields.filter(
      (f: any) => f && f.name && !forbiddenNames.includes(String(f.name).toLowerCase()),
    );

    if (type === "base" && cleanUserFields.length === 0) {
      throw new ApiError("Base Collection must have at least one custom field.", 422);
    }

    finalFields = [...finalFields, ...cleanUserFields];

    for (const field of cleanUserFields) {
      if (!field.name || !COLLECTION_NAME_REGEX.test(field.name))
        throw new ApiError(`Invalid field name: ${field.name}`, 422);

      query += `, ${buildFieldColumnDefinition(field)}`;
      for (const check of buildFieldChecks(field, field.name, name)) {
        query += `, CONSTRAINT "${buildSqlConstraintName(name, field.name, check.suffix)}" CHECK (${check.expression})`;
      }
    }
    query += `,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );`;

    await sql.unsafe(query);

    for (const idx of indexes) {
      if (!idx || !idx.fields) continue;
      const columns = String(idx.fields)
        .split(",")
        .map((f: string) => f.trim().toLowerCase().replace(/\s+/g, "_"))
        .filter(Boolean);
      if (columns.length === 0) continue;
      for (const col of columns) {
        if (!COLLECTION_NAME_REGEX.test(col))
          throw new ApiError(`Invalid index column name: ${col}`, 422);
      }
      const indexName = `idx_${name}_${columns.join("_")}`;

      if (idx.type === "unique") {
        await sql.unsafe(
          `ALTER TABLE "${name}" ADD CONSTRAINT "uq_${indexName}" UNIQUE ("${columns.join('", "')}")`,
        );
      } else {
        await sql.unsafe(
          `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${name}" ("${columns.join('", "')}")`,
        );
      }
    }

    await sql`
      INSERT INTO _collections
        (name, type, schema, oauth2, list_rule, view_rule, create_rule, update_rule, delete_rule)
      VALUES
        (${name}, ${type}, ${JSON.stringify(finalFields)}::jsonb, ${JSON.stringify(authOptions)}::jsonb, ${list_rule}, ${view_rule}, ${create_rule}, ${update_rule}, ${delete_rule})
    `;

    const created = await getCollectionMeta(name);
    return c.json({ collection: serializeCollection(created) }, 201);
  } catch (err: any) {
    return handleRouteError(c, err, "Error creating collection");
  }
});

adminApi.get("/collections/:name", async (c) => {
  const name = c.req.param("name");
  try {
    assertValidCollectionName(name);
    const meta = await getCollectionMeta(name);
    if (!meta) return c.json({ error: "Collection not found." }, 404);
    return c.json({ collection: serializeCollection(meta) });
  } catch (err: any) {
    return handleRouteError(c, err, "Error loading collection");
  }
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

adminApi.get("/collections/:name/records", async (c) => {
  const collectionName = c.req.param("name");
  const filter = c.req.query("filter") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const requestedSort = c.req.query("sort") || "";
  const requestedOrder = c.req.query("order") === "asc" ? "asc" : "desc";
  const offset = (page - 1) * PER_PAGE;

  try {
    assertValidCollectionName(collectionName);

    const meta =
      await sql`SELECT type, schema FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0 && collectionName !== "_users") {
      return c.json({ error: "Collection not found." }, 404);
    }

    const columnInfo = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${collectionName}
        AND table_schema = 'public'
    `;
    if (columnInfo.length === 0) {
      return c.json({ error: "Collection not found." }, 404);
    }

    let definedSchema: any[] = [];
    if (meta.length > 0 && meta[0].schema) {
      definedSchema = parseMaybeJson(meta[0].schema) || [];
      if (!Array.isArray(definedSchema)) definedSchema = [];
    }

    const availableSortColumns = columnInfo.map((col: any) => col.column_name);
    const defaultSortColumn = availableSortColumns.includes("created_at")
      ? "created_at"
      : availableSortColumns.includes("id")
        ? "id"
        : availableSortColumns[0] || "id";
    const sortColumn = availableSortColumns.includes(requestedSort)
      ? requestedSort
      : defaultSortColumn;
    const sortDirection = requestedSort ? requestedOrder : "desc";

    let records: any[];
    let totalItems = 0;
    if (filter) {
      let sqlFilterStr: string;
      try {
        sqlFilterStr = buildSafeSqlFilter(filter, availableSortColumns);
      } catch (e: any) {
        return c.json({ error: `Invalid filter: ${e.message}` }, 400);
      }
      const rows = await sql.unsafe(
        `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${sqlFilterStr} ORDER BY "${sortColumn}" ${sortDirection.toUpperCase()} LIMIT ${PER_PAGE} OFFSET ${offset}`,
      );
      const countRes = await sql.unsafe(
        `SELECT count(*) as count FROM ${quoteIdentifier(collectionName)} WHERE ${sqlFilterStr}`,
      );
      records = rows;
      totalItems = parseInt(countRes[0].count, 10);
    } else {
      records = await sql.unsafe(
        `SELECT * FROM ${quoteIdentifier(collectionName)} ORDER BY "${sortColumn}" ${sortDirection.toUpperCase()} LIMIT ${PER_PAGE} OFFSET ${offset}`,
      );
      const countRes =
        await sql`SELECT count(*) as count FROM ${sql(collectionName)}`;
      totalItems = parseInt(countRes[0].count, 10);
    }

    return c.json({
      columns: columnInfo,
      schema: definedSchema,
      records: records.map(sanitizeRecord),
      page,
      perPage: PER_PAGE,
      hasMore: page * PER_PAGE < totalItems,
    });
  } catch (err: any) {
    return handleRouteError(c, err, "Error listing records");
  }
});

adminApi.get("/collections/:name/records/:id", async (c) => {
  const collectionName = c.req.param("name");
  const recordId = c.req.param("id");
  try {
    assertValidCollectionName(collectionName);
    if (!UUID_REGEX.test(recordId)) {
      return c.json({ error: "Invalid record id." }, 400);
    }
    const meta = await getCollectionMeta(collectionName);
    if (!meta && collectionName !== "_users") {
      return c.json({ error: "Collection not found." }, 404);
    }
    const rows = await sql`
      SELECT * FROM ${sql(collectionName)} WHERE id = ${recordId} LIMIT 1
    `;
    if (rows.length === 0) {
      return c.json({ error: "Record not found." }, 404);
    }
    return c.json({ record: sanitizeRecord(rows[0]) });
  } catch (err: any) {
    return handleRouteError(c, err, "Error loading record");
  }
});

adminApi.post("/collections/:name/records", async (c) => {
  const collectionName = c.req.param("name");
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  const isSystemUsers = collectionName === "_users";

  try {
    assertValidCollectionName(collectionName);
    const metaRows =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (metaRows.length === 0 && !isSystemUsers) {
      return c.json({ error: "Collection not found." }, 404);
    }
    const metaInfo =
      metaRows.length > 0 ? metaRows : [{ type: "base", schema: null, oauth2: null }];
    if (metaInfo[0].type === "view") {
      return c.json({ error: "Views are read only." }, 405);
    }

    if (isSystemUsers) {
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const passwordConfirm = String(body.passwordConfirm || "");

      if (!email) {
        return c.json({ error: "email is required for superadmins." }, 422);
      }
      if (!password || password.length < 8) {
        return c.json(
          { error: "Password is required and must be at least 8 characters." },
          422,
        );
      }
      if (password !== passwordConfirm) {
        return c.json({ error: "Password and passwordConfirm must match." }, 422);
      }

      const hashedPassword = await Bun.password.hash(password);
      const result = await sql`
        INSERT INTO _users (email, password, owner)
        VALUES (${email}, ${hashedPassword}, FALSE)
        RETURNING id, email, owner, created_at, updated_at
      `;

      return c.json({ record: result[0] }, 201);
    }

    const configuredTimeZone = await getConfiguredTimeZone();
    const columnTypeByName = await getTableColumnTypes(collectionName);

    let definedSchema: any[] = [];
    if (metaInfo[0].schema) {
      definedSchema = parseMaybeJson(metaInfo[0].schema) || [];
      if (!Array.isArray(definedSchema)) definedSchema = [];
    }

    for (const fieldDef of definedSchema) {
      if (!fieldDef || !fieldDef.name) continue;
      if (fieldDef.system || fieldDef.name === "id") continue;
      if (fieldDef.type === "password" || fieldDef.name === "passwordConfirm")
        continue;

      if (fieldDef.type === "geolocation") {
        const latKey = `${fieldDef.name}_lat`;
        const lonKey = `${fieldDef.name}_lon`;
        const hasLat = Object.prototype.hasOwnProperty.call(body, latKey);
        const hasLon = Object.prototype.hasOwnProperty.call(body, lonKey);
        if (
          fieldDef.required &&
          (!hasLat || !hasLon || isBlankValue(body[latKey]) || isBlankValue(body[lonKey]))
        ) {
          throw new ApiError(`Field "${fieldDef.name}" is required.`);
        }
        if (hasLat && !isBlankValue(body[latKey]) && !Number.isFinite(Number(body[latKey]))) {
          throw new ApiError(`Field "${fieldDef.name}" latitude must be a valid number.`);
        }
        if (hasLon && !isBlankValue(body[lonKey]) && !Number.isFinite(Number(body[lonKey]))) {
          throw new ApiError(`Field "${fieldDef.name}" longitude must be a valid number.`);
        }
        continue;
      }

      validateFieldValue(fieldDef, fieldDef.name, body);
    }

    const cleanBody: Record<string, any> = {};
    const finalKeys: string[] = [];
    const keys = Object.keys(body).filter(
      (k) => body[k] !== "" && body[k] !== undefined,
    );

    if (keys.length === 0) {
      return c.json({ error: "Empty payload" }, 422);
    }

    const isAuthCollection = metaInfo[0].type === "auth";
    let authMethod = "email";
    if (isAuthCollection && metaInfo[0].oauth2) {
      const oauthCfg = parseMaybeJson(metaInfo[0].oauth2);
      authMethod = oauthCfg?.auth_method || "email";
    }

    if (isAuthCollection) {
      const password = typeof body.password === "string" ? body.password : "";
      const passwordConfirm =
        typeof body.passwordConfirm === "string" ? body.passwordConfirm : "";

      if (!password || password.length < 8) {
        return c.json(
          { error: "Password is required and must be at least 8 characters." },
          422,
        );
      }
      if (password !== passwordConfirm) {
        return c.json({ error: "Password and passwordConfirm must match." }, 422);
      }

      if (authMethod === "username" || authMethod === "both") {
        if (isBlankValue(body.username)) {
          return c.json(
            { error: "username is required for this auth collection." },
            422,
          );
        }
      } else {
        delete cleanBody.username;
      }

      if (authMethod === "email" || authMethod === "both") {
        if (isBlankValue(body.email)) {
          return c.json(
            { error: "email is required for this auth collection." },
            422,
          );
        }
      } else {
        delete cleanBody.email;
      }

      cleanBody.verified = truthy(body.verified);
      const hashResult =
        await sql`SELECT crypt(${password}, gen_salt('bf')) as hash`;
      cleanBody.password_hash = hashResult[0].hash;
      delete cleanBody.password;
      delete cleanBody.passwordConfirm;

      if (!finalKeys.includes("verified")) finalKeys.push("verified");
      if (!finalKeys.includes("password_hash")) finalKeys.push("password_hash");
    }

    keys.forEach((k) => {
      if (k === "password" || k === "passwordConfirm") return;
      coerceFieldIntoBody(
        k,
        body,
        definedSchema,
        columnTypeByName,
        cleanBody,
        finalKeys,
        configuredTimeZone,
      );
    });

    // Optional manual id support on create; if blank, DB default gen_random_uuid() is used.
    if (
      cleanBody.id === "" ||
      cleanBody.id === null ||
      cleanBody.id === undefined
    ) {
      delete cleanBody.id;
      const idx = finalKeys.indexOf("id");
      if (idx > -1) finalKeys.splice(idx, 1);
    }

    const result = await sql`
      INSERT INTO ${sql(collectionName)} ${sql(cleanBody, finalKeys as any)}
      RETURNING *
    `;

    return c.json({ record: sanitizeRecord(result[0]) }, 201);
  } catch (err: any) {
    return handleRouteError(c, err, "Error creating record");
  }
});

adminApi.post("/collections/:name/records/:id", async (c) => {
  const collectionName = c.req.param("name");
  const recordId = c.req.param("id");
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  try {
    assertValidCollectionName(collectionName);
    if (!UUID_REGEX.test(recordId)) {
      return c.json({ error: "Invalid record id." }, 400);
    }

    const metaRows =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    const isSystemUsers = collectionName === "_users";
    if (metaRows.length === 0 && !isSystemUsers) {
      return c.json({ error: "Collection not found." }, 404);
    }
    const metaInfo =
      metaRows.length > 0 ? metaRows : [{ type: "base", schema: null, oauth2: null }];
    if (metaInfo[0].type === "view") {
      return c.json({ error: "Views are read only." }, 405);
    }

    const existingRows = await sql`
      SELECT * FROM ${sql(collectionName)} WHERE id = ${recordId} LIMIT 1
    `;
    if (existingRows.length === 0) {
      return c.json({ error: "Record not found." }, 404);
    }
    const existingRecord = existingRows[0];

    if (isSystemUsers) {
      const currentAdminRecord = await getCurrentAdminRecord(c);
      const currentAdminId = currentAdminRecord?.id || null;
      const currentAdminOwns = currentAdminRecord?.owner === true;
      const nextEmail = String(body.email || "").trim();
      const requestedPassword = String(body.password || "");
      const requestedPasswordConfirm = String(body.passwordConfirm || "");
      const wantsOwnership = truthy(body.transfer_owner);

      if (requestedPassword || requestedPasswordConfirm) {
        if (!currentAdminId || (recordId !== currentAdminId && !currentAdminOwns)) {
          return c.json(
            {
              error:
                "You can only change your own password unless you are the current owner.",
            },
            403,
          );
        }
        if (!requestedPassword || requestedPassword.length < 8) {
          return c.json(
            { error: "Password must be at least 8 characters when updated." },
            422,
          );
        }
        if (requestedPassword !== requestedPasswordConfirm) {
          return c.json({ error: "Password and passwordConfirm must match." }, 422);
        }
      }

      if (wantsOwnership && !currentAdminOwns) {
        return c.json(
          { error: "Only the current owner can assign ownership." },
          403,
        );
      }

      const assignments: string[] = [];
      if (nextEmail) {
        assignments.push(`"email" = ${escapeSqlLiteral(nextEmail)}`);
      }

      if (requestedPassword) {
        const hashResult = await sql`
          SELECT crypt(${requestedPassword}, gen_salt('bf')) as hash
        `;
        assignments.push(`"password" = ${escapeSqlLiteral(hashResult[0].hash)}`);
      }

      if (assignments.length > 0) {
        await sql.unsafe(
          `UPDATE _users SET ${assignments.join(", ")} WHERE id = ${escapeSqlLiteral(recordId)}`,
        );
      }

      if (wantsOwnership) {
        await sql`UPDATE _users SET owner = (id = ${recordId})`;
      }

      if (assignments.length === 0 && !wantsOwnership) {
        return c.json({ error: "No changes to save." }, 422);
      }

      const updated = await sql`
        SELECT id, email, owner, created_at, updated_at FROM _users WHERE id = ${recordId} LIMIT 1
      `;
      return c.json({ record: updated[0] });
    }

    const configuredTimeZone = await getConfiguredTimeZone();
    const columnTypeByName = await getTableColumnTypes(collectionName);

    let definedSchema: any[] = [];
    if (metaInfo[0].schema) {
      definedSchema = parseMaybeJson(metaInfo[0].schema) || [];
      if (!Array.isArray(definedSchema)) definedSchema = [];
    }

    for (const fieldDef of definedSchema) {
      if (!fieldDef || !fieldDef.name) continue;
      if (
        fieldDef.system ||
        fieldDef.type === "password" ||
        fieldDef.name === "passwordConfirm"
      ) {
        continue;
      }

      if (fieldDef.type === "geolocation") {
        const latKey = `${fieldDef.name}_lat`;
        const lonKey = `${fieldDef.name}_lon`;
        const hasLat = Object.prototype.hasOwnProperty.call(body, latKey);
        const hasLon = Object.prototype.hasOwnProperty.call(body, lonKey);
        if (
          fieldDef.required &&
          (!hasLat || !hasLon || isBlankValue(body[latKey]) || isBlankValue(body[lonKey]))
        ) {
          throw new ApiError(`Field "${fieldDef.name}" is required.`);
        }
        if (hasLat && !isBlankValue(body[latKey]) && !Number.isFinite(Number(body[latKey]))) {
          throw new ApiError(`Field "${fieldDef.name}" latitude must be a valid number.`);
        }
        if (hasLon && !isBlankValue(body[lonKey]) && !Number.isFinite(Number(body[lonKey]))) {
          throw new ApiError(`Field "${fieldDef.name}" longitude must be a valid number.`);
        }
        continue;
      }

      validateFieldValue(fieldDef, fieldDef.name, body);
    }

    const isAuthCollection = metaInfo[0].type === "auth";
    let authMethod = "email";
    if (isAuthCollection && metaInfo[0].oauth2) {
      const oauthCfg = parseMaybeJson(metaInfo[0].oauth2);
      authMethod = oauthCfg?.auth_method || "email";
    }

    const cleanBody: Record<string, any> = {};
    const finalKeys: string[] = [];
    const keys = Object.keys(body).filter(
      (k) => body[k] !== "" && body[k] !== undefined,
    );

    keys.forEach((k) => {
      if (k === "password" || k === "passwordConfirm") return;
      if (k.endsWith("_lat") || k.endsWith("_lon")) {
        const baseName = k.slice(0, -4);
        if (!cleanBody[baseName]) {
          cleanBody[baseName] = existingRecord[baseName] || {};
        }
        if (k.endsWith("_lat")) {
          cleanBody[baseName].lat = parseFloat(String(body[k]));
        } else {
          cleanBody[baseName].lon = parseFloat(String(body[k]));
        }
        if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
        return;
      }
      coerceFieldIntoBody(
        k,
        body,
        definedSchema,
        columnTypeByName,
        cleanBody,
        finalKeys,
        configuredTimeZone,
      );
    });

    if (isAuthCollection) {
      const password = typeof body.password === "string" ? body.password : "";
      const passwordConfirm =
        typeof body.passwordConfirm === "string" ? body.passwordConfirm : "";

      if (password) {
        if (password.length < 8) {
          return c.json(
            { error: "Password must be at least 8 characters when updated." },
            422,
          );
        }
        if (password !== passwordConfirm) {
          return c.json({ error: "Password and passwordConfirm must match." }, 422);
        }

        const hashResult =
          await sql`SELECT crypt(${password}, gen_salt('bf')) as hash`;
        cleanBody.password_hash = hashResult[0].hash;
        if (!finalKeys.includes("password_hash")) finalKeys.push("password_hash");
      }

      if (authMethod === "username" || authMethod === "both") {
        if (!cleanBody.username && existingRecord.username) {
          cleanBody.username = existingRecord.username;
        }
      } else {
        delete cleanBody.username;
        const idx = finalKeys.indexOf("username");
        if (idx > -1) finalKeys.splice(idx, 1);
      }

      if (authMethod === "email" || authMethod === "both") {
        if (!cleanBody.email && existingRecord.email) {
          cleanBody.email = existingRecord.email;
        }
      } else {
        delete cleanBody.email;
        const idx = finalKeys.indexOf("email");
        if (idx > -1) finalKeys.splice(idx, 1);
      }

      if (!finalKeys.includes("verified") && existingRecord.verified !== undefined) {
        cleanBody.verified = truthy(body.verified);
        finalKeys.push("verified");
      }
    }

    if (Object.prototype.hasOwnProperty.call(existingRecord, "updated_at")) {
      cleanBody.updated_at = new Date().toISOString();
      if (!finalKeys.includes("updated_at")) finalKeys.push("updated_at");
    }

    const updateAssignments = finalKeys
      .filter((key) => key !== "id")
      .map(
        (key) =>
          `"${key.replace(/"/g, '""')}" = ${escapeSqlLiteral(cleanBody[key])}`,
      );

    if (updateAssignments.length === 0) {
      return c.json({ error: "No changes to save." }, 422);
    }

    await sql.unsafe(
      `UPDATE ${quoteIdentifier(collectionName)} SET ${updateAssignments.join(", ")} WHERE id = ${escapeSqlLiteral(recordId)}`,
    );

    const updated = await sql`
      SELECT * FROM ${sql(collectionName)} WHERE id = ${recordId} LIMIT 1
    `;
    return c.json({ record: sanitizeRecord(updated[0]) });
  } catch (err: any) {
    return handleRouteError(c, err, "Error updating record");
  }
});

adminApi.post("/collections/:name/records/:id/delete", async (c) => {
  const collectionName = c.req.param("name");
  const recordId = c.req.param("id");

  try {
    assertValidCollectionName(collectionName);
    if (!UUID_REGEX.test(recordId)) {
      return c.json({ error: "Invalid record id." }, 400);
    }

    const metaInfo =
      await sql`SELECT type FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (metaInfo.length === 0 && collectionName !== "_users") {
      return c.json({ error: "Collection not found." }, 404);
    }
    if (metaInfo.length > 0 && metaInfo[0].type === "view") {
      return c.json({ error: "Views are read only." }, 405);
    }

    if (collectionName === "_users") {
      const targetRows = await sql`
        SELECT id, owner FROM _users WHERE id = ${recordId} LIMIT 1
      `;
      if (targetRows.length === 0) {
        return c.json({ error: "Record not found." }, 404);
      }
      if (targetRows[0].owner === true) {
        return c.json(
          { error: "Transfer ownership before deleting the current owner." },
          403,
        );
      }
    }

    const deleted = await sql`
      DELETE FROM ${sql(collectionName)} WHERE id = ${recordId} RETURNING id
    `;

    if (deleted.length === 0) {
      return c.json({ error: "Record not found." }, 404);
    }

    return c.json({ ok: true });
  } catch (err: any) {
    return handleRouteError(c, err, "Error deleting record");
  }
});

// ---------------------------------------------------------------------------
// Settings / delete
// ---------------------------------------------------------------------------

adminApi.post("/collections/:name/settings", async (c) => {
  const collectionName = c.req.param("name");
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  try {
    assertValidCollectionName(collectionName);
    if (collectionName.startsWith("_")) {
      return c.json({ error: "System collections cannot be modified here." }, 422);
    }

    const rawName =
      typeof body.name === "string" && body.name ? body.name : collectionName;
    const targetCollectionName = rawName
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (!targetCollectionName || !COLLECTION_NAME_REGEX.test(targetCollectionName)) {
      throw new ApiError("Invalid collection name.", 422);
    }
    if (targetCollectionName.startsWith("_")) {
      throw new ApiError(
        "Collection names cannot start with an underscore (reserved for system).",
        422,
      );
    }

    const currentMeta =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (currentMeta.length === 0) {
      return c.json({ error: "Collection not found." }, 404);
    }

    if (targetCollectionName !== collectionName) {
      const existing =
        await sql`SELECT name FROM _collections WHERE name = ${targetCollectionName} LIMIT 1`;
      if (existing.length > 0) {
        throw new ApiError(`Collection '${targetCollectionName}' already exists.`, 422);
      }
    }

    const isView = currentMeta[0].type === "view";
    let newSchema: any[] = [];
    const viewQuery =
      typeof body.view_query === "string" ? body.view_query.trim() : "";

    if (isView && !viewQuery) {
      throw new ApiError("View Collection requires a SELECT query.", 422);
    }

    let schemaProvided = false;
    if (Array.isArray(body.schema)) {
      newSchema = body.schema;
      schemaProvided = true;
    } else if (typeof body.schema === "string" && body.schema.trim()) {
      newSchema = JSON.parse(body.schema);
      schemaProvided = true;
    }

    if (!isView && schemaProvided) {
      const cleanUserFields = newSchema.filter((field: any) => !field.system);
      if (currentMeta[0].type === "base" && cleanUserFields.length === 0) {
        throw new ApiError("Base Collection must have at least one custom field.", 422);
      }

      const oldSchema = parseMaybeJson(currentMeta[0].schema) || [];

      // Compute deleted fields
      const newNames = newSchema.map((s: any) => s.originalName || s.name);
      const deletedFields = (Array.isArray(oldSchema) ? oldSchema : []).filter(
        (os: any) => !os.system && !newNames.includes(os.name),
      );

      for (const df of deletedFields) {
        await sql.unsafe(
          `ALTER TABLE "${collectionName}" DROP COLUMN "${df.name}" CASCADE`,
        );
      }

      // Compute added and renamed fields
      for (const ns of newSchema) {
        if (ns.system) continue;
        if (!ns.name || !COLLECTION_NAME_REGEX.test(ns.name))
          throw new ApiError(`Invalid field name: ${ns.name}`, 422);
        if (ns.isNew) {
          let safeType = "TEXT";
          switch (ns.type) {
            case "number":
              safeType = "NUMERIC";
              break;
            case "boolean":
              safeType = "BOOLEAN";
              break;
            case "date":
              safeType = "TIMESTAMP WITH TIME ZONE";
              break;
            case "date_only":
              safeType = "VARCHAR(10)";
              break;
            case "json":
              safeType = "JSONB";
              break;
            case "relation":
              safeType = "UUID";
              break;
          }
          await sql.unsafe(
            `ALTER TABLE "${collectionName}" ADD COLUMN "${ns.name}" ${safeType}`,
          );

          await syncFieldSqlConstraints(collectionName, ns, ns.name);

          delete ns.isNew;
          delete ns.originalName;
        } else {
          const oldField = (Array.isArray(oldSchema) ? oldSchema : []).find(
            (os: any) => os.name === ns.originalName,
          );

          if (ns.originalName && ns.originalName !== ns.name) {
            await sql.unsafe(
              `ALTER TABLE "${collectionName}" RENAME COLUMN "${ns.originalName}" TO "${ns.name}"`,
            );
          }

          await syncFieldSqlConstraints(
            collectionName,
            ns,
            oldField?.name || ns.originalName,
          );

          delete ns.originalName;
        }
      }

      // Indexes
      let customIndexes: any[] = [];
      if (Array.isArray(body.indexes)) customIndexes = body.indexes;
      else if (typeof body.indexes === "string" && body.indexes.trim())
        customIndexes = JSON.parse(body.indexes);

      for (const idx of customIndexes) {
        if (!idx || !idx.fields) continue;
        const columns = String(idx.fields)
          .split(",")
          .map((f: string) => f.trim().toLowerCase().replace(/\s+/g, "_"))
          .filter(Boolean);
        if (columns.length === 0) continue;
        for (const col of columns) {
          if (!COLLECTION_NAME_REGEX.test(col))
            throw new ApiError(`Invalid index column name: ${col}`, 422);
        }
        const indexName = `idx_${collectionName}_${columns.join("_")}`;

        if (idx.type === "unique") {
          try {
            await sql.unsafe(
              `ALTER TABLE "${collectionName}" ADD CONSTRAINT "uq_${indexName}" UNIQUE ("${columns.join('", "')}")`,
            );
          } catch (e) {} // Ignore if already exists
        } else {
          await sql.unsafe(
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${collectionName}" ("${columns.join('", "')}")`,
          );
        }
      }
    }

    let existingOauth2: any = {};
    try {
      existingOauth2 = parseMaybeJson(currentMeta[0].oauth2) || {};
    } catch (e) {
      existingOauth2 = {};
    }

    const mergedOauth2: any = {
      ...existingOauth2,
      google_enabled: truthy(body.google_enabled),
    };
    if (typeof body.auth_method === "string" && body.auth_method) {
      mergedOauth2.auth_method = body.auth_method;
    }

    if (targetCollectionName !== collectionName) {
      if (isView) {
        assertViewQuery(viewQuery);
        await sql.unsafe(
          `ALTER VIEW "${collectionName}" RENAME TO "${targetCollectionName}"`,
        );
      } else {
        await sql.unsafe(
          `ALTER TABLE "${collectionName}" RENAME TO "${targetCollectionName}"`,
        );
      }
    }

    if (isView) {
      assertViewQuery(viewQuery);
      await sql.unsafe(
        `CREATE OR REPLACE VIEW "${targetCollectionName}" AS ${viewQuery}`,
      );
    }

    const rule = (key: string) =>
      typeof body[key] === "string" ? body[key] : null;

    const schemaAssignment =
      !isView && schemaProvided
        ? sql`${JSON.stringify(newSchema)}::jsonb`
        : sql`schema`;

    await sql`
      UPDATE _collections
      SET
        name = ${targetCollectionName},
        view_query = ${isView ? viewQuery : sql`view_query`},
        list_rule = ${rule("list_rule")},
        view_rule = ${rule("view_rule")},
        create_rule = ${rule("create_rule")},
        update_rule = ${rule("update_rule")},
        delete_rule = ${rule("delete_rule")},
        schema = ${schemaAssignment},
        updated_at = NOW(),
        oauth2 = ${JSON.stringify(mergedOauth2)}::jsonb
      WHERE name = ${collectionName}
    `;

    const updated = await getCollectionMeta(targetCollectionName);
    return c.json({ collection: serializeCollection(updated) });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving settings");
  }
});

adminApi.delete("/collections/:name", async (c) => {
  const collectionName = c.req.param("name");
  try {
    assertValidCollectionName(collectionName);
    const meta =
      await sql`SELECT type FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0) {
      return c.json({ error: "Collection not found." }, 404);
    }

    if (meta[0].type !== "view") {
      await sql.unsafe(
        `DROP TABLE IF EXISTS ${quoteIdentifier(collectionName)} CASCADE`,
      );
    } else {
      await sql.unsafe(
        `DROP VIEW IF EXISTS ${quoteIdentifier(collectionName)} CASCADE`,
      );
    }

    await sql`DELETE FROM _collections WHERE name = ${collectionName}`;

    return c.json({ ok: true });
  } catch (err: any) {
    return handleRouteError(c, err, "Error deleting collection");
  }
});

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

adminApi.get("/system", async (c) => {
  let googleOauth: any = { enabled: false, client_id: "", client_secret: "" };
  let rateLimiting: { enabled: boolean; rules: any[] } = {
    enabled: false,
    rules: [],
  };
  try {
    const res =
      await sql`SELECT value FROM _settings WHERE key = 'google_oauth' LIMIT 1`;
    if (res.length > 0) {
      googleOauth =
        typeof res[0].value === "string" ? JSON.parse(res[0].value) : res[0].value;
    }
  } catch {}
  try {
    const res =
      await sql`SELECT value FROM _settings WHERE key = 'rate_limiting' LIMIT 1`;
    if (res.length > 0) {
      const parsed =
        typeof res[0].value === "string" ? JSON.parse(res[0].value) : res[0].value;
      if (parsed && typeof parsed === "object") {
        rateLimiting = {
          enabled: !!parsed.enabled,
          rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        };
      }
    }
  } catch {}

  return c.json({
    timezone: await getConfiguredTimeZone(),
    customEndpointsEnabled: isCustomEndpointsEnabled(),
    // The legacy settings page pre-fills the client secret into the form, so
    // the SPA gets it too. Only superadmins can reach this endpoint.
    googleOAuth: {
      enabled: !!googleOauth?.enabled,
      clientId: String(googleOauth?.client_id || ""),
      clientSecret: String(googleOauth?.client_secret || ""),
      redirectUrl: "/api/collections/auth-with-oauth2/google/callback",
    },
    rateLimiting,
  });
});

adminApi.post("/system/timezone", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  // Same validation as the legacy route: invalid IANA names fall back to UTC.
  const requestedTimeZone = safeTimeZone(
    typeof body.timezone === "string" ? body.timezone : "",
  );

  try {
    await sql`DELETE FROM _settings WHERE key = 'timezone'`;
    await sql`
      INSERT INTO _settings (key, value)
      VALUES ('timezone', ${JSON.stringify({ timezone: requestedTimeZone })}::jsonb)
    `;
    return c.json({ ok: true, timezone: requestedTimeZone });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving timezone");
  }
});

adminApi.post("/system/custom-endpoints", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  const enabled = truthy(body.enabled);

  try {
    await sql`DELETE FROM _settings WHERE key = 'custom_endpoints'`;
    await sql`
      INSERT INTO _settings (key, value)
      VALUES ('custom_endpoints', ${JSON.stringify({ enabled })}::jsonb)
    `;

    // Apply the change to the runtime flag immediately.
    setCustomEndpointsEnabled(enabled);

    // If enabling, make sure scripts are loaded; if disabling, clear the
    // runtime so handlers and crons stop immediately.
    try {
      if (enabled) {
        await loadCustomScripts();
      } else {
        await reloadCustomScripts();
      }
    } catch (e) {
      console.error("[custom-endpoints] Script load error after toggle:", e);
    }

    return c.json({ ok: true, enabled });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving custom endpoints setting");
  }
});

adminApi.post("/system/google-oauth", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  try {
    const next = {
      enabled: truthy(body.enabled),
      client_id: String(body.clientId ?? body.client_id ?? "").trim(),
      client_secret: String(body.clientSecret ?? body.client_secret ?? "").trim(),
    };

    await sql`DELETE FROM _settings WHERE key = 'google_oauth'`;
    await sql`
      INSERT INTO _settings (key, value)
      VALUES ('google_oauth', ${JSON.stringify(next)}::jsonb)
    `;

    return c.json({ ok: true });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving Google OAuth settings");
  }
});

adminApi.post("/system/rate-limiting", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  if (!Array.isArray(body.rules)) {
    return c.json({ error: "rules must be an array." }, 400);
  }

  try {
    const enabled = truthy(body.enabled);

    // Same cleaning criteria as the legacy handler, except rules that fail
    // validation are rejected with 422 instead of being silently dropped.
    const cleaned: Array<{
      label: string;
      pattern: string;
      maxRequests: number;
      intervalSeconds: number;
      targetedUsers: "all" | "guest" | "auth";
    }> = [];
    for (const r of body.rules) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return c.json({ error: "Each rule must be an object." }, 422);
      }
      const pattern = String(r.pattern || "").trim();
      if (!pattern) {
        return c.json({ error: "Each rule requires a path pattern." }, 422);
      }
      if (pattern.length > 512) {
        return c.json(
          { error: `Rule pattern is too long (max 512 chars): ${pattern.slice(0, 64)}...` },
          422,
        );
      }
      if (!/^[A-Za-z0-9._~:/?#\[\]@!$&'()+,;=\-*]+$/.test(pattern)) {
        return c.json(
          { error: `Rule pattern contains invalid characters: ${pattern}` },
          422,
        );
      }
      const maxRequests = Math.max(
        1,
        Math.min(1_000_000, Math.floor(Number(r.maxRequests) || 0)),
      );
      const intervalSeconds = Math.max(
        1,
        Math.min(86_400, Math.floor(Number(r.intervalSeconds) || 0)),
      );
      const targetedUsers: "all" | "guest" | "auth" =
        r.targetedUsers === "guest" || r.targetedUsers === "auth"
          ? r.targetedUsers
          : "all";
      const label = String(r.label || pattern).slice(0, 200);
      cleaned.push({ label, pattern, maxRequests, intervalSeconds, targetedUsers });
    }

    await sql`DELETE FROM _settings WHERE key = 'rate_limiting'`;
    await sql`
      INSERT INTO _settings (key, value)
      VALUES ('rate_limiting', ${JSON.stringify({ enabled, rules: cleaned })}::jsonb)
    `;
    invalidateRateLimitCache();

    return c.json({ ok: true });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving rate limiting settings");
  }
});

// ---------------------------------------------------------------------------
// Backups (pg_dump)
// ---------------------------------------------------------------------------

adminApi.get("/backups", async (c) => {
  try {
    const settings = await getPgBackupSettings();
    const files = await listPgBackupFiles();
    return c.json({
      settings,
      backups: files.map((file) => ({
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        createdAt: new Date(file.mtimeMs).toISOString(),
      })),
    });
  } catch (err: any) {
    return handleRouteError(c, err, "Error listing backups");
  }
});

adminApi.post("/backups/settings", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  try {
    const current = await getPgBackupSettings();
    const next: PgBackupSettings = {
      ...current,
      enabled: truthy(body.enabled),
      frequency: normalizePgBackupFrequency(String(body.frequency || "")),
      retainCount: normalizeRetainCount(body.retainCount ?? body.retain_count),
    };
    await savePgBackupSettings(next);
    await applyPgBackupRetention(next.retainCount);

    return c.json({ ok: true, settings: next });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving backup settings");
  }
});

adminApi.post("/backups/run", async (c) => {
  try {
    const result = await runPgDumpBackupOnce("manual");
    return c.json({ fileName: result.fileName });
  } catch (err: any) {
    console.error("Backup run error:", err);
    return c.json({ error: "Backup failed." }, 500);
  }
});

adminApi.post("/backups/restore", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  const filename = typeof body.filename === "string" ? body.filename : "";

  try {
    sanitizeBackupFilename(filename);
  } catch {
    return c.json({ error: "Invalid backup filename." }, 400);
  }

  try {
    await restorePgDumpBackup(filename);
    return c.json({ ok: true });
  } catch (err: any) {
    console.error("Backup restore error:", err);
    return c.json({ error: "Restore failed." }, 500);
  }
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

adminApi.post("/import", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  if (!Array.isArray(body.collections)) {
    return c.json({ error: "collections must be an array." }, 400);
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  const importRule = (value: unknown) =>
    typeof value === "string" ? value : null;

  for (const col of body.collections) {
    let name = "";
    try {
      name = typeof col?.name === "string" ? col.name.trim() : "";
      if (!name) throw new Error("Missing collection name");
      if (!COLLECTION_NAME_REGEX.test(name)) {
        throw new Error(
          "Collection name must contain only letters, numbers, and underscores.",
        );
      }
      if (name.startsWith("_")) {
        throw new Error(
          "Collection names cannot start with an underscore (reserved for system).",
        );
      }

      const type = col.type || "base";
      const schemaStr =
        typeof col.schema === "string"
          ? col.schema
          : Array.isArray(col.schema)
            ? JSON.stringify(col.schema)
            : "[]";
      const viewQuery = col.view_query || null;

      const existing =
        await sql`SELECT id FROM _collections WHERE name = ${name} LIMIT 1`;
      if (existing.length > 0) {
        skipped.push(name);
        continue;
      }

      if (type === "view") {
        if (!viewQuery) throw new Error("View requires view_query");
        assertReadOnlySqlQuery(viewQuery);
        await sql.unsafe(`CREATE OR REPLACE VIEW "${name}" AS ${viewQuery}`);
        await sql`
          INSERT INTO _collections
            (name, type, view_query, list_rule, view_rule, create_rule, update_rule, delete_rule)
          VALUES
            (${name}, ${type}, ${viewQuery}, ${importRule(col.list_rule)}, ${importRule(col.view_rule)}, ${importRule(col.create_rule)}, ${importRule(col.update_rule)}, ${importRule(col.delete_rule)})
        `;
      } else {
        const fields = JSON.parse(schemaStr);
        let query = `CREATE TABLE IF NOT EXISTS "${name}" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid()`;

        if (type === "auth") {
          query += `, email VARCHAR(255) UNIQUE, password_hash VARCHAR(255), token_key VARCHAR(255) DEFAULT gen_random_uuid()`;
        }

        for (const field of fields) {
          const safeName = String(field.name || "").replace(/[^a-zA-Z0-9_]/g, "");
          if (!safeName) {
            throw new Error(`Invalid field name: ${field.name}`);
          }
          const safeType = String(field.type || "").replace(
            /[^a-zA-Z0-9_\(\)\s]/g,
            "",
          );
          query += `, "${safeName}" ${safeType}`;
        }
        query += `,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`;

        await sql.unsafe(query);
        await sql`
          INSERT INTO _collections
            (name, type, schema, list_rule, view_rule, create_rule, update_rule, delete_rule)
          VALUES
            (${name}, ${type}, ${schemaStr}, ${importRule(col.list_rule)}, ${importRule(col.view_rule)}, ${importRule(col.create_rule)}, ${importRule(col.update_rule)}, ${importRule(col.delete_rule)})
        `;
      }

      created.push(name);
    } catch (err: any) {
      console.error("Collection import error:", err);
      errors.push({
        name: name || "(unknown)",
        error: String(err?.message || "Unknown error"),
      });
    }
  }

  return c.json({ created, skipped, errors });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

adminApi.get("/logs", async (c) => {
  try {
    const logs = await sql`
      SELECT id, method, url, status, error, collection, user_ip, user_agent, created_at
      FROM _logs
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return c.json({ logs });
  } catch (err: any) {
    return handleRouteError(c, err, "Error loading logs");
  }
});

// ---------------------------------------------------------------------------
// SQL explorer
// ---------------------------------------------------------------------------

const SQL_EXPLORER_ROW_CAP = 500;

adminApi.post("/sql-explorer", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);
  const query = typeof body.query === "string" ? body.query : "";

  if (!query.trim()) {
    return c.json({ error: "Query cannot be empty." }, 400);
  }
  try {
    assertReadOnlySqlQuery(query);
  } catch (err: any) {
    return c.json({ error: err.message }, 422);
  }

  try {
    const start = performance.now();
    const result = await sql.unsafe(query);
    const durationMs = Math.round(performance.now() - start);

    const allRows: any[] = Array.isArray(result) ? result : [];
    const columns = allRows.length > 0 ? Object.keys(allRows[0]) : [];
    const rows = allRows
      .slice(0, SQL_EXPLORER_ROW_CAP)
      .map((row) => columns.map((col) => row[col]));

    return c.json({
      columns,
      rows,
      rowCount: allRows.length,
      truncated: allRows.length > SQL_EXPLORER_ROW_CAP,
      durationMs,
    });
  } catch (err: any) {
    console.error("SQL explorer error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Custom endpoints
// ---------------------------------------------------------------------------

adminApi.get("/custom-endpoints", async (c) => {
  try {
    const files = await listCustomEndpointFiles();
    return c.json({
      enabled: isCustomEndpointsEnabled(),
      files: files.map((file) => ({
        name: file.fileName,
        sizeBytes: file.size,
        updatedAt: new Date(file.updatedAt).toISOString(),
      })),
      routes: getRegisteredEndpointPaths(),
    });
  } catch (err: any) {
    return handleRouteError(c, err, "Error listing custom endpoints");
  }
});

adminApi.get("/custom-endpoints/:file", async (c) => {
  const file = c.req.param("file");
  try {
    const content = await readCustomEndpointFile(file);
    return c.json({ name: file, content });
  } catch {
    return c.json({ error: "Custom endpoint file not found." }, 404);
  }
});

adminApi.post("/custom-endpoints", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const originalName =
    typeof body.originalName === "string" ? body.originalName.trim() : "";

  if (!name) {
    return c.json({ error: "File name is required." }, 422);
  }

  try {
    const normalizedName = await writeCustomEndpointFile(name, content);
    if (originalName && originalName !== normalizedName) {
      await deleteCustomEndpointFile(originalName);
    }
    return c.json({ ok: true, name: normalizedName });
  } catch (err: any) {
    return handleRouteError(c, err, "Error saving custom endpoint");
  }
});

adminApi.post("/custom-endpoints/delete", async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "Missing file name." }, 422);
  }

  try {
    await deleteCustomEndpointFile(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return handleRouteError(c, err, "Error deleting custom endpoint");
  }
});

export default adminApi;
