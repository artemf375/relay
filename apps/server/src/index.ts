import { serve } from "@hono/node-server";
import { createRuntime } from "./runtime.js";

const { app, store, environment, reconcileCheckpoints } = await createRuntime(process.env);
const maintenance = () => reconcileCheckpoints().catch(() => {
  console.error(JSON.stringify({ level: "error", message: "Checkpoint maintenance failed" }));
});
void maintenance();
const checkpointTimer = setInterval(() => void maintenance(), 30_000);
checkpointTimer.unref();
const retentionTimer = setInterval(() => {
  void store.pruneRetention().catch(() => {
    console.error(JSON.stringify({ level: "error", message: "Retention maintenance failed" }));
  });
}, 24 * 60 * 60 * 1_000);
retentionTimer.unref();
const server = serve({ fetch: app.fetch, port: environment.PORT }, (info) => {
  console.log(JSON.stringify({ level: "info", message: "Relay listening", port: info.port }));
});

const shutdown = () => {
  clearInterval(retentionTimer);
  clearInterval(checkpointTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
