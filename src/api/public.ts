import { Hono } from "hono";
import sql from "../db/db.ts";
import { verify } from "hono/jwt";
import { sign } from "hono/jwt";
import { satisfiesRule, type RuleEvaluationContext } from "../ruleEngine.ts";
import { buildSafeSqlFilter } from "../sqlSafety.ts";

type PublicApiEnv = {
  Variables: {
    auth_user: any;
    jwtPayload: unknown;
  };
};

const publicApi = new Hono<PublicApiEnv>();

// Auth user sign in for collections dynamically
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
    const secret = process.env.JWT_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set in production");
    }
    const finalSecret = secret || "super-secret-default-key";

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
    return c.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : "Configuration or SQL Error: " + err.message,
      },
      500,
    );
  }
});

// Middleware to extract the public bearer token and assess API Rules for List/View
publicApi.use("/collections/:collection/records*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const cookieHeader = c.req.header("Cookie");
  let user: any = null;

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set in production");
    }
    const finalSecret = secret || "super-secret-default-key";

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      user = await verify(token, finalSecret, "HS256");
    }
  } catch {
    // It's ok to have an invalid token, they just remain anonymous guests, they might still be able to hit public endpoints.
  }

  c.set("auth_user", user);
  await next();
});
// Build a richer rule context for PocketBase-style expressions.
function buildRuleContext(
  c: any,
  collectionName: string,
  extras: Partial<RuleEvaluationContext> = {},
): RuleEvaluationContext {
  const query: Record<string, string> = {};
  const searchParams = new URL(c.req.url).searchParams;
  searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return {
    user: c.get("auth_user"),
    collectionName,
    collection: { name: collectionName },
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    query,
    ...extras,
  };
}

// Remove sensitive fields
function sanitizeRecord(r: any) {
  const clean = { ...r };
  delete clean.password_hash;
  delete clean.token_key;
  return clean;
}

function getPublicAppOrigin() {
  const configured = [
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.SITE_URL,
    process.env.BASE_URL,
  ].find((value) => typeof value === "string" && value.trim() !== "");

  if (configured) {
    return new URL(configured).origin;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_APP_URL must be set in production");
  }

  return new URL("http://localhost:8080").origin;
}

function getGoogleOAuthRedirectUri() {
  return `${getPublicAppOrigin()}/api/collections/auth-with-oauth2/google/callback`;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function getValidatedGoogleOAuthConfig(collectionName: string) {
  const meta =
    await sql`SELECT type, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
  if (meta.length === 0 || meta[0].type !== "auth") {
    return { error: "Invalid auth collection" as const };
  }

  let localOauth2 = meta[0].oauth2;
  if (typeof localOauth2 === "string") localOauth2 = JSON.parse(localOauth2);

  if (!localOauth2?.google_enabled) {
    return {
      error: "Google OAuth2 is not enabled for this collection" as const,
    };
  }

  const gSet =
    await sql`SELECT value FROM _settings WHERE key = 'google_oauth' LIMIT 1`;
  if (gSet.length === 0) {
    return { error: "Google OAuth2 is not globally configured" as const };
  }

  let globalOauth2 = gSet[0].value;
  if (typeof globalOauth2 === "string") globalOauth2 = JSON.parse(globalOauth2);

  if (!globalOauth2?.enabled || !globalOauth2?.client_id) {
    return {
      error: "Google OAuth2 is not globally configured or enabled" as const,
    };
  }

  return {
    meta,
    localOauth2,
    globalOauth2,
  } as const;
}

async function handleGoogleOAuthCallback(
  c: any,
  collectionName: string,
  redirectUri: string,
) {
  const code = c.req.query("code");

  if (!code) return c.json({ error: "Authorization code missing" }, 400);

  const validation = await getValidatedGoogleOAuthConfig(collectionName);
  if ("error" in validation) {
    return c.json({ error: validation.error }, 400);
  }

  // Exchange code for token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: validation.globalOauth2.client_id,
      client_secret: validation.globalOauth2.client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.error) {
    return c.json(
      { error: tokenData.error_description || tokenData.error },
      400,
    );
  }

  // Get user info
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  const userData = await userRes.json();
  if (!userData.email) {
    return c.json({ error: "Could not fetch email from Google" }, 400);
  }

  // Upsert user
  let users =
    await sql`SELECT * FROM ${sql(collectionName)} WHERE email = ${userData.email} LIMIT 1`;
  let user;

  if (users.length === 0) {
    // Create random password hash so they can't login via normal password effectively
    const fakeHash = crypto.randomUUID();
    const insertRes = await sql`
        INSERT INTO ${sql(collectionName)} (email, password_hash) 
        VALUES (${userData.email}, ${fakeHash}) 
        RETURNING *
      `;
    user = insertRes[0];
  } else {
    user = users[0];
  }

  const payload = {
    auth_user: sanitizeRecord(user),
    auth_type: "google",
    collection: collectionName,
    timestamp: Date.now(),
  };

  const token = await signJwt(payload);

  // Redirect to success page or home with token cookie
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `token=${token}; Path=/; HttpOnly; SameSite=Lax; ${process.env.NODE_ENV === "production" ? "Secure;" : ""}`,
  );
  headers.append("Location", "/");
  return new Response(null, { status: 302, headers });
}

// Initiate Google OAuth2 flow
publicApi.get("/collections/:collection/auth-with-oauth2/google", async (c) => {
  const collectionName = c.req.param("collection");
  const redirectUri = getGoogleOAuthRedirectUri();

  try {
    const validation = await getValidatedGoogleOAuthConfig(collectionName);
    if ("error" in validation) {
      return c.json({ error: validation.error }, 400);
    }

    const state = JSON.stringify({ collection: collectionName });
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
    return c.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
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

  return handleGoogleOAuthCallback(c, collectionName, redirectUri);
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
    return c.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
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
    return c.json(
      {
        code: 500,
        message:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
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

    const cleanBody: Record<string, any> = { ...body };
    for (const key of Object.keys(cleanBody)) {
      const fieldDef = definedSchema.find((f) => f.name === key);
      if (fieldDef && fieldDef.type === "date_only" && cleanBody[key]) {
        const valStr = String(cleanBody[key]);
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
        }
      }
    }
    // Keep optional custom id on create; if blank/invalid empty value, let DB generate it.
    if (cleanBody.id === "" || cleanBody.id === null) {
      delete cleanBody.id;
    }

    // Filter immutable and system managed fields
    delete cleanBody.created;
    delete cleanBody.updated;
    delete cleanBody.created_at;
    delete cleanBody.updated_at;
    delete cleanBody.token_key;
    delete cleanBody.password_hash;
    if (meta[0].type === "auth" && body.password) {
      cleanBody.password_hash = await Bun.password.hash(body.password);
      delete cleanBody.password;
    }

    const finalKeys = Object.keys(cleanBody);
    const result = await sql`
      INSERT INTO ${sql(collectionName)} ${sql(cleanBody, finalKeys)}
      RETURNING *
    `;

    return c.json(sanitizeRecord(result[0]));
  } catch (err: any) {
    return c.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
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

    // Filter out id injection
    const cleanBody: Record<string, any> = {};
    const protectedFields = [
      "id",
      "created",
      "updated",
      "created_at",
      "updated_at",
      "token_key",
      "password_hash",
    ];
    keys
      .filter((k) => !protectedFields.includes(k))
      .forEach((k) => {
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
      });

    if (meta[0].type === "auth" && body.password) {
      cleanBody.password_hash = await Bun.password.hash(body.password);
      delete cleanBody.password;
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
    return c.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
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
    return c.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
      },
      500,
    );
  }
});

export default publicApi;
