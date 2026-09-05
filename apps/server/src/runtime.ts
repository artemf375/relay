import { mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ApnsPushProvider } from "./apns.js";
import { createRelayApp } from "./app.js";
import { CheckpointDeliveryService } from "./checkpoints.js";
import { parseEnvironment } from "./env.js";
import { SecretBox, TokenAuthority } from "./security.js";
import { openRelayStore } from "./store.js";

export async function createRuntime(input: Record<string, string | undefined>, serverless = false) {
  const environment = parseEnvironment(input);
  const remoteDatabase = /^(libsql|https):\/\//.test(environment.RELAY_DATABASE_URL);
  if (!remoteDatabase && environment.RELAY_DATABASE_URL !== ":memory:") {
    mkdirSync(dirname(environment.RELAY_DATABASE_URL), { recursive: true });
  }

  const store = await openRelayStore({
    ...(remoteDatabase ? { url: environment.RELAY_DATABASE_URL } : { filename: environment.RELAY_DATABASE_URL }),
    ...(environment.RELAY_DATABASE_AUTH_TOKEN ? { authToken: environment.RELAY_DATABASE_AUTH_TOKEN } : {}),
    tokenAuthority: new TokenAuthority(Buffer.from(environment.RELAY_TOKEN_HASH_KEY, "base64")),
    secretBox: SecretBox.fromBase64(environment.RELAY_ENCRYPTION_KEY),
  });
  await store.installCliCredential(environment.RELAY_CLI_TOKEN, environment.RELAY_CLI_HOST_NAME);
  await store.pruneRetention();
  const pushProvider = new ApnsPushProvider({
    keyId: environment.APNS_KEY_ID,
    teamId: environment.APPLE_TEAM_ID,
    privateKey:
      environment.APNS_PRIVATE_KEY ??
      readFileSync(environment.APNS_PRIVATE_KEY_FILE!, "utf8"),
    bundleId: environment.APNS_BUNDLE_ID,
    environment: environment.APNS_ENVIRONMENT,
  });
  const checkpointDeliveryService = new CheckpointDeliveryService(store, pushProvider, serverless ? async (task, delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await task();
    } : undefined);
  let checkpointReconciliationRunning = false;
  const reconcileCheckpoints = async () => {
    if (checkpointReconciliationRunning) return;
    checkpointReconciliationRunning = true;
    try {
      await store.reconcileExpiredCheckpoints();
      await checkpointDeliveryService.flush();
    } finally {
      checkpointReconciliationRunning = false;
    }
  };
  const app = createRelayApp({
    store,
    pushProvider,
    getBackupStatus: async () => {
      if (remoteDatabase) return { ok: false, reason: "Manage backups with your database provider" };
      try {
        const parsed = JSON.parse(await readFile(environment.RELAY_BACKUP_STATUS_FILE, "utf8")) as {
          ok?: unknown;
          completedAt?: unknown;
        };
        return {
          ok: parsed.ok === true,
          ...(typeof parsed.completedAt === "string" ? { completedAt: parsed.completedAt } : {}),
        };
      } catch {
        return { ok: false, reason: "No backup has completed" };
      }
    },
    allowedUrlHosts: new Set(
      environment.RELAY_ALLOWED_URL_HOSTS.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
    apnsEnvironment: environment.APNS_ENVIRONMENT,
    checkpointDeliveryService,
  });
  return { app, store, environment, reconcileCheckpoints };
}
