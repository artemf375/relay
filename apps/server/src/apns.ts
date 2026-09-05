import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";
import type { InteractionKind, NotificationCreate } from "@relay/contracts";
import type { ActivityCheckpointPayload, PublicActivity } from "./store.js";

const MAX_PAYLOAD_BYTES = 4_096;
const JWT_TTL_SECONDS = 50 * 60;

export interface PushResult {
  accepted: boolean;
  status: number;
  apnsId: string | null;
  reason: string | null;
}

const PERMANENT_ACTIVITY_TOKEN_FAILURES = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export function isPermanentActivityTokenFailure(
  result: Pick<PushResult, "accepted" | "reason">,
): boolean {
  return !result.accepted
    && result.reason !== null
    && PERMANENT_ACTIVITY_TOKEN_FAILURES.has(result.reason);
}

export interface PushProvider {
  waitForActivityIdle?(): Promise<void>;
  withActivityDrain?<T>(task: () => T | Promise<T>): Promise<T>;
  sendNotification(token: string, input: NotificationCreate, requestId: string): Promise<PushResult>;
  sendInteraction(
    token: string,
    input: {
      interactionId: string;
      kind: InteractionKind;
      title: string;
      prompt: string;
      responseCredential: string;
    },
    requestId: string,
  ): Promise<PushResult>;
  sendActivity(
    token: string,
    event: "start" | "update" | "end",
    activity: ActivityPushContent,
    priority: 5 | 10,
    requestId: string,
  ): Promise<PushResult>;
}

export type ActivityPushContent = PublicActivity | ActivityCheckpointPayload;

export interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
  environment: "sandbox" | "production";
}

const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value));

export function createProviderJwt(
  config: Pick<ApnsConfiguration, "keyId" | "teamId" | "privateKey">,
  issuedAt: number,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: config.teamId, iat: issuedAt })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(config.privateKey.replace(/\\n/g, "\n")),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

export function buildNotificationPayload(input: NotificationCreate): Record<string, unknown> {
  return {
    aps: {
      alert: { title: input.title, body: input.body },
      sound: "default",
      "mutable-content": 1,
      "thread-id": "relay-notifications",
    },
    relay: { type: "notification", ...(input.url ? { url: input.url } : {}) },
  };
}

export function buildInteractionPayload(input: {
  interactionId: string;
  kind: InteractionKind;
  title: string;
  prompt: string;
  responseCredential: string;
}): Record<string, unknown> {
  const category =
    input.kind === "approval"
      ? "RELAY_APPROVAL"
      : input.kind === "yes_no"
        ? "RELAY_YES_NO"
        : "RELAY_TEXT_REPLY";
  return {
    aps: {
      alert: { title: input.title, body: input.prompt },
      sound: "default",
      category,
      "mutable-content": 1,
      "thread-id": `relay-${input.interactionId}`,
    },
    relay: {
      type: "interaction",
      interactionId: input.interactionId,
      interactionKind: input.kind,
      responseCredential: input.responseCredential,
    },
  };
}

export function buildActivityPayload(
  event: "start" | "update" | "end",
  input: ActivityPushContent,
): { aps: Record<string, unknown> } {
  const activity = "activity" in input ? input.activity : input;
  const timestamp = activity.pushTimestamp;
  const presentation = "activity" in input ? input.presentation : "task";
  const checkpoint = "activity" in input ? input.checkpoint ?? null : null;
  const contentState = {
    status: activity.status,
    detail: activity.detail,
    progress: activity.progress,
    symbol: activity.symbol,
    accentColor: activity.accentColor,
    sequence: activity.sequence,
    isEnded: event === "end",
    presentation,
    checkpoint,
  };
  const aps: Record<string, unknown> = {
    timestamp,
    event,
    "content-state": contentState,
    "stale-date": Math.floor(new Date(activity.staleAt).getTime() / 1_000),
  };
  if (event === "start") {
    aps["attributes-type"] = "RelayActivityAttributes";
    aps.attributes = { relayActivityId: activity.id, title: activity.title };
    aps["input-push-token"] = 1;
    aps.alert = { title: activity.title, body: activity.status };
  }
  if (event === "end") aps["dismissal-date"] = timestamp + 60;
  return { aps };
}

export class ActivityPushSequencer {
  private readonly tails = new Map<string, Promise<void>>();
  private draining = false;

