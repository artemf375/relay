import { describe, expect, test } from "vitest";
import type { PushProvider, PushResult } from "./apns.js";
import { createRelayApp } from "./app.js";
import { SecretBox, TokenAuthority } from "./security.js";
import { openRelayStore } from "./store.js";

class RecordingPushProvider implements PushProvider {
  public notifications: Array<{ input: unknown; requestId: string }> = [];
  public interactions: Array<{ responseCredential: string; requestId: string }> = [];
  public activities: Array<{ event: string; token: string; priority: number; requestId: string; activity: unknown }> = [];
  public results: PushResult[] = [];
  public delayMilliseconds = 0;
  public rejectNext = false;
  private readonly accepted: PushResult = {
    accepted: true,
    status: 200,
    apnsId: "apns-1",
    reason: null,
  };

  private async result() {
    if (this.delayMilliseconds) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));
    }
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("Provider rejected");
    }
    return this.results.shift() ?? this.accepted;
  }

  async sendNotification(_token: string, input: unknown, requestId: string) {
    this.notifications.push({ input, requestId });
    return this.result();
  }

  async sendInteraction(_token: string, input: { responseCredential: string }, requestId: string) {
    this.interactions.push({ ...input, requestId });
    return this.result();
  }

  async sendActivity(
    token: string,
    event: "start" | "update" | "end",
    activity: unknown,
    priority: 5 | 10,
    requestId: string,
  ) {
    this.activities.push({ event, token, priority, requestId, activity });
    return this.result();
  }
}

async function setup() {
  const store = await openRelayStore({
    filename: ":memory:",
    tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
    secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
  });
  await store.installCliCredential("relay_cli_test-secret");
  const pushProvider = new RecordingPushProvider();
  const app = createRelayApp({ store, pushProvider });
  const cliHeaders = { authorization: "Bearer relay_cli_test-secret", "content-type": "application/json" };
  return { app, store, pushProvider, cliHeaders };
}

async function pair(setupResult: Awaited<ReturnType<typeof setup>>) {
  const pairingResponse = await setupResult.app.request("/v1/enrollments", {
    method: "POST",
    headers: { ...setupResult.cliHeaders, "idempotency-key": "pair-helper" },
  });
  const pairing = (await pairingResponse.json()) as { code: string };
  const response = await setupResult.app.request("/v1/devices/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, deviceName: "Phone" }),
  });
  return (await response.json()) as { id: string; credential: string };
}

