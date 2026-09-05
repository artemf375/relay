import { randomUUID } from "node:crypto";

export interface RelayctlConfig {
  url: string;
  token: string;
}

export interface RelayctlRuntime {
  config: RelayctlConfig;
  request(path: string, init: RequestInit): Promise<unknown>;
  randomId?: () => string;
  now?: () => number;
}

export interface ExecutionResult {
  body: unknown;
  exitCode: 0 | 1 | 4 | 5;
  json: boolean;
}

export class UsageError extends Error {}

interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | boolean>;
}

const valueFlags = new Set([
  "title",
  "url",
  "timeout",
  "expires-in",
  "idempotency-key",
  "key",
  "status",
  "detail",
  "progress",
  "symbol",
  "accent-color",
  "sequence",
  "stale-after",
  "activity",
  "name",
]);
const booleanFlags = new Set([
  "approval",
  "yes-no",
  "text",
  "wait",
  "replace",
  "json",
  "live-activity",
  "no-live-activity",
]);

export function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    const name = value.slice(2, separator < 0 ? undefined : separator);
    const inline = separator < 0 ? undefined : value.slice(separator + 1);
    if (valueFlags.has(name)) {
      const optionValue = inline ?? argv[++index];
      if (!optionValue || optionValue.startsWith("--")) throw new UsageError(`--${name} requires a value`);
      options[name] = optionValue;
      continue;
    }
    if (booleanFlags.has(name) && inline === undefined) {
      options[name] = true;
      continue;
    }
    throw new UsageError(`Unknown option: --${name}`);
  }
  return { positionals, options };
}

export function parseDuration(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!match) throw new UsageError(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "d" ? 86_400 : match[2] === "h" ? 3_600 : match[2] === "m" ? 60 : 1;
  const seconds = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new UsageError(`Invalid duration: ${value}`);
  return seconds;
}

function terminalExit(status: string, timedOut = false): 0 | 4 | 5 {
  if (timedOut || status === "expired" || status === "canceled") return 4;
  if (status === "denied" || status === "no") return 5;
  return 0;
}

function bodyHeaders(runtime: RelayctlRuntime, key?: string): Record<string, string> {
  return {
    authorization: `Bearer ${runtime.config.token}`,
    "content-type": "application/json",
    ...(key ? { "idempotency-key": key } : {}),
  };
}

