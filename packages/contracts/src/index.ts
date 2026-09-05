import { z } from "zod";

export const API_VERSION = 1 as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

function isPublicHttps(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80:")
    ) {
      return false;
    }
    const octets = hostname.split(".").map(Number);
    if (octets.length === 4 && octets.every((value) => Number.isInteger(value))) {
      const [a = -1, b = -1] = octets;
      if (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export const publicHttpsUrlSchema = z
  .url()
  .max(2048)
  .refine(isPublicHttps, "Must be a public HTTPS URL");

export const idempotencyKeySchema = z.string().trim().min(1).max(200);

export const notificationCreateSchema = z
  .object({
    title: boundedText(80).default("Relay"),
    body: boundedText(2_000),
    url: publicHttpsUrlSchema.optional(),
  })
  .strict();
export type NotificationCreate = z.infer<typeof notificationCreateSchema>;

export const interactionKindSchema = z.enum(["approval", "yes_no", "text"]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const liveActivityPresentationSchema = z.enum(["auto", "required", "disabled"]);
export type LiveActivityPresentation = z.infer<typeof liveActivityPresentationSchema>;

export const interactionCreateSchema = z
  .object({
    title: boundedText(80).default("Relay"),
    prompt: boundedText(2_000),
    kind: interactionKindSchema,
    expiresInSeconds: z.number().int().min(30).max(86_400).default(900),
    liveActivity: liveActivityPresentationSchema.optional(),
    activity: boundedText(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "text" && value.liveActivity && value.liveActivity !== "disabled") {
      context.addIssue({
        code: "custom",
        path: ["liveActivity"],
        message: "Text interactions cannot use a Live Activity",
      });
    }
    if (value.kind === "text" && value.activity) {
      context.addIssue({
        code: "custom",
        path: ["activity"],
        message: "Text interactions cannot target a Live Activity",
      });
    }
  })
  .transform((value) => ({
    ...value,
    liveActivity: value.liveActivity ?? (value.kind === "text" ? "disabled" : "auto"),
  }));
export type InteractionCreate = z.infer<typeof interactionCreateSchema>;

export const interactionResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("deny") }).strict(),
  z.object({ action: z.literal("yes") }).strict(),
  z.object({ action: z.literal("no") }).strict(),
  z.object({ action: z.literal("reply"), text: boundedText(2_000) }).strict(),
]);
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

export const interactionStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "yes",
  "no",
  "replied",
  "canceled",
  "expired",
]);
export type InteractionStatus = z.infer<typeof interactionStatusSchema>;

export const activitySymbolSchema = z.enum(["terminal", "code", "build", "success", "warning"]);
export type ActivitySymbol = z.infer<typeof activitySymbolSchema>;

export const activityCreateSchema = z
  .object({
    title: boundedText(80),
    status: boundedText(120),
    detail: z.string().trim().max(500).optional(),
    progress: z.number().min(0).max(1).default(0),
    symbol: activitySymbolSchema.default("terminal"),
    accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#5ED8B7"),
    key: boundedText(100).optional(),
    replace: z.boolean().default(false),
    staleAfterSeconds: z.number().int().min(60).max(28_800).default(3_600),
  })
  .strict()
  .refine((value) => !value.replace || Boolean(value.key), {
    path: ["key"],
    message: "Replacing an activity requires a key",
  });
export type ActivityCreate = z.infer<typeof activityCreateSchema>;

export const activityUpdateSchema = z
  .object({
    status: boundedText(120).optional(),
    detail: z.string().trim().max(500).optional(),
    progress: z.number().min(0).max(1).optional(),
    symbol: activitySymbolSchema.optional(),
    accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    sequence: z.number().int().positive().optional(),
    staleAfterSeconds: z.number().int().min(60).max(28_800).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one update field is required");
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>;

export const activityEndSchema = z
  .object({
    status: boundedText(120).optional(),
    detail: z.string().trim().max(500).optional(),
    progress: z.number().min(0).max(1).optional(),
    sequence: z.number().int().positive().optional(),
  })
  .strict();
export type ActivityEnd = z.infer<typeof activityEndSchema>;

export const enrollmentCodeSchema = z.string().trim().regex(/^[A-Z0-9]{8}$/);

export const enrollmentExchangeSchema = z
  .object({
    code: enrollmentCodeSchema,
    deviceName: boundedText(80),
  })
  .strict();

export const hostNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "Host names may contain letters, digits, spaces, dots, dashes, and underscores");
export type HostName = z.infer<typeof hostNameSchema>;

export const hostEnrollmentExchangeSchema = z
  .object({
    code: enrollmentCodeSchema,
    hostName: hostNameSchema,
  })
  .strict();

export const deviceTokenUpdateSchema = z
  .object({
    apnsToken: z.string().regex(/^[0-9a-fA-F]{64,400}$/).optional(),
    pushToStartToken: z.string().regex(/^[0-9a-fA-F]{64,400}$/).optional(),
    environment: z.enum(["sandbox", "production"]),
    capabilities: z
      .object({ liveActivityInteractions: z.literal(1) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.apnsToken || value.pushToStartToken),
    "At least one push token is required",
  );

export const activityPushTokenUpdateSchema = z
  .object({
    activityPushToken: z.string().regex(/^[0-9a-fA-F]{64,400}$/),
    activityId: z.string().trim().min(1).max(200),
    environment: z.enum(["sandbox", "production"]),
  })
  .strict();
export type ActivityPushTokenUpdate = z.infer<typeof activityPushTokenUpdateSchema>;
