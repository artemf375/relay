import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("JSON mode keeps local usage and configuration failures machine-readable", () => {
  const launcherPath = resolve(import.meta.dirname, "../bin/relayctl.mjs");
  for (const [args, code] of [
    [["configure", "--json"], "usage"],
    [["doctor", "--json"], "local"],
  ] as const) {
    const result = spawnSync(process.execPath, [launcherPath, ...args], {
      env: { ...process.env, RELAY_CONFIG: "/dev/null/missing-relay-config" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: expect.any(String), code, retryable: false, status: null });
  }
});

test("the installed launcher retries a transient DNS failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayctl-bin-"));
  const configPath = join(directory, "config.json");
  const bootstrapPath = join(directory, "fetch-bootstrap.mjs");
  await writeFile(
    configPath,
    `${JSON.stringify({ url: "https://relay.example.com", token: "relay_cli_test" })}\n`,
  );
  await chmod(configPath, 0o600);
  await writeFile(
    bootstrapPath,
    `let attempts = 0;
globalThis.fetch = async () => {
  attempts += 1;
  if (attempts < 3) {
    const cause = Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    throw new TypeError("fetch failed", { cause });
  }
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
  );

  const launcherPath = resolve(import.meta.dirname, "../bin/relayctl.mjs");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult) => {
    const child = spawn(process.execPath, ["--import", bootstrapPath, launcherPath, "doctor", "--json"], {
      env: { ...process.env, RELAY_CONFIG: configPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });

  expect(result).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ status: "ok", health: "ok", authenticated: true })}\n`,
    stderr: "",
  });
});