  public run<T>(activityId: string, task: () => Promise<T>): Promise<T> {
    if (this.draining) return Promise.reject(new Error("Activity push provider is draining"));
    const previous = this.tails.get(activityId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(activityId, tail);
    void tail.finally(() => {
      if (this.tails.get(activityId) === tail) this.tails.delete(activityId);
    });
    return operation;
  }

  public async waitForIdle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.allSettled([...this.tails.values()]);
    }
  }

  public async withDrain<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.draining) throw new Error("Activity push provider is already draining");
    this.draining = true;
    try {
      await this.waitForIdle();
      return await task();
    } finally {
      this.draining = false;
    }
  }
}

export class ApnsPushProvider implements PushProvider {
  private cachedJwt: { value: string; issuedAt: number } | null = null;
  private readonly activitySequencer = new ActivityPushSequencer();

  public constructor(private readonly config: ApnsConfiguration) {}

  public waitForActivityIdle(): Promise<void> {
    return this.activitySequencer.waitForIdle();
  }

  public withActivityDrain<T>(task: () => T | Promise<T>): Promise<T> {
    return this.activitySequencer.withDrain(task);
  }

  public encodePayload(value: unknown): Buffer {
    const encoded = encodeJson(value);
    if (encoded.byteLength > MAX_PAYLOAD_BYTES) {
      throw new Error(`APNs payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    return encoded;
  }

  public sendNotification(token: string, input: NotificationCreate, requestId: string): Promise<PushResult> {
    return this.send(token, buildNotificationPayload(input), "alert", this.config.bundleId, 10, requestId);
  }

  public sendInteraction(
    token: string,
    input: {
      interactionId: string;
      kind: InteractionKind;
      title: string;
      prompt: string;
      responseCredential: string;
    },
    requestId: string,
  ): Promise<PushResult> {
    return this.send(token, buildInteractionPayload(input), "alert", this.config.bundleId, 10, requestId);
  }

  public sendActivity(
    token: string,
    event: "start" | "update" | "end",
    activity: ActivityPushContent,
    priority: 5 | 10,
    requestId: string,
  ): Promise<PushResult> {
    const state = "activity" in activity ? activity.activity : activity;
    return this.activitySequencer.run(state.id, () =>
      this.send(
        token,
        buildActivityPayload(event, activity),
        "liveactivity",
        `${this.config.bundleId}.push-type.liveactivity`,
        priority,
        requestId,
      ),
    );
  }

  private jwt(): string {
    const issuedAt = Math.floor(Date.now() / 1_000);
    if (this.cachedJwt && issuedAt - this.cachedJwt.issuedAt < JWT_TTL_SECONDS) {
      return this.cachedJwt.value;
    }
    const value = createProviderJwt(this.config, issuedAt);
    this.cachedJwt = { value, issuedAt };
    return value;
  }

  private send(
    token: string,
    payloadValue: unknown,
    pushType: "alert" | "liveactivity",
    topic: string,
    priority: 5 | 10,
    requestId: string,
  ): Promise<PushResult> {
    let payload: Buffer;
    let jwt: string;
    try {
      payload = this.encodePayload(payloadValue);
      jwt = this.jwt();
    } catch (error) {
      return Promise.resolve({
        accepted: false,
        status: 0,
        apnsId: null,
        reason: error instanceof Error ? error.message : "Invalid APNs payload",
      });
    }
    const host =
      this.config.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";

    return new Promise((resolve) => {
      const client = connect(host);
      let settled = false;
      let request: ReturnType<typeof client.request> | null = null;
      const finish = (result: PushResult) => {
        if (settled) return;
        settled = true;
        request?.close();
        client.close();
        client.destroy();
        resolve(result);
      };
      client.setTimeout(10_000, () =>
        finish({ accepted: false, status: 0, apnsId: null, reason: "Timeout" }),
      );
      client.on("error", (error) =>
        finish({ accepted: false, status: 0, apnsId: null, reason: error.message }),
      );
      request = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-push-type": pushType,
        "apns-topic": topic,
        "apns-priority": String(priority),
        "apns-id": requestId,
      });
      let status = 0;
      let apnsId: string | null = null;
      const chunks: Buffer[] = [];
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
        apnsId = typeof headers["apns-id"] === "string" ? headers["apns-id"] : null;
      });
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("error", (error) =>
        finish({ accepted: false, status: 0, apnsId, reason: error.message }),
      );
      request.on("end", () => {
        let reason: string | null = null;
        if (chunks.length) {
          try {
            const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string };
            reason = decoded.reason ?? null;
          } catch {
            reason = "Invalid APNs response";
          }
        }
        finish({ accepted: status === 200, status, apnsId, reason });
      });
      request.end(payload);
    });
  }
}
