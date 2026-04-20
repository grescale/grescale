import sql from "../db/db.ts";
import { sign } from "hono/jwt";
import { type RuleEvaluationContext, satisfiesRule } from "../ruleEngine.ts";
import { getCookie, deleteCookie } from "hono/cookie";
import { getRequiredJwtSecret } from "../security.ts";

export function buildRuleContext(
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

export function sanitizeRecord(r: any) {
  const clean = { ...r };
  delete clean.password_hash;
  delete clean.token_key;
  return clean;
}

export function getPublicAppOrigin() {
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

export function getGoogleOAuthRedirectUri() {
  return `${getPublicAppOrigin()}/api/collections/auth-with-oauth2/google/callback`;
}

export async function getValidatedGoogleOAuthConfig(collectionName: string) {
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

export async function handleGoogleOAuthCallback(c: any, redirectUri: string) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "google_oauth_state");

  deleteCookie(c, "google_oauth_state", {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "Lax",
  });

  if (!code) return c.json({ error: "Authorization code missing" }, 400);

  if (!state || !expectedState || state !== expectedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  let collectionName = "";
  try {
    const parsedState = JSON.parse(state);
    collectionName = String(parsedState?.collection || "");
  } catch {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  if (!collectionName) {
    return c.json({ error: "Missing collection in OAuth state" }, 400);
  }

  const validation = await getValidatedGoogleOAuthConfig(collectionName);
  if ("error" in validation) {
    return c.json({ error: validation.error }, 400);
  }

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

  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  const userData = await userRes.json();
  if (!userData.email) {
    return c.json({ error: "Could not fetch email from Google" }, 400);
  }
  if (userData.verified_email !== true) {
    return c.json(
      { error: "Google account email is not verified" },
      400,
    );
  }

  let users =
    await sql`SELECT * FROM ${sql(collectionName)} WHERE email = ${userData.email} LIMIT 1`;
  let user;

  if (users.length === 0) {
    const fakeHash = crypto.randomUUID();
    const insertRes = await sql`
        INSERT INTO ${sql(collectionName)} (email, password_hash, verified)
        VALUES (${userData.email}, ${fakeHash}, TRUE)
        RETURNING *
      `;
    user = insertRes[0];
  } else {
    user = users[0];
  }

  const payload = {
    id: user.id,
    email: user.email,
    collection: collectionName,
    type: "auth_record",
    auth_type: "google",
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  };

  const token = await signJwt(payload);

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `token=${token}; Path=/; HttpOnly; SameSite=Lax; ${process.env.NODE_ENV === "production" ? "Secure;" : ""}`,
  );
  headers.append("Location", "/");
  return new Response(null, { status: 302, headers });
}

function signJwt(payload: Record<string, any>) {
  return sign(payload, getRequiredJwtSecret());
}
