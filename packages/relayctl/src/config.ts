import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RelayctlConfig } from "./cli.js";

function validate(config: unknown): RelayctlConfig {
  if (!config || typeof config !== "object") throw new Error("Invalid Relay configuration");
  const { url, token } = config as { url?: unknown; token?: unknown };
  if (typeof url !== "string" || new URL(url).protocol !== "https:") {
    throw new Error("Relay URL must use HTTPS");
  }
  if (typeof token !== "string" || !token.startsWith("relay_cli_")) {
    throw new Error("Relay CLI token is invalid");
  }
  return { url: url.replace(/\/$/, ""), token };
}

export function defaultConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.RELAY_CONFIG) return environment.RELAY_CONFIG;
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "relay", "config.json");
}

export async function loadConfig(path = defaultConfigPath()): Promise<RelayctlConfig> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Relay is not configured. Run relayctl configure.`);
    throw error;
  });
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Refusing insecure Relay configuration at ${path}; expected mode 0600`);
  }
  return validate(JSON.parse(await readFile(path, "utf8")));
}

export async function saveConfig(path: string, config: RelayctlConfig): Promise<void> {
  const validated = validate(config);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}
