import { Container } from "@cloudflare/containers";

interface Env {
  RELAY: DurableObjectNamespace<RelayContainer>;
  RELAY_DATABASE_URL: string;
  RELAY_DATABASE_AUTH_TOKEN: string;
  RELAY_TOKEN_HASH_KEY: string;
  RELAY_ENCRYPTION_KEY: string;
  RELAY_CLI_TOKEN: string;
  APNS_KEY_ID: string;
  APPLE_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
  APNS_ENVIRONMENT?: string;
  RELAY_ALLOWED_URL_HOSTS?: string;
}

export class RelayContainer extends Container<Env> {
  defaultPort = 8787;
  sleepAfter = "5m";
  enableInternet = true;
  envVars = {
    RELAY_DATABASE_URL: this.env.RELAY_DATABASE_URL,
    RELAY_DATABASE_AUTH_TOKEN: this.env.RELAY_DATABASE_AUTH_TOKEN,
    RELAY_TOKEN_HASH_KEY: this.env.RELAY_TOKEN_HASH_KEY,
    RELAY_ENCRYPTION_KEY: this.env.RELAY_ENCRYPTION_KEY,
    RELAY_CLI_TOKEN: this.env.RELAY_CLI_TOKEN,
    APNS_KEY_ID: this.env.APNS_KEY_ID,
    APPLE_TEAM_ID: this.env.APPLE_TEAM_ID,
    APNS_PRIVATE_KEY: this.env.APNS_PRIVATE_KEY,
    APNS_BUNDLE_ID: this.env.APNS_BUNDLE_ID,
    APNS_ENVIRONMENT: this.env.APNS_ENVIRONMENT || "production",
    RELAY_ALLOWED_URL_HOSTS: this.env.RELAY_ALLOWED_URL_HOSTS || "",
    RELAY_REQUIRE_REMOTE_DATABASE: "true",
  };
}

export default {
  fetch(request: Request, env: Env) {
    return env.RELAY.getByName("relay").fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env) {
    // Keep the server's checkpoint reconciliation timer running between requests.
    const response = await env.RELAY.getByName("relay").fetch(new Request("http://relay/healthz"));
    if (!response.ok) throw new Error("Relay maintenance wake-up failed");
  },
} satisfies ExportedHandler<Env>;
