import { hostNameSchema } from "@relay/contracts";
import { z } from "zod";

const base64Key = z.string().refine((value) => Buffer.from(value, "base64").byteLength === 32, {
  message: "Must encode exactly 32 bytes",
});

const environmentSchema = z
  .object({
    RELAY_DATABASE_URL: z.string().min(1).default("./data/relay.sqlite"),
    RELAY_DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
    RELAY_REQUIRE_REMOTE_DATABASE: z.enum(["true", "false"]).default("false"),
    RELAY_BACKUP_STATUS_FILE: z.string().min(1).default("/data/backup-status.json"),
    RELAY_ALLOWED_URL_HOSTS: z.string().default(""),
    RELAY_TOKEN_HASH_KEY: base64Key,
    RELAY_ENCRYPTION_KEY: base64Key,
    RELAY_CLI_TOKEN: z.string().min(24).max(512).regex(/^relay_cli_/),
    RELAY_CLI_HOST_NAME: hostNameSchema.default("primary"),
    APNS_KEY_ID: z.string().min(1),
    APPLE_TEAM_ID: z.string().min(1),
    APNS_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((value) => value.replace(/\\n/g, "\n"))
      .optional(),
    APNS_PRIVATE_KEY_FILE: z.string().min(1).optional(),
    APNS_BUNDLE_ID: z.string().min(1),
    APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("production"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  })
  .refine((value) => Boolean(value.APNS_PRIVATE_KEY || value.APNS_PRIVATE_KEY_FILE), {
    message: "APNS_PRIVATE_KEY or APNS_PRIVATE_KEY_FILE is required",
  })
  .refine((value) => !/^(?:libsql|https):\/\//.test(value.RELAY_DATABASE_URL) || Boolean(value.RELAY_DATABASE_AUTH_TOKEN), {
    message: "RELAY_DATABASE_AUTH_TOKEN is required for a remote database",
  })
  .refine((value) => value.RELAY_REQUIRE_REMOTE_DATABASE !== "true" || /^(?:libsql|https):\/\//.test(value.RELAY_DATABASE_URL), {
    message: "Cloud deployments require a remote libsql:// or https:// database URL",
  })
  .refine((value) => value.RELAY_REQUIRE_REMOTE_DATABASE !== "true" || Boolean(value.APNS_PRIVATE_KEY), {
    message: "Cloud deployments require APNS_PRIVATE_KEY as an environment secret",
  });

export function parseEnvironment(input: Record<string, string | undefined>) {
  return environmentSchema.parse(input);
}

export type RelayEnvironment = ReturnType<typeof parseEnvironment>;
