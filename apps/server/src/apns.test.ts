import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ActivityPushSequencer,
  ApnsPushProvider,
  buildActivityPayload,
  buildInteractionPayload,
  buildNotificationPayload,
  createProviderJwt,
} from "./apns.js";

const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
  format: "pem",
  type: "pkcs8",
}) as string;

describe("APNs provider authentication", () => {
  test("creates a short-lived ES256 provider token with Apple claims", () => {
    const jwt = createProviderJwt({ keyId: "KEY123", teamId: "TEAM123", privateKey }, 1_786_017_600);
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iss: "TEAM123", iat: 1_786_017_600 });
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
  });
});

describe("APNs payloads", () => {
  test("builds a communication notification and an interaction category", () => {
    expect(buildNotificationPayload({ title: "Codex", body: "Finished", url: "https://example.com" })).toMatchObject({
      aps: { alert: { title: "Codex", body: "Finished" }, "mutable-content": 1 },
      relay: { url: "https://example.com" },
    });

    expect(
      buildInteractionPayload({
        interactionId: "int_1",
        kind: "text",
        title: "Codex",
        prompt: "What next?",
        responseCredential: "relay_response_secret",
      }),
    ).toMatchObject({
      aps: { category: "RELAY_TEXT_REPLY" },
      relay: { interactionId: "int_1", responseCredential: "relay_response_secret" },
    });
  });

  test("builds remote start and update Live Activity payloads", () => {
    const start = buildActivityPayload("start", {
      id: "act_1",
      key: null,
      title: "Release",
      status: "Building",
      detail: null,
      progress: 0.2,
      symbol: "build",
      accentColor: "#5ED8B7",
      state: "active",
      sequence: 1,
      pushTimestamp: 1_786_017_600,
      staleAt: "2026-08-06T13:00:00.000Z",
    });
    expect(start.aps).toMatchObject({ timestamp: 1_786_017_600, event: "start", "attributes-type": "RelayActivityAttributes", "input-push-token": 1 });
    expect(start.aps["content-state"]).toMatchObject({ status: "Building", sequence: 1 });
  });

  test("builds a credential-free interactive checkpoint payload", () => {
    const update = buildActivityPayload("update", {
      presentation: "checkpoint",
      activity: {
        id: "act_1",
        key: "release",
        title: "Release",
        status: "Building",
        detail: null,
        progress: 0.5,
        symbol: "build",
        accentColor: "#5ED8B7",
        state: "active",
        sequence: 3,
        pushTimestamp: 1_786_017_602,
        staleAt: "2026-08-06T13:00:00.000Z",
      },
      checkpoint: {
        interactionId: "int_1",
        kind: "approval",
        prompt: "Deploy?",
        expiresAt: "2026-08-06T12:15:00.000Z",
        result: null,
      },
    });

    expect(update.aps.timestamp).toBe(1_786_017_602);
    expect(update.aps["content-state"]).toMatchObject({
      presentation: "checkpoint",
      checkpoint: { interactionId: "int_1", kind: "approval", prompt: "Deploy?" },
      sequence: 3,
    });
    expect(JSON.stringify(update)).not.toMatch(/credential|token|secret/i);
    expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(4096);
  });

  test("rejects payloads over the APNs 4KB limit", () => {
    const provider = new ApnsPushProvider({
      keyId: "KEY123",
      teamId: "TEAM123",
      privateKey,
      bundleId: "com.example.relay",
      environment: "production",
    });
    expect(() => provider.encodePayload({ aps: {}, oversized: "x".repeat(5_000) })).toThrow(/4096/);
  });
});

describe("ActivityPushSequencer", () => {
  test("blocks new activity pushes while an exclusive drain commits", async () => {
    const sequencer = new ActivityPushSequencer();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = sequencer.run("act_1", async () => firstGate);
    let drained = false;
    const drain = sequencer.withDrain(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(sequencer.run("act_2", async () => "late")).rejects.toThrow("draining");
    expect(drained).toBe(false);
    releaseFirst();
    await Promise.all([first, drain]);
    expect(drained).toBe(true);
  });

  test("serializes pushes for one activity", async () => {
    const sequencer = new ActivityPushSequencer();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = sequencer.run("act_1", async () => {
      events.push("first");
      await firstGate;
      events.push("first:done");
      return "first";
    });
    const second = sequencer.run("act_1", async () => {
      events.push("second");
      return "second";
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first"]);
    let idleResolved = false;
    const idle = sequencer.waitForIdle().then(() => { idleResolved = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(idleResolved).toBe(false);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    await idle;
    expect(idleResolved).toBe(true);
    expect(events).toEqual(["first", "first:done", "second"]);
  });
});
