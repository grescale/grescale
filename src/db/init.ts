import sql from "./db.ts";

async function repairLegacyCollectionSchema() {
  const migrationKey = "migration_repair_collections_schema_v1";

  try {
    const existing =
      await sql`SELECT value FROM _settings WHERE key = ${migrationKey} LIMIT 1`;
    if (existing.length > 0) {
      return;
    }

    const rows = await sql`
      SELECT id, name, schema::text AS schema_text
      FROM _collections
      WHERE jsonb_typeof(schema) = 'string'
    `;

    let repairedCount = 0;
    let skippedCount = 0;

    for (const row of rows as any[]) {
      const schemaText = String(row.schema_text || "");
      let rawValue: unknown = schemaText;

      // For JSONB strings, schema::text may be quoted JSON string (escaped).
      try {
        rawValue = JSON.parse(schemaText);
      } catch (_e) {
        rawValue = schemaText;
      }

      if (typeof rawValue !== "string") {
        skippedCount += 1;
        continue;
      }

      const normalized = rawValue.replace(/::jsonb\s*$/i, "").trim();
      if (!normalized) {
        skippedCount += 1;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(normalized);
      } catch (_e) {
        skippedCount += 1;
        continue;
      }

      if (
        parsed === null ||
        (typeof parsed !== "object" && !Array.isArray(parsed))
      ) {
        skippedCount += 1;
        continue;
      }

      await sql`
        UPDATE _collections
        SET schema = ${JSON.stringify(parsed)}::jsonb,
            updated_at = NOW()
        WHERE id = ${row.id}
      `;

      repairedCount += 1;
    }

    await sql`
      INSERT INTO _settings (key, value)
      VALUES (
        ${migrationKey},
        ${JSON.stringify({
          done: true,
          repairedCount,
          skippedCount,
          ranAt: new Date().toISOString(),
        })}::jsonb
      )
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW()
    `;

    if (repairedCount > 0 || skippedCount > 0) {
      console.log(
        `Schema repair migration complete (repaired=${repairedCount}, skipped=${skippedCount}).`,
      );
    }
  } catch (err) {
    console.warn("Schema repair migration skipped due to error:", err);
  }
}

async function repairUsersOwnershipSchema() {
  try {
    await sql`ALTER TABLE _users ADD COLUMN IF NOT EXISTS owner BOOLEAN NOT NULL DEFAULT FALSE`;

    const ownerRows =
      await sql`SELECT id FROM _users WHERE owner = TRUE ORDER BY created_at ASC, id ASC`;
    if (ownerRows.length === 0) {
      const firstUser =
        await sql`SELECT id FROM _users ORDER BY created_at ASC, id ASC LIMIT 1`;
      if (firstUser.length > 0) {
        await sql`UPDATE _users SET owner = FALSE`;
        await sql`UPDATE _users SET owner = TRUE WHERE id = ${firstUser[0].id}`;
      }
    } else if (ownerRows.length > 1) {
      const keepOwnerId = ownerRows[0].id;
      await sql`UPDATE _users SET owner = FALSE WHERE id <> ${keepOwnerId}`;
      await sql`UPDATE _users SET owner = TRUE WHERE id = ${keepOwnerId}`;
    }

    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS _users_single_owner_idx ON _users (owner) WHERE owner = TRUE`;
    } catch (_err) {}
  } catch (err) {
    console.warn("User ownership migration skipped due to error:", err);
  }
}

export async function initializeDatabase() {
  console.log("Initializing database tables...");

  try {
    // System Users table
    await sql`
      CREATE TABLE IF NOT EXISTS _users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        owner BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;

    // System Collections metadata (for a real pocketbase, to track schemas)
    await sql`
      CREATE TABLE IF NOT EXISTS _collections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) UNIQUE NOT NULL,
        type VARCHAR(50) DEFAULT 'base',
        schema JSONB NOT NULL DEFAULT '[]'::jsonb,
        list_rule TEXT DEFAULT NULL,
        view_rule TEXT DEFAULT NULL,
        create_rule TEXT DEFAULT NULL,
        update_rule TEXT DEFAULT NULL,
        delete_rule TEXT DEFAULT NULL,
        view_query TEXT DEFAULT NULL,
        oauth2 JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;

    // Global Settings table
    await sql`
      CREATE TABLE IF NOT EXISTS _settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(255) UNIQUE NOT NULL,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;

    // Ensure default google setting exists
    await sql`
      INSERT INTO _settings (key, value) 
      VALUES ('google_oauth', '{"enabled": false, "client_id": "", "client_secret": ""}'::jsonb)
      ON CONFLICT (key) DO NOTHING;
    `;

    // System Logs metadata
    await sql`
      CREATE TABLE IF NOT EXISTS _logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        method VARCHAR(10) NOT NULL,
        url TEXT NOT NULL,
        status INTEGER NOT NULL,
        error TEXT,
        collection VARCHAR(255),
        user_ip VARCHAR(255),
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;

    // Attempt to add new columns to existing _collections table in case of upgrade
    try {
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'base'`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS list_rule TEXT DEFAULT NULL`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS view_rule TEXT DEFAULT NULL`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS create_rule TEXT DEFAULT NULL`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS update_rule TEXT DEFAULT NULL`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS delete_rule TEXT DEFAULT NULL`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS view_query TEXT DEFAULT NULL`;
      await sql`ALTER TABLE _collections ADD COLUMN IF NOT EXISTS oauth2 JSONB DEFAULT '{}'::jsonb`;
    } catch (e) {
      console.log(
        "Could not alter _collections, might already exist or need manual migration.",
      );
    }

    await repairUsersOwnershipSchema();

    await repairLegacyCollectionSchema();

    console.log("Database initialized successfully!");
  } catch (err) {
    console.error("Failed to initialize database:", err);
    throw err;
  }
}

if (import.meta.main) {
  initializeDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
