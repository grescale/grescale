import { Hono } from "hono";
import type { Context } from "hono";
import { verify } from "hono/jwt";
import { existsSync, watch } from "fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import path from "path";
import sql from "../db/db.ts";
import { satisfiesRule, type RuleEvaluationContext } from "../ruleEngine.ts";
import { buildSafeSqlFilter } from "../sqlSafety.ts";
import { getRequiredJwtSecret } from "../security.ts";
import {
  ContentfulStatusCode,
  RedirectStatusCode,
} from "hono/utils/http-status";

const customEndpointsDir = path.resolve(process.cwd(), "custom_endpoints");

export const customRouter = new Hono();

type SqlExecutor = any;

type CollectionMeta = {
  name: string;
  type: string;
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
};

type CollectionListOptions = {
  filter?: string;
  page?: number;
  perPage?: number;
};

type CollectionApi = {
  list: (options?: CollectionListOptions) => Promise<{
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
    items: any[];
  }>;
  find: (
    filter?: string,
    options?: Omit<CollectionListOptions, "filter">,
  ) => Promise<any[]>;
  filter: (
    filter?: string,
    options?: Omit<CollectionListOptions, "filter">,
  ) => Promise<any[]>;
  first: (filter?: string) => Promise<any | null>;
  count: (filter?: string) => Promise<number>;
  get: (id: string) => Promise<any | null>;
  getById: (id: string) => Promise<any | null>;
  create: (data: Record<string, any>) => Promise<any>;
  createWithoutValidation: (data: Record<string, any>) => Promise<any>;
  update: (id: string, data: Record<string, any>) => Promise<any>;
  updateWithoutValidation: (
    id: string,
    data: Record<string, any>,
  ) => Promise<any>;
  delete: (id: string) => Promise<boolean>;
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
};

type RuntimeApi = {
  collection: (name: string) => Promise<CollectionApi>;
  record: (name: string, id: string) => Promise<any | null>;
  transaction: <T>(
    handler: (ctx: { sql: SqlExecutor; db: RuntimeApi }) => Promise<T> | T,
  ) => Promise<T>;
};

type CustomHookContext = {
  req: Context["req"];
  res: Context["res"];
  request: Request;
  url: URL;
  method: string;
  params: Record<string, string>;
  sql: SqlExecutor;
  auth: () => Promise<any | null>;
  requestInfo: () => RuleEvaluationContext;
  body: () => Promise<any>;
  query: (name: string) => string | undefined;
  param: (name: string) => string | undefined;
  header: (name: string) => string | null;
  json: (data: any, status?: number) => Response;
  text: (data: string, status?: number) => Response;
  html: (data: string, status?: number) => Response;
  redirect: (location: string, status?: number) => Response;
  db: RuntimeApi;
  transaction: <T>(
    handler: (ctx: { sql: SqlExecutor; db: RuntimeApi }) => Promise<T> | T,
  ) => Promise<T>;
  canAccess: (
    collectionOrRecord: Record<string, any> | null,
    auth: any,
    rule: string | null,
    context?: Partial<RuleEvaluationContext>,
  ) => boolean;
  canAccessCollection: (
    collectionOrRecord: Record<string, any> | null,
    requestInfo: RuleEvaluationContext,
    rule: string | null,
  ) => boolean;
  listRule: (collectionName?: string) => Promise<string | null>;
  viewRule: (collectionName?: string) => Promise<string | null>;
  createRule: (collectionName?: string) => Promise<string | null>;
  updateRule: (collectionName?: string) => Promise<string | null>;
  deleteRule: (collectionName?: string) => Promise<string | null>;
  rules: (collectionName?: string) => Promise<{
    listRule: string | null;
    viewRule: string | null;
    createRule: string | null;
    updateRule: string | null;
    deleteRule: string | null;
  }>;
  saveImage: (
    formField: string,
    folder: string,
    options?: {
      maxBytes?: number;
      allowedMimeTypes?: string[];
      formData?: FormData;
    },
  ) => Promise<{
    field: string;
    fileName: string;
    mimeType: string;
    size: number;
    folder: string;
    relativePath: string;
    publicPath: string;
    absolutePath: string;
  }>;
  collection: (name: string) => Promise<CollectionApi>;
  record: (name: string, id: string) => Promise<any | null>;
};

type EndpointHandler = {
  fileName: string;
  method: string;
  path: string;
  regex: RegExp;
  paramNames: string[];
  handler: (c: CustomHookContext) => any;
};

