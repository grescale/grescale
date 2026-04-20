import type { MiddlewareHandler } from "hono";
import sql from "../db/db.ts";

export type RateLimitTarget = "all" | "guest" | "auth";

export interface RateLimitRule {
  label: string;
  pattern: string;
  maxRequests: number;
  intervalSeconds: number;
  targetedUsers: RateLimitTarget;
}

export interface RateLimitConfig {
  enabled: boolean;
  rules: RateLimitRule[];
}

const DEFAULT_CONFIG: RateLimitConfig = { enabled: false, rules: [] };

type Bucket = { count: number; resetAt: number };

type CompiledRule = RateLimitRule & { regex: RegExp };

const buckets = new Map<string, Bucket>();
let cachedConfig: { compiled: CompiledRule[]; enabled: boolean } = {
  compiled: [],
  enabled: false,
};
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 10_000;

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function compile(config: RateLimitConfig): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const r of config.rules || []) {
    if (!r || typeof r.pattern !== "string" || !r.pattern.trim()) continue;
    const max = Math.max(1, Math.floor(Number(r.maxRequests) || 0));
    const interval = Math.max(1, Math.floor(Number(r.intervalSeconds) || 0));
    if (!max || !interval) continue;
    let regex: RegExp;
    try {
      regex = globToRegex(r.pattern.trim());
    } catch {
      continue;
    }
    const target: RateLimitTarget =
      r.targetedUsers === "guest" || r.targetedUsers === "auth"
        ? r.targetedUsers
        : "all";
    rules.push({
      label: r.label || r.pattern,
      pattern: r.pattern.trim(),
      maxRequests: max,
      intervalSeconds: interval,
      targetedUsers: target,
      regex,
    });
  }
  return rules;
}

async function getConfig(): Promise<{
  compiled: CompiledRule[];
  enabled: boolean;
}> {
  const now = Date.now();
  if (now < cacheExpiresAt) return cachedConfig;
  let config: RateLimitConfig = DEFAULT_CONFIG;
  try {
    if (process.env.DATABASE_URL) {
      const rows =
        await sql`SELECT value FROM _settings WHERE key = 'rate_limiting' LIMIT 1`;
      if (rows.length > 0) {
        const raw = rows[0].value;
        const parsed =
          typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") {
          config = {
            enabled: !!parsed.enabled,
            rules: Array.isArray(parsed.rules) ? parsed.rules : [],
          };
        }
      }
    }
  } catch {
    config = DEFAULT_CONFIG;
  }
  cachedConfig = { enabled: config.enabled, compiled: compile(config) };
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedConfig;
}

export function invalidateRateLimitCache() {
  cacheExpiresAt = 0;
}

function clientIp(c: any): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  try {
    const addr = c.env?.incoming?.socket?.remoteAddress;
    if (addr) return String(addr);
  } catch {}
  return "unknown";
}

function isAuthenticated(c: any): boolean {
  const authHeader = c.req.header("authorization") || c.req.header("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) return true;
  const cookieHeader = c.req.header("cookie") || c.req.header("Cookie") || "";
  if (/(?:^|;\s*)admin_session=/.test(cookieHeader)) return true;
  return false;
}

function matchesTarget(target: RateLimitTarget, authed: boolean): boolean {
  if (target === "all") return true;
  if (target === "auth") return authed;
  return !authed;
}

export const globalRateLimit: MiddlewareHandler = async (c, next) => {
  const cfg = await getConfig();
  if (!cfg.enabled || cfg.compiled.length === 0) return next();

  const path = new URL(c.req.url).pathname;
  const now = Date.now();
  const ip = clientIp(c);
  const authed = isAuthenticated(c);

  let matchedAny = false;
  for (const rule of cfg.compiled) {
    if (!rule.regex.test(path)) continue;
    if (!matchesTarget(rule.targetedUsers, authed)) continue;
    matchedAny = true;
    const key = `${rule.pattern}|${rule.targetedUsers}|${ip}`;
    const b = buckets.get(key);
    const windowMs = rule.intervalSeconds * 1000;
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      b.count += 1;
      if (b.count > rule.maxRequests) {
        const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
        c.header("Retry-After", String(retryAfter));
        return c.json(
          {
            error: "Too many requests. Please try again later.",
            rule: rule.label,
          },
          429,
        );
      }
    }
  }

  if (matchedAny && buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  return next();
};
