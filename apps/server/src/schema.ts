import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    digest: text("digest").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("credentials_digest_unique").on(table.digest)],
);

export const enrollmentCodes = sqliteTable(
  "enrollment_codes",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    digest: text("digest").notNull(),
    codeCiphertext: text("code_ciphertext").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("enrollment_digest_unique").on(table.digest)],
);

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("hosts_active_name_unique").on(table.name).where(sql`${table.revokedAt} IS NULL`)],
);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  credentialId: text("credential_id")
    .notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
  apnsTokenCiphertext: text("apns_token_ciphertext"),
  pushToStartTokenCiphertext: text("push_to_start_token_ciphertext"),
  environment: text("environment"),
  liveActivityInteractionsVersion: integer("live_activity_interactions_version"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url"),
    status: text("status").notNull(),
    apnsId: text("apns_id"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    originHostId: text("origin_host_id").references(() => hosts.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("notifications_idempotency_unique").on(table.idempotencyKey)],
);

export const interactions = sqliteTable(
  "interactions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    response: text("response"),
    responseTokenDigest: text("response_token_digest").notNull(),
    responseTokenCiphertext: text("response_token_ciphertext").notNull(),
    responseTokenConsumedAt: integer("response_token_consumed_at", { mode: "timestamp_ms" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    originHostId: text("origin_host_id").references(() => hosts.id, { onDelete: "set null" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("interactions_idempotency_unique").on(table.idempotencyKey),
    index("interactions_status_expires_idx").on(table.status, table.expiresAt),
  ],
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    key: text("key"),
    title: text("title").notNull(),
    status: text("status").notNull(),
    detail: text("detail"),
    progress: real("progress").notNull(),
    symbol: text("symbol").notNull(),
    accentColor: text("accent_color").notNull(),
    state: text("state").notNull(),
    sequence: integer("sequence").notNull(),
    pushTimestamp: integer("push_timestamp").notNull(),
    staleAt: integer("stale_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    endReason: text("end_reason"),
  },
  (table) => [uniqueIndex("activities_active_key_unique").on(table.key).where(sql`${table.state} = 'active'`)],
);

export const activityPushTokens = sqliteTable(
  "activity_push_tokens",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    tokenCiphertext: text("token_ciphertext").notNull(),
    environment: text("environment").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.activityId] })],
);

export const activityCheckpoints = sqliteTable(
  "activity_checkpoints",
  {
    interactionId: text("interaction_id")
      .primaryKey()
      .references(() => interactions.id, { onDelete: "cascade" }),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    presentation: text("presentation").notNull(),
    state: text("state").notNull(),
    result: text("result"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("activity_checkpoints_unresolved_activity_unique")
      .on(table.activityId)
      .where(sql`${table.state} != 'finished'`),
  ],
);

export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  purpose: text("purpose").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: text("payload"),
  status: text("status").notNull(),
  accepted: integer("accepted", { mode: "boolean" }),
  apnsId: text("apns_id"),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  availableAt: integer("available_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("deliveries_mutation_purpose_unique").on(
    table.resourceType,
    table.resourceId,
    table.purpose,
    table.idempotencyKey,
  ),
]);

export const mutations = sqliteTable(
  "mutations",
  {
    id: text("id").primaryKey(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("mutations_operation_key_unique").on(table.operation, table.idempotencyKey)],
);
