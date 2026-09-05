import { describe, expect, test } from "vitest";
import type { PushProvider, PushResult } from "./apns.js";
import { CheckpointDeliveryService } from "./checkpoints.js";
import { SecretBox, TokenAuthority } from "./security.js";
import { openRelayStore } from "./store.js";

class RecordingProvider implements PushProvider {
    public activities: Array<{ token: string; event: string; priority: number; activity: unknown }> = [];
    public activityGate: Promise<void> | null = null;
    public results: PushResult[] = [];

  async sendNotification(): Promise<PushResult> {
    throw new Error("not used");
  }

  async sendInteraction(): Promise<PushResult> {
    throw new Error("not used");
  }

  async sendActivity(token: string, event: "start" | "update" | "end", activity: unknown, priority: 5 | 10) {
    this.activities.push({ token, event, priority, activity });
    await this.activityGate;
    return this.results.shift() ?? { accepted: true, status: 200, apnsId: "apns-checkpoint", reason: null };
  }
}

async function setup() {
  const store = await openRelayStore({
    filename: ":memory:",
    tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
    secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
  });
  const pairing = await store.createEnrollment();
  const device = await store.exchangeEnrollment(pairing.code, "Phone");
  await store.updateDeviceTokens(device.id, {
    apnsToken: "a".repeat(64),
    pushToStartToken: "b".repeat(64),
    environment: "production",
    capabilities: { liveActivityInteractions: 1 },
  });
  const provider = new RecordingProvider();
  return {
    store,
    provider,
    service: new CheckpointDeliveryService(store, provider, (task) => task()),
    device,
  };
}

describe("CheckpointDeliveryService", () => {
  test("coalesces concurrent flushes of the same delivery", async () => {
    const { store, provider, service } = await setup();
    let release!: () => void;
    provider.activityGate = new Promise<void>((resolve) => { release = resolve; });
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "required" },
      "coalesce-flush",
    );

    const first = service.flush([created.activityDelivery!]);
    while (provider.activities.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = service.flush([created.activityDelivery!]);
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult[0]?.accepted).toBe(true);
    expect(secondResult[0]?.accepted).toBe(true);
    expect(provider.activities).toHaveLength(1);
  });

  test("waits for an in-flight activity push before credential revocation can continue", async () => {
    const { store, provider, service } = await setup();
    let release!: () => void;
    provider.activityGate = new Promise<void>((resolve) => { release = resolve; });
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "required" },
      "revoke-drain",
    );

    const flush = service.flush([created.activityDelivery!]);
    while (provider.activities.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    let idleResolved = false;
    const idle = service.waitForIdle().then(() => { idleResolved = true; });
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    release();
    await Promise.all([flush, idle]);
    expect(idleResolved).toBe(true);
  });

  test("uses push-to-start for a temporary checkpoint and records acceptance", async () => {
    const { store, provider, service } = await setup();
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "required" },
      "temporary-start",
    );

    const results = await service.flush([created.activityDelivery!]);

    expect(results).toMatchObject([{ accepted: true, apnsId: "apns-checkpoint" }]);
    expect(provider.activities).toMatchObject([
      { token: "b".repeat(64), event: "start", priority: 10 },
    ]);
    expect((await store.deliveryById(created.activityDelivery!.id)).status).toBe("accepted");
  });

  test("uses the matching update token for task checkpoint and restoration", async () => {
    const { store, provider, service, device } = await setup();
    const activity = await store.startActivity({
      title: "Release",
      status: "Building",
      progress: 0,
      symbol: "build",
      accentColor: "#5ED8B7",
      replace: false,
      staleAfterSeconds: 3600,
    });
    await store.registerActivityPushToken(device.id, activity.id, "c".repeat(64), "production");
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "auto" },
      "task-checkpoint",
    );
    await service.flush([created.activityDelivery!]);
    const answered = await store.respondToInteractionWithDelivery(
      created.interaction.id,
      created.responseCredential,
      { action: "approve" },
    );
    await service.flush([answered.activityDelivery!]);

    expect(provider.activities).toMatchObject([
      { token: "c".repeat(64), event: "update", priority: 10 },
      { token: "c".repeat(64), event: "update", priority: 10 },
      { token: "c".repeat(64), event: "update", priority: 5 },
    ]);
  });

  test("parks permanent token failures until a replacement token is registered", async () => {
    const { store, provider, service, device } = await setup();
    provider.results.push(
      { accepted: false, status: 400, apnsId: "bad-token", reason: "BadDeviceToken" },
      { accepted: true, status: 200, apnsId: "replacement-token", reason: null },
    );
    const created = await store.createInteraction(
      { title: "Relay", prompt: "Deploy?", kind: "approval", expiresInSeconds: 900, liveActivity: "required" },
      "permanent-token-failure",
    );

    await service.flush([created.activityDelivery!]);

    expect((await store.deliveryById(created.activityDelivery!.id)).status).toBe("blocked");
    await new CheckpointDeliveryService(store, provider).flush();
    expect(provider.activities).toHaveLength(1);

    await store.updateDeviceTokens(device.id, {
      pushToStartToken: "b".repeat(64),
      environment: "production",
    });
    await new CheckpointDeliveryService(store, provider).flush();
    expect(provider.activities).toHaveLength(1);

    await store.updateDeviceTokens(device.id, {
      pushToStartToken: "d".repeat(64),
      environment: "production",
    });
    await new CheckpointDeliveryService(store, provider).flush();

    expect(provider.activities).toHaveLength(2);
    expect(provider.activities[1]).toMatchObject({ token: "d".repeat(64), event: "start" });
    expect((await store.deliveryById(created.activityDelivery!.id)).status).toBe("accepted");
  });
});
