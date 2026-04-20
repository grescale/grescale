import sql from "../db/db.ts";
import { mkdir, readdir, stat, unlink, access } from "fs/promises";
import { join, basename } from "path";

export function getCollectionsBasePath(c: any) {
  return c.req.path.startsWith("/admin/") ||
    c.req.path.startsWith("/internal/api/collections")
    ? "/internal/api/collections"
    : "/api/collections";
}

export function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export const DEFAULT_APP_TIMEZONE = "UTC";

export function isValidIanaTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch (_err) {
    return false;
  }
}

export function safeTimeZone(timeZone?: string | null) {
  if (!timeZone) return DEFAULT_APP_TIMEZONE;
  return isValidIanaTimeZone(timeZone) ? timeZone : DEFAULT_APP_TIMEZONE;
}

export async function getConfiguredTimeZone() {
  try {
    const rows =
      await sql`SELECT value FROM _settings WHERE key = 'timezone' LIMIT 1`;
    if (rows.length === 0) return DEFAULT_APP_TIMEZONE;
    const raw = rows[0].value;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string") return safeTimeZone(parsed);
        if (parsed && typeof parsed.timezone === "string") {
          return safeTimeZone(parsed.timezone);
        }
      } catch (_err) {
        return safeTimeZone(raw);
      }
    }
    if (raw && typeof raw.timezone === "string") {
      return safeTimeZone(raw.timezone);
    }
  } catch (_err) {}
  return DEFAULT_APP_TIMEZONE;
}

export function getDatePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

export function formatDateOnlyForInput(value: any, timeZone: string) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatDateTimeForInput(value: any, timeZone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value).slice(0, 16);
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function getTimeZoneOffsetMillis(utcMillis: number, timeZone: string) {
  const date = new Date(utcMillis);
  const parts = getDatePartsInTimeZone(date, timeZone);
  const asUtcMillis = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );
  return asUtcMillis - utcMillis;
}

export function convertLocalDateTimeInTimeZoneToUtcIso(
  localValue: string,
  timeZone: string,
) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    localValue,
  );
  if (!m) return localValue;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = m[6] ? parseInt(m[6], 10) : 0;

  const targetUtcLike = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMillis = targetUtcLike;
  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMillis(utcMillis, timeZone);
    utcMillis = targetUtcLike - offset;
  }
  return new Date(utcMillis).toISOString();
}

export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Warsaw",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

export const PG_BACKUP_DIR = join(process.cwd(), "backups", "pg_dump");
export const PG_BACKUP_FREQUENCIES = [
  "30m",
  "1h",
  "12h",
  "daily",
  "weekly",
  "monthly",
] as const;

export type PgBackupFrequency = (typeof PG_BACKUP_FREQUENCIES)[number];

export type PgBackupSettings = {
  enabled: boolean;
  frequency: PgBackupFrequency;
  retainCount: number;
  lastRunAt: string | null;
};

export const DEFAULT_PG_BACKUP_SETTINGS: PgBackupSettings = {
  enabled: false,
  frequency: "daily",
  retainCount: 3,
  lastRunAt: null,
};

export const PG_BACKUP_INTERVAL_MS: Record<PgBackupFrequency, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function normalizePgBackupFrequency(value: string): PgBackupFrequency {
  if ((PG_BACKUP_FREQUENCIES as readonly string[]).includes(value)) {
    return value as PgBackupFrequency;
  }
  return DEFAULT_PG_BACKUP_SETTINGS.frequency;
}

export function normalizeRetainCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PG_BACKUP_SETTINGS.retainCount;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

export async function ensureBackupDir() {
  await mkdir(PG_BACKUP_DIR, { recursive: true });
}

