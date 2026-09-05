import { afterEach, expect, test, vi } from "vitest";
import { app } from "./vercel.js";

afterEach(() => vi.unstubAllEnvs());

test("maintenance rejects missing or wrong credentials before opening storage", async () => {
  vi.stubEnv("CRON_SECRET", "test-maintenance-secret");
  expect((await app.request("/api/maintenance")).status).toBe(401);
  expect((await app.request("/api/maintenance", {
    headers: { authorization: "Bearer wrong-maintenance-secret" },
  })).status).toBe(401);
});

test("Vercel fails closed with temporary storage and does not expose configuration", async () => {
  vi.stubEnv("RELAY_DATABASE_URL", "/tmp/relay.sqlite");
  const response = await app.request("/readyz");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Server configuration or storage unavailable" });
});
