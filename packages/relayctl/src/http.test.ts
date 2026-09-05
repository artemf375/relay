import { describe, expect, test, vi } from "vitest";
import { createRelayRequester, RelayHttpError } from "./http.js";

describe("relayctl HTTP transport", () => {
  test("retries transient fetch failures and eventually succeeds", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    const request = createRelayRequester("https://relay.example.com", {
      fetcher,
      sleep: async () => {},
    });

    await expect(request("/healthz", { method: "GET" })).resolves.toEqual({ status: "ok" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("returns an actionable stable error instead of fetch failed", async () => {
    const fetcher = vi.fn().mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    );
    const request = createRelayRequester("https://relay.example.com", {
      fetcher,
      sleep: async () => {},
    });

    await expect(request("/healthz", { method: "GET" })).rejects.toMatchObject({
      code: "dns",
      retryable: true,
      message: expect.stringMatching(/DNS|hostname/i),
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("retries temporary HTTP responses but not authentication failures", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "busy" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const request = createRelayRequester("https://relay.example.com", { fetcher, sleep: async () => {} });
    await expect(request("/healthz", { method: "GET" })).resolves.toEqual({ ok: true });

    const unauthorized = createRelayRequester("https://relay.example.com", {
      fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })),
      sleep: async () => {},
    });
    await expect(unauthorized("/v1/inbox", { method: "GET" })).rejects.toEqual(
      expect.objectContaining<Partial<RelayHttpError>>({ code: "auth", retryable: false, status: 401 }),
    );
  });
});
