import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@libsql/client";
import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type {
  ActivityCreate,
  ActivityEnd,
  ActivityUpdate,
  InteractionCreate,
  InteractionKind,
  InteractionResponse,
  InteractionStatus,
  NotificationCreate,
} from "@relay/contracts";
import {
  activities,
  activityCheckpoints,
  activityPushTokens,
  credentials,
  deliveries,
  devices,
  enrollmentCodes,
  hosts,
  interactions,
  mutations,
  notifications,
} from "./schema.js";
import { migrate } from "./migrate.js";
import { SecretBox, TokenAuthority } from "./security.js";

export class ConflictError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
  }
}
export class NotFoundError extends Error {}
export class UnauthorizedError extends Error {}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
const requestHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("base64url");

type InteractionRow = typeof interactions.$inferSelect;
type NotificationRow = typeof notifications.$inferSelect;
type ActivityRow = typeof activities.$inferSelect;
type PushResult = { accepted: boolean; apnsId: string | null; reason: string | null };

export interface RelayStoreOptions {
  filename?: string;
  url?: string;
  authToken?: string;
  tokenAuthority: TokenAuthority;
  secretBox: SecretBox;
  now?: () => Date;
}

export const BOOTSTRAP_HOST_NAME = "primary";

export interface PublicHost {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PublicNotification {
  id: string;
  title: string;
  body: string;
  url: string | null;
  status: string;
  origin: string | null;
  createdAt: string;
}

export interface PublicInteraction {
  id: string;
  title: string;
  prompt: string;
  kind: InteractionKind;
  status: InteractionStatus;
  response: string | null;
  origin: string | null;
  expiresAt: string;
  createdAt: string;
  respondedAt: string | null;
  activity?: { id: string; presentation: "checkpoint" | "temporary" };
}

export interface PublicActivity {
  id: string;
  key: string | null;
  title: string;
  status: string;
  detail: string | null;
  progress: number;
  symbol: string;
  accentColor: string;
  state: "active" | "ended";
  sequence: number;
  pushTimestamp: number;
  staleAt: string;
  endReason?: string | null;
}

function toInteraction(row: InteractionRow, origin: string | null): PublicInteraction {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    kind: row.kind as InteractionKind,
    status: row.status as InteractionStatus,
    response: row.response,
    origin,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

function toActivity(row: ActivityRow): PublicActivity {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    status: row.status,
    detail: row.detail,
    progress: row.progress,
    symbol: row.symbol,
    accentColor: row.accentColor,
    state: row.state as "active" | "ended",
    sequence: row.sequence,
    pushTimestamp: row.pushTimestamp,
    staleAt: row.staleAt.toISOString(),
    endReason: row.endReason,
  };
}

export interface ActivityCheckpointPayload {
  presentation: "task" | "checkpoint" | "acknowledged";
  activity: PublicActivity;
  checkpoint?: {
    interactionId: string;
    kind: "approval" | "yes_no";
    prompt: string;
    expiresAt: string;
    result: "approve" | "deny" | "yes" | "no" | "canceled" | "expired" | null;
  };
}

function validateResponseKind(kind: string, response: InteractionResponse): boolean {
  if (kind === "approval") return response.action === "approve" || response.action === "deny";
  if (kind === "yes_no") return response.action === "yes" || response.action === "no";
  return kind === "text" && response.action === "reply";
}

export async function openRelayStore(options: RelayStoreOptions) {
  const client = createClient({
    url: options.url ?? `file:${options.filename ?? ":memory:"}`,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  try {
  try {
    await migrate(client);
  } catch (error) {
    client.close();
    throw error;
  }
  } catch (error) {
    client.close();
    throw error;
  }
  const rootDb = drizzle(client);
  type Transaction = Parameters<Parameters<typeof rootDb.transaction>[0]>[0];
  const transactions = new AsyncLocalStorage<{ transaction?: Transaction }>();
  const db = (): Pick<typeof rootDb, "select" | "insert" | "update" | "delete"> => transactions.getStore()?.transaction ?? rootDb;
  const transaction = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
    const current = transactions.getStore()?.transaction;
    return current ? work(current) : rootDb.transaction((tx) => transactions.run({ transaction: tx }, () => work(tx)), { behavior: "immediate" });
  };
  const now = options.now ?? (() => new Date());
  const nextPushTimestamp = (activity: { pushTimestamp: number }, time = now()) =>
    Math.max(Math.floor(time.getTime() / 1_000), activity.pushTimestamp + 1);

  const payloadActivityState = (payload: string) => {
    const parsed = JSON.parse(payload) as {
      id?: unknown;
      sequence?: unknown;
      activity?: { id?: unknown; sequence?: unknown };
    };
    const candidate = parsed.activity ?? parsed;
    return typeof candidate.id === "string" && typeof candidate.sequence === "number"
      ? { id: candidate.id, sequence: candidate.sequence }
      : null;
  };

  const ensureDeliveryIntent = async (
    resourceType: string,
    resourceId: string,
    purpose: string,
    idempotencyKey: string,
    payload?: unknown,
    availableAt?: Date,
  ) => {
    return transaction(async () => {
      const existing = await db()
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.resourceType, resourceType),
            eq(deliveries.resourceId, resourceId),
            eq(deliveries.purpose, purpose),
            eq(deliveries.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (existing) return existing;
      const serializedPayload = payload === undefined ? null : JSON.stringify(payload);
      if (["activity", "checkpoint"].includes(resourceType) && serializedPayload) {
        const desired = payloadActivityState(serializedPayload);
        const obsolete = (await db()
          .select()
          .from(deliveries)
          .where(
            and(
              inArray(deliveries.resourceType, ["activity", "checkpoint"]),
              inArray(deliveries.status, ["pending", "failed", "blocked"]),
            ),
          )
          .all())
          .filter((delivery) => {
            if (!delivery.payload || !desired) return false;
            try {
              const existing = payloadActivityState(delivery.payload);
              return existing?.id === desired.id && existing.sequence < desired.sequence;
            } catch {
              return false;
            }
          });
        if (obsolete.length) {
          await db().update(deliveries)
            .set({ status: "superseded", accepted: false, reason: "Superseded by newer activity state" })
            .where(inArray(deliveries.id, obsolete.map((delivery) => delivery.id)))
            .run();
        }
      }
      const deliveryId = randomUUID();
      await db().insert(deliveries)
        .values({
          id: deliveryId,
          resourceType,
          resourceId,
          purpose,
          idempotencyKey,
          payload: serializedPayload,
          status: "pending",
          createdAt: now(),
          availableAt: availableAt ?? null,
        })
        .run();
      return (await db().select().from(deliveries).where(eq(deliveries.id, deliveryId)).get())!;
    });
  };

  const deliveryIntentsForKey = async (resourceType: string, idempotencyKey: string) =>
    (await db()
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.resourceType, resourceType), eq(deliveries.idempotencyKey, idempotencyKey)))
      .orderBy(deliveries.createdAt)
      .all());

  const checkpointForInteraction = async (interactionId: string) =>
    (await db().select().from(activityCheckpoints).where(eq(activityCheckpoints.interactionId, interactionId)).get());

  const unresolvedCheckpointForActivity = async (activityId: string) =>
    (await db()
      .select()
      .from(activityCheckpoints)
      .where(and(eq(activityCheckpoints.activityId, activityId), ne(activityCheckpoints.state, "finished")))
      .get());

  const hostNameCache = new Map<string, string | null>();
  const hostNameById = async (hostId: string | null): Promise<string | null> => {
    if (!hostId) return null;
    if (!hostNameCache.has(hostId)) {
      hostNameCache.set(hostId, (await db().select({ name: hosts.name }).from(hosts).where(eq(hosts.id, hostId)).get())?.name ?? null);
    }
    return hostNameCache.get(hostId) ?? null;
  };

  const publicNotification = async (row: NotificationRow): Promise<PublicNotification> => ({
    id: row.id,
    title: row.title,
    body: row.body,
    url: row.url,
    status: row.status,
    origin: await hostNameById(row.originHostId),
    createdAt: row.createdAt.toISOString(),
  });

  const publicInteraction = async (row: InteractionRow): Promise<PublicInteraction> => {
    const checkpoint = await checkpointForInteraction(row.id);
    return {
      ...toInteraction(row, await hostNameById(row.originHostId)),
      ...(checkpoint
        ? {
            activity: {
              id: checkpoint.activityId,
              presentation: checkpoint.presentation as "checkpoint" | "temporary",
            },
          }
        : {}),
    };
  };

  const checkpointPayload = (
    interaction: InteractionRow,
    activity: ActivityRow,
    presentation: ActivityCheckpointPayload["presentation"],
    result: "approve" | "deny" | "yes" | "no" | "canceled" | "expired" | null = null,
  ): ActivityCheckpointPayload => ({
    presentation,
    activity: toActivity(activity),
    ...(presentation === "task"
      ? {}
      : {
          checkpoint: {
            interactionId: interaction.id,
            kind: interaction.kind as "approval" | "yes_no",
            prompt: interaction.prompt,
            expiresAt: interaction.expiresAt.toISOString(),
            result,
          },
        }),
  });

  const desiredActivityPayload = async (activity: ActivityRow): Promise<PublicActivity | ActivityCheckpointPayload> => {
    const checkpoint = await unresolvedCheckpointForActivity(activity.id);
    if (!checkpoint) return toActivity(activity);
    const interaction = await db().select().from(interactions).where(eq(interactions.id, checkpoint.interactionId)).get();
    if (!interaction) return toActivity(activity);
    return checkpoint.state === "acknowledged"
      ? checkpointPayload(
          interaction,
          activity,
          "acknowledged",
          checkpoint.result as "approve" | "deny" | "yes" | "no" | "canceled" | "expired",
        )
      : checkpointPayload(interaction, activity, "checkpoint");
  };

  const finishPresentationForActivity = async (activityId: string) => {
    await db().update(activityCheckpoints)
      .set({ state: "finished", resolvedAt: now() })
      .where(and(eq(activityCheckpoints.activityId, activityId), ne(activityCheckpoints.state, "finished")))
      .run();
  };

  const acknowledgeCheckpoint = async (
    interaction: InteractionRow,
    result: "approve" | "deny" | "yes" | "no" | "canceled" | "expired",
  ) => {
    const checkpoint = await checkpointForInteraction(interaction.id);
    if (!checkpoint || checkpoint.state === "finished") return null;
    const activity = await db().select().from(activities).where(eq(activities.id, checkpoint.activityId)).get();
    const currentTime = now();
    if (!activity || activity.state !== "active") {
      await db().update(activityCheckpoints)
        .set({ state: "finished", result, resolvedAt: currentTime })
        .where(eq(activityCheckpoints.interactionId, interaction.id))
        .run();
      return null;
    }
    const nextSequence = activity.sequence + 1;
    await db().update(activities)
      .set({ sequence: nextSequence, pushTimestamp: nextPushTimestamp(activity, currentTime), updatedAt: currentTime })
      .where(and(eq(activities.id, activity.id), eq(activities.state, "active")))
      .run();
    await db().update(activityCheckpoints)
      .set({ state: "acknowledged", result, resolvedAt: currentTime })
      .where(and(eq(activityCheckpoints.interactionId, interaction.id), ne(activityCheckpoints.state, "finished")))
      .run();
    const updated = (await db().select().from(activities).where(eq(activities.id, activity.id)).get())!;
    return await ensureDeliveryIntent(
      "checkpoint",
      interaction.id,
      "checkpoint-ack",
      `checkpoint:${interaction.id}:checkpoint-ack`,
      checkpointPayload(interaction, updated, "acknowledged", result),
    );
  };

  const finishAcknowledgedCheckpoint = async (interactionId: string) =>
    (await transaction(async () => {
      const checkpoint = await checkpointForInteraction(interactionId);
      if (!checkpoint || checkpoint.state !== "acknowledged") return null;
      const interaction = await db().select().from(interactions).where(eq(interactions.id, interactionId)).get();
      const activity = await db().select().from(activities).where(eq(activities.id, checkpoint.activityId)).get();
      if (!interaction || !activity || activity.state !== "active") {
        await db().update(activityCheckpoints)
          .set({ state: "finished", resolvedAt: now() })
          .where(eq(activityCheckpoints.interactionId, interactionId))
          .run();
        return null;
      }
      const currentTime = now();
      const nextSequence = activity.sequence + 1;
      if (checkpoint.presentation === "temporary") {
        await db().update(activities)
          .set({
            state: "ended",
            sequence: nextSequence,
            pushTimestamp: nextPushTimestamp(activity, currentTime),
            status: checkpoint.result ?? activity.status,
            updatedAt: currentTime,
            endedAt: currentTime,
          })
          .where(and(eq(activities.id, activity.id), eq(activities.state, "active")))
          .run();
      } else {
        await db().update(activities)
          .set({ sequence: nextSequence, pushTimestamp: nextPushTimestamp(activity, currentTime), updatedAt: currentTime })
          .where(and(eq(activities.id, activity.id), eq(activities.state, "active")))
          .run();
      }
      await db().update(activityCheckpoints)
        .set({ state: "finished", resolvedAt: currentTime })
        .where(and(eq(activityCheckpoints.interactionId, interactionId), eq(activityCheckpoints.state, "acknowledged")))
        .run();
      const updated = (await db().select().from(activities).where(eq(activities.id, activity.id)).get())!;
      const purpose = checkpoint.presentation === "temporary" ? "checkpoint-end" : "checkpoint-restore";
      return await ensureDeliveryIntent(
        "checkpoint",
        interaction.id,
        purpose,
        `checkpoint:${interaction.id}:${purpose}`,
        checkpoint.presentation === "temporary"
          ? checkpointPayload(
              interaction,
              updated,
              "acknowledged",
              checkpoint.result as "approve" | "deny" | "yes" | "no" | "canceled" | "expired",
            )
          : checkpointPayload(interaction, updated, "task"),
        new Date(currentTime.getTime() + 1_500),
      );
    }));

  const terminalCheckpointResult = (
    interaction: InteractionRow,
  ): "approve" | "deny" | "yes" | "no" | "canceled" | "expired" | null => {
    if (interaction.status === "canceled" || interaction.status === "expired") return interaction.status;
    if (["approve", "deny", "yes", "no"].includes(interaction.response ?? "")) {
      return interaction.response as "approve" | "deny" | "yes" | "no";
    }
    return null;
  };

  const expireInteraction = async (row: InteractionRow): Promise<InteractionRow> =>
    (await transaction(async () => {
      const currentTime = now();
      if (row.status !== "pending" || row.expiresAt > currentTime) return row;
      const changed = await db().update(interactions)
        .set({ status: "expired", respondedAt: currentTime })
        .where(and(eq(interactions.id, row.id), eq(interactions.status, "pending")))
        .run();
      const expired = changed.rowsAffected === 1
        ? { ...row, status: "expired", respondedAt: currentTime }
        : (await db().select().from(interactions).where(eq(interactions.id, row.id)).get())!;
      if (expired.status === "expired") await acknowledgeCheckpoint(expired, "expired");
      return expired;
    }));

  const applyInteractionResponse = async (
    interactionId: string,
    response: InteractionResponse,
    responseCredential?: string,
  ) =>
    (await transaction(async (tx) => {
      const row = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).get();
      if (!row) throw new NotFoundError("Interaction not found");
      const current = await expireInteraction(row);
      if (
        responseCredential !== undefined &&
        !options.tokenAuthority.verify(responseCredential, current.responseTokenDigest, "response")
      ) {
        throw new UnauthorizedError("Invalid response credential");
      }
      if (!validateResponseKind(current.kind, response)) {
        throw new ConflictError(`Interaction requires a ${current.kind} response`);
      }
      const responseTokenConsumedAt = responseCredential === undefined
        ? current.responseTokenConsumedAt
        : current.responseTokenConsumedAt ?? now();
      if (responseCredential !== undefined && current.responseTokenConsumedAt === null) {
        await tx.update(interactions)
          .set({ responseTokenConsumedAt })
          .where(and(eq(interactions.id, interactionId), isNull(interactions.responseTokenConsumedAt)))
          .run();
      }
      const requestedValue = response.action === "reply" ? response.text : response.action;
      if (current.status !== "pending") {
        return { interaction: await publicInteraction(current), activityDelivery: null };
      }
      const status: InteractionStatus =
        response.action === "approve"
          ? "approved"
          : response.action === "deny"
            ? "denied"
            : response.action === "reply"
              ? "replied"
              : response.action;
      const respondedAt = now();
      const changed = await tx
        .update(interactions)
        .set({
          status,
          response: requestedValue,
          respondedAt,
          ...(responseCredential === undefined ? {} : { responseTokenConsumedAt }),
        })
        .where(and(eq(interactions.id, interactionId), eq(interactions.status, "pending")))
        .run();
      if (changed.rowsAffected !== 1) throw new ConflictError("Interaction is already terminal");
      const answered = (await tx.select().from(interactions).where(eq(interactions.id, interactionId)).get())!;
      return {
        interaction: await publicInteraction(answered),
        activityDelivery: response.action === "reply" ? null : await acknowledgeCheckpoint(answered, response.action),
      };
    }));

  const store = {
    close: () => {
      client.close();
    },
    integrityCheck: async () => String((await client.execute("PRAGMA integrity_check")).rows[0]![0]),

    async pruneRetention(retentionDays = 30) {
      const cutoff = new Date(now().getTime() - retentionDays * 86_400_000);
      return await transaction(async (tx) => {
        await tx.delete(deliveries).where(lt(deliveries.createdAt, cutoff)).run();
        await tx.delete(mutations).where(lt(mutations.createdAt, cutoff)).run();
        await tx.delete(notifications).where(lt(notifications.createdAt, cutoff)).run();
        await tx.delete(interactions)
          .where(and(lt(interactions.createdAt, cutoff), lt(interactions.expiresAt, now())))
          .run();
        await tx.delete(activities).where(and(eq(activities.state, "ended"), lt(activities.updatedAt, cutoff))).run();
        await tx.delete(enrollmentCodes).where(lt(enrollmentCodes.expiresAt, cutoff)).run();
        await tx.delete(credentials).where(lt(credentials.revokedAt, cutoff)).run();
      });
    },

    ensureDeliveryIntent,
    deliveryIntentsForKey,

    async deliveryById(deliveryId: string) {
      const delivery = await db().select().from(deliveries).where(eq(deliveries.id, deliveryId)).get();
      if (!delivery) throw new NotFoundError("Delivery not found");
      return delivery;
    },

    async claimDelivery(deliveryId: string) {
      return (
        (await db()
          .update(deliveries)
          .set({ status: "sending", reason: null, availableAt: new Date(now().getTime() + 300_000) })
          .where(and(eq(deliveries.id, deliveryId), or(
            inArray(deliveries.status, ["pending", "failed"]),
            and(eq(deliveries.status, "sending"), or(isNull(deliveries.availableAt), lte(deliveries.availableAt, now()))),
          )))
          .run()).rowsAffected === 1
      );
    },

    async completeDelivery(deliveryId: string, result: PushResult, failureStatus = "failed") {
      await db().update(deliveries)
        .set({
          status: result.accepted ? "accepted" : failureStatus,
          accepted: result.accepted,
          apnsId: result.apnsId,
          reason: result.reason,
          availableAt: null,
        })
        .where(
          and(
            eq(deliveries.id, deliveryId),
            ne(deliveries.status, "superseded"),
            ...(result.accepted ? [] : [ne(deliveries.status, "accepted")]),
          ),
        )
        .run();
      return (await db().select().from(deliveries).where(eq(deliveries.id, deliveryId)).get())!;
    },

    async completeCheckpointDelivery(deliveryId: string, result: PushResult, retryable = true) {
      return await transaction(async () => {
        const delivery = await this.completeDelivery(deliveryId, result, retryable ? "failed" : "blocked");
        const nextDelivery = delivery.purpose === "checkpoint-ack"
          ? await finishAcknowledgedCheckpoint(delivery.resourceId)
          : null;
        return { delivery, nextDelivery };
      });
    },

    async completeNotificationDelivery(notificationId: string, deliveryId: string, result: PushResult) {
      return await transaction(async () => {
        const delivery = await this.completeDelivery(deliveryId, result);
        await db().update(notifications)
          .set({
            status: delivery.accepted ? "accepted" : "failed",
            apnsId: delivery.apnsId,
            error: delivery.reason,
          })
          .where(eq(notifications.id, notificationId))
          .run();
        return delivery;
      });
    },

    async findMutation(operation: string, idempotencyKey: string, payload: unknown) {
      const row = await db()
        .select()
        .from(mutations)
        .where(and(eq(mutations.operation, operation), eq(mutations.idempotencyKey, idempotencyKey)))
        .get();
      if (!row) return null;
      if (row.requestHash !== requestHash(payload)) {
        throw new ConflictError("Idempotency key payload mismatch");
      }
      return { resourceId: row.resourceId };
    },

    async recordMutation(operation: string, idempotencyKey: string, payload: unknown, resourceId: string) {
      await db().insert(mutations)
        .values({
          id: id("mut"),
          operation,
          idempotencyKey,
          requestHash: requestHash(payload),
          resourceId,
          createdAt: now(),
        })
        .run();
    },

    async installCliCredential(token: string, hostName: string = BOOTSTRAP_HOST_NAME) {
      return await transaction(async (tx) => {
        const linked = await tx.select().from(hosts).where(isNull(hosts.revokedAt)).get();
        if (linked) return linked.id;
        const currentTime = now();
        const existing = await tx
          .select()
          .from(credentials)
          .where(and(eq(credentials.kind, "cli"), isNull(credentials.revokedAt)))
          .get();
        const credentialId = existing?.id ?? id("cred");
        if (!existing) {
          await tx.insert(credentials)
            .values({
              id: credentialId,
              kind: "cli",
              digest: options.tokenAuthority.digest(token, "cli"),
              createdAt: currentTime,
            })
            .run();
        }
        const hostId = id("hst");
        await tx.insert(hosts)
          .values({ id: hostId, name: hostName, credentialId, createdAt: currentTime })
          .run();
        return hostId;
      });
    },

    async authenticateCli(token: string) {
      const active = await db()
        .select({ id: hosts.id, name: hosts.name, digest: credentials.digest })
        .from(hosts)
        .innerJoin(credentials, eq(hosts.credentialId, credentials.id))
        .where(and(isNull(hosts.revokedAt), eq(credentials.kind, "cli"), isNull(credentials.revokedAt)))
        .all();
      const match = active.find((host) => options.tokenAuthority.verify(token, host.digest, "cli"));
      if (!match) return undefined;
      await db().update(hosts).set({ lastSeenAt: now() }).where(eq(hosts.id, match.id)).run();
      return { id: match.id, name: match.name };
    },

    async listHosts(): Promise<PublicHost[]> {
      return (await db()
        .select()
        .from(hosts)
        .where(isNull(hosts.revokedAt))
        .orderBy(hosts.createdAt, hosts.name)
        .all())
        .map((row) => ({
          id: row.id,
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        }));
    },

    async revokeHost(selector: string) {
      return await transaction(async (tx) => {
        const linked = await tx.select().from(hosts).where(isNull(hosts.revokedAt)).all();
        const host = linked.find((row) => row.id === selector || row.name === selector);
        if (!host) throw new NotFoundError("Host not found");
        if (linked.length === 1) throw new ConflictError("Cannot revoke the only linked host");
        const currentTime = now();
        await tx.update(credentials)
          .set({ revokedAt: currentTime })
          .where(and(eq(credentials.id, host.credentialId), isNull(credentials.revokedAt)))
          .run();
        await tx.update(hosts).set({ revokedAt: currentTime }).where(eq(hosts.id, host.id)).run();
        return { id: host.id, name: host.name };
      });
    },

    async rotateCliCredential(currentToken: string, idempotencyKey: string) {
      return await transaction(async (tx) => {
        const replay = await tx
          .select()
          .from(mutations)
          .where(and(eq(mutations.operation, "cli:rotate"), eq(mutations.idempotencyKey, idempotencyKey)))
          .get();
        const issued = options.tokenAuthority.derive("cli", `rotation:${idempotencyKey}`);
        if (replay) {
          if (replay.requestHash !== requestHash({})) throw new ConflictError("Idempotency key payload mismatch");
          const [oldId, newId] = replay.resourceId.split(":", 2);
          const replayCredentials = (await tx
            .select()
            .from(credentials)
            .where(eq(credentials.kind, "cli"))
            .all())
            .filter((credential) => credential.id === oldId || credential.id === newId);
          if (!replayCredentials.some((credential) => options.tokenAuthority.verify(currentToken, credential.digest, "cli"))) {
            throw new UnauthorizedError("Invalid CLI credential");
          }
          return issued.plaintext;
        }

        const current = (await tx
          .select()
          .from(credentials)
          .where(and(eq(credentials.kind, "cli"), isNull(credentials.revokedAt)))
          .all())
          .find((credential) => options.tokenAuthority.verify(currentToken, credential.digest, "cli"));
        if (!current) throw new UnauthorizedError("Invalid CLI credential");

        const newCredentialId = id("cred");
        await tx.insert(credentials)
          .values({ id: newCredentialId, kind: "cli", digest: issued.digest, createdAt: now() })
          .run();
        await tx.update(credentials)
          .set({ revokedAt: now() })
          .where(and(eq(credentials.id, current.id), isNull(credentials.revokedAt)))
          .run();
        await tx.update(hosts)
          .set({ credentialId: newCredentialId, lastSeenAt: now() })
          .where(and(eq(hosts.credentialId, current.id), isNull(hosts.revokedAt)))
          .run();
        await tx.insert(mutations)
          .values({
            id: id("mut"),
            operation: "cli:rotate",
            idempotencyKey,
            requestHash: requestHash({}),
            resourceId: `${current.id}:${newCredentialId}`,
            createdAt: now(),
          })
          .run();
        return issued.plaintext;
      });
    },

    async createEnrollment(idempotencyKey?: string, kind: "device" | "host" = "device") {
      return transaction(async () => {
        const payload = {};
        const operation = kind === "host" ? "host-enrollment:create" : "enrollment:create";
        if (idempotencyKey) {
          const replay = await db()
            .select()
            .from(mutations)
            .where(and(eq(mutations.operation, operation), eq(mutations.idempotencyKey, idempotencyKey)))
            .get();
          if (replay) {
            if (replay.requestHash !== requestHash(payload)) throw new ConflictError("Idempotency key payload mismatch");
            const enrollment = await db().select().from(enrollmentCodes).where(eq(enrollmentCodes.id, replay.resourceId)).get();
            if (!enrollment) throw new ConflictError("Idempotent enrollment has expired from retention");
            return {
              code: options.secretBox.open(enrollment.codeCiphertext, `enrollment:${enrollment.id}:code`),
              expiresAt: enrollment.expiresAt.toISOString(),
            };
          }
        }
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = randomBytes(8);
        const code = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
        const currentTime = now();
        const expiresAt = new Date(currentTime.getTime() + 10 * 60_000);
        const enrollmentId = id("enr");
        await transaction(async (tx) => {
          await tx.insert(enrollmentCodes)
            .values({
              id: enrollmentId,
              kind,
              digest: options.tokenAuthority.digest(code, "enrollment"),
              codeCiphertext: options.secretBox.seal(code, `enrollment:${enrollmentId}:code`),
              expiresAt,
              createdAt: currentTime,
            })
            .run();
          if (idempotencyKey) {
            await tx.insert(mutations)
              .values({
                id: id("mut"),
                operation,
                idempotencyKey,
                requestHash: requestHash(payload),
                resourceId: enrollmentId,
                createdAt: currentTime,
              })
              .run();
          }
        });
        return { code, expiresAt: expiresAt.toISOString() };
      });
    },

    async exchangeEnrollment(code: string, deviceName: string) {
      return await transaction(async (tx) => {
        const currentTime = now();
        const digest = options.tokenAuthority.digest(code, "enrollment");
        const pairing = await tx
          .select()
          .from(enrollmentCodes)
          .where(and(eq(enrollmentCodes.digest, digest), eq(enrollmentCodes.kind, "device")))
          .get();
        if (!pairing || pairing.expiresAt <= currentTime) {
          throw new NotFoundError("Pairing code is invalid or expired");
        }
        if (pairing.usedAt) throw new ConflictError("Pairing code has already been used");
        if ((await tx.select({ id: devices.id }).from(devices).get())) {
          throw new ConflictError("A device is already paired; revoke it before pairing another");
        }
        const issued = options.tokenAuthority.issue("device");
        const credentialId = id("cred");
        const deviceId = id("dev");
        await tx.insert(credentials)
          .values({ id: credentialId, kind: "device", digest: issued.digest, createdAt: currentTime })
          .run();
        await tx.insert(devices)
          .values({
            id: deviceId,
            name: deviceName,
            credentialId,
            createdAt: currentTime,
            updatedAt: currentTime,
          })
          .run();
        await tx.update(enrollmentCodes)
          .set({ usedAt: currentTime })
          .where(and(eq(enrollmentCodes.id, pairing.id), isNull(enrollmentCodes.usedAt)))
          .run();
        return { id: deviceId, credential: issued.plaintext, name: deviceName };
      });
    },

    async exchangeHostEnrollment(code: string, hostName: string) {
      return await transaction(async (tx) => {
        const currentTime = now();
        const digest = options.tokenAuthority.digest(code, "enrollment");
        const enrollment = await tx
          .select()
          .from(enrollmentCodes)
          .where(and(eq(enrollmentCodes.digest, digest), eq(enrollmentCodes.kind, "host")))
          .get();
        if (!enrollment || enrollment.expiresAt <= currentTime) {
          throw new NotFoundError("Host enrollment code is invalid or expired");
        }
        if (enrollment.usedAt) throw new ConflictError("Host enrollment code has already been used");
        const taken = await tx
          .select({ id: hosts.id })
          .from(hosts)
          .where(and(eq(hosts.name, hostName), isNull(hosts.revokedAt)))
          .get();
        if (taken) throw new ConflictError(`A host named ${hostName} is already linked`);
        const issued = options.tokenAuthority.issue("cli");
        const credentialId = id("cred");
        const hostId = id("hst");
        await tx.insert(credentials)
          .values({ id: credentialId, kind: "cli", digest: issued.digest, createdAt: currentTime })
          .run();
        await tx.insert(hosts)
          .values({ id: hostId, name: hostName, credentialId, createdAt: currentTime })
          .run();
        await tx.update(enrollmentCodes)
          .set({ usedAt: currentTime })
          .where(and(eq(enrollmentCodes.id, enrollment.id), isNull(enrollmentCodes.usedAt)))
          .run();
        return { id: hostId, name: hostName, token: issued.plaintext };
      });
    },

    async authenticateDevice(token: string) {
      const candidates = await db()
        .select({ id: devices.id, name: devices.name, digest: credentials.digest })
        .from(devices)
        .innerJoin(credentials, eq(devices.credentialId, credentials.id))
        .where(and(eq(credentials.kind, "device"), isNull(credentials.revokedAt)))
        .all();
      const match = candidates.find((candidate) =>
        options.tokenAuthority.verify(token, candidate.digest, "device"),
      );
      return match ? { id: match.id, name: match.name } : undefined;
    },

    async revokeDevice(deviceId: string) {
      return await transaction(async (tx) => {
        const device = await tx.select().from(devices).where(eq(devices.id, deviceId)).get();
        if (!device) throw new NotFoundError("Device not found");
        const pending = await tx.select().from(interactions).where(eq(interactions.status, "pending")).all();
        await tx.update(credentials)
          .set({ revokedAt: now() })
          .where(and(eq(credentials.id, device.credentialId), isNull(credentials.revokedAt)))
          .run();
        for (const interaction of pending) {
          await tx.update(interactions)
            .set({ status: "canceled", respondedAt: now() })
            .where(and(eq(interactions.id, interaction.id), eq(interactions.status, "pending")))
            .run();
          const canceled = (await tx.select().from(interactions).where(eq(interactions.id, interaction.id)).get())!;
          if ((await acknowledgeCheckpoint(canceled, "canceled"))) {
            await finishAcknowledgedCheckpoint(canceled.id);
          }
        }
        await tx.update(deliveries)
          .set({
            status: "superseded",
            accepted: false,
            reason: "Device credential revoked before checkpoint cleanup",
          })
          .where(
            and(
              eq(deliveries.resourceType, "checkpoint"),
              inArray(deliveries.status, ["pending", "failed"]),
            ),
          )
          .run();
        await tx.delete(devices).where(eq(devices.id, deviceId)).run();
      });
    },

    async updateDeviceTokens(
      deviceId: string,
      input: {
        apnsToken?: string | undefined;
        pushToStartToken?: string | undefined;
        environment: "sandbox" | "production";
        capabilities?: { liveActivityInteractions: 1 } | undefined;
      },
    ) {
      const existing = await db().select().from(devices).where(eq(devices.id, deviceId)).get();
      if (!existing) throw new NotFoundError("Device not found");
      const pushToStartTokenChanged = Boolean(
        input.pushToStartToken && (
          !existing.pushToStartTokenCiphertext ||
          options.secretBox.open(existing.pushToStartTokenCiphertext, `device:${deviceId}:push-to-start`) !==
            input.pushToStartToken
        ),
      );
      const values: Partial<typeof devices.$inferInsert> = {
        environment: input.environment,
        updatedAt: now(),
      };
      if (input.apnsToken) {
        values.apnsTokenCiphertext = options.secretBox.seal(input.apnsToken, `device:${deviceId}:apns`);
      }
      if (input.pushToStartToken) {
        values.pushToStartTokenCiphertext = options.secretBox.seal(
          input.pushToStartToken,
          `device:${deviceId}:push-to-start`,
        );
      }
      if (input.capabilities) {
        values.liveActivityInteractionsVersion = input.capabilities.liveActivityInteractions;
      }
      await db().update(devices).set(values).where(eq(devices.id, deviceId)).run();
      if (pushToStartTokenChanged) {
        const retryable = (await db()
          .select()
          .from(deliveries)
          .where(and(eq(deliveries.resourceType, "checkpoint"), eq(deliveries.status, "blocked")))
          .all())
          .filter((delivery) => {
            if (!delivery.payload) return false;
            const activity = payloadActivityState(delivery.payload);
            if (!activity) return false;
            return Boolean(
              pushToStartTokenChanged && delivery.purpose === "checkpoint-show" && activity.sequence === 1,
            );
          });
        if (retryable.length) {
          await db().update(deliveries)
            .set({ status: "failed", availableAt: now(), reason: "Push token updated; delivery ready to retry" })
            .where(inArray(deliveries.id, retryable.map((delivery) => delivery.id)))
            .run();
        }
      }
    },

    async inspectDeviceCiphertexts(deviceId: string) {
      const row = await db().select().from(devices).where(eq(devices.id, deviceId)).get();
      if (!row) throw new NotFoundError("Device not found");
      return row;
    },

    async pushTarget() {
      const row = await db().select().from(devices).orderBy(desc(devices.updatedAt)).get();
      if (!row || !row.apnsTokenCiphertext || !row.environment) return null;
      return {
        deviceId: row.id,
        apnsToken: options.secretBox.open(row.apnsTokenCiphertext, `device:${row.id}:apns`),
        pushToStartToken: row.pushToStartTokenCiphertext
          ? options.secretBox.open(row.pushToStartTokenCiphertext, `device:${row.id}:push-to-start`)
          : null,
        liveActivityInteractionsVersion: row.liveActivityInteractionsVersion,
        environment: row.environment as "sandbox" | "production",
      };
    },

    async registerActivityPushToken(
      deviceId: string,
      activityId: string,
      token: string,
      environment: "sandbox" | "production",
    ) {
      const device = await db().select().from(devices).where(eq(devices.id, deviceId)).get();
      if (!device) throw new NotFoundError("Device not found");
      const activity = await db().select().from(activities).where(eq(activities.id, activityId)).get();
      if (!activity) throw new NotFoundError("Activity not found");
      const values: typeof activityPushTokens.$inferInsert = {
        deviceId,
        activityId,
        tokenCiphertext: options.secretBox.seal(token, `device:${deviceId}:activity`),
        environment,
        updatedAt: now(),
      };
      await db().insert(activityPushTokens)
        .values(values)
        .onConflictDoUpdate({
          target: [activityPushTokens.deviceId, activityPushTokens.activityId],
          set: {
            tokenCiphertext: values.tokenCiphertext,
            environment,
            updatedAt: values.updatedAt,
          },
        })
        .run();
      const retryable = (await db()
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.status, "blocked"), inArray(deliveries.resourceType, ["activity", "checkpoint"])))
        .all())
        .filter((delivery) => {
          if (!delivery.payload) return false;
          return payloadActivityState(delivery.payload)?.id === activityId;
        });
      if (retryable.length) {
        await db().update(deliveries)
          .set({ status: "failed", availableAt: now(), reason: "Push token updated; delivery ready to retry" })
          .where(inArray(deliveries.id, retryable.map((delivery) => delivery.id)))
          .run();
      }
    },

    async removeActivityPushToken(deviceId: string, activityId: string) {
      await db().delete(activityPushTokens)
        .where(and(eq(activityPushTokens.deviceId, deviceId), eq(activityPushTokens.activityId, activityId)))
        .run();
    },

    async activityPushTarget(activityId: string) {
      const row = await db()
        .select()
        .from(activityPushTokens)
        .where(eq(activityPushTokens.activityId, activityId))
        .orderBy(desc(activityPushTokens.updatedAt))
        .get();
      if (!row) return null;
      return {
        deviceId: row.deviceId,
        activityId: row.activityId,
        activityPushToken: options.secretBox.open(row.tokenCiphertext, `device:${row.deviceId}:activity`),
        environment: row.environment as "sandbox" | "production",
      };
    },

    async createNotification(input: NotificationCreate, idempotencyKey: string, originHostId: string | null = null) {
      return await transaction(async () => {
        const hash = requestHash(input);
        const existing = await db()
          .select()
          .from(notifications)
          .where(eq(notifications.idempotencyKey, idempotencyKey))
          .get();
        if (existing) {
          if (existing.requestHash !== hash) throw new ConflictError("Idempotency key payload mismatch");
          return {
            notification: await publicNotification(existing),
            delivery: await ensureDeliveryIntent("notification", existing.id, "alert", idempotencyKey),
            idempotent: true,
          };
        }
        const row: typeof notifications.$inferInsert = {
          id: id("ntf"),
          title: input.title,
          body: input.body,
          url: input.url ?? null,
          status: "pending",
          idempotencyKey,
          requestHash: hash,
          originHostId,
          createdAt: now(),
        };
        await db().insert(notifications).values(row).run();
        return {
          notification: await publicNotification((await db().select().from(notifications).where(eq(notifications.id, row.id)).get())!),
          delivery: await ensureDeliveryIntent("notification", row.id, "alert", idempotencyKey),
          idempotent: false,
        };
      });
    },

    async createInteraction(input: InteractionCreate, idempotencyKey: string, originHostId: string | null = null) {
      return await transaction(async () => {
        const hash = requestHash(input);
        const existing = await db()
          .select()
          .from(interactions)
          .where(eq(interactions.idempotencyKey, idempotencyKey))
          .get();
        if (existing) {
          if (existing.requestHash !== hash) throw new ConflictError("Idempotency key payload mismatch");
          const current = await expireInteraction(existing);
          return {
            interaction: await publicInteraction(current),
            responseCredential: options.secretBox.open(
              existing.responseTokenCiphertext,
              `interaction:${existing.id}:response`,
            ),
            delivery: await ensureDeliveryIntent("interaction", existing.id, "alert", idempotencyKey),
            activityDelivery: (await deliveryIntentsForKey("checkpoint", idempotencyKey))[0] ?? null,
            idempotent: true,
          };
        }
        const capability = (await db()
          .select({ version: devices.liveActivityInteractionsVersion })
          .from(devices)
          .orderBy(desc(devices.updatedAt))
          .get())?.version;
        if (input.liveActivity === "required" && capability !== 1) {
          throw new ConflictError(
            "Interactive Live Activities are unsupported by the paired device",
            "live_activity_interactions_unsupported",
          );
        }
        const activeRows = await db().select().from(activities).where(eq(activities.state, "active")).all();
        let active = input.activity
          ? activeRows.find((activity) => activity.id === input.activity || activity.key === input.activity)
          : activeRows.length === 1
            ? activeRows[0]
            : undefined;
        if (input.activity && !active) throw new NotFoundError("Target activity not found");
        const occupied = active ? await unresolvedCheckpointForActivity(active.id) : undefined;
        const shouldCheckpoint =
          input.liveActivity !== "disabled" &&
          capability === 1 &&
          (Boolean(active && !occupied) ||
            input.liveActivity === "required" ||
            activeRows.length > 1 ||
            Boolean(input.activity && occupied));
        if (occupied) active = undefined;
        const currentTime = now();
        const interactionId = id("int");
        const responseToken = options.tokenAuthority.issue("response");
        const row: typeof interactions.$inferInsert = {
          id: interactionId,
          title: input.title,
          prompt: input.prompt,
          kind: input.kind,
          status: "pending",
          responseTokenDigest: responseToken.digest,
          responseTokenCiphertext: options.secretBox.seal(
            responseToken.plaintext,
            `interaction:${interactionId}:response`,
          ),
          idempotencyKey,
          requestHash: hash,
          originHostId,
          expiresAt: new Date(currentTime.getTime() + input.expiresInSeconds * 1_000),
          createdAt: currentTime,
        };
        await db().insert(interactions).values(row).run();
        const createdInteraction = (await db().select().from(interactions).where(eq(interactions.id, interactionId)).get())!;
        let activityDelivery = null;
        if (shouldCheckpoint) {
          let activity = active;
          let presentation: "checkpoint" | "temporary" = "checkpoint";
          if (!activity) {
            presentation = "temporary";
            activity = {
              id: id("act"),
              key: null,
              title: input.title,
              status: input.prompt,
              detail: null,
              progress: 0,
              symbol: "warning",
              accentColor: "#5ED8B7",
              state: "active",
              sequence: 1,
              pushTimestamp: Math.floor(currentTime.getTime() / 1_000),
              staleAt: row.expiresAt,
              createdAt: currentTime,
              updatedAt: currentTime,
              endedAt: null,
              endReason: null,
            } satisfies ActivityRow;
            await db().insert(activities).values(activity).run();
          } else {
            await db().update(activities)
              .set({ sequence: activity.sequence + 1, pushTimestamp: nextPushTimestamp(activity, currentTime), updatedAt: currentTime })
              .where(and(eq(activities.id, activity.id), eq(activities.state, "active")))
              .run();
            activity = (await db().select().from(activities).where(eq(activities.id, activity.id)).get())!;
          }
          await db().insert(activityCheckpoints)
            .values({
              interactionId,
              activityId: activity.id,
              presentation,
              state: "pending",
              createdAt: currentTime,
            })
            .run();
          activityDelivery = await ensureDeliveryIntent(
            "checkpoint",
            interactionId,
            "checkpoint-show",
            idempotencyKey,
            checkpointPayload(createdInteraction, activity, "checkpoint"),
          );
        }
        return {
          interaction: await publicInteraction(createdInteraction),
          responseCredential: responseToken.plaintext,
          delivery: await ensureDeliveryIntent("interaction", interactionId, "alert", idempotencyKey),
          activityDelivery,
          idempotent: false,
        };
      });
    },

    async getInteraction(interactionId: string) {
      const row = await db().select().from(interactions).where(eq(interactions.id, interactionId)).get();
      if (!row) throw new NotFoundError("Interaction not found");
      return await publicInteraction(await expireInteraction(row));
    },

    async listInbox(limit = 50) {
      const rows = await db().select().from(interactions).orderBy(desc(interactions.createdAt)).limit(limit).all();
      const result: PublicInteraction[] = [];
      for (const row of rows) result.push(await publicInteraction(await expireInteraction(row)));
      return result;
    },

    async listRecentNotifications(limit = 50): Promise<PublicNotification[]> {
      const rows = await db().select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit).all();
      return Promise.all(rows.map(publicNotification));
    },

    async cancelInteraction(interactionId: string) {
      return transaction(async () => {
        const current = await this.getInteraction(interactionId);
        if (current.status !== "pending") throw new ConflictError("Interaction is already terminal");
        await db().update(interactions)
          .set({ status: "canceled", respondedAt: now() })
          .where(and(eq(interactions.id, interactionId), eq(interactions.status, "pending")))
          .run();
        const canceled = (await db().select().from(interactions).where(eq(interactions.id, interactionId)).get())!;
        return {
          interaction: await publicInteraction(canceled),
          activityDelivery: await acknowledgeCheckpoint(canceled, "canceled"),
        };
      });
    },

    async cancelInteractionIdempotent(interactionId: string, idempotencyKey: string) {
      const operation = "interaction:cancel";
      const payload = { interactionId };
      return await transaction(async () => {
        const replay = await this.findMutation(operation, idempotencyKey, payload);
        if (replay) {
          return {
            interaction: await this.getInteraction(replay.resourceId),
            activityDelivery: (await deliveryIntentsForKey("checkpoint", `checkpoint:${replay.resourceId}:checkpoint-restore`))[0]
              ?? (await deliveryIntentsForKey("checkpoint", `checkpoint:${replay.resourceId}:checkpoint-end`))[0]
              ?? null,
            idempotent: true,
          };
        }
        const result = await this.cancelInteraction(interactionId);
        await this.recordMutation(operation, idempotencyKey, payload, result.interaction.id);
        return { ...result, idempotent: false };
      });
    },

    async respondToInteraction(interactionId: string, credential: string, response: InteractionResponse) {
      return (await applyInteractionResponse(interactionId, response, credential)).interaction;
    },

    async respondToInteractionWithDelivery(interactionId: string, credential: string, response: InteractionResponse) {
      return await applyInteractionResponse(interactionId, response, credential);
    },

    async respondToInteractionAsDevice(interactionId: string, response: InteractionResponse) {
      return (await applyInteractionResponse(interactionId, response)).interaction;
    },

    async respondToInteractionAsDeviceWithDelivery(interactionId: string, response: InteractionResponse) {
      return await applyInteractionResponse(interactionId, response);
    },

    finishAcknowledgedCheckpoint,

    async reconcileExpiredCheckpoints() {
      return transaction(async () => {
        const before = new Set(
          (await db().select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.resourceType, "checkpoint")).all()).map((row) => row.id),
        );
        const unresolved = await db()
          .select()
          .from(activityCheckpoints)
          .where(ne(activityCheckpoints.state, "finished"))
          .all();
        for (const checkpoint of unresolved) {
          const interaction = await db().select().from(interactions).where(eq(interactions.id, checkpoint.interactionId)).get();
          if (!interaction) continue;
          const current = interaction.status === "pending" && interaction.expiresAt <= now()
            ? await expireInteraction(interaction)
            : interaction;
          const result = terminalCheckpointResult(current);
          if (!result) continue;
          if (checkpoint.state === "pending") {
            await acknowledgeCheckpoint(current, result);
            continue;
          }
          const acknowledgement = await db()
            .select()
            .from(deliveries)
            .where(
              and(
                eq(deliveries.resourceType, "checkpoint"),
                eq(deliveries.resourceId, current.id),
                eq(deliveries.purpose, "checkpoint-ack"),
              ),
            )
            .get();
          if (acknowledgement?.status === "accepted" || acknowledgement?.status === "superseded") {
            await finishAcknowledgedCheckpoint(current.id);
          } else if (!acknowledgement) {
            const activity = await db().select().from(activities).where(eq(activities.id, checkpoint.activityId)).get();
            if (activity?.state === "active") {
              await ensureDeliveryIntent(
                "checkpoint",
                current.id,
                "checkpoint-ack",
                `checkpoint:${current.id}:checkpoint-ack`,
                checkpointPayload(current, activity, "acknowledged", result),
              );
            } else {
              await db().update(activityCheckpoints)
                .set({ state: "finished", resolvedAt: now() })
                .where(eq(activityCheckpoints.interactionId, current.id))
                .run();
            }
          }
        }
        return (await db()
          .select()
          .from(deliveries)
          .where(eq(deliveries.resourceType, "checkpoint"))
          .all())
          .filter((delivery) => !before.has(delivery.id));
      });
    },

    async pendingCheckpointDeliveries() {
      return await db()
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.resourceType, "checkpoint"),
            inArray(deliveries.status, ["pending", "failed", "sending"]),
            or(isNull(deliveries.availableAt), lte(deliveries.availableAt, now())),
          ),
        )
        .orderBy(deliveries.createdAt)
        .all();
    },

    async startActivity(input: ActivityCreate) {
      return await transaction(async (tx) => {
        const currentTime = now();
        if (input.replace && !input.key) throw new ConflictError("Replacing an activity requires a key");
        const active = input.key
          ? await tx.select().from(activities).where(and(eq(activities.key, input.key), eq(activities.state, "active"))).get()
          : undefined;
        if (active && !input.replace) throw new ConflictError("Activity key is already in use");
        if (active) {
          await finishPresentationForActivity(active.id);
          await tx.update(activities)
            .set({
              state: "ended",
              endReason: "replaced",
              endedAt: currentTime,
              updatedAt: currentTime,
              sequence: active.sequence + 1,
              pushTimestamp: nextPushTimestamp(active, currentTime),
            })
            .where(and(eq(activities.id, active.id), eq(activities.state, "active")))
            .run();
        }
        const row: typeof activities.$inferInsert = {
          id: id("act"),
          key: input.key ?? null,
          title: input.title,
          status: input.status,
          detail: input.detail ?? null,
          progress: input.progress,
          symbol: input.symbol,
          accentColor: input.accentColor,
          state: "active",
          sequence: 1,
          pushTimestamp: Math.floor(currentTime.getTime() / 1_000),
          staleAt: new Date(currentTime.getTime() + input.staleAfterSeconds * 1_000),
          createdAt: currentTime,
          updatedAt: currentTime,
        };
        try {
          await tx.insert(activities).values(row).run();
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE")) {
            throw new ConflictError("Activity key is already in use");
          }
          throw error;
        }
        return toActivity((await tx.select().from(activities).where(eq(activities.id, row.id)).get())!);
      });
    },

    async startActivityIdempotent(input: ActivityCreate, idempotencyKey: string) {
      return await transaction(async () => {
        const replay = await this.findMutation("activity:start", idempotencyKey, input);
        if (replay) {
          const activity = await this.getActivity(replay.resourceId);
          const existingDeliveries = await deliveryIntentsForKey("activity", idempotencyKey);
          const replacedDelivery = existingDeliveries.find((delivery) => delivery.purpose === "replace-end");
          return {
            activity,
            replaced: replacedDelivery ? await this.getActivity(replacedDelivery.resourceId) : null,
            deliveries: existingDeliveries.length
              ? existingDeliveries
              : [(await ensureDeliveryIntent("activity", activity.id, "start", idempotencyKey, activity))],
            idempotent: true,
          };
        }
        const replaced = input.replace && input.key ? await this.activeActivity(input.key) : null;
        const activity = await this.startActivity(input);
        await this.recordMutation("activity:start", idempotencyKey, input, activity.id);
        const deliveryIntents = [];
        if (replaced) {
          deliveryIntents.push(
            await ensureDeliveryIntent("activity", replaced.id, "replace-end", idempotencyKey, await this.getActivity(replaced.id)),
          );
        }
        deliveryIntents.push(await ensureDeliveryIntent("activity", activity.id, "start", idempotencyKey, activity));
        return { activity, replaced, deliveries: deliveryIntents, idempotent: false };
      });
    },

    async getActivity(identifier: string) {
      const row =
        await db().select().from(activities).where(eq(activities.id, identifier)).get() ??
        await db()
            .select()
            .from(activities)
            .where(and(eq(activities.key, identifier), eq(activities.state, "active")))
            .get() ??
        await db().select().from(activities).where(eq(activities.key, identifier)).orderBy(desc(activities.updatedAt)).get();
      if (!row) throw new NotFoundError("Activity not found");
      return toActivity(row);
    },

    async activeActivity(identifier?: string) {
      const row = identifier
        ? await db().select().from(activities).where(
            and(
              eq(activities.state, "active"),
              or(eq(activities.id, identifier), eq(activities.key, identifier)),
            ),
          ).get()
        : await db().select().from(activities).where(eq(activities.state, "active")).orderBy(desc(activities.updatedAt)).get();
      return row ? toActivity(row) : null;
    },

    async activeActivities() {
      return (await db()
        .select()
        .from(activities)
        .where(eq(activities.state, "active"))
        .orderBy(desc(activities.updatedAt))
        .all())
        .map(toActivity);
    },

    async deviceActivities(deviceId: string) {
      const registered = new Set(
        (await db()
          .select({ activityId: activityPushTokens.activityId })
          .from(activityPushTokens)
          .where(eq(activityPushTokens.deviceId, deviceId))
          .all())
          .map((row) => row.activityId),
      );
      const unresolvedEnds = new Set(
        (await db()
          .select({ activityId: deliveries.resourceId })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.resourceType, "activity"),
              inArray(deliveries.purpose, ["device-end", "end", "replace-end"]),
              inArray(deliveries.status, ["pending", "failed", "sending"]),
            ),
          )
          .all())
          .map((row) => row.activityId),
      );
      return (await db()
        .select()
        .from(activities)
        .orderBy(desc(activities.updatedAt))
        .all())
        .filter(
          (activity) =>
            activity.state === "active" ||
            (registered.has(activity.id) && unresolvedEnds.has(activity.id)),
        )
        .map(toActivity);
    },

    async updateActivity(identifier: string, input: ActivityUpdate) {
      return transaction(async () => {
        const current = await this.getActivity(identifier);
        if (current.state !== "active") throw new ConflictError("Activity has ended");
        const requestedSequence = input.sequence ?? current.sequence + 1;
        if (requestedSequence <= current.sequence) throw new ConflictError("Activity sequence is stale");
        const currentTime = now();
        const values: Partial<typeof activities.$inferInsert> = {
          sequence: requestedSequence,
          pushTimestamp: nextPushTimestamp(current),
          updatedAt: currentTime,
        };
        if (input.status !== undefined) values.status = input.status;
        if (input.detail !== undefined) values.detail = input.detail;
        if (input.progress !== undefined) values.progress = input.progress;
        if (input.symbol !== undefined) values.symbol = input.symbol;
        if (input.accentColor !== undefined) values.accentColor = input.accentColor;
        if (input.staleAfterSeconds !== undefined) {
          values.staleAt = new Date(currentTime.getTime() + input.staleAfterSeconds * 1_000);
        }
        const changed = await db()
          .update(activities)
          .set(values)
          .where(
            and(
              eq(activities.id, current.id),
              eq(activities.state, "active"),
              lt(activities.sequence, requestedSequence),
            ),
          )
          .run();
        if (changed.rowsAffected !== 1) throw new ConflictError("Activity sequence is stale");
        return await this.getActivity(current.id);
      });
    },

    async updateActivityIdempotent(identifier: string, input: ActivityUpdate, idempotencyKey: string) {
      const operation = `activity:update:${identifier}`;
      return await transaction(async () => {
        const replay = await this.findMutation(operation, idempotencyKey, input);
        const activity = replay
          ? await this.getActivity(replay.resourceId)
          : await this.updateActivity(identifier, input);
        if (!replay) await this.recordMutation(operation, idempotencyKey, input, activity.id);
        return {
          activity,
          delivery: await ensureDeliveryIntent(
            "activity",
            activity.id,
            "update",
            idempotencyKey,
            await desiredActivityPayload((await db().select().from(activities).where(eq(activities.id, activity.id)).get())!),
          ),
          idempotent: Boolean(replay),
        };
      });
    },

    async endActivity(identifier: string, input: ActivityEnd = {}, reason = "agent_ended") {
      return transaction(async () => {
        const current = await this.getActivity(identifier);
        if (current.state !== "active") throw new ConflictError("Activity has ended");
        const requestedSequence = input.sequence ?? current.sequence + 1;
        if (requestedSequence <= current.sequence) throw new ConflictError("Activity sequence is stale");
        const values: Partial<typeof activities.$inferInsert> = {
          state: "ended",
          sequence: requestedSequence,
          pushTimestamp: nextPushTimestamp(current),
          updatedAt: now(),
          endedAt: now(),
          endReason: reason,
        };
        await finishPresentationForActivity(current.id);
        if (input.status !== undefined) values.status = input.status;
        if (input.detail !== undefined) values.detail = input.detail;
        if (input.progress !== undefined) values.progress = input.progress;
        await db().update(activities)
          .set(values)
          .where(and(eq(activities.id, current.id), eq(activities.state, "active")))
          .run();
        return await this.getActivity(current.id);
      });
    },

    async dismissActivity(deviceId: string, identifier: string) {
      const current = await this.getActivity(identifier);
      if (current.state === "active") await this.endActivity(current.id, {}, "dismissed");
      await this.removeActivityPushToken(deviceId, current.id);
      return await this.getActivity(current.id);
    },

    async endActivityForDevice(identifier: string, idempotencyKey: string) {
      return await transaction(async () => {
        const current = await this.getActivity(identifier);
        const activity = current.state === "active"
          ? await this.endActivity(current.id, {}, "user_ended")
          : current;
        return {
          activity,
          delivery: await ensureDeliveryIntent(
            "activity",
            activity.id,
            "device-end",
            idempotencyKey,
            activity,
          ),
        };
      });
    },

    async endActivityIdempotent(
      identifier: string,
      input: ActivityEnd,
      idempotencyKey: string,
      reason = "agent_ended",
    ) {
      const operation = `activity:end:${identifier}`;
      return await transaction(async () => {
        const replay = await this.findMutation(operation, idempotencyKey, input);
        const activity = replay
          ? await this.getActivity(replay.resourceId)
          : await this.endActivity(identifier, input, reason);
        if (!replay) await this.recordMutation(operation, idempotencyKey, input, activity.id);
        return {
          activity,
          delivery: await ensureDeliveryIntent("activity", activity.id, "end", idempotencyKey, activity),
          idempotent: Boolean(replay),
        };
      });
    },
  };
  // ponytail: serialize this client's operations; use separate clients if throughput requires it.
  let pending: Promise<unknown> = Promise.resolve();
  for (const [name, method] of Object.entries(store)) {
    if (name === "close") continue;
    Object.assign(store, {
      [name]: (...args: unknown[]) => {
        const run = () => Reflect.apply(method, store, args);
        if (transactions.getStore()) return run();
        const result = pending.then(() => transactions.run({}, run));
        pending = result.catch(() => undefined);
        return result;
      },
    });
  }
  return store;
}

export type RelayStore = Awaited<ReturnType<typeof openRelayStore>>;
