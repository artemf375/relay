export type RelayHttpErrorCode = "dns" | "timeout" | "tls" | "connect" | "auth" | "http";

export class RelayHttpError extends Error {
  constructor(
    message: string,
    public readonly code: RelayHttpErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RelayHttpError";
  }
}

interface RequesterOptions {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function causeCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; cause?: unknown; name?: unknown };
  if (typeof value.code === "string") return value.code;
  return causeCode(value.cause);
}

function classify(error: unknown): RelayHttpError {
  if (error instanceof RelayHttpError) return error;
  const code = causeCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new RelayHttpError("Relay hostname could not be resolved. Check the configured URL and DNS connection.", "dns", true);
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || (error as { name?: string })?.name === "AbortError") {
    return new RelayHttpError("Relay request timed out. Check connectivity, then run relayctl doctor.", "timeout", true);
  }
  if (code?.startsWith("CERT_") || code?.includes("TLS") || code?.includes("SSL")) {
    return new RelayHttpError("Relay TLS verification failed. Check the configured HTTPS URL and certificate.", "tls", false);
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
    return new RelayHttpError("Relay connection failed. Check server health with relayctl doctor.", "connect", true);
  }
  return new RelayHttpError("Relay request failed. Check connectivity with relayctl doctor.", "connect", true);
}

export function createRelayRequester(baseURL: string, options: RequesterOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return async (path: string, init: RequestInit): Promise<unknown> => {
    const longPollSeconds = Number(new URL(path, "https://relay.invalid").searchParams.get("timeout") ?? 0);
    const timeoutMilliseconds = Math.max(15_000, (longPollSeconds + 5) * 1_000);
    let lastError: RelayHttpError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
      try {
        const response = await fetcher(`${baseURL}${path}`, { ...init, signal: controller.signal });
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        if (response.ok) return body;
        const message = body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
        const error = new RelayHttpError(
          response.status === 401 ? "Relay authentication failed. Reconfigure or rotate the CLI credential." : message,
          response.status === 401 ? "auth" : "http",
          retryableStatuses.has(response.status),
          response.status,
        );
        if (!error.retryable || attempt === 2) throw error;
        lastError = error;
      } catch (error) {
        const classified = classify(error);
        if (!classified.retryable || attempt === 2) throw classified;
        lastError = classified;
      } finally {
        clearTimeout(timeout);
      }
      await sleep(attempt === 0 ? 250 : 750);
    }
    throw lastError ?? new RelayHttpError("Relay request failed.", "connect", true);
  };
}
