import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrate.js";
import { ConflictError, NotFoundError, openRelayStore } from "./store.js";
import { SecretBox, TokenAuthority } from "./security.js";

async function makeStore() {
  let now = new Date("2026-08-06T12:00:00.000Z");
  const store = await openRelayStore({
    filename: ":memory:",
    tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
    secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
    now: () => now,
  });
  return {
    store,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

async function pairLiveActivityPhone(store: Awaited<ReturnType<typeof makeStore>>["store"]) {
  const pairing = await store.createEnrollment();
  const enrolled = await store.exchangeEnrollment(pairing.code, "Phone");
  await store.updateDeviceTokens(enrolled.id, {
    apnsToken: "a".repeat(64),
    pushToStartToken: "b".repeat(64),
    environment: "production",
    capabilities: { liveActivityInteractions: 1 },
  });
  return enrolled;
}

async function startTask(store: Awaited<ReturnType<typeof makeStore>>["store"]) {
  return await store.startActivity({
    key: "release",
    title: "Release",
    status: "Building",
    progress: 0.25,
    symbol: "build",
    accentColor: "#5ED8B7",
    replace: false,
    staleAfterSeconds: 3600,
  });
}

describe("database migration", () => {
  test("upgrades a version-one database without losing existing device rows", async () => {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple(`
      CREATE TABLE credentials (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        apns_token_ciphertext TEXT, push_to_start_token_ciphertext TEXT,
        activity_push_token_ciphertext TEXT, system_activity_id TEXT, environment TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE interactions (id TEXT PRIMARY KEY);
      CREATE TABLE activities (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE notifications (id TEXT PRIMARY KEY);
      CREATE TABLE enrollment_codes (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, code_ciphertext TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        purpose TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
        accepted INTEGER, apns_id TEXT, reason TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO credentials (id, kind, digest, created_at) VALUES ('cred_1', 'device', 'digest', 1);
      INSERT INTO devices (id, name, credential_id, created_at, updated_at)
        VALUES ('dev_1', 'Phone', 'cred_1', 1, 1);
      PRAGMA user_version = 1;
    `);

    await migrate(client);

    expect((await client.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(7);
    expect((await client.execute({ sql: "SELECT name FROM devices WHERE id = ?", args: ["dev_1"] })).rows[0]).toEqual({ name: "Phone" });
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toContainEqual({
      name: "hosts",
    });
    expect((await client.execute("PRAGMA table_info(enrollment_codes)")).rows).toContainEqual(
      expect.objectContaining({ name: "kind", dflt_value: "'device'" }),
    );
    expect((await client.execute("PRAGMA table_info(notifications)")).rows).toContainEqual(
      expect.objectContaining({ name: "origin_host_id" }),
    );
    expect((await client.execute("PRAGMA table_info(interactions)")).rows).toContainEqual(
      expect.objectContaining({ name: "origin_host_id" }),
    );
    expect((await client.execute("PRAGMA table_info(devices)")).rows).toContainEqual(
      expect.objectContaining({ name: "live_activity_interactions_version" }),
    );
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toContainEqual({
      name: "activity_checkpoints",
    });
    expect((await client.execute("PRAGMA table_info(deliveries)")).rows).toContainEqual(
      expect.objectContaining({ name: "available_at" }),
    );
    expect((await client.execute("PRAGMA table_info(interactions)")).rows).toContainEqual(
      expect.objectContaining({ name: "response_token_consumed_at" }),
    );
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toContainEqual({
      name: "activity_push_tokens",
    });
    expect((await client.execute("PRAGMA table_info(activities)")).rows).toContainEqual(
      expect.objectContaining({ name: "end_reason" }),
    );
    client.close();
  });

  test("upgrades the deployed version-two delivery table", async () => {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple(`
      CREATE TABLE credentials (id TEXT PRIMARY KEY);
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, activity_push_token_ciphertext TEXT, system_activity_id TEXT,
        environment TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE interactions (id TEXT PRIMARY KEY);
      CREATE TABLE activities (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE notifications (id TEXT PRIMARY KEY);
      CREATE TABLE enrollment_codes (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE);
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        purpose TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
        accepted INTEGER, apns_id TEXT, reason TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO deliveries (
        id, resource_type, resource_id, purpose, idempotency_key, status, created_at
      ) VALUES ('del_1', 'checkpoint', 'int_1', 'checkpoint-ack', 'ack-once', 'accepted', 1);
      PRAGMA user_version = 2;
    `);

    await migrate(client);

    expect((await client.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(7);
    expect((await client.execute("PRAGMA table_info(deliveries)")).rows).toContainEqual(
      expect.objectContaining({ name: "available_at" }),
    );
    expect((await client.execute({ sql: "SELECT status FROM deliveries WHERE id = ?", args: ["del_1"] })).rows[0]).toEqual({
      status: "accepted",
    });
    client.close();
  });

  test("upgrades the deployed version-three interaction table", async () => {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple(`
      CREATE TABLE credentials (id TEXT PRIMARY KEY);
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, activity_push_token_ciphertext TEXT, system_activity_id TEXT,
        environment TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE interactions (id TEXT PRIMARY KEY);
      CREATE TABLE activities (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE notifications (id TEXT PRIMARY KEY);
      CREATE TABLE enrollment_codes (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE);
      PRAGMA user_version = 3;
    `);

    await migrate(client);

    expect((await client.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(7);
    expect((await client.execute("PRAGMA table_info(interactions)")).rows).toContainEqual(
      expect.objectContaining({ name: "response_token_consumed_at" }),
    );
    client.close();
  });

  test("upgrades the published schema-five database without losing activity tokens", async () => {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple(`
      CREATE TABLE credentials (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE enrollment_codes (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, code_ciphertext TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE notifications (id TEXT PRIMARY KEY);
      CREATE TABLE interactions (id TEXT PRIMARY KEY);
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE activities (id TEXT PRIMARY KEY, end_reason TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE activity_push_tokens (
        device_id TEXT NOT NULL, activity_id TEXT NOT NULL, token_ciphertext TEXT NOT NULL,
        environment TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, activity_id)
      );
      INSERT INTO devices (id) VALUES ('dev_1');
      INSERT INTO activities (id, end_reason) VALUES ('act_1', NULL);
      INSERT INTO activity_push_tokens (
        device_id, activity_id, token_ciphertext, environment, updated_at
      ) VALUES ('dev_1', 'act_1', 'sealed-token', 'production', 1);
      PRAGMA user_version = 5;
    `);

    await migrate(client);

    expect((await client.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(7);
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toContainEqual({
      name: "hosts",
    });
    expect((await client.execute("PRAGMA table_info(enrollment_codes)")).rows).toContainEqual(
      expect.objectContaining({ name: "kind", dflt_value: "'device'" }),
    );
    expect((await client.execute("PRAGMA table_info(notifications)")).rows).toContainEqual(
      expect.objectContaining({ name: "origin_host_id" }),
    );
    expect((await client.execute("PRAGMA table_info(interactions)")).rows).toContainEqual(
      expect.objectContaining({ name: "origin_host_id" }),
    );
    expect((await client.execute("SELECT token_ciphertext FROM activity_push_tokens")).rows[0]).toEqual({
      token_ciphertext: "sealed-token",
    });
    client.close();
  });

  test("refuses a database newer than the server supports", async () => {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple("PRAGMA user_version = 8;");
    await expect(migrate(client)).rejects.toThrow(/newer than this server supports/);
    client.close();
  });
});

describe("device enrollment", () => {
  test("exchanges an unexpired code exactly once", async () => {
    const { store } = await makeStore();
    const pairing = await store.createEnrollment();
    const enrolled = await store.exchangeEnrollment(pairing.code, "Phone");

    expect(pairing.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(enrolled.credential).toMatch(/^relay_device_/);
    expect((await store.authenticateDevice(enrolled.credential))?.name).toBe("Phone");
    await expect(store.exchangeEnrollment(pairing.code, "Other")).rejects.toThrow(ConflictError);
  });

  test("replays the same encrypted enrollment code for an idempotency key", async () => {
    const { store } = await makeStore();
    const first = await store.createEnrollment("pair-once");
    const replay = await store.createEnrollment("pair-once");
    expect(replay).toEqual(first);
  });

  test("rejects an expired code", async () => {
    const { store, advance } = await makeStore();
    const pairing = await store.createEnrollment();
    advance(10 * 60_000 + 1);
    await expect(store.exchangeEnrollment(pairing.code, "Phone")).rejects.toThrow(NotFoundError);
  });

  test("encrypts registered APNs tokens at rest", async () => {
    const { store } = await makeStore();
    const pairing = await store.createEnrollment();
    const enrolled = await store.exchangeEnrollment(pairing.code, "Phone");
    await store.updateDeviceTokens(enrolled.id, {
      apnsToken: "a".repeat(64),
      environment: "production",
    });

    const raw = await store.inspectDeviceCiphertexts(enrolled.id);
    expect(raw.apnsTokenCiphertext).not.toContain("a".repeat(64));
    expect((await store.pushTarget())?.apnsToken).toBe("a".repeat(64));
  });

  test("revokes a device credential and permits re-pairing", async () => {
    const { store } = await makeStore();
    const firstPairing = await store.createEnrollment();
    const first = await store.exchangeEnrollment(firstPairing.code, "Old Phone");
    const pending = await store.createInteraction(
      { title: "Relay", prompt: "Still valid?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "pending-before-revoke",
    );
    await store.revokeDevice(first.id);
    expect(await store.authenticateDevice(first.credential)).toBeUndefined();
    expect((await store.getInteraction(pending.interaction.id)).status).toBe("canceled");

    const secondPairing = await store.createEnrollment();
    expect((await store.exchangeEnrollment(secondPairing.code, "New Phone")).name).toBe("New Phone");
  });

  test("revocation resolves an active checkpoint before re-pairing", async () => {
    const { store } = await makeStore();
    const first = await pairLiveActivityPhone(store);
    await startTask(store);
    const pending = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "checkpoint-before-revoke",
    );

    await store.revokeDevice(first.id);

    expect((await store.getInteraction(pending.interaction.id)).status).toBe("canceled");
    expect(await store.pendingCheckpointDeliveries()).toEqual([]);
    expect(
      (await store.deliveryIntentsForKey("checkpoint", `checkpoint:${pending.interaction.id}:checkpoint-restore`))
        .map((delivery) => delivery.status),
    ).toEqual(["superseded"]);
    const second = await pairLiveActivityPhone(store);
    expect(second.name).toBe("Phone");
    await expect(store.createInteraction(
        { title: "Relay", prompt: "Continue?", kind: "yes_no", expiresInSeconds: 900, liveActivity: "required" },
        "checkpoint-after-revoke",
      )).resolves.toBeDefined();
  });
});

test("rotates the CLI credential atomically", async () => {
  const { store } = await makeStore();
  await store.installCliCredential("relay_cli_original-secret");
  const rotated = await store.rotateCliCredential("relay_cli_original-secret", "rotate-once");
  expect(rotated).toMatch(/^relay_cli_/);
  expect(await store.authenticateCli("relay_cli_original-secret")).toBeUndefined();
  expect(await store.authenticateCli(rotated)).toMatchObject({ name: "primary" });
  expect(await store.rotateCliCredential("relay_cli_original-secret", "rotate-once")).toBe(rotated);
  expect(await store.rotateCliCredential(rotated, "rotate-once")).toBe(rotated);
  await expect(store.installCliCredential("relay_cli_original-secret")).resolves.toBeDefined();
  expect(await store.authenticateCli("relay_cli_original-secret")).toBeUndefined();
  expect(await store.authenticateCli(rotated)).toMatchObject({ name: "primary" });
});

describe("hosts", () => {
  test("links a second host with its own credential", async () => {
    const { store, advance } = await makeStore();
    const piId = await store.installCliCredential("relay_cli_original-secret", "pi");
    const enrollment = await store.createEnrollment("link-mac", "host");
    advance(1_000);
    const mac = await store.exchangeHostEnrollment(enrollment.code, "mac");

    expect(mac.token).toMatch(/^relay_cli_/);
    expect(mac.token).not.toBe("relay_cli_original-secret");
    expect(await store.authenticateCli("relay_cli_original-secret")).toEqual({ id: piId, name: "pi" });
    expect(await store.authenticateCli(mac.token)).toEqual({ id: mac.id, name: "mac" });
    expect(await (await store.listHosts()).map((host) => host.name)).toEqual(["pi", "mac"]);
  });

  test("rotating one host leaves the other host working", async () => {
    const { store } = await makeStore();
    await store.installCliCredential("relay_cli_original-secret", "pi");
    const mac = await store.exchangeHostEnrollment((await store.createEnrollment("link-mac", "host")).code, "mac");

    const rotated = await store.rotateCliCredential(mac.token, "rotate-mac");

    expect(await store.authenticateCli(mac.token)).toBeUndefined();
    expect(await store.authenticateCli(rotated)).toEqual({ id: mac.id, name: "mac" });
    expect(await store.authenticateCli("relay_cli_original-secret")).toMatchObject({ name: "pi" });
  });

  test("rejects a reused, expired, or device-scoped enrollment code", async () => {
    const { store, advance } = await makeStore();
    await store.installCliCredential("relay_cli_original-secret", "pi");
    const reused = await store.createEnrollment("link-once", "host");
    await store.exchangeHostEnrollment(reused.code, "mac");
    await expect(store.exchangeHostEnrollment(reused.code, "laptop")).rejects.toThrow(ConflictError);

    const devicePairing = await store.createEnrollment("device-code");
    await expect(store.exchangeHostEnrollment(devicePairing.code, "laptop")).rejects.toThrow(NotFoundError);

    const stale = await store.createEnrollment("link-late", "host");
    advance(11 * 60_000);
    await expect(store.exchangeHostEnrollment(stale.code, "laptop")).rejects.toThrow(NotFoundError);
  });

  test("rejects a duplicate active host name and frees it after revocation", async () => {
    const { store } = await makeStore();
    await store.installCliCredential("relay_cli_original-secret", "pi");
    const mac = await store.exchangeHostEnrollment((await store.createEnrollment("link-mac", "host")).code, "mac");
    await expect(store.exchangeHostEnrollment((await store.createEnrollment("link-again", "host")).code, "mac")).rejects.toThrow(ConflictError);

    await store.revokeHost("mac");
    const replacement = await store.exchangeHostEnrollment((await store.createEnrollment("relink-mac", "host")).code, "mac");
    expect(replacement.id).not.toBe(mac.id);
    expect(await store.authenticateCli(mac.token)).toBeUndefined();
    expect(await store.authenticateCli(replacement.token)).toMatchObject({ name: "mac" });
  });

  test("revokes a host by name or id but never the last one", async () => {
    const { store } = await makeStore();
    await store.installCliCredential("relay_cli_original-secret", "pi");
    const mac = await store.exchangeHostEnrollment((await store.createEnrollment("link-mac", "host")).code, "mac");

    expect(await store.revokeHost(mac.id)).toEqual({ id: mac.id, name: "mac" });
    expect(await store.authenticateCli(mac.token)).toBeUndefined();
    expect(await (await store.listHosts()).map((host) => host.name)).toEqual(["pi"]);
    await expect(store.revokeHost("pi")).rejects.toThrow(ConflictError);
    await expect(store.revokeHost("nope")).rejects.toThrow(NotFoundError);
    expect(await store.authenticateCli("relay_cli_original-secret")).toMatchObject({ name: "pi" });
  });

  test("attributes notifications and interactions to the sending host", async () => {
    const { store } = await makeStore();
    const piId = await store.installCliCredential("relay_cli_original-secret", "pi");
    const mac = await store.exchangeHostEnrollment((await store.createEnrollment("link-mac", "host")).code, "mac");

    await store.createNotification({ title: "Relay", body: "Built" }, "ntf-pi", piId);
    const asked = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "int-mac",
      mac.id,
    );

    expect(asked.interaction.origin).toBe("mac");
    expect(await (await store.listInbox()).map((row) => row.origin)).toEqual(["mac"]);
    expect(await (await store.listRecentNotifications()).map((row) => row.origin)).toEqual(["pi"]);
  });

  test("reports the origin host name rather than its id when creating a notification", async () => {
    const { store } = await makeStore();
    const piId = await store.installCliCredential("relay_cli_original-secret", "pi");
    const created = await store.createNotification({ title: "Relay", body: "Built" }, "ntf-pi", piId);

    expect(created.notification.origin).toBe("pi");
    expect(created.notification).not.toHaveProperty("originHostId");
    expect((await store.createNotification({ title: "Relay", body: "Built" }, "ntf-pi", piId)).notification).toEqual(
      created.notification,
    );
  });

  test("records the rotating host's call in lastSeenAt", async () => {
    const { store, advance } = await makeStore();
    await store.installCliCredential("relay_cli_original-secret", "pi");
    advance(60_000);
    await store.rotateCliCredential("relay_cli_original-secret", "rotate-once");
    expect((await store.listHosts())[0]?.lastSeenAt).toBe("2026-08-06T12:01:00.000Z");
  });

  test("records the last time each host called the API", async () => {
    const { store, advance } = await makeStore();
    await store.installCliCredential("relay_cli_original-secret", "pi");
    expect((await store.listHosts())[0]?.lastSeenAt).toBeNull();
    advance(60_000);
    await store.authenticateCli("relay_cli_original-secret");
    expect((await store.listHosts())[0]?.lastSeenAt).toBe("2026-08-06T12:01:00.000Z");
  });
});

test("keeps the rotating host linked to its replacement credential", async () => {
  const { store } = await makeStore();
  const hostId = await store.installCliCredential("relay_cli_original-secret", "pi");
  const rotated = await store.rotateCliCredential("relay_cli_original-secret", "rotate-once");
  expect(await store.authenticateCli(rotated)).toEqual({ id: hostId, name: "pi" });
  expect(await store.listHosts()).toHaveLength(1);
});

describe("interactions", () => {
  test("replays matching idempotent creation and rejects conflicting payloads", async () => {
    const { store } = await makeStore();
    const first = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "same-key",
    );
    const replay = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "same-key",
    );

    expect(replay.interaction.id).toBe(first.interaction.id);
    expect(replay.idempotent).toBe(true);
    await expect(store.createInteraction(
        { title: "Relay", prompt: "Delete?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
        "same-key",
      )).rejects.toThrow(ConflictError);
  });

  test("accepts one credential-bound response and returns its result to a competing tap", async () => {
    const { store } = await makeStore();
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "ask-1",
    );

    const answered = await store.respondToInteraction(created.interaction.id, created.responseCredential, {
      action: "approve",
    });
    expect(answered.status).toBe("approved");
    expect(
      await store.respondToInteraction(created.interaction.id, created.responseCredential, {
        action: "deny",
      }),
    ).toMatchObject({ status: "approved", response: "approve" });
  });

  test("records response credential consumption with the winning transition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-response-credential-"));
    const filename = join(directory, "relay.sqlite");
    try {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const store = await openRelayStore({
        filename,
        tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
        secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
        now: () => now,
      });
      const created = await store.createInteraction(
        { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "disabled" },
        "consume-response-credential",
      );

      await store.respondToInteraction(created.interaction.id, created.responseCredential, { action: "approve" });

      const deviceWinner = await store.createInteraction(
        { title: "Relay", prompt: "Continue?", kind: "yes_no", expiresInSeconds: 900, liveActivity: "disabled" },
        "consume-competing-response-credential",
      );
      await store.respondToInteractionAsDevice(deviceWinner.interaction.id, { action: "yes" });
      await store.respondToInteraction(deviceWinner.interaction.id, deviceWinner.responseCredential, { action: "no" });
      store.close();

      const client = new BetterSqlite3(filename, { readonly: true });
      expect(
        client.prepare("SELECT response_token_consumed_at FROM interactions WHERE id = ?").get(created.interaction.id),
      ).toEqual({ response_token_consumed_at: now.getTime() });
      expect(
        client.prepare("SELECT response_token_consumed_at FROM interactions WHERE id = ?").get(deviceWinner.interaction.id),
      ).toEqual({ response_token_consumed_at: now.getTime() });
      client.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("enforces response kind and expiry", async () => {
    const { store, advance } = await makeStore();
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Why?", kind: "text", expiresInSeconds: 30, liveActivity: "disabled" },
      "ask-2",
    );
    await expect(store.respondToInteraction(created.interaction.id, created.responseCredential, {
        action: "approve",
      })).rejects.toThrow(ConflictError);
    advance(30_001);
    expect((await store.getInteraction(created.interaction.id)).status).toBe("expired");
  });
});

describe("Live Activity interaction checkpoints", () => {
  test("automatically checkpoints an active task and replays the same delivery", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);

    const first = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "checkpoint-auto",
    );
    const replay = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "checkpoint-auto",
    );

    expect(first.interaction.activity).toEqual({ id: activity.id, presentation: "checkpoint" });
    expect(first.activityDelivery).toMatchObject({ purpose: "checkpoint-show", status: "pending" });
    expect(replay.activityDelivery?.id).toBe(first.activityDelivery?.id);
    expect((await store.getActivity(activity.id)).sequence).toBe(2);
  });

  test("starts a temporary activity only when presentation is required", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);

    const automatic = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "automatic-alert-only",
    );
    expect(automatic.activityDelivery).toBeNull();

    const required = await store.createInteraction(
      { title: "Relay", prompt: "Proceed?", kind: "yes_no", expiresInSeconds: 900, liveActivity: "required" },
      "temporary-required",
    );
    expect(required.interaction.activity?.presentation).toBe("temporary");
    expect(required.activityDelivery).toMatchObject({ purpose: "checkpoint-show" });
    expect((await store.activeActivity())?.id).toBe(required.interaction.activity?.id);
  });

  test("rejects unsupported presentation and uses a temporary activity when the target is occupied", async () => {
    const unsupported = (await makeStore()).store;
    await expect(unsupported.createInteraction(
        { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "required" },
        "unsupported-required",
      )).rejects.toThrow(/unsupported/i);

    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    await store.createInteraction(
      { title: "Relay", prompt: "First?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "first-checkpoint",
    );
    const automatic = await store.createInteraction(
      {
        title: "Relay",
        prompt: "Second?",
        kind: "approval",
        expiresInSeconds: 900,
        liveActivity: "auto",
        activity: activity.id,
      },
      "busy-auto",
    );
    expect(automatic.interaction.activity?.presentation).toBe("temporary");
    expect(automatic.activityDelivery).toMatchObject({ purpose: "checkpoint-show" });
  });

  test("targets the requested agent when several activities are active", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const release = await startTask(store);
    const review = await store.startActivity({
      key: "review",
      title: "Review",
      status: "Reading",
      progress: 0,
      symbol: "code",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 3600,
    });

    const targeted = await store.createInteraction(
      {
        title: "Relay",
        prompt: "Approve review?",
        kind: "approval",
        expiresInSeconds: 900,
        liveActivity: "auto",
        activity: "review",
      },
      "target-review",
    );
    expect(targeted.interaction.activity).toEqual({ id: review.id, presentation: "checkpoint" });
    expect((await store.getActivity(review.id)).sequence).toBe(2);
    expect((await store.getActivity(release.id)).sequence).toBe(1);
  });

  test("keeps disabled asks off an active activity and returns the winner to device retries", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "disabled" },
      "disabled-presentation",
    );
    expect(created.activityDelivery).toBeNull();
    expect((await store.getActivity(activity.id)).sequence).toBe(1);

    expect(
      (await store.respondToInteraction(created.interaction.id, created.responseCredential, { action: "approve" })).status,
    ).toBe("approved");
    expect(
      (await store.respondToInteractionAsDevice(created.interaction.id, { action: "approve" })).status,
    ).toBe("approved");
    expect(
      await store.respondToInteractionAsDevice(created.interaction.id, { action: "deny" }),
    ).toMatchObject({ status: "approved", response: "approve" });
  });

  test("keeps task updates hidden behind a checkpoint and restores the newest state", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "restore-newest",
    );

    const update = await store.updateActivityIdempotent(activity.id, { status: "Ready", progress: 0.9 }, "ready-update");
    expect(JSON.parse(update.delivery.payload!)).toMatchObject({
      presentation: "checkpoint",
      activity: { status: "Ready", progress: 0.9 },
      checkpoint: { interactionId: created.interaction.id },
    });

    const answered = await store.respondToInteractionWithDelivery(
      created.interaction.id,
      created.responseCredential,
      { action: "approve" },
    );
    expect(answered.interaction.status).toBe("approved");
    expect(JSON.parse(answered.activityDelivery!.payload!)).toMatchObject({
      presentation: "acknowledged",
      activity: { status: "Ready", progress: 0.9 },
      checkpoint: { interactionId: created.interaction.id, result: "approve" },
    });

    const restored = await store.finishAcknowledgedCheckpoint(created.interaction.id);
    expect(JSON.parse(restored!.payload!)).toMatchObject({
      presentation: "task",
      activity: { status: "Ready", progress: 0.9 },
    });
  });

  test("supersedes failed checkpoint deliveries when a newer activity state is durable", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "supersede-checkpoint-show",
    );
    await store.claimDelivery(created.activityDelivery!.id);
    await store.completeCheckpointDelivery(created.activityDelivery!.id, {
      accepted: false,
      apnsId: "failed-show",
      reason: "TooManyRequests",
    });

    const answered = await store.respondToInteractionWithDelivery(
      created.interaction.id,
      created.responseCredential,
      { action: "approve" },
    );
    expect((await store.deliveryById(created.activityDelivery!.id)).status).toBe("superseded");
    expect(await (await store.pendingCheckpointDeliveries()).map((item) => item.id)).toEqual([answered.activityDelivery!.id]);

    const completed = await store.completeCheckpointDelivery(answered.activityDelivery!.id, {
      accepted: true,
      apnsId: "accepted-ack",
      reason: null,
    });
    expect(completed.nextDelivery?.purpose).toBe("checkpoint-restore");
    expect(await store.deliveryById(completed.nextDelivery!.id)).toMatchObject({ status: "pending" });
    expect(await store.pendingCheckpointDeliveries()).toEqual([]);

    const newerTask = await store.updateActivityIdempotent(
      activity.id,
      { status: "Newer task state" },
      "newer-than-restore",
    );
    expect((await store.deliveryById(completed.nextDelivery!.id)).status).toBe("superseded");
    expect(await store.pendingCheckpointDeliveries()).toEqual([]);
    expect(JSON.parse(newerTask.delivery.payload!)).toMatchObject({ status: "Newer task state" });
  });

  test("restores the desired task state after an acknowledgement delivery fails", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    await startTask(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "failed-ack-restores-task",
    );
    const answered = await store.respondToInteractionWithDelivery(
      created.interaction.id,
      created.responseCredential,
      { action: "approve" },
    );

    const completed = await store.completeCheckpointDelivery(answered.activityDelivery!.id, {
      accepted: false,
      apnsId: "failed-ack",
      reason: "TooManyRequests",
    });

    expect(completed.nextDelivery).toMatchObject({ purpose: "checkpoint-restore", status: "pending" });
    expect((await store.deliveryById(answered.activityDelivery!.id)).status).toBe("superseded");
  });

  test("keeps restore delivery hidden until its durable acknowledgement interval elapses", async () => {
    const { store, advance } = await makeStore();
    await pairLiveActivityPhone(store);
    await startTask(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "durable-acknowledgement-interval",
    );
    const answered = await store.respondToInteractionWithDelivery(
      created.interaction.id,
      created.responseCredential,
      { action: "approve" },
    );
    const completed = await store.completeCheckpointDelivery(answered.activityDelivery!.id, {
      accepted: true,
      apnsId: "accepted-ack",
      reason: null,
    });

    expect(completed.nextDelivery?.availableAt?.toISOString()).toBe("2026-08-06T12:00:01.500Z");
    expect(await store.pendingCheckpointDeliveries()).toEqual([]);
    advance(1_500);
    expect(await store.pendingCheckpointDeliveries()).toEqual([completed.nextDelivery]);
  });

  test("keeps acknowledged presentation through concurrent task updates and reconciles it", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "acknowledgement-concurrent-update",
    );
    const answered = await store.respondToInteractionWithDelivery(
      created.interaction.id,
      created.responseCredential,
      { action: "approve" },
    );

    const update = await store.updateActivityIdempotent(
      activity.id,
      { status: "Published" },
      "update-during-acknowledgement",
    );
    expect(JSON.parse(update.delivery.payload!)).toMatchObject({
      presentation: "acknowledged",
      activity: { status: "Published" },
      checkpoint: { result: "approve" },
    });
    expect((await store.deliveryById(answered.activityDelivery!.id)).status).toBe("superseded");

    const reconciled = await store.reconcileExpiredCheckpoints();
    expect(reconciled).toContainEqual(expect.objectContaining({ purpose: "checkpoint-restore" }));
  });

  test("ends temporary checkpoints and reconciles expiry", async () => {
    const { store, advance } = await makeStore();
    await pairLiveActivityPhone(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Proceed?", kind: "yes_no", expiresInSeconds: 30, liveActivity: "required" },
      "temporary-expiry",
    );
    advance(30_001);

    const deliveries = await store.reconcileExpiredCheckpoints();

    expect((await store.getInteraction(created.interaction.id)).status).toBe("expired");
    expect((await store.getActivity(created.interaction.activity!.id)).state).toBe("active");
    expect(deliveries[0]).toMatchObject({ purpose: "checkpoint-ack", status: "pending" });

    const ended = await store.finishAcknowledgedCheckpoint(created.interaction.id);
    expect((await store.getActivity(created.interaction.activity!.id)).state).toBe("ended");
    expect(ended).toMatchObject({ purpose: "checkpoint-end", status: "pending" });
  });

  test("ending a task frees its checkpoint without canceling the interaction", async () => {
    const { store } = await makeStore();
    await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    const first = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "task-ending",
    );

    await store.endActivity(activity.id, { status: "Stopped" });
    const second = await store.createInteraction(
      { title: "Relay", prompt: "Continue?", kind: "yes_no", expiresInSeconds: 900, liveActivity: "required" },
      "after-task-ending",
    );

    expect((await store.getInteraction(first.interaction.id)).status).toBe("pending");
    expect(second.interaction.activity?.presentation).toBe("temporary");
  });

  test("inbox reads reconcile expired checkpoints", async () => {
    const { store, advance } = await makeStore();
    await pairLiveActivityPhone(store);
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Proceed?", kind: "yes_no", expiresInSeconds: 30, liveActivity: "required" },
      "inbox-expiry",
    );
    advance(30_001);

    expect((await (await store.listInbox()).find((item) => item.id === created.interaction.id))?.status).toBe("expired");
    expect(await store.pendingCheckpointDeliveries()).toContainEqual(
      expect.objectContaining({ purpose: "checkpoint-ack" }),
    );
  });

  test("startup reconciliation repairs a terminal interaction with an unresolved checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-checkpoint-recovery-"));
    const filename = join(directory, "relay.sqlite");
    const options = {
      filename,
      tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
      secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
      now: () => new Date("2026-08-06T12:01:00.000Z"),
    };
    try {
      const first = await openRelayStore(options);
      await pairLiveActivityPhone(first);
      const activity = await startTask(first);
      const created = await first.createInteraction(
        { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 30, liveActivity: "auto" },
        "crash-between-terminal-and-checkpoint",
      );
      first.close();

      const raw = new BetterSqlite3(filename);
      raw.prepare("UPDATE interactions SET status = 'expired', responded_at = ? WHERE id = ?")
        .run(Date.parse("2026-08-06T12:00:31.000Z"), created.interaction.id);
      raw.close();

      const reopened = await openRelayStore(options);
      const deliveries = await reopened.reconcileExpiredCheckpoints();
      expect(deliveries).toContainEqual(expect.objectContaining({ purpose: "checkpoint-ack" }));
      expect((await reopened.getActivity(activity.id)).sequence).toBe(3);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("task Live Activity", () => {
  test("keeps concurrent activities and their update tokens isolated", async () => {
    const { store } = await makeStore();
    const phone = await pairLiveActivityPhone(store);
    const first = await startTask(store);
    const second = await store.startActivity({
      key: "review",
      title: "Review",
      status: "Reading",
      progress: 0.1,
      symbol: "code",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 7200,
    });

    await store.registerActivityPushToken(phone.id, first.id, "c".repeat(64), "production");
    await store.registerActivityPushToken(phone.id, second.id, "d".repeat(64), "production");

    expect(new Set(await (await store.activeActivities()).map((activity) => activity.id))).toEqual(new Set([first.id, second.id]));
    expect((await store.activityPushTarget(first.id))?.activityPushToken).toBe("c".repeat(64));
    expect((await store.activityPushTarget(second.id))?.activityPushToken).toBe("d".repeat(64));

    await store.removeActivityPushToken(phone.id, first.id);
    expect(await store.activityPushTarget(first.id)).toBeNull();
    expect((await store.activityPushTarget(second.id))?.activityPushToken).toBe("d".repeat(64));
  });

  test("replaces only the active activity with the same key", async () => {
    const { store } = await makeStore();
    const first = await startTask(store);
    const sibling = await store.startActivity({
      key: "review",
      title: "Review",
      status: "Reading",
      progress: 0,
      symbol: "code",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 3600,
    });

    const replacement = await store.startActivity({
      key: "release",
      title: "Release again",
      status: "Restarting",
      progress: 0,
      symbol: "build",
      accentColor: "#5ED8B7",
      replace: true,
      staleAfterSeconds: 3600,
    });

    expect((await store.getActivity(first.id)).state).toBe("ended");
    expect((await store.getActivity(sibling.id)).state).toBe("active");
    expect((await store.getActivity(replacement.id)).state).toBe("active");
  });

  test("dismissal releases only the matching activity and stale tasks remain controllable", async () => {
    const { store, advance } = await makeStore();
    const phone = await pairLiveActivityPhone(store);
    const first = await startTask(store);
    const sibling = await store.startActivity({
      key: "review",
      title: "Review",
      status: "Reading",
      progress: 0,
      symbol: "code",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 7200,
    });
    await store.registerActivityPushToken(phone.id, first.id, "c".repeat(64), "production");

    await store.dismissActivity(phone.id, first.id);
    expect(await store.getActivity(first.id)).toMatchObject({ state: "ended", endReason: "dismissed" });
    expect(await store.activityPushTarget(first.id)).toBeNull();
    expect((await store.getActivity(sibling.id)).state).toBe("active");

    advance(7200_001);
    expect(await store.activeActivities()).toEqual([expect.objectContaining({ id: sibling.id, state: "active" })]);
    expect((await store.getActivity(sibling.id)).staleAt).toBe("2026-08-06T14:00:00.000Z");
  });

  test("device end records the ended activity and delivery intent together", async () => {
    const { store } = await makeStore();
    const activity = await startTask(store);

    const result = await store.endActivityForDevice(activity.id, `device-end:${activity.id}`);

    expect(result.activity).toMatchObject({ state: "ended", endReason: "user_ended" });
    expect(result.delivery).toMatchObject({
      resourceId: activity.id,
      purpose: "device-end",
      status: "pending",
    });
    expect(await store.deliveryIntentsForKey("activity", `device-end:${activity.id}`)).toEqual([
      expect.objectContaining({ id: result.delivery.id, resourceId: activity.id }),
    ]);
  });

  test("keeps failed agent-driven display ends controllable from the device", async () => {
    const { store } = await makeStore();
    const phone = await pairLiveActivityPhone(store);
    const activity = await startTask(store);
    await store.registerActivityPushToken(phone.id, activity.id, "c".repeat(64), "production");

    await store.endActivityIdempotent(activity.id, {}, "agent-end");

    expect(await store.deviceActivities(phone.id)).toEqual([
      expect.objectContaining({ id: activity.id, state: "ended", endReason: "agent_ended" }),
    ]);
  });

  test("persists the exact payload and pending delivery intent for each mutation", async () => {
    const { store } = await makeStore();
    const started = await store.startActivityIdempotent(
      {
        key: "release",
        title: "Release",
        status: "Building",
        progress: 0,
        symbol: "build",
        accentColor: "#5ED8B7",
        replace: false,
        staleAfterSeconds: 3600,
      },
      "start-delivery",
    );
    expect(started.deliveries[0]).toMatchObject({ purpose: "start", status: "pending" });

    const firstUpdate = await store.updateActivityIdempotent(started.activity.id, { progress: 0.5 }, "update-one");
    await store.updateActivityIdempotent(started.activity.id, { progress: 0.75 }, "update-two");

    expect(JSON.parse(firstUpdate.delivery.payload!)).toMatchObject({ progress: 0.5, sequence: 2 });
    expect(await store.getActivity(started.activity.id)).toMatchObject({ progress: 0.75, sequence: 3 });

    const replayedUpdate = await store.updateActivityIdempotent(started.activity.id, { progress: 0.5 }, "update-one");
    expect(replayedUpdate).toMatchObject({
      idempotent: true,
      activity: { progress: 0.75, sequence: 3 },
      delivery: { id: firstUpdate.delivery.id, payload: firstUpdate.delivery.payload, status: "superseded" },
    });

    const ended = await store.endActivityIdempotent(started.activity.id, {}, "end-one");
    expect(ended.idempotent).toBe(false);
    expect(await store.endActivityIdempotent(started.activity.id, {}, "end-one"))
      .toEqual({ ...ended, idempotent: true });
  });

  test("allows distinct activities, requires replacement for duplicate keys, and rejects stale sequences", async () => {
    const { store } = await makeStore();
    const first = await store.startActivity({
      key: "release",
      title: "Release",
      status: "Building",
      progress: 0,
      symbol: "build",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 3600,
    });
    expect((await store.startActivity({
      title: "Other",
      status: "Queued",
      progress: 0,
      symbol: "terminal",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 3600,
    })).state).toBe("active");
    await expect(store.startActivity({
      key: "release",
      title: "Duplicate",
      status: "Queued",
      progress: 0,
      symbol: "terminal",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 3600,
    })).rejects.toThrow(ConflictError);

    const updated = await store.updateActivity(first.id, { progress: 0.5, sequence: 2 });
    expect(updated.progress).toBe(0.5);
    await expect(store.updateActivity(first.id, { progress: 0.25, sequence: 1 })).rejects.toThrow(ConflictError);

    const replacement = await store.startActivity({
      key: "release",
      title: "Other",
      status: "Queued",
      progress: 0,
      symbol: "terminal",
      accentColor: "#5ED8B7",
      replace: true,
      staleAfterSeconds: 3600,
    });
    expect((await store.getActivity(first.id)).state).toBe("ended");
    expect(replacement.state).toBe("active");
  });
});

test("independent server instances share delivery claims and recover an expired lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-delivery-lease-"));
  let currentTime = new Date("2026-08-06T12:00:00.000Z");
  const options = {
    filename: join(directory, "relay.sqlite"),
    tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
    secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
    now: () => currentTime,
  };
  const first = await openRelayStore(options);
  const second = await openRelayStore(options);
  try {
    const activity = await startTask(first);
    const update = await first.updateActivity(activity.id, { progress: 0.5 });
    const nextUpdate = await second.updateActivity(activity.id, { progress: 0.75 });
    expect(nextUpdate.pushTimestamp).toBe(update.pushTimestamp + 1);
    const created = await first.createNotification({ title: "Relay", body: "Ready" }, "shared-delivery");
    expect(await Promise.all([
      first.claimDelivery(created.delivery.id),
      second.claimDelivery(created.delivery.id),
    ])).toEqual(expect.arrayContaining([true, false]));
    expect(await second.claimDelivery(created.delivery.id)).toBe(false);
    currentTime = new Date(currentTime.getTime() + 300_000);
    expect(await second.claimDelivery(created.delivery.id)).toBe(true);
    await second.completeNotificationDelivery(created.notification.id, created.delivery.id, {
      accepted: true, apnsId: "accepted-after-recovery", reason: null,
    });
    expect(await first.deliveryById(created.delivery.id)).toMatchObject({ status: "accepted" });
    expect(await first.claimDelivery(created.delivery.id)).toBe(false);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent notification creation keeps each notification and delivery together", async () => {
  const { store } = await makeStore();
  try {
    const created = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      store.createNotification({ title: "Relay", body: `Update ${index}` }, `concurrent-${index}`),
    ));
    expect(await store.listRecentNotifications()).toHaveLength(4);
    for (const item of created) {
      expect(await store.deliveryById(item.delivery.id)).toMatchObject({ resourceId: item.notification.id });
    }
  } finally {
    store.close();
  }
});
