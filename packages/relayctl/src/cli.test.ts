import { describe, expect, test } from "vitest";
import { execute, type RelayctlRuntime } from "./cli.js";

function runtime(responses: Array<{ status?: number; body: unknown }> = []) {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  let currentTime = 0;
  const value: RelayctlRuntime = {
    config: { url: "https://relay.example.com", token: "relay_cli_secret" },
    request: async (path, init) => {
      requests.push({ path, init });
      const waitSeconds = Number(new URL(path, "https://relay.invalid").searchParams.get("timeout") ?? 0);
      currentTime += waitSeconds * 1_000;
      const next = responses.shift() ?? { body: {} };
      if ((next.status ?? 200) >= 400) throw new Error(`HTTP ${next.status}`);
      return next.body;
    },
    randomId: () => "generated-key",
    now: () => currentTime,
  };
  return { runtime: value, requests };
}

describe("relayctl notify", () => {
  test("sends stable JSON with an idempotency key", async () => {
    const context = runtime([{ body: { accepted: true, notification: { id: "ntf_1" } } }]);
    const result = await execute(["notify", "Finished", "--title", "Codex", "--json"], context.runtime);

    expect(result.exitCode).toBe(0);
    expect(context.requests[0]).toMatchObject({ path: "/v1/notifications" });
    expect(context.requests[0]?.init.headers).toMatchObject({ "idempotency-key": "generated-key" });
    expect(JSON.parse(String(context.requests[0]?.init.body))).toEqual({ title: "Codex", body: "Finished" });
  });
});

describe("relayctl host", () => {
  test("mints a host enrollment code with an idempotency key", async () => {
    const context = runtime([{ body: { code: "ABCD2345", expiresAt: "2026-08-10T12:10:00.000Z" } }]);
    const result = await execute(["host", "enroll", "--json"], context.runtime);

    expect(result).toMatchObject({ body: { code: "ABCD2345" }, exitCode: 0, json: true });
    expect(context.requests[0]).toMatchObject({ path: "/v1/hosts/enrollments" });
    expect(context.requests[0]?.init.method).toBe("POST");
    expect(context.requests[0]?.init.headers).toMatchObject({ "idempotency-key": "generated-key" });
  });

  test("lists linked hosts", async () => {
    const context = runtime([{ body: { hosts: [{ id: "hst_1", name: "pi" }], current: "hst_1" } }]);
    const result = await execute(["host", "list", "--json"], context.runtime);

    expect(result.exitCode).toBe(0);
    expect(context.requests[0]).toMatchObject({ path: "/v1/hosts" });
    expect(context.requests[0]?.init.method).toBe("GET");
  });

  test("revokes a host by name and requires a selector", async () => {
    const context = runtime([{ body: { id: "hst_2", name: "mac" } }]);
    const result = await execute(["host", "revoke", "mac", "--json"], context.runtime);

    expect(result).toMatchObject({ body: { name: "mac" }, exitCode: 0 });
    expect(context.requests[0]).toMatchObject({ path: "/v1/hosts/mac" });
    expect(context.requests[0]?.init.method).toBe("DELETE");
    await expect(execute(["host", "revoke"], runtime().runtime)).rejects.toThrow(/host id or name/);
  });
});

describe("relayctl auth", () => {
  test("requests an atomic CLI token rotation", async () => {
    const context = runtime([{ body: { token: "relay_cli_rotated" } }]);
    const result = await execute(["auth", "rotate", "--json"], context.runtime);
    expect(result).toMatchObject({ body: { token: "relay_cli_rotated" }, exitCode: 0, json: true });
    expect(context.requests[0]).toMatchObject({ path: "/v1/operations/cli-token/rotate" });
    expect(context.requests[0]?.init.method).toBe("POST");
    expect(context.requests[0]?.init.headers).toMatchObject({ "idempotency-key": "generated-key" });
  });
});

describe("relayctl doctor", () => {
  test("checks public health and authenticated integrity", async () => {
    const context = runtime([
      { body: { status: "ok" } },
      { body: { integrity: "ok" } },
    ]);

    const result = await execute(["doctor", "--json"], context.runtime);

    expect(result).toEqual({
      body: { status: "ok", health: "ok", authenticated: true },
      exitCode: 0,
      json: true,
    });
    expect(context.requests.map((request) => request.path)).toEqual([
      "/healthz",
      "/v1/operations/integrity",
    ]);
  });
});

