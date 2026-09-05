import {
  activityCreateSchema,
  activityEndSchema,
  activityPushTokenUpdateSchema,
  activityUpdateSchema,
  deviceTokenUpdateSchema,
  enrollmentExchangeSchema,
  hostEnrollmentExchangeSchema,
  idempotencyKeySchema,
  interactionCreateSchema,
  interactionResponseSchema,
  notificationCreateSchema,
} from "@relay/contracts";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { isPermanentActivityTokenFailure, type ActivityPushContent, type PushProvider, type PushResult } from "./apns.js";
import { CheckpointDeliveryService } from "./checkpoints.js";
import {
  ConflictError,
  NotFoundError,
  type PublicActivity,
  type RelayStore,
  UnauthorizedError,
} from "./store.js";

const MAX_BODY_BYTES = 8_192;
const MAX_WAIT_SECONDS = 25;

export interface RelayAppDependencies {
  store: RelayStore;
  pushProvider: PushProvider;
  getBackupStatus?: () => Promise<unknown>;
  allowedUrlHosts?: ReadonlySet<string>;
  apnsEnvironment?: "sandbox" | "production";
  checkpointDeliveryService?: CheckpointDeliveryService;
}

type RelayEnv = { Variables: { relayDeviceId: string; relayHostId: string; relayHostName: string } };
type DeliveryIntent = Awaited<ReturnType<RelayStore["ensureDeliveryIntent"]>>;

function bearer(value: string | undefined): string | null {
  const match = value?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}

async function jsonBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new PayloadTooLargeError();
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new PayloadTooLargeError();
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestError("Request body must be valid JSON");
  }
}

class InvalidRequestError extends Error {}
class PayloadTooLargeError extends Error {}

function deliveryActivity(payload: string | null): ActivityPushContent {
  if (!payload) throw new Error("Activity delivery payload is missing");
  return JSON.parse(payload) as ActivityPushContent;
}

function publicActivity(payload: ActivityPushContent): PublicActivity {
  return "activity" in payload ? payload.activity : payload;
}

function idempotencyKey(headers: Headers): string {
  const parsed = idempotencyKeySchema.safeParse(headers.get("idempotency-key"));
  if (!parsed.success) throw new InvalidRequestError("A valid Idempotency-Key header is required");
  return parsed.data;
}

function fixedWindowRateLimit(limit: number): MiddlewareHandler<RelayEnv> {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return async (context, next) => {
    const key = context.req.header("cf-connecting-ip") ?? "local";
    const currentTime = Date.now();
    const current = windows.get(key);
    if (!current || currentTime - current.startedAt >= 60_000) {
      windows.set(key, { startedAt: currentTime, count: 1 });
    } else {
      current.count += 1;
      if (current.count > limit) {
        context.header("Retry-After", String(Math.ceil((60_000 - (currentTime - current.startedAt)) / 1_000)));
        return context.json({ error: "Rate limit exceeded" }, 429);
      }
    }
    await next();
  };
}

