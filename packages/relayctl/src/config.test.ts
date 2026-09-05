import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, saveConfig } from "./config.js";

test("writes and reads a mode-0600 CLI configuration atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayctl-config-"));
  const path = join(directory, "nested", "config.json");
  await saveConfig(path, { url: "https://relay.example.com", token: "relay_cli_secret-token" });

  expect(await loadConfig(path)).toEqual({
    url: "https://relay.example.com",
    token: "relay_cli_secret-token",
  });
  expect((await stat(path)).mode & 0o077).toBe(0);
});

test("rejects insecure configuration permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayctl-config-"));
  const path = join(directory, "config.json");
  await saveConfig(path, { url: "https://relay.example.com", token: "relay_cli_secret-token" });
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o644);
  await expect(loadConfig(path)).rejects.toThrow(/0600/);
});