type CronHandler = {
  fileName: string;
  schedule: string;
  generation: number;
  handler: (ctx: {
    sql: typeof sql;
    db: RuntimeApi;
    fileName: string;
    schedule: string;
  }) => any;
};

const protectedRecordFields = new Set([
  "id",
  "created",
  "updated",
  "created_at",
  "updated_at",
  "token_key",
  "password_hash",
]);

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFileName(input: string) {
  const safe = input
    .trim()
    .replace(/[\\/]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe) throw new Error("File name is required.");
  if (safe.endsWith(".gs.js")) return safe;
  if (safe.endsWith(".js")) return `${safe.slice(0, -3)}gs.js`;
  return `${safe}.gs.js`;
}

function normalizeEndpointPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Route path is required.");
  if (trimmed.startsWith("/api/")) return trimmed;
  if (trimmed.startsWith("/")) return `/api${trimmed}`;
  return `/api/${trimmed}`;
}

function escapeSqlLiteral(value: any) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date)
    return `'${value.toISOString().replace(/'/g, "''")}'`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeFilterExpression(
  filter?: string,
  allowedColumns?: Iterable<string>,
) {
  if (!allowedColumns) return "";
  return buildSafeSqlFilter(filter, allowedColumns);
}

function assertCollectionName(collectionName: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(collectionName)) {
    throw new Error(`Invalid collection name: ${collectionName}`);
  }
}

async function getCollectionColumns(
  collectionName: string,
  executor: SqlExecutor = sql,
): Promise<Set<string>> {
  assertCollectionName(collectionName);
  const columns = await executor`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${collectionName}
  `;

  return new Set<string>(
    columns.map((column: any) => String(column.column_name)),
  );
}

function cleanRecordInput(
  data: Record<string, any>,
  availableColumns: Set<string>,
) {
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (protectedRecordFields.has(key)) continue;
    if (!availableColumns.has(key)) continue;
    if (value === undefined) continue;
    clean[key] = value;
  }
  return clean;
}

