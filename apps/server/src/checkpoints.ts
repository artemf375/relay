import { isPermanentActivityTokenFailure, type ActivityPushContent, type PushProvider, type PushResult } from "./apns.js";
import type { RelayStore } from "./store.js";

type CheckpointDelivery = Awaited<ReturnType<RelayStore["pendingCheckpointDeliveries"]>>[number];

export interface CheckpointFlushResult extends PushResult {
  deliveryId: string;
}

type AcknowledgementScheduler = (
  task: () => Promise<void>,
  delayMilliseconds: number,
) => void | Promise<void>;

const scheduleAcknowledgement: AcknowledgementScheduler = (task, delayMilliseconds) => {
  const timer = setTimeout(() => void task(), delayMilliseconds);
  timer.unref();
};

function parsePayload(delivery: CheckpointDelivery): ActivityPushContent {
  if (!delivery.payload) throw new Error("Checkpoint delivery payload is missing");
  return JSON.parse(delivery.payload) as ActivityPushContent;
}

export class CheckpointDeliveryService {
  private readonly retryState = new Map<string, { attempts: number; retryAt: number }>();
  private readonly inFlight = new Map<string, Promise<CheckpointFlushResult>>();

  public constructor(
    private readonly store: RelayStore,
    private readonly pushProvider: PushProvider,
    private readonly schedule: AcknowledgementScheduler = scheduleAcknowledgement,
  ) {}

  public async flush(deliveries?: CheckpointDelivery[]): Promise<CheckpointFlushResult[]> {
    const scheduled = deliveries === undefined;
    const candidates = deliveries ?? (await this.store.pendingCheckpointDeliveries());
    const results: CheckpointFlushResult[] = [];
    for (const delivery of candidates) {
      const retry = this.retryState.get(delivery.id);
      if (scheduled && retry && retry.retryAt > Date.now()) continue;
      let operation = this.inFlight.get(delivery.id);
      if (!operation) {
        operation = this.flushOne(delivery);
        this.inFlight.set(delivery.id, operation);
        const remove = () => {
          if (this.inFlight.get(delivery.id) === operation) this.inFlight.delete(delivery.id);
        };
        void operation.then(remove, remove);
      }
      const result = await operation;
      results.push(result);
      if (result.accepted) {
        this.retryState.delete(delivery.id);
      } else if ((await this.store.deliveryById(delivery.id)).status === "blocked") {
        this.retryState.delete(delivery.id);
      } else {
        const attempts = (retry?.attempts ?? 0) + 1;
        const delay = Math.min(300_000, 5_000 * 2 ** Math.min(attempts - 1, 6));
        this.retryState.set(delivery.id, { attempts, retryAt: Date.now() + delay });
      }
    }
    return results;
  }

  public async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  private async flushOne(delivery: CheckpointDelivery): Promise<CheckpointFlushResult> {
    const current = await this.store.deliveryById(delivery.id);
    if (current.status === "accepted") {
      return {
        deliveryId: current.id,
        accepted: true,
        status: 200,
        apnsId: current.apnsId,
        reason: current.reason,
      };
    }
    if (!(await this.store.claimDelivery(delivery.id))) {
      return {
        deliveryId: current.id,
        accepted: false,
        status: 0,
        apnsId: current.apnsId,
        reason: "Delivery is already in progress",
      };
    }

    let result: PushResult;
    try {
      const payload = parsePayload(delivery);
      const activity = "activity" in payload ? payload.activity : payload;
      const event = delivery.purpose === "checkpoint-end"
        ? "end"
        : delivery.purpose === "checkpoint-show" && activity.sequence === 1
          ? "start"
          : "update";
      const priority: 5 | 10 = event === "update" && delivery.purpose === "checkpoint-restore" ? 5 : 10;
      const token = event === "start"
        ? (await this.store.pushTarget())?.pushToStartToken
        : (await this.store.activityPushTarget(activity.id))?.activityPushToken ?? null;
      if (!token) {
        result = {
          accepted: false,
          status: 0,
          apnsId: null,
          reason: event === "start"
            ? "No Live Activity push-to-start token registered"
            : "No matching Live Activity update token registered",
        };
      } else {
        result = await this.pushProvider.sendActivity(token, event, payload, priority, delivery.id);
      }
    } catch (error) {
      result = {
        accepted: false,
        status: 0,
        apnsId: null,
        reason: error instanceof Error ? error.message : "Checkpoint delivery failed",
      };
    }
    const completion = await this.store.completeCheckpointDelivery(delivery.id, result, !isPermanentActivityTokenFailure(result));
    const completed = completion.delivery;
    if (completion.nextDelivery) {
      await this.schedule(async () => {
        await this.flush([completion.nextDelivery!]);
      }, 1_500);
    }
    return {
      deliveryId: completed.id,
      accepted: completed.accepted ?? false,
      status: completed.accepted ? 200 : result.status,
      apnsId: completed.apnsId,
      reason: completed.reason,
    };
  }
}