describe("Relay HTTP interface", () => {
  test("exposes health and protects CLI routes", async () => {
    const { app } = await setup();
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/v1/enrollments", { method: "POST" })).status).toBe(401);
  });

  test("pairs a phone and registers encrypted push tokens", async () => {
    const context = await setup();
    const device = await pair(context);
    const response = await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    expect(response.status).toBe(200);
    expect((await context.store.pushTarget())?.apnsToken).toBe("a".repeat(64));
  });

  test("lists and independently ends concurrent Live Activities from the device", async () => {
    const context = await setup();
    const device = await pair(context);
    const deviceHeaders = { authorization: `Bearer ${device.credential}`, "content-type": "application/json" };
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        apnsToken: "a".repeat(64),
        pushToStartToken: "b".repeat(64),
        environment: "production",
      }),
    });
    const start = async (key: string) => {
      const response = await context.app.request("/v1/activities", {
        method: "POST",
        headers: { ...context.cliHeaders, "idempotency-key": `start-${key}` },
        body: JSON.stringify({ title: key, status: "Running", key }),
      });
      return (await response.json()) as { activity: { id: string } };
    };
    const first = await start("build");
    const second = await start("deploy");
    for (const [activity, token] of [[first, "c"], [second, "d"]] as const) {
      await context.app.request(`/v1/device/activities/${activity.activity.id}/push-token`, {
        method: "PUT",
        headers: deviceHeaders,
        body: JSON.stringify({
          activityPushToken: token.repeat(64),
          activityId: activity.activity.id,
          environment: "production",
        }),
      });
    }

    const list = await context.app.request("/v1/device/activities", { headers: deviceHeaders });
    expect(await list.json()).toMatchObject({ activities: [{ id: second.activity.id }, { id: first.activity.id }] });

    context.pushProvider.results.push({ accepted: false, status: 503, apnsId: null, reason: "ServiceUnavailable" });
    const failedEnd = await context.app.request(`/v1/device/activities/${first.activity.id}/end`, {
      method: "POST",
      headers: deviceHeaders,
    });
    expect(failedEnd.status).toBe(200);
    expect((await context.store.activityPushTarget(first.activity.id))?.activityPushToken).toBe("c".repeat(64));
    expect(await (await context.app.request("/v1/device/activities", { headers: deviceHeaders })).json()).toMatchObject({
      activities: expect.arrayContaining([
        expect.objectContaining({ id: first.activity.id, state: "ended" }),
        expect.objectContaining({ id: second.activity.id }),
      ]),
    });

    const ended = await context.app.request(`/v1/device/activities/${first.activity.id}/end`, {
      method: "POST",
      headers: deviceHeaders,
    });
    expect(await ended.json()).toMatchObject({ activity: { id: first.activity.id, endReason: "user_ended" } });
    expect(context.pushProvider.activities.at(-1)).toMatchObject({
      event: "end",
      token: "c".repeat(64),
    });
    expect(await context.store.activityPushTarget(first.activity.id)).toBeNull();
    expect(await context.store.activeActivities()).toMatchObject([{ id: second.activity.id }]);
    expect(await (await context.app.request("/v1/device/activities", { headers: deviceHeaders })).json()).toMatchObject({
      activities: [{ id: second.activity.id }],
    });

    const dismissed = await context.app.request(`/v1/device/activities/${second.activity.id}/dismissed`, {
      method: "POST",
      headers: deviceHeaders,
    });
    expect(await dismissed.json()).toMatchObject({ activity: { id: second.activity.id, endReason: "dismissed" } });
    expect(await context.store.activeActivities()).toEqual([]);
  });

  test("rejects a device token for the wrong APNs environment", async () => {
    const context = await setup();
    const device = await pair(context);
    const response = await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "sandbox" }),
    });
    expect(response.status).toBe(409);
    expect(await context.store.pushTarget()).toBeNull();
  });

  test("links a second agent host that can notify the same phone", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const enrollmentResponse = await context.app.request("/v1/hosts/enrollments", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "link-mac" },
    });
    expect(enrollmentResponse.status).toBe(201);
    const enrollment = (await enrollmentResponse.json()) as { code: string };

    const enrolled = await context.app.request("/v1/hosts/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: enrollment.code, hostName: "mac" }),
    });
    expect(enrolled.status).toBe(201);
    const mac = (await enrolled.json()) as { id: string; name: string; token: string };
    expect(mac.token).not.toBe("relay_cli_test-secret");

    const notified = await context.app.request("/v1/notifications", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mac.token}`,
        "content-type": "application/json",
        "idempotency-key": "mac-notify",
      },
      body: JSON.stringify({ body: "Build finished" }),
    });
    expect(notified.status).toBe(201);
    expect((await context.store.listRecentNotifications())[0]?.origin).toBe("mac");

    const listed = await context.app.request("/v1/hosts", { headers: context.cliHeaders });
    const hosts = (await listed.json()) as { hosts: Array<{ name: string }>; current: string };
    expect(hosts.hosts.map((host) => host.name)).toEqual(["primary", "mac"]);
    expect(hosts.current).not.toBe(mac.id);
  });

  test("revokes one host without disturbing the others", async () => {
    const context = await setup();
    const enrollment = await (
      await context.app.request("/v1/hosts/enrollments", {
        method: "POST",
        headers: { ...context.cliHeaders, "idempotency-key": "link-mac" },
      })
    ).json() as { code: string };
    const mac = await (
      await context.app.request("/v1/hosts/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: enrollment.code, hostName: "mac" }),
      })
    ).json() as { token: string };

    const revoked = await context.app.request("/v1/hosts/mac", {
      method: "DELETE",
      headers: context.cliHeaders,
    });
    expect(revoked.status).toBe(200);
    expect(
      (await context.app.request("/v1/hosts", { headers: { authorization: `Bearer ${mac.token}` } })).status,
    ).toBe(401);
    expect((await context.app.request("/v1/hosts", { headers: context.cliHeaders })).status).toBe(200);
    expect((await context.app.request("/v1/hosts/primary", { method: "DELETE", headers: context.cliHeaders })).status).toBe(409);
  });

  test("rejects host enrollment without a valid code", async () => {
    const context = await setup();
    expect((await context.app.request("/v1/hosts/enrollments", { method: "POST" })).status).toBe(401);
    const response = await context.app.request("/v1/hosts/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "AAAAAAAA", hostName: "mac" }),
    });
    expect(response.status).toBe(404);
  });

  test("makes pairing-code creation idempotent", async () => {
    const context = await setup();
    const init = { method: "POST", headers: { ...context.cliHeaders, "idempotency-key": "pair-code-1" } };
    const first = await context.app.request("/v1/enrollments", init);
    const replay = await context.app.request("/v1/enrollments", init);
    expect(await replay.json()).toEqual(await first.json());
  });

  test("rotates the CLI credential and rejects the old token", async () => {
    const context = await setup();
    const response = await context.app.request("/v1/operations/cli-token/rotate", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "rotate-cli-1" },
    });
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as { token: string };
    expect(rotated.token).toMatch(/^relay_cli_/);
    expect(
      (
        await context.app.request("/v1/enrollments", {
          method: "POST",
          headers: context.cliHeaders,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await context.app.request("/v1/enrollments", {
          method: "POST",
          headers: { authorization: `Bearer ${rotated.token}`, "idempotency-key": "pair-after-rotation" },
        })
      ).status,
    ).toBe(201);
  });

  test("revokes the paired device credential", async () => {
    const context = await setup();
    const device = await pair(context);
    const headers = { authorization: `Bearer ${device.credential}` };
    expect((await context.app.request("/v1/device", { method: "DELETE", headers })).status).toBe(204);
    expect((await context.app.request("/v1/inbox", { headers })).status).toBe(401);
  });

  test("reports database integrity to the CLI", async () => {
    const context = await setup();
    const response = await context.app.request("/v1/operations/integrity", {
      headers: context.cliHeaders,
    });
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("reports backup status without exposing the status file", async () => {
    const context = await setup();
    const app = createRelayApp({
      store: context.store,
      pushProvider: context.pushProvider,
      getBackupStatus: async () => ({ ok: true, completedAt: "2026-08-06T12:00:00Z" }),
    });
    const response = await app.request("/v1/operations/backup-status", { headers: context.cliHeaders });
    expect(await response.json()).toEqual({ ok: true, completedAt: "2026-08-06T12:00:00Z" });
  });

  test("sends an idempotent notification and reports APNs acceptance", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const init = {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "notify-1" },
      body: JSON.stringify({ title: "Codex", body: "Finished" }),
    };
    const first = await context.app.request("/v1/notifications", init);
    const replay = await context.app.request("/v1/notifications", init);
    expect(first.status).toBe(201);
    expect(await replay.json()).toMatchObject({ idempotent: true, accepted: true });
    expect(context.pushProvider.notifications).toHaveLength(1);

    const inbox = await context.app.request("/v1/inbox", {
      headers: { authorization: `Bearer ${device.credential}` },
    });
    expect(await inbox.json()).toMatchObject({
      notifications: [{ title: "Codex", body: "Finished", status: "accepted" }],
    });
  });

  test("retries a failed APNs delivery with the same request ID", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    context.pushProvider.results.push({ accepted: false, status: 503, apnsId: null, reason: "Shutdown" });
    const init = {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "notify-retry" },
      body: JSON.stringify({ body: "Retry me" }),
    };
    expect((await context.app.request("/v1/notifications", init)).status).toBe(502);
    const replay = await context.app.request("/v1/notifications", init);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ accepted: true, idempotent: true });
    expect(context.pushProvider.notifications).toHaveLength(2);
    expect(context.pushProvider.notifications[1]?.requestId).toBe(
      context.pushProvider.notifications[0]?.requestId,
    );
  });

  test("persists provider exceptions as retryable delivery failures", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    context.pushProvider.rejectNext = true;
    const init = {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "notify-provider-error" },
      body: JSON.stringify({ body: "Recover" }),
    };
    expect((await context.app.request("/v1/notifications", init)).status).toBe(502);
    expect((await context.app.request("/v1/notifications", init)).status).toBe(200);
    expect(context.pushProvider.notifications).toHaveLength(2);
  });

  test("serializes concurrent retries of one delivery intent", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    context.pushProvider.delayMilliseconds = 100;
    const init = {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "notify-concurrent" },
      body: JSON.stringify({ body: "Once" }),
    };
    const responses = await Promise.all([
      context.app.request("/v1/notifications", init),
      context.app.request("/v1/notifications", init),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(context.pushProvider.notifications).toHaveLength(1);
  });

  test("enforces the configured notification URL hostname allowlist", async () => {
    const context = await setup();
    const app = createRelayApp({
      store: context.store,
      pushProvider: context.pushProvider,
      allowedUrlHosts: new Set(["allowed.example.com"]),
    });
    const response = await app.request("/v1/notifications", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "blocked-url" },
      body: JSON.stringify({ body: "Open", url: "https://blocked.example.com/path" }),
    });
    expect(response.status).toBe(400);
  });

  test("replays the recorded APNs outcome for an idempotent interaction", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const init = {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "ask-replay" },
      body: JSON.stringify({ prompt: "Ready?", kind: "yes_no" }),
    };
    await context.app.request("/v1/interactions", init);
    const replay = await context.app.request("/v1/interactions", init);
    expect(await replay.json()).toMatchObject({ accepted: true, idempotent: true });
    expect(context.pushProvider.interactions).toHaveLength(1);
  });

  test("round-trips an interaction response to a waiting CLI", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const createdResponse = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "ask-1" },
      body: JSON.stringify({ prompt: "Deploy?", kind: "approval" }),
    });
    const created = (await createdResponse.json()) as { interaction: { id: string } };
    const responseCredential = context.pushProvider.interactions[0]?.responseCredential;
    const phoneResponse = await context.app.request(
      `/v1/interactions/${created.interaction.id}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ responseCredential, action: "approve" }),
      },
    );
    expect(phoneResponse.status).toBe(200);

    const waited = await context.app.request(`/v1/interactions/${created.interaction.id}/wait?timeout=0`, {
      headers: context.cliHeaders,
    });
    expect(await waited.json()).toMatchObject({ interaction: { status: "approved" }, timedOut: false });
  });

  test("lets the paired app answer an inbox interaction with its device credential", async () => {
    const context = await setup();
    const device = await pair(context);
    const deviceHeaders = { authorization: `Bearer ${device.credential}`, "content-type": "application/json" };
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const createdResponse = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "ask-from-inbox" },
      body: JSON.stringify({ prompt: "Deploy?", kind: "approval" }),
    });
    const created = (await createdResponse.json()) as { interaction: { id: string } };

    const response = await context.app.request(
      `/v1/device/interactions/${created.interaction.id}/respond`,
      { method: "POST", headers: deviceHeaders, body: JSON.stringify({ action: "deny" }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ interaction: { status: "denied" } });
  });

  test("replays the accepted create result after the interaction becomes terminal", async () => {
    const context = await setup();
    const device = await pair(context);
    const deviceHeaders = { authorization: `Bearer ${device.credential}`, "content-type": "application/json" };
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const request = {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "terminal-create-replay" },
      body: JSON.stringify({ prompt: "Deploy?", kind: "approval", liveActivity: "disabled" }),
    };
    const first = await context.app.request("/v1/interactions", request);
    const created = (await first.json()) as { interaction: { id: string }; apnsId: string };
    await context.app.request(`/v1/device/interactions/${created.interaction.id}/respond`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ action: "approve" }),
    });

    const replay = await context.app.request("/v1/interactions", request);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      interaction: { id: created.interaction.id, status: "approved", response: "approve" },
      accepted: true,
      apnsId: created.apnsId,
      activityDelivery: null,
      idempotent: true,
    });
  });

  test("shows and restores a task checkpoint with separate activity delivery results", async () => {
    const context = await setup();
    const device = await pair(context);
    const deviceHeaders = { authorization: `Bearer ${device.credential}`, "content-type": "application/json" };
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        apnsToken: "a".repeat(64),
        pushToStartToken: "b".repeat(64),
        environment: "production",
        capabilities: { liveActivityInteractions: 1 },
      }),
    });
    const started = await (
      await context.app.request("/v1/activities", {
        method: "POST",
        headers: { ...context.cliHeaders, "idempotency-key": "checkpoint-task-start" },
        body: JSON.stringify({ title: "Release", status: "Building" }),
      })
    ).json() as { activity: { id: string } };
    await context.app.request(`/v1/device/activities/${started.activity.id}/push-token`, {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        activityPushToken: "c".repeat(64),
        activityId: started.activity.id,
        environment: "production",
      }),
    });

    const createdResponse = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "checkpoint-task-ask" },
      body: JSON.stringify({ prompt: "Deploy?", kind: "approval", liveActivity: "auto" }),
    });
    const created = (await createdResponse.json()) as { interaction: { id: string } };
    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({
      interaction: { activity: { id: started.activity.id, presentation: "checkpoint" } },
      accepted: true,
      activityDelivery: { accepted: true },
    });
    expect(context.pushProvider.activities.at(-1)).toMatchObject({ event: "update", priority: 10 });
    expect(JSON.stringify(context.pushProvider.activities.at(-1)?.activity)).not.toMatch(/credential|secret/i);

    const concurrentResponse = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "checkpoint-task-busy" },
      body: JSON.stringify({ prompt: "Restart?", kind: "approval", liveActivity: "required" }),
    });
    expect(concurrentResponse.status).toBe(201);
    expect(await concurrentResponse.json()).toMatchObject({
      interaction: { activity: { presentation: "temporary" } },
      activityDelivery: { accepted: true },
    });

    const response = await context.app.request(`/v1/device/interactions/${created.interaction.id}/respond`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ action: "approve" }),
    });
    expect(await response.json()).toMatchObject({
      interaction: { status: "approved" },
      activityDelivery: { accepted: true },
    });
    expect(context.pushProvider.activities.at(-1)).toMatchObject({ event: "update", priority: 10 });
    expect(
      await context.store.deliveryIntentsForKey(
        "checkpoint",
        `checkpoint:${created.interaction.id}:checkpoint-restore`,
      ),
    ).toContainEqual(
      expect.objectContaining({ purpose: "checkpoint-restore", status: "pending", availableAt: expect.any(Date) }),
    );
  });

  test("keeps alert acceptance separate when a temporary activity start fails", async () => {
    const context = await setup();
    const device = await pair(context);
    const deviceHeaders = { authorization: `Bearer ${device.credential}`, "content-type": "application/json" };
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        apnsToken: "a".repeat(64),
        pushToStartToken: "b".repeat(64),
        environment: "production",
        capabilities: { liveActivityInteractions: 1 },
      }),
    });
    context.pushProvider.results.push(
      { accepted: true, status: 200, apnsId: "alert-apns", reason: null },
      { accepted: false, status: 429, apnsId: "activity-apns", reason: "TooManyRequests" },
    );

    const response = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "temporary-start-fails" },
      body: JSON.stringify({ prompt: "Proceed?", kind: "yes_no", liveActivity: "required" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      accepted: true,
      apnsId: "alert-apns",
      activityDelivery: { accepted: false, apnsId: "activity-apns", reason: "TooManyRequests" },
    });
    expect(context.pushProvider.activities.at(-1)).toMatchObject({ event: "start", priority: 10 });
  });

  test("keeps the notification and inbox fallback when required activity tokens are unavailable", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({
        apnsToken: "a".repeat(64),
        environment: "production",
        capabilities: { liveActivityInteractions: 1 },
      }),
    });

    const response = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "required-without-activity-token" },
      body: JSON.stringify({ prompt: "Proceed?", kind: "yes_no", liveActivity: "required" }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      interaction: { status: "pending", activity: { presentation: "temporary" } },
      accepted: true,
      activityDelivery: { accepted: false, reason: expect.stringMatching(/push-to-start token/i) },
    });
  });

  test("returns a stable code when required Live Activity interactions are unsupported", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });

    const response = await context.app.request("/v1/interactions", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "unsupported-live-activity" },
      body: JSON.stringify({ prompt: "Proceed?", kind: "yes_no", liveActivity: "required" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "live_activity_interactions_unsupported" });
  });

  test("makes interaction cancellation idempotent", async () => {
    const context = await setup();
    const device = await pair(context);
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: { authorization: `Bearer ${device.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "a".repeat(64), environment: "production" }),
    });
    const created = await (
      await context.app.request("/v1/interactions", {
        method: "POST",
        headers: { ...context.cliHeaders, "idempotency-key": "cancel-create" },
        body: JSON.stringify({ prompt: "Cancel?", kind: "yes_no" }),
      })
    ).json() as { interaction: { id: string } };
    const init = { method: "POST", headers: { ...context.cliHeaders, "idempotency-key": "cancel-once" } };
    const first = await context.app.request(`/v1/interactions/${created.interaction.id}/cancel`, init);
    const replay = await context.app.request(`/v1/interactions/${created.interaction.id}/cancel`, init);
    expect(await first.json()).toMatchObject({ interaction: { status: "canceled" }, idempotent: false });
    expect(await replay.json()).toMatchObject({ interaction: { status: "canceled" }, idempotent: true });
  });

  test("uses push-to-start then activity update tokens with correct priority", async () => {
    const context = await setup();
    const device = await pair(context);
    const deviceHeaders = { authorization: `Bearer ${device.credential}`, "content-type": "application/json" };
    await context.app.request("/v1/device/push-tokens", {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        apnsToken: "a".repeat(64),
        pushToStartToken: "b".repeat(64),
        environment: "production",
      }),
    });
    const startedResponse = await context.app.request("/v1/activities", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "activity-1" },
      body: JSON.stringify({ title: "Release", status: "Building", key: "release" }),
    });
    const started = (await startedResponse.json()) as { activity: { id: string } };
    expect(context.pushProvider.activities[0]).toMatchObject({ event: "start", token: "b".repeat(64), priority: 10 });

    const replay = await context.app.request("/v1/activities", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "activity-1" },
      body: JSON.stringify({ title: "Release", status: "Building", key: "release" }),
    });
    expect(await replay.json()).toMatchObject({ idempotent: true, activity: { id: started.activity.id } });
    expect(context.pushProvider.activities).toHaveLength(1);

    await context.app.request(`/v1/device/activities/${started.activity.id}/push-token`, {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        activityPushToken: "c".repeat(64),
        activityId: started.activity.id,
        environment: "production",
      }),
    });
    const update = await context.app.request(`/v1/activities/${started.activity.id}`, {
      method: "PATCH",
      headers: { ...context.cliHeaders, "idempotency-key": "activity-update-1" },
      body: JSON.stringify({ progress: 0.5 }),
    });
    expect(update.status).toBe(200);
    expect(context.pushProvider.activities[1]).toMatchObject({ event: "update", token: "c".repeat(64), priority: 5 });

    await context.app.request(`/v1/device/activities/${started.activity.id}/push-token`, {
      method: "DELETE",
      headers: deviceHeaders,
    });
    const rejectedReplacement = await context.app.request("/v1/activities", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "activity-replace-rejected" },
      body: JSON.stringify({ title: "Rejected", status: "Starting", key: "release", replace: true }),
    });
    expect(rejectedReplacement.status).toBe(409);
    expect((await context.store.activeActivity())?.id).toBe(started.activity.id);
    await context.app.request(`/v1/device/activities/${started.activity.id}/push-token`, {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        activityPushToken: "c".repeat(64),
        activityId: started.activity.id,
        environment: "production",
      }),
    });

    const replacement = await context.app.request("/v1/activities", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "activity-replace-1" },
      body: JSON.stringify({ title: "Deploy", status: "Starting", key: "release", replace: true }),
    });
    expect(replacement.status).toBe(201);
    expect(context.pushProvider.activities.slice(2)).toMatchObject([
      { event: "end", token: "c".repeat(64), priority: 10 },
      { event: "start", token: "b".repeat(64), priority: 10 },
    ]);
    const replacementBody = (await replacement.json()) as { activity: { id: string } };
    const staleTokenUpdate = await context.app.request(`/v1/activities/${replacementBody.activity.id}`, {
      method: "PATCH",
      headers: { ...context.cliHeaders, "idempotency-key": "wrong-activity-token" },
      body: JSON.stringify({ progress: 0.1 }),
    });
    expect(staleTokenUpdate.status).toBe(409);

    await context.app.request(`/v1/device/activities/${replacementBody.activity.id}/push-token`, {
      method: "PUT",
      headers: deviceHeaders,
      body: JSON.stringify({
        activityPushToken: "d".repeat(64),
        activityId: replacementBody.activity.id,
        environment: "production",
      }),
    });
    const replacementReplay = await context.app.request("/v1/activities", {
      method: "POST",
      headers: { ...context.cliHeaders, "idempotency-key": "activity-replace-1" },
      body: JSON.stringify({ title: "Deploy", status: "Starting", key: "release", replace: true }),
    });
    expect(replacementReplay.status).toBe(200);
    expect(await replacementReplay.json()).toMatchObject({ accepted: true, idempotent: true });
    expect(context.pushProvider.activities).toHaveLength(4);
  });
});