async function validateRecordInput(
  data: Record<string, any>,
  collectionName: string,
  executor: SqlExecutor = sql,
) {
  const result = await executor`
    SELECT schema FROM _collections WHERE name = ${collectionName} LIMIT 1
  `;

  if (result.length === 0) {
    throw makeHttpError(500, "Collection not found");
  }

  let schema: any[] = [];
  const schemaData = result[0].schema;
  if (schemaData) {
    schema =
      typeof schemaData === "string" ? JSON.parse(schemaData) : schemaData;
  }

  for (const [fieldName, value] of Object.entries(data || {})) {
    const fieldDef = schema.find((f) => f.name === fieldName);
    if (!fieldDef) continue;

    const fieldType = fieldDef.type?.toLowerCase() || "text";

    if (
      fieldDef.required &&
      (value === null || value === undefined || value === "")
    ) {
      throw makeHttpError(400, `Field "${fieldName}" is required`);
    }

    if (value === null || value === undefined) continue;

    switch (fieldType) {
      case "number":
        if (typeof value !== "number") {
          const num = Number(value);
          if (isNaN(num)) {
            throw makeHttpError(
              400,
              `Field "${fieldName}" must be a valid number`,
            );
          }
        }
        const numVal = typeof value === "number" ? value : Number(value);
        if (fieldDef.nonzero && numVal === 0) {
          throw makeHttpError(400, `Field "${fieldName}" must be non-zero`);
        }
        if (
          fieldDef.min !== undefined &&
          fieldDef.min !== null &&
          fieldDef.min !== ""
        ) {
          const min = Number(fieldDef.min);
          if (numVal < min) {
            throw makeHttpError(
              400,
              `Field "${fieldName}" must be at least ${min}`,
            );
          }
        }
        if (
          fieldDef.max !== undefined &&
          fieldDef.max !== null &&
          fieldDef.max !== ""
        ) {
          const max = Number(fieldDef.max);
          if (numVal > max) {
            throw makeHttpError(
              400,
              `Field "${fieldName}" must be at most ${max}`,
            );
          }
        }
        break;

      case "text":
      case "richtext":
      case "email":
      case "url":
        const strVal = String(value);
        if (fieldDef.regex && fieldDef.regex.trim()) {
          const regex = new RegExp(fieldDef.regex);
          if (!regex.test(strVal)) {
            throw makeHttpError(
              400,
              `Field "${fieldName}" does not match the required pattern`,
            );
          }
        }
        if (fieldType === "email") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(strVal)) {
            throw makeHttpError(
              400,
              `Field "${fieldName}" must be a valid email`,
            );
          }
        }
        if (fieldType === "url") {
          try {
            new URL(strVal);
          } catch {
            throw makeHttpError(
              400,
              `Field "${fieldName}" must be a valid URL`,
            );
          }
        }
        break;

      case "boolean":
        if (typeof value !== "boolean") {
          throw makeHttpError(400, `Field "${fieldName}" must be a boolean`);
        }
        break;

      case "date":
      case "datetime":
        if (!(value instanceof Date) && typeof value !== "string") {
          throw makeHttpError(400, `Field "${fieldName}" must be a valid date`);
        }
        if (typeof value === "string") {
          if (isNaN(Date.parse(value))) {
            throw makeHttpError(
              400,
              `Field "${fieldName}" must be a valid date string`,
            );
          }
        }
        break;

      case "date_only":
        const dateStr = String(value);
        const format = fieldDef.date_format || "YYYY-MM-DD";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && format === "YYYY-MM-DD") {
          throw makeHttpError(
            400,
            `Field "${fieldName}" must be in YYYY-MM-DD format`,
          );
        }
        break;

      case "json":
      case "jsonb":
        if (typeof value === "string") {
          try {
            JSON.parse(value);
          } catch {
            throw makeHttpError(400, `Field "${fieldName}" must be valid JSON`);
          }
        } else if (typeof value !== "object") {
          throw makeHttpError(
            400,
            `Field "${fieldName}" must be a JSON object`,
          );
        }
        break;

      case "uuid":
        const uuidStr = String(value);
        const uuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(uuidStr)) {
          throw makeHttpError(400, `Field "${fieldName}" must be a valid UUID`);
        }
        break;

      case "relation":
        const relId = String(value);
        const relUuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!relUuidRegex.test(relId)) {
          throw makeHttpError(
            400,
            `Field "${fieldName}" must be a valid UUID for the relation`,
          );
        }
        break;

      case "file":
        if (typeof value !== "string") {
          throw makeHttpError(
            400,
            `Field "${fieldName}" must be a string path`,
          );
        }
        break;
    }
  }
}

function makeHttpError(status: number, message: string) {
  return new HttpError(status, message);
}

function buildQueryMap(url: string) {
  const query: Record<string, string> = {};
  const searchParams = new URL(url).searchParams;
  searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return query;
}

function getJwtSecret() {
  return getRequiredJwtSecret();
}

function canAccess(
  collectionOrRecord: Record<string, any> | null,
  auth: any,
  rule: string | null,
  context: Partial<RuleEvaluationContext> = {},
) {
  return satisfiesRule(rule, {
    collectionName: context.collectionName || "",
    ...context,
    user: auth,
    collection: context.collection || collectionOrRecord || undefined,
  });
}

async function resolveRequestAuthUser(c: Context) {
  const authHeader = c.req.header("Authorization");
  const token =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  if (!token) {
    return null;
  }

  const secret = getJwtSecret();
  try {
    return await verify(token, secret, "HS256");
  } catch {
    return null;
  }
}

async function getCollectionMeta(
  collectionName: string,
  executor: SqlExecutor = sql,
): Promise<CollectionMeta> {
  const rows = await executor`
    SELECT name, type, list_rule, view_rule, create_rule, update_rule, delete_rule
    FROM _collections
    WHERE name = ${collectionName}
    LIMIT 1
  `;

  if (!rows.length) {
    throw makeHttpError(404, "Collection not found");
  }

  return rows[0] as CollectionMeta;
}

function sanitizeUploadFolder(folder: string) {
  const normalized = (folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");

  const safeSegments = normalized.map((segment) =>
    segment.replace(/[^a-zA-Z0-9._-]/g, "-"),
  );

  const safeFolder = safeSegments.join("/");
  if (!safeFolder) {
    throw makeHttpError(400, "A valid upload folder is required");
  }

  return safeFolder;
}

function inferFileExtension(file: File) {
  const byName = (file.name || "").split(".").pop() || "";
  const safeNameExt = byName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (safeNameExt) return safeNameExt;

  const mimeMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
  };

  return mimeMap[file.type] || "bin";
}

