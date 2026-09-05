#!/usr/bin/env node

import { hostname } from "node:os";
import { execute, help, UsageError } from "../dist/cli.js";
import { defaultConfigPath, loadConfig, saveConfig } from "../dist/config.js";
import { createRelayRequester, RelayHttpError } from "../dist/http.js";

const argv = process.argv.slice(2);

async function main() {
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(help);
    return 0;
  }

  if (argv[0] === "configure") {
    const flag = (name) => {
      const index = argv.indexOf(`--${name}`);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const url = flag("url");
    const enroll = flag("enroll");
    let token = flag("token");
    if (!url) throw new UsageError("configure requires --url");
    if (!token && !enroll) throw new UsageError("configure requires --token or --enroll");
    if (token && enroll) throw new UsageError("configure accepts only one of --token or --enroll");
    if (enroll) {
      const hostName = flag("name") ?? hostname();
      const enrolled = await createRelayRequester(url.replace(/\/$/, ""))("/v1/hosts/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: enroll.trim().toUpperCase(), hostName }),
      });
      if (typeof enrolled?.token !== "string") throw new Error("Relay returned an invalid host credential");
      token = enrolled.token;
      console.log(`Linked this machine to Relay as "${enrolled.name}".`);
    }
    const path = defaultConfigPath();
    await saveConfig(path, { url, token });
    console.log(`Relay configured at ${path}`);
    return 0;
  }

  const config = await loadConfig();
  const result = await execute(argv, {
    config,
    request: createRelayRequester(config.url),
  });
  if (argv[0] === "auth" && argv[1] === "rotate") {
    const token = result.body?.token;
    if (typeof token !== "string") throw new Error("Relay returned an invalid rotated credential");
    await saveConfig(defaultConfigPath(), { ...config, token });
    if (result.json) console.log(JSON.stringify({ rotated: true }));
    else console.log("Relay CLI credential rotated and saved.");
    return result.exitCode;
  }
  console.log(JSON.stringify(result.body, null, result.json ? undefined : 2));
  return result.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (argv.includes("--json") && error instanceof RelayHttpError) {
    console.error(JSON.stringify({ error: error.message, code: error.code, retryable: error.retryable, status: error.status ?? null }));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