describe("relayctl ask", () => {
  test("targets an existing task activity", async () => {
    const context = runtime([{ body: { interaction: { id: "int_1", status: "pending" }, accepted: true } }]);

    await execute(["ask", "Deploy?", "--approval", "--activity", "release-task"], context.runtime);

    expect(JSON.parse(String(context.requests[0]?.init.body))).toMatchObject({
      prompt: "Deploy?",
      activity: "release-task",
    });
  });

  test("maps Live Activity presentation flags to stable request JSON", async () => {
    const required = runtime([{ body: { interaction: { id: "int_1", status: "pending" }, accepted: true } }]);
    await execute(["ask", "Deploy?", "--approval", "--live-activity"], required.runtime);
    expect(JSON.parse(String(required.requests[0]?.init.body))).toMatchObject({
      prompt: "Deploy?",
      kind: "approval",
      liveActivity: "required",
    });

    const disabled = runtime([{ body: { interaction: { id: "int_2", status: "pending" }, accepted: true } }]);
    await execute(["ask", "Deploy?", "--yes-no", "--no-live-activity"], disabled.runtime);
    expect(JSON.parse(String(disabled.requests[0]?.init.body))).toMatchObject({ liveActivity: "disabled" });

    const automatic = runtime([{ body: { interaction: { id: "int_3", status: "pending" }, accepted: true } }]);
    await execute(["ask", "Deploy?", "--approval"], automatic.runtime);
    expect(JSON.parse(String(automatic.requests[0]?.init.body))).toMatchObject({ liveActivity: "auto" });
  });

  test("targets a prompt to its agent activity", async () => {
    const context = runtime([{ body: { interaction: { id: "int_1", status: "pending" }, accepted: true } }]);
    await execute(["ask", "Deploy?", "--approval", "--activity", "release"], context.runtime);
    expect(JSON.parse(String(context.requests[0]?.init.body))).toMatchObject({ activity: "release" });
  });

  test("rejects conflicting presentation flags and Live Activity text asks", async () => {
    const context = runtime();
    await expect(
      execute(["ask", "Deploy?", "--approval", "--live-activity", "--no-live-activity"], context.runtime),
    ).rejects.toThrow(/only one/i);
    await expect(
      execute(["ask", "Reply?", "--text", "--live-activity"], context.runtime),
    ).rejects.toThrow(/text/i);
  });

  test("does not treat a failed optional activity delivery as alert failure", async () => {
    const context = runtime([
      {
        body: {
          interaction: { id: "int_1", status: "pending" },
          accepted: true,
          activityDelivery: { accepted: false, reason: "TooManyRequests" },
        },
      },
    ]);
    const result = await execute(["ask", "Deploy?", "--approval", "--live-activity", "--json"], context.runtime);
    expect(result.exitCode).toBe(0);
    expect(result.body).toMatchObject({ accepted: true, activityDelivery: { accepted: false } });
  });

  test("waits for an answer and maps denial to exit code 5", async () => {
    const context = runtime([
      { body: { interaction: { id: "int_1", status: "pending" }, accepted: true } },
      { body: { interaction: { id: "int_1", status: "denied" }, timedOut: false } },
    ]);
    const result = await execute(
      ["ask", "Deploy?", "--approval", "--wait", "--timeout", "30s"],
      context.runtime,
    );

    expect(result.exitCode).toBe(5);
    expect(context.requests.map((request) => request.path)).toEqual([
      "/v1/interactions",
      "/v1/interactions/int_1/wait?timeout=25",
    ]);
  });

  test("rejects a mutation when APNs did not accept it", async () => {
    const context = runtime([{ body: { accepted: false, notification: { id: "ntf_1" } } }]);
    await expect(execute(["notify", "Failed"], context.runtime)).rejects.toThrow(/APNs/);
  });

  test("maps a wait timeout to exit code 4 without canceling", async () => {
    const context = runtime([
      { body: { interaction: { id: "int_1", status: "pending" }, accepted: true } },
      { body: { interaction: { id: "int_1", status: "pending" }, timedOut: true } },
    ]);
    const result = await execute(["ask", "Reply?", "--text", "--wait", "--timeout", "1s"], context.runtime);
    expect(result.exitCode).toBe(4);
    expect(context.requests).toHaveLength(2);
  });

  test("continues bounded long polling until the requested timeout", async () => {
    const context = runtime([
      { body: { interaction: { id: "int_1", status: "pending" }, accepted: true } },
      { body: { interaction: { id: "int_1", status: "pending" }, timedOut: true } },
      { body: { interaction: { id: "int_1", status: "pending" }, timedOut: true } },
      { body: { interaction: { id: "int_1", status: "approved" }, timedOut: false } },
    ]);
    const result = await execute(["ask", "Deploy?", "--approval", "--wait", "--timeout", "60s"], context.runtime);
    expect(result.exitCode).toBe(0);
    expect(context.requests.slice(1).map((request) => request.path)).toEqual([
      "/v1/interactions/int_1/wait?timeout=25",
      "/v1/interactions/int_1/wait?timeout=25",
      "/v1/interactions/int_1/wait?timeout=10",
    ]);
  });
});

describe("relayctl activity", () => {
  test("requires a stable key before replacing an activity", async () => {
    const context = runtime();

    await expect(
      execute(["activity", "start", "--title", "Release", "--status", "Building", "--replace"], context.runtime),
    ).rejects.toThrow(/requires --key/);
  });

  test("updates by key and preserves an explicit idempotency key", async () => {
    const context = runtime([{ body: { activity: { id: "act_1", progress: 0.5 }, accepted: true } }]);
    const result = await execute(
      ["activity", "update", "release", "--progress", "0.5", "--idempotency-key", "update-7"],
      context.runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(context.requests[0]).toMatchObject({ path: "/v1/activities/release" });
    expect(context.requests[0]?.init.method).toBe("PATCH");
    expect(context.requests[0]?.init.headers).toMatchObject({ "idempotency-key": "update-7" });
  });

  test("requires a key when replacing an activity", async () => {
    const context = runtime();
    await expect(execute(["activity", "start", "--title", "Release", "--status", "Restarting", "--replace"], context.runtime))
      .rejects.toThrow(/key/i);
  });
});

test("rejects invalid durations and ambiguous ask kinds", async () => {
  const context = runtime();
  await expect(execute(["ask", "Question", "--approval", "--text"], context.runtime)).rejects.toThrow(
    /exactly one/,
  );
  await expect(
    execute(["interaction", "wait", "int_1", "--timeout", "tomorrow"], context.runtime),
  ).rejects.toThrow(/duration/);
});
