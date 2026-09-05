import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { localEnvironment } from "./local.js";

test("local keys survive restart and missing keys never replace existing database keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-local-"));
  try {
    const input = { RELAY_DATABASE_URL: join(directory, "relay.sqlite") };
    const first = localEnvironment(input);
    expect(Buffer.from(first.RELAY_ENCRYPTION_KEY!, "base64")).toHaveLength(32);
    expect(first.RELAY_TOKEN_HASH_KEY).not.toBe(first.RELAY_ENCRYPTION_KEY);
    expect(first.RELAY_CLI_TOKEN).toMatch(/^relay_cli_.{43}$/);
    const secrets = join(directory, "relay-secrets.json");
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(secrets, "utf8"))).toHaveProperty("RELAY_CLI_TOKEN", first.RELAY_CLI_TOKEN);
    writeFileSync(input.RELAY_DATABASE_URL, "existing database");
    expect(localEnvironment(input)).toEqual(first);
    rmSync(secrets);
    expect(() => localEnvironment(input)).toThrow("existing database");
    expect(localEnvironment(first)).toEqual(first);
    expect(localEnvironment({ RELAY_DATABASE_URL: "libsql://example.com" })).toEqual({ RELAY_DATABASE_URL: "libsql://example.com" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
