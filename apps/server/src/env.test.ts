import { expect, test } from "vitest";
import { parseEnvironment } from "./env.js";

test("requires production secrets and normalizes the APNs key", () => {
  expect(() => parseEnvironment({})).toThrow();
  const parsed = parseEnvironment({
    RELAY_DATABASE_URL: "/data/relay.sqlite",
    RELAY_TOKEN_HASH_KEY: Buffer.alloc(32, 1).toString("base64"),
    RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    RELAY_CLI_TOKEN: "relay_cli_bootstrap-token-with-entropy",
    APNS_KEY_ID: "KEY123",
    APPLE_TEAM_ID: "TEAM123",
    APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    APNS_BUNDLE_ID: "com.example.relay",
    APNS_ENVIRONMENT: "production",
  });
  expect(parsed.APNS_PRIVATE_KEY).toContain("\nabc\n");
  expect(parsed.PORT).toBe(8787);
});

test("cloud deployments reject local storage, missing database credentials and implicit bundle IDs", () => {
  const input = {
    RELAY_REQUIRE_REMOTE_DATABASE: "true",
    RELAY_DATABASE_URL: "libsql://relay.example.com",
    RELAY_DATABASE_AUTH_TOKEN: "test-database-token",
    RELAY_TOKEN_HASH_KEY: Buffer.alloc(32, 1).toString("base64"),
    RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    RELAY_CLI_TOKEN: "relay_cli_bootstrap-token-with-entropy",
    APNS_KEY_ID: "KEY123",
    APPLE_TEAM_ID: "TEAM123",
    APNS_PRIVATE_KEY: "test-key",
    APNS_BUNDLE_ID: "com.example.relay",
  };
  expect(parseEnvironment(input).RELAY_DATABASE_URL).toBe(input.RELAY_DATABASE_URL);
  expect(() => parseEnvironment({ ...input, RELAY_DATABASE_URL: "/tmp/relay.sqlite" })).toThrow();
  expect(() => parseEnvironment({ ...input, RELAY_DATABASE_AUTH_TOKEN: undefined })).toThrow();
  expect(() => parseEnvironment({ ...input, APNS_BUNDLE_ID: undefined })).toThrow();
  expect(() => parseEnvironment({ ...input, APNS_PRIVATE_KEY: undefined, APNS_PRIVATE_KEY_FILE: "/tmp/key.p8" })).toThrow();
});
