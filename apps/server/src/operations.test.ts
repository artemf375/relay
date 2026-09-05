import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, test } from "vitest";
import { createConsistentSnapshot, integrityCheck } from "./operations.js";
import { SecretBox, TokenAuthority } from "./security.js";
import { openRelayStore } from "./store.js";

test("creates a consistent SQLite snapshot for restic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-backup-"));
  const source = join(directory, "relay.sqlite");
  const destination = join(directory, "snapshot.sqlite");
  const store = await openRelayStore({
    filename: source,
    tokenAuthority: new TokenAuthority(Buffer.alloc(32, 4)),
    secretBox: SecretBox.fromBase64(Buffer.alloc(32, 8).toString("base64")),
  });
  await store.installCliCredential("relay_cli_test-secret");

  await createConsistentSnapshot(source, destination);
  expect(integrityCheck(destination)).toBe("ok");
  const snapshot = new BetterSqlite3(destination, { readonly: true });
  expect(snapshot.prepare("SELECT COUNT(*) AS count FROM credentials").get()).toEqual({ count: 1 });
  snapshot.close();
  store.close();
});