async function createCollectionApi(
  collectionName: string,
  executor: SqlExecutor = sql,
): Promise<CollectionApi> {
  assertCollectionName(collectionName);
  const meta = await getCollectionMeta(collectionName, executor);
  const collectionColumns = await getCollectionColumns(
    collectionName,
    executor,
  );

  return {
    async list(options: CollectionListOptions = {}) {
      const page = Math.max(1, options.page || 1);
      const perPage = Math.min(200, Math.max(1, options.perPage || 50));
      const offset = (page - 1) * perPage;
      const filterClause = normalizeFilterExpression(
        options.filter,
        collectionColumns,
      );

      const selectSql = filterClause
        ? executor.unsafe(
            `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${filterClause} LIMIT ${perPage} OFFSET ${offset}`,
          )
        : executor`SELECT * FROM ${executor(collectionName)} LIMIT ${perPage} OFFSET ${offset}`;

      const countSql = filterClause
        ? executor.unsafe(
            `SELECT count(*) as count FROM ${quoteIdentifier(collectionName)} WHERE ${filterClause}`,
          )
        : executor`SELECT count(*) as count FROM ${executor(collectionName)}`;

      const [items, totalCountRes] = await Promise.all([selectSql, countSql]);
      const totalItems = parseInt(totalCountRes[0].count, 10);

      return {
        page,
        perPage,
        totalItems,
        totalPages: Math.ceil(totalItems / perPage),
        items,
      };
    },

    async find(
      filter?: string,
      options: Omit<CollectionListOptions, "filter"> = {},
    ) {
      const page = Math.max(1, options.page || 1);
      const perPage = Math.min(200, Math.max(1, options.perPage || 50));
      const offset = (page - 1) * perPage;
      const filterClause = normalizeFilterExpression(filter, collectionColumns);

      const selectSql = filterClause
        ? executor.unsafe(
            `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${filterClause} LIMIT ${perPage} OFFSET ${offset}`,
          )
        : executor`SELECT * FROM ${executor(collectionName)} LIMIT ${perPage} OFFSET ${offset}`;

      const items = await selectSql;
      return items;
    },

    async filter(
      filter?: string,
      options: Omit<CollectionListOptions, "filter"> = {},
    ) {
      const page = Math.max(1, options.page || 1);
      const perPage = Math.min(200, Math.max(1, options.perPage || 50));
      const offset = (page - 1) * perPage;
      const filterClause = normalizeFilterExpression(filter, collectionColumns);

      const selectSql = filterClause
        ? executor.unsafe(
            `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${filterClause} LIMIT ${perPage} OFFSET ${offset}`,
          )
        : executor`SELECT * FROM ${executor(collectionName)} LIMIT ${perPage} OFFSET ${offset}`;

      const items = await selectSql;
      return items;
    },

    async first(filter?: string) {
      const filterClause = normalizeFilterExpression(filter, collectionColumns);

      const selectSql = filterClause
        ? executor.unsafe(
            `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${filterClause} LIMIT 1 OFFSET 0`,
          )
        : executor`SELECT * FROM ${executor(collectionName)} LIMIT 1 OFFSET 0`;

      const items = await selectSql;
      return items[0] || null;
    },

    async count(filter?: string) {
      const filterClause = normalizeFilterExpression(filter, collectionColumns);
      const result = filterClause
        ? await executor.unsafe(
            `SELECT count(*) as count FROM ${quoteIdentifier(collectionName)} WHERE ${filterClause}`,
          )
        : await executor`SELECT count(*) as count FROM ${executor(collectionName)}`;
      return parseInt(result[0].count, 10);
    },

    async get(id: string) {
      const rows = await executor`
        SELECT * FROM ${executor(collectionName)} WHERE id = ${id} LIMIT 1
      `;
      return rows[0] || null;
    },

    async getById(id: string) {
      const rows = await executor`
        SELECT * FROM ${executor(collectionName)} WHERE id = ${id} LIMIT 1
      `;
      return rows[0] || null;
    },

    async create(data: Record<string, any>) {
      const meta = await getCollectionMeta(collectionName, executor);
      if (meta.type === "view") {
        throw makeHttpError(400, "Views are read-only");
      }

      await validateRecordInput(data, collectionName, executor);

      const availableColumns = await getCollectionColumns(
        collectionName,
        executor,
      );
      const clean = cleanRecordInput(data, availableColumns);
      const keys = Object.keys(clean);

      if (keys.length === 0) {
        throw new Error("No writable fields provided.");
      }

      const columnsSql = keys.map((key) => quoteIdentifier(key)).join(", ");
      const valuesSql = keys
        .map((key) => escapeSqlLiteral(clean[key]))
        .join(", ");

      const inserted = await executor.unsafe(
        `INSERT INTO ${quoteIdentifier(collectionName)} (${columnsSql}) VALUES (${valuesSql}) RETURNING *`,
      );

      return inserted[0];
    },

    async createWithoutValidation(data: Record<string, any>) {
      const meta = await getCollectionMeta(collectionName, executor);
      if (meta.type === "view") {
        throw makeHttpError(400, "Views are read-only");
      }

      const availableColumns = await getCollectionColumns(
        collectionName,
        executor,
      );
      const clean = cleanRecordInput(data, availableColumns);
      const keys = Object.keys(clean);

      if (keys.length === 0) {
        throw new Error("No writable fields provided.");
      }

      const columnsSql = keys.map((key) => quoteIdentifier(key)).join(", ");
      const valuesSql = keys
        .map((key) => escapeSqlLiteral(clean[key]))
        .join(", ");

      const inserted = await executor.unsafe(
        `INSERT INTO ${quoteIdentifier(collectionName)} (${columnsSql}) VALUES (${valuesSql}) RETURNING *`,
      );

      return inserted[0];
    },

    async update(id: string, data: Record<string, any>) {
      const meta = await getCollectionMeta(collectionName, executor);
      if (meta.type === "view") {
        throw makeHttpError(400, "Views are read-only");
      }
      const existing = await executor`
        SELECT * FROM ${executor(collectionName)} WHERE id = ${id} LIMIT 1
      `;
      if (!existing.length) {
        return null;
      }

      await validateRecordInput(data, collectionName, executor);

      const availableColumns = await getCollectionColumns(
        collectionName,
        executor,
      );
      const clean = cleanRecordInput(data, availableColumns);
      const keys = Object.keys(clean);

      if (keys.length === 0) {
        throw new Error("No writable fields provided.");
      }

      const assignments = keys
        .map(
          (key) => `${quoteIdentifier(key)} = ${escapeSqlLiteral(clean[key])}`,
        )
        .join(", ");

      const updated = await executor.unsafe(
        `UPDATE ${quoteIdentifier(collectionName)} SET ${assignments}${availableColumns.has("updated_at") ? ', "updated_at" = NOW()' : ""} WHERE id = ${escapeSqlLiteral(id)} RETURNING *`,
      );

      return updated[0] || null;
    },

    async updateWithoutValidation(id: string, data: Record<string, any>) {
      const meta = await getCollectionMeta(collectionName, executor);
      if (meta.type === "view") {
        throw makeHttpError(400, "Views are read-only");
      }
      const existing = await executor`
        SELECT * FROM ${executor(collectionName)} WHERE id = ${id} LIMIT 1
      `;
      if (!existing.length) {
        return null;
      }

      const availableColumns = await getCollectionColumns(
        collectionName,
        executor,
      );
      const clean = cleanRecordInput(data, availableColumns);
      const keys = Object.keys(clean);

      if (keys.length === 0) {
        throw new Error("No writable fields provided.");
      }

      const assignments = keys
        .map(
          (key) => `${quoteIdentifier(key)} = ${escapeSqlLiteral(clean[key])}`,
        )
        .join(", ");

      const updated = await executor.unsafe(
        `UPDATE ${quoteIdentifier(collectionName)} SET ${assignments}${availableColumns.has("updated_at") ? ', "updated_at" = NOW()' : ""} WHERE id = ${escapeSqlLiteral(id)} RETURNING *`,
      );

      return updated[0] || null;
    },

    async delete(id: string) {
      const meta = await getCollectionMeta(collectionName, executor);
      if (meta.type === "view") {
        throw makeHttpError(400, "Views are read-only");
      }

      const existing = await executor`
        SELECT * FROM ${executor(collectionName)} WHERE id = ${id} LIMIT 1
      `;
      if (!existing.length) {
        return false;
      }

      const result = await executor`
        DELETE FROM ${executor(collectionName)} WHERE id = ${id}
      `;
      return (result.count || 0) > 0;
    },
    listRule: meta.list_rule,
    viewRule: meta.view_rule,
    createRule: meta.create_rule,
    updateRule: meta.update_rule,
    deleteRule: meta.delete_rule,
  };
}

