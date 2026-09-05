import { describe, expect, test } from "vitest";
import {
  activityCreateSchema,
  activityPushTokenUpdateSchema,
  activityUpdateSchema,
  deviceTokenUpdateSchema,
  interactionCreateSchema,
  interactionResponseSchema,
  notificationCreateSchema,
} from "./index.js";

describe("notificationCreateSchema", () => {
  test("accepts a bounded message and public HTTPS tap URL", () => {
    const parsed = notificationCreateSchema.parse({
      title: "Codex",
      body: "The build finished.",
      url: "https://example.com/build/42",
    });
    expect(parsed.body).toBe("The build finished.");
  });

  test("rejects non-HTTPS and local tap URLs", () => {
    expect(() => notificationCreateSchema.parse({ body: "x", url: "http://example.com" })).toThrow();
    expect(() => notificationCreateSchema.parse({ body: "x", url: "https://localhost/x" })).toThrow();
  });
});

describe("device token contracts", () => {
  test("separates device-wide tokens from per-activity update tokens", () => {
    expect(() =>
      deviceTokenUpdateSchema.parse({ activityPushToken: "a".repeat(64), environment: "production" }),
    ).toThrow();
    expect(
      activityPushTokenUpdateSchema.parse({
        activityPushToken: "a".repeat(64),
        activityId: "act_1",
        environment: "production",
      }).activityId,
    ).toBe("act_1");
  });

  test("accepts the exact interactive Live Activity capability marker", () => {
    expect(
      deviceTokenUpdateSchema.parse({
        apnsToken: "a".repeat(64),
        environment: "production",
        capabilities: { liveActivityInteractions: 1 },
      }),
    ).toMatchObject({ capabilities: { liveActivityInteractions: 1 } });
    expect(() =>
      deviceTokenUpdateSchema.parse({
        apnsToken: "a".repeat(64),
        environment: "production",
        capabilities: { liveActivityInteractions: 2 },
      }),
    ).toThrow();
  });
});

describe("interaction contracts", () => {
  test("requires one supported prompt kind", () => {
    const parsed = interactionCreateSchema.parse({ prompt: "Deploy?", kind: "approval", activity: "release" });
    expect(parsed.kind).toBe("approval");
    expect(parsed.liveActivity).toBe("auto");
    expect(parsed.activity).toBe("release");
    expect(() => interactionCreateSchema.parse({ prompt: "Deploy?", kind: "choice" })).toThrow();
  });

  test("validates Live Activity presentation and excludes text prompts", () => {
    for (const liveActivity of ["auto", "required", "disabled"] as const) {
      expect(
        interactionCreateSchema.parse({ prompt: "Deploy?", kind: "approval", liveActivity })
          .liveActivity,
      ).toBe(liveActivity);
    }
    expect(() =>
      interactionCreateSchema.parse({ prompt: "Reply", kind: "text", liveActivity: "required" }),
    ).toThrow();
    expect(() =>
      interactionCreateSchema.parse({ prompt: "Reply", kind: "text", liveActivity: "auto" }),
    ).toThrow();
    expect(interactionCreateSchema.parse({ prompt: "Reply", kind: "text" }).liveActivity).toBe(
      "disabled",
    );
    expect(
      interactionCreateSchema.parse({ prompt: "Reply", kind: "text", liveActivity: "disabled" })
        .liveActivity,
    ).toBe("disabled");
  });

  test("requires text only for a text response", () => {
    const response = interactionResponseSchema.parse({ action: "reply", text: "Ship after lunch" });
    expect(response).toEqual({ action: "reply", text: "Ship after lunch" });
    expect(() => interactionResponseSchema.parse({ action: "reply" })).toThrow();
    expect(() => interactionResponseSchema.parse({ action: "approve", text: "extra" })).toThrow();
  });
});

describe("activity contracts", () => {
  test("validates progress and requires an update field", () => {
    expect(activityCreateSchema.parse({ title: "Release", status: "Building" }).progress).toBe(0);
    expect(activityUpdateSchema.parse({ progress: 0.5 }).progress).toBe(0.5);
    expect(() => activityUpdateSchema.parse({})).toThrow();
    expect(() => activityUpdateSchema.parse({ progress: 1.1 })).toThrow();
  });

  test("requires a stable key for replacement", () => {
    expect(() => activityCreateSchema.parse({ title: "Release", status: "Restarting", replace: true })).toThrow();
    expect(activityCreateSchema.parse({ title: "Release", status: "Restarting", key: "release", replace: true }))
      .toMatchObject({ key: "release", replace: true });
  });
});
