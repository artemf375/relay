import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { handle } from "@hono/node-server/vercel";
import { createRuntime } from "./runtime.js";

let runtime: ReturnType<typeof createRuntime> | undefined;
const getRuntime = () => runtime ??= createRuntime({
  ...process.env,
  RELAY_REQUIRE_REMOTE_DATABASE: "true",
}, true).catch((error) => {
  runtime = undefined;
  throw error;
});

export const app = new Hono();
app.get("/api/maintenance", async (context) => {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(context.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return context.json({ error: "Unauthorized" }, 401);
  }
  const current = await getRuntime();
  await current.reconcileCheckpoints();
  await current.store.pruneRetention();
  return context.json({ ok: true });
});
app.all("*", async (context) => {
  const current = await getRuntime();
  // Serverless work must complete before the invocation ends.
  const response = await current.app.fetch(context.req.raw);
  return response;
});
app.onError((_error, context) => context.json({ error: "Server configuration or storage unavailable" }, 503));

export default handle(app);
