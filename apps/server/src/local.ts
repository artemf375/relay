import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const keys = ["RELAY_TOKEN_HASH_KEY", "RELAY_ENCRYPTION_KEY", "RELAY_CLI_TOKEN"] as const;

export function localEnvironment(input: Record<string, string | undefined>) {
  const database = input.RELAY_DATABASE_URL ?? "./data/relay.sqlite";
  if (input.RELAY_REQUIRE_REMOTE_DATABASE === "true" || /^(?:libsql|https):\/\//.test(database)
    || database === ":memory:" || keys.every((key) => input[key])) return input;

  const filename = join(dirname(database), "relay-secrets.json");
  if (!existsSync(filename)) {
    if (existsSync(database)) throw new Error("Supply the original Relay keys for the existing database; refusing to generate replacements");
    mkdirSync(dirname(database), { recursive: true });
    const generated = {
      RELAY_TOKEN_HASH_KEY: input.RELAY_TOKEN_HASH_KEY || randomBytes(32).toString("base64"),
      RELAY_ENCRYPTION_KEY: input.RELAY_ENCRYPTION_KEY || randomBytes(32).toString("base64"),
      RELAY_CLI_TOKEN: input.RELAY_CLI_TOKEN || `relay_cli_${randomBytes(32).toString("base64url")}`,
    };
    writeFileSync(filename, JSON.stringify(generated) + "\n", { mode: 0o600, flag: "wx" });
  }
  const saved = JSON.parse(readFileSync(filename, "utf8")) as Record<string, string>;
  return { ...input, ...Object.fromEntries(keys.map((key) => [key, input[key] || saved[key]])) };
}