function createRuntimeApi(executor: SqlExecutor = sql): RuntimeApi {
  return {
    collection: (name: string) => createCollectionApi(name, executor),
    record: async (name: string, id: string) => {
      return await (await createCollectionApi(name, executor)).get(id);
    },
    transaction: async <T>(
      handler: (ctx: { sql: SqlExecutor; db: RuntimeApi }) => Promise<T> | T,
    ) => {
      if (typeof executor.begin !== "function") {
        throw new Error("Current SQL executor does not support transactions.");
      }

      return await executor.begin(async (tx: SqlExecutor) => {
        const txRuntimeApi = createRuntimeApi(tx);
        return await handler({ sql: tx, db: txRuntimeApi });
      });
    },
  };
}

function compileRoutePattern(routePath: string) {
  const segments = routePath.split("/").filter(Boolean);
  const paramNames: string[] = [];
  const regexSegments = segments.map((segment) => {
    if (segment === "*") return ".*";
    if (segment.startsWith(":")) {
      paramNames.push(segment.slice(1));
      return "([^/]+)";
    }
    return escapeRegex(segment);
  });

  return {
    paramNames,
    regex: new RegExp(`^/${regexSegments.join("/")}/?$`),
  };
}

async function buildHookContext(
  c: Context,
  params: Record<string, string> = {},
): Promise<CustomHookContext> {
  const requestUrl = new URL(c.req.url);
  const requestQuery = buildQueryMap(c.req.url);
  const authCache = await resolveRequestAuthUser(c);
  const auth = async () => authCache;
  const runtimeApi = createRuntimeApi(sql);
  let cachedFormData: FormData | null = null;
  let cachedBodyReady = false;
  let cachedBody: any = null;

  const ensureFormData = async () => {
    if (cachedFormData) return cachedFormData;
    cachedFormData = await c.req.raw.formData();
    return cachedFormData;
  };

  const resolveCollectionName = (collectionName?: string) => {
    const resolved =
      collectionName || params.collection || c.req.param("collection") || "";
    if (!resolved) {
      throw makeHttpError(400, "Collection name is required for rule helper");
    }
    assertCollectionName(resolved);
    return resolved;
  };

  const loadRulesForCollection = async (collectionName?: string) => {
    const resolved = resolveCollectionName(collectionName);
    const meta = await getCollectionMeta(resolved, sql);
    return {
      listRule: meta.list_rule,
      viewRule: meta.view_rule,
      createRule: meta.create_rule,
      updateRule: meta.update_rule,
      deleteRule: meta.delete_rule,
    };
  };

  const defaultCollectionName =
    params.collection || c.req.param("collection") || "";

  const requestInfo = (context: Partial<RuleEvaluationContext> = {}) => ({
    user: authCache,
    collectionName: context.collectionName || defaultCollectionName,
    method: c.req.method,
    path: requestUrl.pathname,
    query: requestQuery,
    ...context,
  });

  return {
    req: c.req,
    res: c.res,
    request: c.req.raw,
    url: requestUrl,
    method: c.req.method,
    params,
    sql,
    auth,
    requestInfo: () => requestInfo(),
    body: async () => {
      if (cachedBodyReady) return cachedBody;
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("application/json")) {
        cachedBody = await c.req.json();
        cachedBodyReady = true;
        return cachedBody;
      }
      if (contentType.includes("multipart/form-data")) {
        cachedBody = Object.fromEntries((await ensureFormData()).entries());
        cachedBodyReady = true;
        return cachedBody;
      }
      cachedBody = await c.req.parseBody();
      cachedBodyReady = true;
      return cachedBody;
    },
    query: (name: string) => c.req.query(name) || undefined,
    param: (name: string) => params[name] || c.req.param(name),
    header: (name: string) => c.req.header(name),
    json: (data: any, status: ContentfulStatusCode = 200) =>
      c.json(data, status),
    text: (data: string, status: ContentfulStatusCode = 200) =>
      c.text(data, status),
    html: (data: string, status: ContentfulStatusCode = 200) =>
      c.html(data, status),
    redirect: (location: string, status: RedirectStatusCode = 302) =>
      c.redirect(location, status),
    db: runtimeApi,
    transaction: runtimeApi.transaction,
    canAccess: (collectionOrRecord, authUser, rule, context = {}) => {
      const collectionName =
        context.collectionName ||
        params.collection ||
        c.req.param("collection") ||
        "";
      return canAccess(collectionOrRecord, authUser, rule, {
        method: c.req.method,
        path: requestUrl.pathname,
        query: requestQuery,
        collectionName,
        ...context,
      });
    },
    canAccessCollection: (collectionOrRecord, info, rule) => {
      return canAccess(collectionOrRecord, info?.user || authCache, rule, {
        ...requestInfo(),
        ...(info || {}),
        collection: info?.collection || collectionOrRecord || undefined,
      });
    },
    rules: (collectionName?: string) => loadRulesForCollection(collectionName),
    listRule: async (collectionName?: string) =>
      (await loadRulesForCollection(collectionName)).listRule,
    viewRule: async (collectionName?: string) =>
      (await loadRulesForCollection(collectionName)).viewRule,
    createRule: async (collectionName?: string) =>
      (await loadRulesForCollection(collectionName)).createRule,
    updateRule: async (collectionName?: string) =>
      (await loadRulesForCollection(collectionName)).updateRule,
    deleteRule: async (collectionName?: string) =>
      (await loadRulesForCollection(collectionName)).deleteRule,
    saveImage: async (formField, folder, options = {}) => {
      const formData = options.formData || (await ensureFormData());
      const value = formData.get(formField);
      if (!(value instanceof File)) {
        throw makeHttpError(400, `${formField} must be a file`);
      }
      if (!value.type || !value.type.startsWith("image/")) {
        throw makeHttpError(400, `${formField} must be an image`);
      }
      if (options.allowedMimeTypes && options.allowedMimeTypes.length > 0) {
        if (!options.allowedMimeTypes.includes(value.type)) {
          throw makeHttpError(400, `${formField} has unsupported mime type`);
        }
      }
      if (options.maxBytes && value.size > options.maxBytes) {
        throw makeHttpError(400, `${formField} exceeds maximum size`);
      }

      const safeFolder = sanitizeUploadFolder(folder);
      const extension = inferFileExtension(value);
      const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const relativePath = `${safeFolder}/${fileName}`;
      const absolutePath = path.resolve(process.cwd(), relativePath);

      await mkdir(path.dirname(absolutePath), { recursive: true });
      if (typeof Bun !== "undefined" && typeof Bun.write === "function") {
        await Bun.write(absolutePath, value);
      } else {
        const bytes = new Uint8Array(await value.arrayBuffer());
        await writeFile(absolutePath, bytes);
      }

      return {
        field: formField,
        fileName,
        mimeType: value.type,
        size: value.size,
        folder: safeFolder,
        relativePath,
        publicPath: `/${relativePath}`,
        absolutePath,
      };
    },
    collection: async (name: string) => {
      const api = await runtimeApi.collection(name);
      return api;
    },
    record: runtimeApi.record,
  };
}

