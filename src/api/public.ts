import { Hono } from "hono";
import sql from "../db/db.ts";
import { buildSafeSqlFilter } from "../sqlSafety.ts";
import {
  buildRuleContext,
  getGoogleOAuthRedirectUri,
  getValidatedGoogleOAuthConfig,
  handleGoogleOAuthCallback,
  sanitizeRecord,
} from "../services/publicBackend.ts";
import { setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { satisfiesRule } from "../ruleEngine.ts";
import { getRequiredJwtSecret } from "../security.ts";
import { quoteIdentifier } from "../services/collectionsBackend.ts";

type PublicApiEnv = {
  Variables: {
    auth_user: any;
    jwtPayload: unknown;
  };
};

const publicApi = new Hono<PublicApiEnv>();

// User-writable system fields for auth collections. All other system
// fields (verified, token_key, password_hash, created, updated, etc.)
// are rejected to prevent mass-assignment privilege escalation.
const USER_WRITABLE_SYSTEM_FIELDS: Record<"create" | "update", Set<string>> = {
  create: new Set(["id", "email", "username", "password"]),
  update: new Set(["email", "username", "password"]),
};

function buildAllowedBodyKeys(
  schema: any[],
  op: "create" | "update",
): Set<string> {
  const allowed = new Set<string>();
  const writableSystem = USER_WRITABLE_SYSTEM_FIELDS[op];
  for (const field of schema) {
    if (!field?.name) continue;
    if (field.system) {
      if (writableSystem.has(field.name)) allowed.add(field.name);
    } else {
      allowed.add(field.name);
    }
  }
  return allowed;
}

publicApi.post("/collections/:collection/auth-with-password", async (c) => {
  const collectionName = c.req.param("collection");
  const body = await c.req.json();

  if (!body.email || !body.password) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  try {
    // 1. Verify this is actually an auth collection
    const meta =
      await sql`SELECT type FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0 || meta[0].type !== "auth") {
      return c.json({ error: "Invalid auth collection" }, 400);
    }

    // 2. Lookup the user (in a real system, you'd use bcrypt or argon2 to compare hashed passwords)
    // For this demo, we compare raw plaintext. WARNING: Never do this in production.
    const users = await sql`
      SELECT * FROM ${sql(collectionName)} WHERE email = ${body.email} LIMIT 1
    `;

    if (users.length === 0) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const isValid = await Bun.password.verify(
      body.password,
      users[0].password_hash,
    );
    if (!isValid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const user = users[0];
    const finalSecret = getRequiredJwtSecret();

    // Create JWT containing the user ID, Email, and collection context mapping to their specific table
    const token = await sign(
      {
        id: user.id,
        email: user.email,
        collection: collectionName,
        type: "auth_record",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
      },
      finalSecret,
    );

    // Filter out password_hash before returning user data
    const userSafe = { ...user };
    delete userSafe.password_hash;
    delete userSafe.token_key;

    return c.json({
      token,
      record: userSafe,
    });
  } catch (err: any) {
    console.error("Public auth error:", err);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

publicApi.use("/collections/:collection/records*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const routeCollection = c.req.param("collection");
  let user: any = null;

  try {
    const finalSecret = getRequiredJwtSecret();

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload: any = await verify(token, finalSecret, "HS256");

      // Enforce token boundary: auth_record tokens can only act on their
      // own collection; admin tokens bypass this check.
      if (payload?.type === "auth_record") {
        if (
          !payload.collection ||
          !routeCollection ||
          payload.collection !== routeCollection
        ) {
          user = null;
        } else {
          user = payload;
        }
      } else if (payload?.type === "admin") {
        user = payload;
      }
    }
  } catch {
    // Invalid token - treat as anonymous guest.
  }

  c.set("auth_user", user);
  await next();
});
// Initiate Google OAuth2 flow
publicApi.get("/collections/:collection/auth-with-oauth2/google", async (c) => {
  const collectionName = c.req.param("collection");
  const redirectUri = getGoogleOAuthRedirectUri();

  try {
    const validation = await getValidatedGoogleOAuthConfig(collectionName);
    if ("error" in validation) {
      return c.json({ error: validation.error }, 400);
    }

    const state = JSON.stringify({
      collection: collectionName,
      nonce: crypto.randomUUID(),
    });
    setCookie(c, "google_oauth_state", state, {
      path: "/",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 10 * 60,
    });

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", validation.globalOauth2.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    );
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "consent");

    return c.redirect(authUrl.toString());
  } catch (err: any) {
    console.error("Public OAuth initiation error:", err);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// Handle Google OAuth2 callback
publicApi.get("/collections/auth-with-oauth2/google/callback", async (c) => {
  const redirectUri = getGoogleOAuthRedirectUri();

  let collectionName = "";
  try {
    const parsedState = JSON.parse(c.req.query("state") || "{}");
    collectionName = String(parsedState?.collection || "");
  } catch (err) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  if (!collectionName) {
    return c.json({ error: "Missing collection in OAuth state" }, 400);
  }

  if (!/^[a-zA-Z0-9_]+$/.test(collectionName)) {
    return c.json({ error: "Invalid collection in OAuth state" }, 400);
  }

  return handleGoogleOAuthCallback(c, redirectUri);
});

// Public Records List Endpoint
publicApi.get("/collections/:collection/records", async (c) => {
  const collectionName = c.req.param("collection");
  const authUser = c.get("auth_user");
  const filter = c.req.query("filter") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = 40;
  const offset = (page - 1) * perPage;

  try {
    const meta =
      await sql`SELECT list_rule FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0) {
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );
    }

    if (
      !satisfiesRule(
        meta[0].list_rule,
        buildRuleContext(c, collectionName, { user: authUser }),
      )
    ) {
      return c.json(
        { error: "You are not authorized to view this collection" },
        403,
      );
    }

    const columnRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${collectionName}
    `;
    const allowedColumns = columnRows.map((row: any) =>
      String(row.column_name),
    );

    let records: any[] = [];
    let totalCountRes: any[] = [];

    if (filter) {
      try {
        const sqlFilterStr = buildSafeSqlFilter(filter, allowedColumns);

        records = await sql.unsafe(
          `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${sqlFilterStr} LIMIT ${perPage} OFFSET ${offset}`,
        );
        totalCountRes = await sql.unsafe(
          `SELECT count(*) as count FROM ${quoteIdentifier(collectionName)} WHERE ${sqlFilterStr}`,
        );
      } catch {
        return c.json({ error: "Invalid filter syntax." }, 400);
      }
    } else {
      records =
        await sql`SELECT * FROM ${sql(collectionName)} LIMIT ${perPage} OFFSET ${offset}`;
      totalCountRes =
        await sql`SELECT count(*) as count FROM ${sql(collectionName)}`;
    }

    const total = parseInt(totalCountRes[0].count);

    return c.json({
      page,
      perPage,
      totalItems: total,
      totalPages: Math.ceil(total / perPage),
      items: records.map(sanitizeRecord),
    });
  } catch (err: any) {
    console.error("Public records list error:", err);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// Public View Single Record Endpoint
publicApi.get("/collections/:collection/records/:id", async (c) => {
  const collectionName = c.req.param("collection");
  const id = c.req.param("id");
  const authUser = c.get("auth_user");

  try {
    const meta =
      await sql`SELECT view_rule FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );

    const records =
      await sql`SELECT * FROM ${sql(collectionName)} WHERE id = ${id} LIMIT 1`;
    if (records.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );

    if (
      !satisfiesRule(
        meta[0].view_rule,
        buildRuleContext(c, collectionName, {
          user: authUser,
          record: records[0],
        }),
      )
    ) {
      return c.json(
        { error: "You are not authorized to view this record" },
        403,
      );
    }

    return c.json(sanitizeRecord(records[0]));
  } catch (err: any) {
    console.error("Public record fetch error:", err);
    return c.json(
      {
        code: 500,
        message: "Internal server error",
        data: {},
      },
      500,
    );
  }
});