async function request(
  runtime: RelayctlRuntime,
  path: string,
  method: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  return runtime.request(path, {
    method,
    headers: bodyHeaders(runtime, idempotencyKey),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mutationKey(runtime: RelayctlRuntime, options: ParsedArguments["options"]): string {
  return String(options["idempotency-key"] ?? runtime.randomId?.() ?? randomUUID());
}

function requireAccepted<T>(body: T): T {
  if (body && typeof body === "object" && "accepted" in body && (body as { accepted?: unknown }).accepted !== true) {
    throw new Error("APNs did not accept the Relay request");
  }
  return body;
}

function numericOption(options: ParsedArguments["options"], name: string): number | undefined {
  if (options[name] === undefined) return undefined;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be numeric`);
  return value;
}

async function waitForInteraction(runtime: RelayctlRuntime, interactionId: string, timeoutSeconds: number) {
  const clock = runtime.now ?? Date.now;
  const deadline = clock() + timeoutSeconds * 1_000;
  let last: { interaction: { status: string }; timedOut: boolean } | undefined;
  while (clock() < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - clock()) / 1_000));
    last = (await request(
      runtime,
      `/v1/interactions/${encodeURIComponent(interactionId)}/wait?timeout=${Math.min(remainingSeconds, 25)}`,
      "GET",
    )) as { interaction: { status: string }; timedOut: boolean };
    if (last.interaction.status !== "pending") return last;
  }
  return last ?? {
    interaction: { status: "pending" },
    timedOut: true,
  };
}

export async function execute(argv: string[], runtime: RelayctlRuntime): Promise<ExecutionResult> {
  const { positionals, options } = parseArguments(argv);
  const [group, action, identifier] = positionals;
  const json = options.json === true;

  if (group === "pair" && action === "create") {
    const body = await request(runtime, "/v1/enrollments", "POST", undefined, mutationKey(runtime, options));
    return { body, exitCode: 0, json };
  }

  if (group === "host" && action === "enroll") {
    const body = await request(runtime, "/v1/hosts/enrollments", "POST", undefined, mutationKey(runtime, options));
    return { body, exitCode: 0, json };
  }

  if (group === "host" && action === "list") {
    const body = await request(runtime, "/v1/hosts", "GET");
    return { body, exitCode: 0, json };
  }

  if (group === "host" && action === "revoke") {
    if (!identifier) throw new UsageError("host revoke requires a host id or name");
    const body = await request(runtime, `/v1/hosts/${encodeURIComponent(identifier)}`, "DELETE");
    return { body, exitCode: 0, json };
  }

  if (group === "auth" && action === "rotate") {
    const body = await request(runtime, "/v1/operations/cli-token/rotate", "POST", undefined, mutationKey(runtime, options));
    return { body, exitCode: 0, json };
  }

  if (group === "doctor" && !action) {
    const health = await request(runtime, "/healthz", "GET") as { status?: string };
    await request(runtime, "/v1/operations/integrity", "GET");
    return {
      body: { status: "ok", health: health.status ?? "unknown", authenticated: true },
      exitCode: 0,
      json,
    };
  }

  if (group === "notify") {
    const message = positionals.slice(1).join(" ").trim();
    if (!message) throw new UsageError("notify requires a message");
    const payload = {
      ...(options.title ? { title: String(options.title) } : {}),
      body: message,
      ...(options.url ? { url: String(options.url) } : {}),
    };
    const body = requireAccepted(await request(runtime, "/v1/notifications", "POST", payload, mutationKey(runtime, options)));
    return { body, exitCode: 0, json };
  }

  if (group === "ask") {
    const prompt = positionals.slice(1).join(" ").trim();
    if (!prompt) throw new UsageError("ask requires a prompt");
    const kinds = [options.approval ? "approval" : null, options["yes-no"] ? "yes_no" : null, options.text ? "text" : null].filter(
      (value): value is string => Boolean(value),
    );
    if (kinds.length !== 1) throw new UsageError("ask requires exactly one of --approval, --yes-no, or --text");
    if (options["live-activity"] && options["no-live-activity"]) {
      throw new UsageError("ask accepts only one of --live-activity or --no-live-activity");
    }
    if (kinds[0] === "text" && options["live-activity"]) {
      throw new UsageError("text asks cannot use a Live Activity");
    }
    const liveActivity = kinds[0] === "text"
      ? "disabled"
      : options["live-activity"]
        ? "required"
        : options["no-live-activity"]
          ? "disabled"
          : "auto";
    const expiresInSeconds = parseDuration(String(options["expires-in"] ?? "15m"));
    const timeout = options.wait ? parseDuration(String(options.timeout ?? "10m")) : undefined;
    const created = requireAccepted((await request(
      runtime,
      "/v1/interactions",
      "POST",
      {
        ...(options.title ? { title: String(options.title) } : {}),
        prompt,
        kind: kinds[0],
        expiresInSeconds,
        liveActivity,
        ...(options.activity ? { activity: String(options.activity) } : {}),
      },
      mutationKey(runtime, options),
    )) as { interaction: { id: string; status: string }; accepted: boolean });
    if (timeout === undefined) return { body: created, exitCode: 0, json };
    const waited = await waitForInteraction(runtime, created.interaction.id, timeout);
    return {
      body: { ...created, interaction: waited.interaction, timedOut: waited.timedOut },
      exitCode: terminalExit(waited.interaction.status, waited.timedOut),
      json,
    };
  }

  if (group === "interaction" && action && identifier) {
    if (action === "get") {
      const body = (await request(runtime, `/v1/interactions/${encodeURIComponent(identifier)}`, "GET")) as {
        interaction: { status: string };
      };
      return { body, exitCode: terminalExit(body.interaction.status), json };
    }
    if (action === "wait") {
      const timeout = parseDuration(String(options.timeout ?? "10m"));
      const body = await waitForInteraction(runtime, identifier, timeout);
      return { body, exitCode: terminalExit(body.interaction.status, body.timedOut), json };
    }
    if (action === "cancel") {
      const body = await request(
        runtime,
        `/v1/interactions/${encodeURIComponent(identifier)}/cancel`,
        "POST",
        undefined,
        mutationKey(runtime, options),
      );
      return { body, exitCode: 4, json };
    }
  }

  if (group === "activity" && action === "start") {
    if (!options.title || !options.status) throw new UsageError("activity start requires --title and --status");
    if (options.replace && !options.key) throw new UsageError("activity start --replace requires --key");
    const body = requireAccepted(await request(
      runtime,
      "/v1/activities",
      "POST",
      {
        title: String(options.title),
        status: String(options.status),
        ...(options.detail ? { detail: String(options.detail) } : {}),
        progress: numericOption(options, "progress"),
        ...(options.symbol ? { symbol: String(options.symbol) } : {}),
        ...(options["accent-color"] ? { accentColor: String(options["accent-color"]) } : {}),
        ...(options.key ? { key: String(options.key) } : {}),
        replace: options.replace === true,
        ...(options["stale-after"] ? { staleAfterSeconds: parseDuration(String(options["stale-after"])) } : {}),
      },
      mutationKey(runtime, options),
    ));
    return { body, exitCode: 0, json };
  }

  if (group === "activity" && (action === "update" || action === "end") && identifier) {
    const payload = {
      ...(options.status ? { status: String(options.status) } : {}),
      ...(options.detail ? { detail: String(options.detail) } : {}),
      progress: numericOption(options, "progress"),
      ...(options.symbol ? { symbol: String(options.symbol) } : {}),
      ...(options["accent-color"] ? { accentColor: String(options["accent-color"]) } : {}),
      sequence: numericOption(options, "sequence"),
    };
    const path = `/v1/activities/${encodeURIComponent(identifier)}${action === "end" ? "/end" : ""}`;
    const body = requireAccepted(await request(
      runtime,
      path,
      action === "end" ? "POST" : "PATCH",
      payload,
      mutationKey(runtime, options),
    ));
    return { body, exitCode: 0, json };
  }

  throw new UsageError("Unknown command. Run relayctl --help for usage.");
}

export const help = `relayctl configure --url <https-url> --token <token>
relayctl configure --url <https-url> --enroll <code> [--name <host-name>]
relayctl doctor
relayctl auth rotate
relayctl pair create
relayctl host enroll
relayctl host list
relayctl host revoke <id|name>
relayctl notify <body> [--title <title>] [--url <https-url>]
relayctl ask <prompt> --approval|--yes-no|--text [--activity <id|key>] [--live-activity|--no-live-activity] [--wait] [--timeout <duration>]
relayctl interaction get|wait|cancel <id>
relayctl activity start --title <title> --status <status> [--key <key>] [--replace]
relayctl activity update <id|key> [--status <status>] [--progress <0..1>]
relayctl activity end <id|key> [--status <status>]`;