function normalizeHandlerResult(c: Context, result: any) {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return c.res;
  if (typeof result === "string") return c.text(result);
  if (typeof result === "object") return c.json(result);
  return c.text(String(result));
}

async function ensureCustomEndpointDir() {
  await mkdir(customEndpointsDir, { recursive: true });
}

async function listEndpointFileNames() {
  await ensureCustomEndpointDir();
  const entries = await readdir(customEndpointsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gs.js"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function createRouterAdd(fileName: string) {
  return (
    method: string,
    routePath: string,
    handler: (c: CustomHookContext) => any,
  ) => {
    const normalizedMethod = (method || "GET").toUpperCase();
    const normalizedPath = normalizeEndpointPath(routePath);
    const { regex, paramNames } = compileRoutePattern(normalizedPath);

    endpointHandlers.push({
      fileName,
      method: normalizedMethod,
      path: normalizedPath,
      regex,
      paramNames,
      handler,
    });
  };
}

function createCronAdd(fileName: string) {
  return (
    schedule: string,
    handler: (ctx: {
      sql: typeof sql;
      db: RuntimeApi;
      fileName: string;
      schedule: string;
    }) => any,
  ) => {
    const generation = runtimeGeneration;
    cronHandlers.push({ fileName, schedule, generation, handler });

    if (typeof Bun !== "undefined" && typeof Bun.cron === "function") {
      Bun.cron(schedule, async () => {
        if (generation !== runtimeGeneration) return;
        try {
          const runtimeApi = createRuntimeApi();
          await handler({ sql, db: runtimeApi, fileName, schedule });
        } catch (error) {
          console.error(`Error executing cron script ${fileName}:`, error);
        }
      });
    }
  };
}

async function loadEndpointFile(fileName: string) {
  const filePath = path.join(customEndpointsDir, fileName);
  if (!existsSync(filePath)) return;

  const code = await readFile(filePath, "utf-8");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  try {
    const routerAdd = createRouterAdd(fileName);
    const cronAdd = createCronAdd(fileName);
    const runtimeApi = createRuntimeApi();
    const compiled = new AsyncFunction(
      "routerAdd",
      "cronAdd",
      "sql",
      "db",
      "console",
      "fileName",
      "HttpError",
      "BadRequestError",
      "UnauthorizedError",
      "ForbiddenError",
      "NotFoundError",
      "ConflictError",
      "InternalServerError",
      code,
    );
    await compiled(
      routerAdd,
      cronAdd,
      sql,
      runtimeApi,
      console,
      fileName,
      HttpError,
      BadRequestError,
      UnauthorizedError,
      ForbiddenError,
      NotFoundError,
      ConflictError,
      InternalServerError,
    );
    console.log(`Loaded custom endpoint script: ${fileName}`);
  } catch (error) {
    console.error(
      `Failed to compile custom endpoint script ${fileName}:`,
      error,
    );
  }
}

async function reloadCustomEndpointRuntime() {
  runtimeGeneration += 1;
  endpointHandlers = [];
  cronHandlers = [];

  const fileNames = await listEndpointFileNames();
  for (const fileName of fileNames) {
    await loadEndpointFile(fileName);
  }
}

function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    void reloadCustomEndpointRuntime();
  }, 150);
}

function startWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;

  watch(customEndpointsDir, { persistent: true }, () => {
    scheduleReload();
  });
}

function findMatchingEndpoint(method: string, pathname: string) {
  for (const endpoint of endpointHandlers) {
    if (
      endpoint.method !== method &&
      endpoint.method !== "ALL" &&
      endpoint.method !== "*"
    ) {
      continue;
    }

    const match = pathname.match(endpoint.regex);
    if (!match) continue;

    const params: Record<string, string> = {};
    endpoint.paramNames.forEach((name, index) => {
      params[name] = match[index + 1];
    });

    return { endpoint, params };
  }

  return null;
}

async function handleLoadCustomScripts() {
  await ensureCustomEndpointDir();
  await reloadCustomEndpointRuntime();
  startWatcher();
}

export async function loadCustomScripts() {
  return handleLoadCustomScripts();
}

export async function reloadCustomScripts() {
  await ensureCustomEndpointDir();
  await reloadCustomEndpointRuntime();
}

export async function listCustomEndpointFiles() {
  await ensureCustomEndpointDir();
  const fileNames = await listEndpointFileNames();
  const files: Array<{ fileName: string; updatedAt: number; size: number }> =
    [];

  for (const fileName of fileNames) {
    const filePath = path.join(customEndpointsDir, fileName);
    const stats = await stat(filePath);
    files.push({
      fileName,
      updatedAt: stats.mtimeMs,
      size: stats.size,
    });
  }

  return files;
}

export async function readCustomEndpointFile(fileName: string) {
  await ensureCustomEndpointDir();
  const normalized = normalizeFileName(fileName);
  const filePath = path.join(customEndpointsDir, normalized);
  if (!existsSync(filePath)) {
    throw new Error("Custom endpoint file not found.");
  }
  return await readFile(filePath, "utf-8");
}

export async function writeCustomEndpointFile(
  fileName: string,
  content: string,
) {
  await ensureCustomEndpointDir();
  const normalized = normalizeFileName(fileName);
  const filePath = path.join(customEndpointsDir, normalized);
  await writeFile(filePath, content, "utf-8");
  await reloadCustomEndpointRuntime();
  startWatcher();
  return normalized;
}

export async function deleteCustomEndpointFile(fileName: string) {
  await ensureCustomEndpointDir();
  const normalized = normalizeFileName(fileName);
  const filePath = path.join(customEndpointsDir, normalized);
  if (existsSync(filePath)) {
    await rm(filePath);
  }
  await reloadCustomEndpointRuntime();
  startWatcher();
  return normalized;
}

export async function countCustomEndpointFiles() {
  const files = await listCustomEndpointFiles();
  return files.length;
}