export function createRelayApp({
  store,
  pushProvider,
  getBackupStatus,
  allowedUrlHosts = new Set(),
  apnsEnvironment = "production",
  checkpointDeliveryService,
}: RelayAppDependencies) {
  const app = new Hono<RelayEnv>();
  const checkpointDeliveries = checkpointDeliveryService ?? new CheckpointDeliveryService(store, pushProvider);
  const requireCli: MiddlewareHandler<RelayEnv> = async (context, next) => {
    const token = bearer(context.req.header("authorization"));
    const host = token ? await store.authenticateCli(token) : undefined;
    if (!host) return context.json({ error: "Unauthorized" }, 401);
    context.set("relayHostId", host.id);
    context.set("relayHostName", host.name);
    await next();
  };
  const requireDevice: MiddlewareHandler<RelayEnv> = async (context, next) => {
    const token = bearer(context.req.header("authorization"));
    const device = token ? await store.authenticateDevice(token) : undefined;
    if (!device) return context.json({ error: "Unauthorized" }, 401);
    context.set("relayDeviceId", device.id);
    await next();
  };
  const dispatchDelivery = async (
    intent: DeliveryIntent,
    send: () => Promise<PushResult>,
    complete: (result: PushResult) => Promise<DeliveryIntent> = (result) => store.completeDelivery(intent.id, result),
  ): Promise<PushResult> => {
    let current = await store.deliveryById(intent.id);
    if (current.status === "accepted") {
      return { accepted: true, status: 200, apnsId: current.apnsId, reason: current.reason };
    }

    let claimed = await store.claimDelivery(intent.id);
    const deadline = Date.now() + 11_000;
    while (!claimed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = await store.deliveryById(intent.id);
      if (current.status === "accepted") {
        return { accepted: true, status: 200, apnsId: current.apnsId, reason: current.reason };
      }
      if (current.status === "failed") claimed = await store.claimDelivery(intent.id);
    }
    if (!claimed) {
      return { accepted: false, status: 0, apnsId: current.apnsId, reason: "Delivery is already in progress" };
    }

    let result: PushResult;
    try {
      result = await send();
    } catch {
      result = { accepted: false, status: 0, apnsId: null, reason: "Push provider failed" };
    }
    const completed = await complete(result);
    return {
      accepted: completed.accepted ?? false,
      status: completed.accepted ? 200 : result.status,
      apnsId: completed.apnsId,
      reason: completed.reason,
    };
  };

  app.use("/v1/*", fixedWindowRateLimit(300));
  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", async (context) => {
    const integrity = await store.integrityCheck();
    return context.json({ status: integrity === "ok" ? "ready" : "degraded", database: integrity }, integrity === "ok" ? 200 : 503);
  });

  app.post("/v1/enrollments", requireCli, async (context) =>
    context.json(await store.createEnrollment(idempotencyKey(context.req.raw.headers)), 201),
  );

  app.post("/v1/hosts/enrollments", requireCli, async (context) =>
    context.json(await store.createEnrollment(idempotencyKey(context.req.raw.headers), "host"), 201),
  );

  app.post("/v1/hosts/enroll", async (context) => {
    const parsed = hostEnrollmentExchangeSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid host enrollment request");
    return context.json(await store.exchangeHostEnrollment(parsed.data.code, parsed.data.hostName), 201);
  });

  app.get("/v1/hosts", requireCli, async (context) =>
    context.json({ hosts: await store.listHosts(), current: context.get("relayHostId") }),
  );

  app.delete("/v1/hosts/:selector", requireCli, async (context) =>
    context.json(await store.revokeHost(context.req.param("selector"))),
  );

  app.post("/v1/operations/cli-token/rotate", async (context) => {
    const token = bearer(context.req.header("authorization"));
    if (!token) throw new UnauthorizedError("Invalid CLI credential");
    return context.json({ token: await store.rotateCliCredential(token, idempotencyKey(context.req.raw.headers)) });
  });

  app.get("/v1/operations/integrity", requireCli, async (context) =>
    context.json({ status: await store.integrityCheck() }),
  );

  app.get("/v1/operations/backup-status", requireCli, async (context) =>
    context.json((await getBackupStatus?.()) ?? { ok: false, reason: "No backup has completed" }),
  );

  app.post("/v1/devices/enroll", async (context) => {
    const parsed = enrollmentExchangeSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid enrollment request");
    return context.json(await store.exchangeEnrollment(parsed.data.code, parsed.data.deviceName), 201);
  });

  app.put("/v1/device/push-tokens", requireDevice, async (context) => {
    const parsed = deviceTokenUpdateSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid push-token registration");
    if (parsed.data.environment !== apnsEnvironment) {
      throw new ConflictError(`This Relay server accepts only ${apnsEnvironment} APNs tokens`);
    }
    const deviceId = context.get("relayDeviceId") as string;
    await store.updateDeviceTokens(deviceId, parsed.data);
    return context.json({ ok: true });
  });

  app.put("/v1/device/activities/:id/push-token", requireDevice, async (context) => {
    const parsed = activityPushTokenUpdateSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success || parsed.data.activityId !== context.req.param("id")) {
      throw new InvalidRequestError("Invalid activity push-token registration");
    }
    if (parsed.data.environment !== apnsEnvironment) {
      throw new ConflictError(`This Relay server accepts only ${apnsEnvironment} APNs tokens`);
    }
    await store.registerActivityPushToken(
      context.get("relayDeviceId") as string,
      parsed.data.activityId,
      parsed.data.activityPushToken,
      parsed.data.environment,
    );
    return context.json({ ok: true });
  });

  app.delete("/v1/device/activities/:id/push-token", requireDevice, async (context) => {
    await store.removeActivityPushToken(context.get("relayDeviceId") as string, context.req.param("id"));
    return context.body(null, 204);
  });

  app.get("/v1/device/activities", requireDevice, async (context) =>
    context.json({ activities: await store.deviceActivities(context.get("relayDeviceId") as string) }),
  );

  app.post("/v1/device/activities/:id/dismissed", requireDevice, async (context) => {
    const activity = await store.dismissActivity(
      context.get("relayDeviceId") as string,
      context.req.param("id"),
    );
    return context.json({ activity });
  });

  app.post("/v1/device/activities/:id/end", requireDevice, async (context) => {
    const deviceId = context.get("relayDeviceId") as string;
    const current = await store.getActivity(context.req.param("id"));
    const target = await store.activityPushTarget(current.id);
    const key = `device-end:${current.id}`;
    if (current.state !== "active" && !target) {
      await store.removeActivityPushToken(deviceId, current.id);
      return context.json({ activity: current, accepted: true, apnsId: null, reason: null });
    }
    const endResult = await store.endActivityForDevice(current.id, key);
    if (endResult.delivery.status === "accepted") {
      await store.removeActivityPushToken(deviceId, current.id);
      return context.json({
        activity: endResult.activity,
        accepted: true,
        apnsId: endResult.delivery.apnsId,
        reason: null,
      });
    }
    if (!target) {
      await store.completeDelivery(
        endResult.delivery.id,
        { accepted: false, apnsId: null, reason: "No matching Live Activity update token registered" },
        "blocked",
      );
      return context.json({
        activity: endResult.activity,
        accepted: false,
        apnsId: null,
        reason: "The app must end this activity locally",
      });
    }
    const delivery = await dispatchDelivery(endResult.delivery, () =>
      pushProvider.sendActivity(
        target.activityPushToken,
        "end",
        deliveryActivity(endResult.delivery.payload),
        10,
        endResult.delivery.id,
      ),
    );
    const permanentFailure = isPermanentActivityTokenFailure(delivery);
    if (delivery.accepted || permanentFailure) {
      if (permanentFailure) {
        await store.completeDelivery(
          endResult.delivery.id,
          { accepted: false, apnsId: delivery.apnsId, reason: delivery.reason },
          "blocked",
        );
      }
      await store.removeActivityPushToken(deviceId, current.id);
    }
    return context.json({
      activity: endResult.activity,
      accepted: delivery.accepted,
      apnsId: delivery.apnsId,
      reason: delivery.reason,
    });
  });

  app.delete("/v1/device", requireDevice, async (context) => {
    const deviceId = context.get("relayDeviceId") as string;
    const revoke = async () => {
      await checkpointDeliveries.waitForIdle();
      await store.revokeDevice(deviceId);
    };
    if (pushProvider.withActivityDrain) {
      await pushProvider.withActivityDrain(revoke);
    } else {
      await pushProvider.waitForActivityIdle?.();
      await revoke();
    }
    return context.body(null, 204);
  });

  app.get("/v1/inbox", requireDevice, async (context) => {
    const requested = Number(context.req.query("limit") ?? "50");
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
    await store.pruneRetention();
    return context.json({
      interactions: await store.listInbox(limit),
      notifications: await store.listRecentNotifications(limit),
    });
  });

  app.post("/v1/notifications", requireCli, async (context) => {
    const key = idempotencyKey(context.req.raw.headers);
    const parsed = notificationCreateSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid notification");
    if (parsed.data.url && !allowedUrlHosts.has(new URL(parsed.data.url).hostname.toLowerCase())) {
      throw new InvalidRequestError("Notification URL host is not allowed");
    }
    const created = await store.createNotification(parsed.data, key, context.get("relayHostId"));
    if (created.delivery.status === "accepted") {
      return context.json(
        { notification: created.notification, accepted: true, apnsId: created.delivery.apnsId, idempotent: true },
        200,
      );
    }
    const target = await store.pushTarget();
    if (!target) throw new ConflictError("No registered APNs device");
    const delivery = await dispatchDelivery(
      created.delivery,
      () => pushProvider.sendNotification(target.apnsToken, parsed.data, created.delivery.id),
      (result) => store.completeNotificationDelivery(created.notification.id, created.delivery.id, result),
    );
    return context.json(
      {
        notification: { ...created.notification, status: delivery.accepted ? "accepted" : "failed" },
        accepted: delivery.accepted,
        apnsId: delivery.apnsId,
        idempotent: created.idempotent,
      },
      delivery.accepted ? (created.idempotent ? 200 : 201) : 502,
    );
  });

  app.post("/v1/interactions", requireCli, async (context) => {
    const key = idempotencyKey(context.req.raw.headers);
    const parsed = interactionCreateSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid interaction");
    const created = await store.createInteraction(parsed.data, key, context.get("relayHostId"));
    if (created.interaction.status !== "pending") {
      const alertAccepted = created.delivery.status === "accepted";
      const activityDelivery = created.activityDelivery
        ? {
            deliveryId: created.activityDelivery.id,
            accepted: created.activityDelivery.status === "accepted",
            status: created.activityDelivery.status === "accepted" ? 200 : 0,
            apnsId: created.activityDelivery.apnsId,
            reason: created.activityDelivery.reason,
          }
        : null;
      return context.json(
        {
          interaction: created.interaction,
          accepted: alertAccepted,
          apnsId: created.delivery.apnsId,
          activityDelivery,
          idempotent: true,
        },
        alertAccepted ? 200 : 502,
      );
    }
    const delivery = created.delivery.status === "accepted"
      ? {
          accepted: true,
          status: 200,
          apnsId: created.delivery.apnsId,
          reason: created.delivery.reason,
        }
      : await (async () => {
          const target = await store.pushTarget();
          if (!target) throw new ConflictError("No registered APNs device");
          return dispatchDelivery(created.delivery, () =>
            pushProvider.sendInteraction(
              target.apnsToken,
              {
                interactionId: created.interaction.id,
                kind: created.interaction.kind,
                title: created.interaction.title,
                prompt: created.interaction.prompt,
                responseCredential: created.responseCredential,
              },
              created.delivery.id,
            ),
          );
        })();
    const activityDelivery = created.activityDelivery
      ? (await checkpointDeliveries.flush([created.activityDelivery]))[0] ?? null
      : null;
    return context.json(
      {
        interaction: created.interaction,
        accepted: delivery.accepted,
        apnsId: delivery.apnsId,
        activityDelivery,
        idempotent: created.idempotent,
      },
      delivery.accepted ? (created.idempotent ? 200 : 201) : 502,
    );
  });

  app.get("/v1/interactions/:id", requireCli, async (context) =>
    context.json({ interaction: await store.getInteraction(context.req.param("id")) }),
  );

  app.get("/v1/interactions/:id/wait", requireCli, async (context) => {
    const requested = Number(context.req.query("timeout") ?? MAX_WAIT_SECONDS);
    const timeoutSeconds = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS)
      : MAX_WAIT_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let interaction = await store.getInteraction(context.req.param("id"));
    while (interaction.status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      interaction = await store.getInteraction(context.req.param("id"));
    }
    return context.json({ interaction, timedOut: interaction.status === "pending" });
  });

  app.post("/v1/interactions/:id/cancel", requireCli, async (context) => {
    const interactionId = context.req.param("id");
    const key = idempotencyKey(context.req.raw.headers);
    const result = await store.cancelInteractionIdempotent(interactionId, key);
    const activityDelivery = result.activityDelivery
      ? (await checkpointDeliveries.flush([result.activityDelivery]))[0] ?? null
      : null;
    return context.json({ ...result, activityDelivery });
  });

  app.post("/v1/device/interactions/:id/respond", requireDevice, async (context) => {
    const parsed = interactionResponseSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid interaction response");
    const result = await store.respondToInteractionAsDeviceWithDelivery(context.req.param("id"), parsed.data);
    const activityDelivery = result.activityDelivery
      ? (await checkpointDeliveries.flush([result.activityDelivery]))[0] ?? null
      : null;
    return context.json({ interaction: result.interaction, activityDelivery });
  });

  app.post("/v1/interactions/:id/respond", async (context) => {
    const body = await jsonBody(context.req.raw);
    if (!body || typeof body !== "object" || !("responseCredential" in body)) {
      throw new InvalidRequestError("Invalid interaction response");
    }
    const responseCredential = (body as { responseCredential?: unknown }).responseCredential;
    if (typeof responseCredential !== "string" || responseCredential.length > 512) {
      throw new InvalidRequestError("Invalid interaction response");
    }
    const responseInput = { ...(body as Record<string, unknown>) };
    delete responseInput.responseCredential;
    const parsed = interactionResponseSchema.safeParse(responseInput);
    if (!parsed.success) throw new InvalidRequestError("Invalid interaction response");
    const result = await store.respondToInteractionWithDelivery(
      context.req.param("id"),
      responseCredential,
      parsed.data,
    );
    const activityDelivery = result.activityDelivery
      ? (await checkpointDeliveries.flush([result.activityDelivery]))[0] ?? null
      : null;
    return context.json({ interaction: result.interaction, activityDelivery });
  });

  app.post("/v1/activities", requireCli, async (context) => {
    const key = idempotencyKey(context.req.raw.headers);
    const parsed = activityCreateSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid activity");
    const replay = await store.findMutation("activity:start", key, parsed.data);
    let target = await store.pushTarget();
    if (!replay) {
      if (!target?.pushToStartToken) throw new ConflictError("No Live Activity push-to-start token registered");
      const active = parsed.data.replace && parsed.data.key ? await store.activeActivity(parsed.data.key) : null;
      if (active && !(await store.activityPushTarget(active.id))) {
        throw new ConflictError("No matching Live Activity update token registered for replacement");
      }
    }
    const startResult = await store.startActivityIdempotent(parsed.data, key);
    const { activity, replaced } = startResult;
    const replaceDelivery = startResult.deliveries.find((item) => item.purpose === "replace-end");
    const startDelivery = startResult.deliveries.find((item) => item.purpose === "start")!;
    if (startDelivery.status === "accepted" && (!replaceDelivery || replaceDelivery.status === "accepted")) {
      return context.json({ activity, accepted: true, apnsId: startDelivery.apnsId, idempotent: true }, 200);
    }
    target ??= await store.pushTarget();
    if (!target?.pushToStartToken) throw new ConflictError("No Live Activity push-to-start token registered");
    if (replaced && replaceDelivery?.status !== "accepted") {
      const replacementTarget = await store.activityPushTarget(replaced.id);
      if (!replacementTarget) {
        throw new ConflictError("No matching Live Activity update token registered for replacement");
      }
      const result = await dispatchDelivery(replaceDelivery!, () =>
        pushProvider.sendActivity(
          replacementTarget.activityPushToken,
          "end",
          deliveryActivity(replaceDelivery!.payload),
          10,
          replaceDelivery!.id,
        ),
      );
      if (!result.accepted) {
        return context.json({ activity, accepted: false, apnsId: result.apnsId, idempotent: startResult.idempotent }, 502);
      }
    }
    const currentStartDelivery = await store.deliveryById(startDelivery.id);
    if (currentStartDelivery.status === "accepted") {
      return context.json({ activity, accepted: true, apnsId: currentStartDelivery.apnsId, idempotent: true }, 200);
    }
    if (activity.state !== "active") {
      return context.json({ activity, accepted: false, apnsId: startDelivery.apnsId, idempotent: true }, 502);
    }
    const pushToStartToken = target.pushToStartToken;
    const delivery = await dispatchDelivery(startDelivery, () =>
      pushProvider.sendActivity(
        pushToStartToken,
        "start",
        deliveryActivity(startDelivery.payload),
        10,
        startDelivery.id,
      ),
    );
    return context.json(
      { activity, accepted: delivery.accepted, apnsId: delivery.apnsId, idempotent: startResult.idempotent },
      delivery.accepted ? (startResult.idempotent ? 200 : 201) : 502,
    );
  });

  app.patch("/v1/activities/:id", requireCli, async (context) => {
    const key = idempotencyKey(context.req.raw.headers);
    const parsed = activityUpdateSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid activity update");
    const identifier = context.req.param("id");
    const replay = await store.findMutation(`activity:update:${identifier}`, key, parsed.data);
    let target = await store.activityPushTarget(identifier);
    if (!replay) {
      const currentActivity = await store.getActivity(identifier);
      target = await store.activityPushTarget(currentActivity.id);
      if (!target) {
        throw new ConflictError("The registered Live Activity token does not match this activity");
      }
    }
    const updateResult = await store.updateActivityIdempotent(identifier, parsed.data, key);
    const activity = updateResult.activity;
    if (updateResult.delivery.status === "accepted") {
      return context.json({ activity, accepted: true, apnsId: updateResult.delivery.apnsId, idempotent: true }, 200);
    }
    const updatePayload = deliveryActivity(updateResult.delivery.payload);
    const updateActivity = publicActivity(updatePayload);
    if (updateActivity.sequence < activity.sequence) {
      return context.json({ activity, accepted: false, apnsId: updateResult.delivery.apnsId, idempotent: true }, 502);
    }
    target = await store.activityPushTarget(updateActivity.id);
    if (!target) {
      throw new ConflictError("The registered Live Activity token does not match this activity");
    }
    const activityPushToken = target.activityPushToken;
    const delivery = await dispatchDelivery(updateResult.delivery, () =>
      pushProvider.sendActivity(
        activityPushToken,
        "update",
        updatePayload,
        5,
        updateResult.delivery.id,
      ),
    );
    return context.json(
      { activity, accepted: delivery.accepted, apnsId: delivery.apnsId, idempotent: updateResult.idempotent },
      delivery.accepted ? 200 : 502,
    );
  });

  app.post("/v1/activities/:id/end", requireCli, async (context) => {
    const key = idempotencyKey(context.req.raw.headers);
    const parsed = activityEndSchema.safeParse(await jsonBody(context.req.raw));
    if (!parsed.success) throw new InvalidRequestError("Invalid activity end request");
    const identifier = context.req.param("id");
    const replay = await store.findMutation(`activity:end:${identifier}`, key, parsed.data);
    let target = await store.activityPushTarget(identifier);
    if (!replay) {
      const currentActivity = await store.getActivity(identifier);
      target = await store.activityPushTarget(currentActivity.id);
      if (!target) {
        throw new ConflictError("The registered Live Activity token does not match this activity");
      }
    }
    const endResult = await store.endActivityIdempotent(identifier, parsed.data, key);
    const activity = endResult.activity;
    if (endResult.delivery.status === "accepted") {
      return context.json({ activity, accepted: true, apnsId: endResult.delivery.apnsId, idempotent: true }, 200);
    }
    const endPayload = deliveryActivity(endResult.delivery.payload);
    const endingActivity = publicActivity(endPayload);
    target = await store.activityPushTarget(endingActivity.id);
    if (!target) {
      throw new ConflictError("The registered Live Activity token does not match this activity");
    }
    const activityPushToken = target.activityPushToken;
    const delivery = await dispatchDelivery(endResult.delivery, () =>
      pushProvider.sendActivity(
        activityPushToken,
        "end",
        endPayload,
        10,
        endResult.delivery.id,
      ),
    );
    return context.json(
      { activity, accepted: delivery.accepted, apnsId: delivery.apnsId, idempotent: endResult.idempotent },
      delivery.accepted ? 200 : 502,
    );
  });

  app.onError((error, context) => {
    if (error instanceof PayloadTooLargeError) return context.json({ error: error.message || "Payload too large" }, 413);
    if (error instanceof InvalidRequestError) return context.json({ error: error.message }, 400);
    if (error instanceof UnauthorizedError) return context.json({ error: error.message }, 401);
    if (error instanceof NotFoundError) return context.json({ error: error.message }, 404);
    if (error instanceof ConflictError) {
      return context.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, 409);
    }
    console.error(JSON.stringify({ level: "error", message: "Unhandled request failure", error: error.name }));
    return context.json({ error: "Internal server error" }, 500);
  });

  return app;
}
