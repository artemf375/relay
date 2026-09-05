import type { Client } from "@libsql/client";

export async function migrate(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON");
  const tx = await client.transaction("write");
  try {
    const version = Number((await tx.execute("PRAGMA user_version")).rows[0]![0]);
    if (version > 7) throw new Error(`Relay database schema ${version} is newer than this server supports`);
    if (version === 7) {
      await tx.commit();
      return;
    }
    if (version === 0) await tx.executeMultiple(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS enrollment_codes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, code_ciphertext TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hosts_active_name_unique ON hosts(name) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      apns_token_ciphertext TEXT, push_to_start_token_ciphertext TEXT,
      activity_push_token_ciphertext TEXT, system_activity_id TEXT, environment TEXT,
      live_activity_interactions_version INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT,
      status TEXT NOT NULL, apns_id TEXT, error TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      origin_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, response TEXT, response_token_digest TEXT NOT NULL,
      response_token_ciphertext TEXT NOT NULL, response_token_consumed_at INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      origin_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, responded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS interactions_status_expires_idx ON interactions(status, expires_at);
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY, key TEXT, title TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
      progress REAL NOT NULL, symbol TEXT NOT NULL, accent_color TEXT NOT NULL, state TEXT NOT NULL,
      sequence INTEGER NOT NULL, stale_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS activities_active_key_unique ON activities(key) WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS activity_checkpoints (
      interaction_id TEXT PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
      activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      presentation TEXT NOT NULL CHECK (presentation IN ('checkpoint', 'temporary')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'restoring', 'finished')),
      result TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS activity_checkpoints_unresolved_activity_unique
      ON activity_checkpoints(activity_id) WHERE state != 'finished';
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      purpose TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
      accepted INTEGER,
      apns_id TEXT, reason TEXT, created_at INTEGER NOT NULL, available_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS deliveries_mutation_purpose_unique
      ON deliveries(resource_type, resource_id, purpose, idempotency_key);
    CREATE TABLE IF NOT EXISTS mutations (
      id TEXT PRIMARY KEY, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(operation, idempotency_key)
    );
  `);
    if (version === 1) await tx.executeMultiple(`
    ALTER TABLE devices ADD COLUMN live_activity_interactions_version INTEGER;
    CREATE TABLE activity_checkpoints (
      interaction_id TEXT PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
      activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      presentation TEXT NOT NULL CHECK (presentation IN ('checkpoint', 'temporary')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'restoring', 'finished')),
      result TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE UNIQUE INDEX activity_checkpoints_unresolved_activity_unique
      ON activity_checkpoints(activity_id) WHERE state != 'finished';
  `);
    if (version === 1 || version === 2) {
      await tx.executeMultiple("ALTER TABLE deliveries ADD COLUMN available_at INTEGER;");
    }
    if (version === 1 || version === 2 || version === 3) {
      await tx.executeMultiple("ALTER TABLE interactions ADD COLUMN response_token_consumed_at INTEGER;");
    }
    if (version <= 4) await tx.executeMultiple(`
      ALTER TABLE activities ADD COLUMN end_reason TEXT;
      CREATE TABLE activity_push_tokens (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        token_ciphertext TEXT NOT NULL,
        environment TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, activity_id)
      );
      INSERT INTO activity_push_tokens (device_id, activity_id, token_ciphertext, environment, updated_at)
      SELECT id, system_activity_id, activity_push_token_ciphertext, environment, updated_at
      FROM devices
      WHERE system_activity_id IS NOT NULL
        AND activity_push_token_ciphertext IS NOT NULL
        AND environment IS NOT NULL
        AND EXISTS (SELECT 1 FROM activities WHERE activities.id = devices.system_activity_id);
    `);
    if (version >= 1 && version <= 5) {
      await tx.executeMultiple(`
        CREATE TABLE hosts (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
        );
        CREATE UNIQUE INDEX hosts_active_name_unique ON hosts(name) WHERE revoked_at IS NULL;
        ALTER TABLE enrollment_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'device';
        ALTER TABLE notifications ADD COLUMN origin_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL;
        ALTER TABLE interactions ADD COLUMN origin_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL;
      `);
    }
    await tx.executeMultiple(`
      ALTER TABLE activities ADD COLUMN push_timestamp INTEGER NOT NULL DEFAULT 0;
      UPDATE activities SET push_timestamp = CAST(updated_at / 1000 AS INTEGER);
    `);
    await tx.execute("PRAGMA user_version = 7");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}