// Public Create Endpoint
publicApi.post("/collections/:collection/records", async (c) => {
  const collectionName = c.req.param("collection");
  const authUser = c.get("auth_user");
  const body = await c.req.json();

  try {
    const meta =
      await sql`SELECT type, create_rule, schema FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );
    if (meta[0].type === "view")
      return c.json({ error: "Views are read-only" }, 400);

    if (
      !satisfiesRule(
        meta[0].create_rule,
        buildRuleContext(c, collectionName, {
          user: authUser,
          body: body as Record<string, any>,
        }),
      )
    ) {
      return c.json(
        {
          error: "You are not authorized to create records in this collection",
        },
        403,
      );
    }

    const keys = Object.keys(body);
    if (keys.length === 0) return c.json({ error: "Empty payload" }, 400);

    let definedSchema: any[] = [];
    if (meta[0].schema) {
      definedSchema =
        typeof meta[0].schema === "string"
          ? JSON.parse(meta[0].schema)
          : meta[0].schema;
    }

    const allowedKeys = buildAllowedBodyKeys(definedSchema, "create");
    const cleanBody: Record<string, any> = {};
    for (const key of keys) {
      if (!allowedKeys.has(key)) continue;
      const fieldDef = definedSchema.find((f) => f.name === key);
      if (fieldDef && fieldDef.type === "date_only" && body[key]) {
        const valStr = String(body[key]);
        const d = new Date(valStr);
        if (!isNaN(d.getTime())) {
          let yyyy = d.getFullYear().toString();
          let mm = String(d.getMonth() + 1).padStart(2, "0");
          let dd = String(d.getDate()).padStart(2, "0");
          const fmt = fieldDef.date_format || "YYYY-MM-DD";
          if (fmt === "DD-MM-YYYY") cleanBody[key] = `${dd}-${mm}-${yyyy}`;
          else if (fmt === "DD/MM/YYYY") cleanBody[key] = `${dd}/${mm}/${yyyy}`;
          else if (fmt === "YYYY/MM/DD") cleanBody[key] = `${yyyy}/${mm}/${dd}`;
          else cleanBody[key] = `${yyyy}-${mm}-${dd}`;
        } else {
          cleanBody[key] = body[key];
        }
      } else {
        cleanBody[key] = body[key];
      }
    }
    // Keep optional custom id on create; if blank/invalid empty value, let DB generate it.
    if (cleanBody.id === "" || cleanBody.id === null) {
      delete cleanBody.id;
    }

    if (meta[0].type === "auth" && cleanBody.password) {
      cleanBody.password_hash = await Bun.password.hash(cleanBody.password);
      delete cleanBody.password;
    }

    const finalKeys = Object.keys(cleanBody);
    const result = await sql`
      INSERT INTO ${sql(collectionName)} ${sql(cleanBody, finalKeys)}
      RETURNING *
    `;

    return c.json(sanitizeRecord(result[0]));
  } catch (err: any) {
    console.error("Public create error:", err);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// Public Update Endpoint
publicApi.patch("/collections/:collection/records/:id", async (c) => {
  const collectionName = c.req.param("collection");
  const id = c.req.param("id");
  const authUser = c.get("auth_user");
  const body = await c.req.json();

  try {
    const meta =
      await sql`SELECT type, update_rule, schema FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );
    if (meta[0].type === "view")
      return c.json({ error: "Views are read-only" }, 400);

    const existingRecords =
      await sql`SELECT * FROM ${sql(collectionName)} WHERE id = ${id} LIMIT 1`;
    if (existingRecords.length === 0)
      return c.json({ error: "Record not found" }, 404);

    if (
      !satisfiesRule(
        meta[0].update_rule,
        buildRuleContext(c, collectionName, {
          user: authUser,
          record: existingRecords[0],
          body: body as Record<string, any>,
        }),
      )
    ) {
      return c.json(
        { error: "You are not authorized to update this record" },
        403,
      );
    }

    const keys = Object.keys(body);
    if (keys.length === 0) return c.json({ error: "Empty payload" }, 400);

    let definedSchema: any[] = [];
    if (meta[0].schema) {
      definedSchema =
        typeof meta[0].schema === "string"
          ? JSON.parse(meta[0].schema)
          : meta[0].schema;
    }

    const allowedKeys = buildAllowedBodyKeys(definedSchema, "update");
    const cleanBody: Record<string, any> = {};
    for (const k of keys) {
      if (!allowedKeys.has(k)) continue;
      const fieldDef = definedSchema.find((f) => f.name === k);
      if (fieldDef && fieldDef.type === "date_only" && body[k]) {
        const valStr = String(body[k]);
        const d = new Date(valStr);
        if (!isNaN(d.getTime())) {
          let yyyy = d.getFullYear().toString();
          let mm = String(d.getMonth() + 1).padStart(2, "0");
          let dd = String(d.getDate()).padStart(2, "0");
          const fmt = fieldDef.date_format || "YYYY-MM-DD";
          if (fmt === "DD-MM-YYYY") cleanBody[k] = `${dd}-${mm}-${yyyy}`;
          else if (fmt === "DD/MM/YYYY") cleanBody[k] = `${dd}/${mm}/${yyyy}`;
          else if (fmt === "YYYY/MM/DD") cleanBody[k] = `${yyyy}/${mm}/${dd}`;
          else cleanBody[k] = `${yyyy}-${mm}-${dd}`;
        } else {
          cleanBody[k] = body[k];
        }
      } else {
        cleanBody[k] = body[k];
      }
    }

    if (meta[0].type === "auth" && cleanBody.password) {
      cleanBody.password_hash = await Bun.password.hash(cleanBody.password);
      delete cleanBody.password;
    }

    if (Object.keys(cleanBody).length === 0) {
      return c.json({ error: "No writable fields provided" }, 400);
    }

    cleanBody["updated_at"] = new Date();

    const result = await sql`
      UPDATE ${sql(collectionName)} SET ${sql(cleanBody)} WHERE id = ${id}
      RETURNING *
    `;

    if (result.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );
    return c.json(sanitizeRecord(result[0]));
  } catch (err: any) {
    console.error("Public update error:", err);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

// Public Delete Endpoint
publicApi.delete("/collections/:collection/records/:id", async (c) => {
  const collectionName = c.req.param("collection");
  const id = c.req.param("id");
  const authUser = c.get("auth_user");

  try {
    const meta =
      await sql`SELECT type, delete_rule FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );
    if (meta[0].type === "view")
      return c.json({ error: "Views are read-only" }, 400);

    const existingRecords =
      await sql`SELECT * FROM ${sql(collectionName)} WHERE id = ${id} LIMIT 1`;
    if (existingRecords.length === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );

    if (
      !satisfiesRule(
        meta[0].delete_rule,
        buildRuleContext(c, collectionName, {
          user: authUser,
          record: existingRecords[0],
        }),
      )
    ) {
      return c.json(
        { error: "You are not authorized to delete this record" },
        403,
      );
    }

    const result =
      await sql`DELETE FROM ${sql(collectionName)} WHERE id = ${id}`;

    if (result.count === 0)
      return c.json(
        {
          code: 404,
          message: "The requested resource wasn't found.",
          data: {},
        },
        404,
      );
    return c.json({ success: true });
  } catch (err: any) {
    console.error("Public delete error:", err);
    return c.json(
      {
        error: "Internal server error",
      },
      500,
    );
  }
});

export default publicApi;