export async function getPgBackupSettings(): Promise<PgBackupSettings> {
  try {
    const rows =
      await sql`SELECT value FROM _settings WHERE key = 'pg_backup' LIMIT 1`;
    if (rows.length === 0) return { ...DEFAULT_PG_BACKUP_SETTINGS };
    const raw = rows[0].value;
    const parsed =
      typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(raw);
            } catch (_err) {
              return {};
            }
          })()
        : raw || {};

    return {
      enabled: parsed.enabled === true,
      frequency: normalizePgBackupFrequency(String(parsed.frequency || "")),
      retainCount: normalizeRetainCount(parsed.retainCount),
      lastRunAt:
        typeof parsed.lastRunAt === "string" && parsed.lastRunAt
          ? parsed.lastRunAt
          : null,
    };
  } catch (_err) {
    return { ...DEFAULT_PG_BACKUP_SETTINGS };
  }
}

export async function savePgBackupSettings(next: PgBackupSettings) {
  await sql`DELETE FROM _settings WHERE key = 'pg_backup'`;
  await sql`
    INSERT INTO _settings (key, value)
    VALUES (
      'pg_backup',
      ${JSON.stringify({
        enabled: next.enabled,
        frequency: next.frequency,
        retainCount: normalizeRetainCount(next.retainCount),
        lastRunAt: next.lastRunAt || null,
      })}::jsonb
    )
  `;
}

export function makePgBackupFilename() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  return `pg_backup_${y}${mo}${d}_${h}${mi}${s}.dump`;
}

export async function listPgBackupFiles() {
  await ensureBackupDir();
  const names = (await readdir(PG_BACKUP_DIR)) as string[];
  const backupNames = names.filter((name: string) => name.endsWith(".dump"));

  const withStats = await Promise.all(
    backupNames.map(async (name: string) => {
      const fullPath = join(PG_BACKUP_DIR, name);
      const fileStat = await stat(fullPath);
      return {
        name,
        fullPath,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
      };
    }),
  );

  return withStats.sort(
    (a: { mtimeMs: number }, b: { mtimeMs: number }) => b.mtimeMs - a.mtimeMs,
  );
}

export function sanitizeBackupFilename(input: string) {
  const onlyBase = basename(input || "");
  if (!/^pg_backup_[0-9]{8}_[0-9]{6}\.dump$/.test(onlyBase)) {
    throw new Error("Invalid backup filename");
  }
  return onlyBase;
}

export async function applyPgBackupRetention(retainCount: number) {
  const normalized = normalizeRetainCount(retainCount);
  const files = await listPgBackupFiles();
  const toDelete = files.slice(normalized);
  for (const file of toDelete) {
    await unlink(file.fullPath);
  }
}

export async function runPgDumpBackupOnce(reason: "manual" | "scheduled") {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  await ensureBackupDir();
  const fileName = makePgBackupFilename();
  const fullPath = join(PG_BACKUP_DIR, fileName);

  const child = Bun.spawn(
    [
      "pg_dump",
      "--dbname",
      databaseUrl,
      "--format=custom",
      "--file",
      fullPath,
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const stderrText = await new Response(child.stderr).text();
    try {
      await unlink(fullPath);
    } catch (_err) {}
    console.error("pg_dump failed:", { reason, exitCode, stderrText });
    throw new Error(`pg_dump failed (${reason}) with code ${exitCode}`);
  }

  const settings = await getPgBackupSettings();
  settings.lastRunAt = new Date().toISOString();
  await savePgBackupSettings(settings);
  await applyPgBackupRetention(settings.retainCount);

  return { fileName, fullPath };
}

export async function restorePgDumpBackup(filename: string) {
  const safeFileName = sanitizeBackupFilename(filename);
  const fullPath = join(PG_BACKUP_DIR, safeFileName);
  await access(fullPath);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const child = Bun.spawn(
    [
      "pg_restore",
      "--dbname",
      databaseUrl,
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      fullPath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const stderrText = await new Response(child.stderr).text();
    console.error("pg_restore failed:", { exitCode, stderrText });
    throw new Error(`pg_restore failed with code ${exitCode}`);
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

