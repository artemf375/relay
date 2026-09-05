# Relay Interactive Live Activity Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Approve/Deny and Yes/No buttons to Relay Live Activities while preserving the latest task state and the existing notification/inbox fallbacks.

**Architecture:** Extend interactions with a requested Live Activity presentation and store one optional checkpoint association for the single active activity. Record each checkpoint show/restore/end as a durable delivery, render it through the existing direct APNs adapter, and execute buttons with a `LiveActivityIntent` that authenticates from the app Keychain. Notification, inbox, and Live Activity responses converge on the same transactional response state machine.

**Tech Stack:** Node.js 22, TypeScript, Hono, Zod, Drizzle, SQLite, Vitest, Swift 6, SwiftUI, ActivityKit, WidgetKit, App Intents, XCTest, XcodeGen.

## Global Constraints

- Bundle ID remains `com.example.relay`; minimum iOS version remains 17.2.
- Support one user, one paired iPhone, one active Live Activity, and at most one visible checkpoint.
- Text interactions never become Live Activity checkpoints.
- The phone may only answer a server-created pending interaction.
- Reusable CLI/device credentials and one-use response credentials never enter ActivityKit state or Live Activity APNs payloads.
- Live Activity sequences increase monotonically and encoded APNs payloads remain below 4 KB.
- APNs acceptance is reported separately from a confirmed user response and never described as device delivery.
- Existing actionable notifications and inbox responses remain valid fallbacks.

---

## File Structure

- `packages/contracts/src/index.ts`: presentation enum, capability registration, and public checkpoint metadata.
- `apps/server/src/schema.ts`, `apps/server/src/migrate.ts`: additive schema versions 2–3 for checkpoint persistence and durable delayed restoration.
- `apps/server/src/store.ts`: transactional checkpoint creation, terminal transition, expiry, and durable delivery state.
- `apps/server/src/checkpoints.ts`: dispatch/retry service for checkpoint activity deliveries.
- `apps/server/src/apns.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`: ActivityKit payload rendering, HTTP orchestration, and periodic/startup reconciliation.
- `packages/relayctl/src/cli.ts`: `--live-activity` and `--no-live-activity` parsing and stable output.
- `ios/RelayCore/LiveActivityInteraction.swift`: testable action/request mapping without UI dependencies.
- `ios/RelayShared/RelayActivityAttributes.swift`: codable task/checkpoint/acknowledgement content state.
- `ios/RelayShared/RelayLiveActivityIntent.swift`: App Intent entry point, background Keychain/config load, authenticated response, and local acknowledgement.
- `ios/RelayWidget/RelayLiveActivityWidget.swift`: Lock Screen and Dynamic Island checkpoint UI.
- `ios/RelayApp/ActivityTokenCoordinator.swift`: capability-aware device registration.
- `ios/project.yml`, generated `ios/Relay.xcodeproj/project.pbxproj`: target membership and build number.

---

### Task 1: Contracts, Capability Registration, and Schema Migration

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`
- Modify: `apps/server/src/schema.ts`
- Modify: `apps/server/src/migrate.ts`
- Test: `apps/server/src/store.test.ts`

**Interfaces:**
- Produces: `liveActivityPresentationSchema` with `"auto" | "required" | "disabled"`.
- Produces: `InteractionCreate.liveActivity`, defaulting to `"auto"`.
- Produces: `DeviceTokenUpdate.capabilities?: { liveActivityInteractions: 1 }`.
- Produces: `activityCheckpoints` rows keyed by `interactionId` and uniquely constrained while unresolved.

- [ ] **Step 1: Write failing contract tests**

Add cases that parse omitted presentation as `auto`, accept all three values, reject Live Activity presentation for `kind: "text"`, and accept the exact capability marker:

```ts
expect(interactionCreateSchema.parse({ prompt: "Deploy?", kind: "approval" }).liveActivity).toBe("auto");
expect(() => interactionCreateSchema.parse({ prompt: "Reply", kind: "text", liveActivity: "required" })).toThrow();
expect(deviceTokenUpdateSchema.parse({ environment: "production", capabilities: { liveActivityInteractions: 1 } }))
  .toMatchObject({ capabilities: { liveActivityInteractions: 1 } });
```

- [ ] **Step 2: Run the focused contract tests and verify failure**

Run: `pnpm --filter @relay/contracts test`
Expected: FAIL because `liveActivity` and `capabilities` are not defined.

- [ ] **Step 3: Implement strict schemas and migration version 2**

Add the presentation schema/refinement, device capability field, nullable `devices.live_activity_interactions_version`, and an `activity_checkpoints` table with:

```text
interaction_id TEXT PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE
activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE
presentation TEXT NOT NULL CHECK (presentation IN ('checkpoint', 'temporary'))
state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'restoring', 'finished'))
result TEXT
created_at INTEGER NOT NULL
resolved_at INTEGER
```

Upgrade `user_version` from 1 through 3 without rebuilding existing tables. Add Drizzle definitions matching the SQL exactly.

- [ ] **Step 4: Test fresh, version-1, and deployed version-2 migrations**

Create version-1 and version-2 in-memory database fixtures, run `migrate`, and assert `user_version = 3`, existing rows remain, and checkpoint/capability plus delivery scheduling columns exist.

Run: `pnpm --filter @relay/server test -- store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts apps/server/src/schema.ts apps/server/src/migrate.ts apps/server/src/store.test.ts
git commit -m "feat: add Live Activity checkpoint contracts"
```

### Task 2: Transactional Checkpoint State Machine

**Files:**
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/store.test.ts`

**Interfaces:**
- Produces: `PublicInteraction.activity?: { id: string; presentation: "checkpoint" | "temporary" }`.
- Produces: `createInteraction(input, key)` returning alert delivery plus optional checkpoint delivery.
- Produces: response/cancel methods returning `{ interaction, activityDelivery? }`.
- Produces: `reconcileExpiredCheckpoints()` and `pendingCheckpointDeliveries()`.

- [ ] **Step 1: Write failing state-machine tests**

Cover these exact cases:

```ts
// auto + active task => checkpoint update delivery
// auto + no task => alert only
// required + no task => temporary start delivery
// disabled => alert only
// required + unresolved checkpoint => ConflictError, no interaction row
// update task behind checkpoint => stored task fields advance, checkpoint remains rendered
// first response wins across device and one-use credential paths
// response/cancel/expiry => restore task or end temporary activity
// idempotent replay returns identical delivery IDs
```

- [ ] **Step 2: Run focused store tests and verify failure**

Run: `pnpm --filter @relay/server test -- store.test.ts`
Expected: FAIL on missing checkpoint fields/methods.

- [ ] **Step 3: Implement checkpoint presentation selection**

Within one SQLite transaction, validate capability support and checkpoint occupancy, create the interaction, associate the active activity or create a temporary activity, increment its sequence, and call `ensureDeliveryIntent` with purposes `checkpoint-show`, `checkpoint-restore`, or `checkpoint-end`. Delivery payloads capture the desired `PublicActivity` plus non-secret checkpoint display state.

- [ ] **Step 4: Implement terminal transitions and expiry reconciliation**

Refactor the existing response application so its transaction records the terminal interaction, resolves the checkpoint, increments the activity sequence, and creates the restore/end delivery. Make cancel and expiry call the same internal transition. Duplicate terminal responses return the existing terminal interaction only when the submitted action agrees; conflicting late actions remain conflicts.

- [ ] **Step 5: Preserve hidden task updates**

Make activity update mutate task fields and sequence while generating a checkpoint-rendering payload when an unresolved association exists. Make activity end/replace finish the presentation without canceling the underlying interaction.

- [ ] **Step 6: Run focused and full server tests**

Run: `pnpm --filter @relay/server test -- store.test.ts`
Expected: PASS.

Run: `pnpm --filter @relay/server test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.test.ts
git commit -m "feat: persist Live Activity checkpoints"
```

### Task 3: APNs Rendering, HTTP Dispatch, and Reconciliation

**Files:**
- Create: `apps/server/src/checkpoints.ts`
- Create: `apps/server/src/checkpoints.test.ts`
- Modify: `apps/server/src/apns.ts`
- Modify: `apps/server/src/apns.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: durable checkpoint deliveries from Task 2.
- Produces: `CheckpointDeliveryService.flush(deliveries?): Promise<CheckpointFlushResult[]>`.
- Produces: activity content state with `presentation` and optional `checkpoint`.

- [ ] **Step 1: Write failing APNs and API tests**

Assert that checkpoint payloads contain prompt, kind, expiry, result, and no credential fields; encoded payloads remain under 4096 bytes; priorities are 10 for start/ack/end and 5 for ordinary restore/update; interaction creation reports alert and activity APNs results separately.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm --filter @relay/server test -- apns.test.ts app.test.ts checkpoints.test.ts`
Expected: FAIL because checkpoint rendering/dispatch does not exist.

- [ ] **Step 3: Implement APNs checkpoint rendering**

Extend `buildActivityPayload` to encode:

```ts
{
  presentation: "task" | "checkpoint" | "acknowledged",
  checkpoint: { interactionId, kind, prompt, expiresAt, result } | null
}
```

Keep attributes unchanged and reuse the liveactivity topic. Reject over-size payloads before opening HTTP/2.

- [ ] **Step 4: Implement durable checkpoint dispatch**

`CheckpointDeliveryService` claims existing delivery rows, resolves the current device push-to-start or matching update token, sends the captured payload, completes the delivery, and leaves retryable failures discoverable. It never logs payload text or tokens.

- [ ] **Step 5: Wire API routes and startup/periodic reconciliation**

Make create/respond/cancel routes async and flush their returned checkpoint deliveries after the interaction alert or state transaction. Response JSON uses separate fields:

```ts
{
  interaction,
  accepted: alert.accepted,
  activityDelivery: { accepted, apnsId, reason } | null
}
```

On startup and every 30 seconds, reconcile expired checkpoints and retry pending checkpoint deliveries. `unref()` the timer and clear it during shutdown.

- [ ] **Step 6: Run server verification**

Run: `pnpm --filter @relay/server test`
Expected: PASS.

Run: `pnpm --filter @relay/server typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/checkpoints.ts apps/server/src/checkpoints.test.ts apps/server/src/apns.ts apps/server/src/apns.test.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/index.ts
git commit -m "feat: dispatch interactive Live Activity checkpoints"
```

### Task 4: Relay CLI Presentation Controls

**Files:**
- Modify: `packages/relayctl/src/cli.ts`
- Modify: `packages/relayctl/src/cli.test.ts`
- Modify: `packages/relayctl/README.md`
- Modify: `skills/relay/SKILL.md`

**Interfaces:**
- Consumes: `InteractionCreate.liveActivity` from Task 1.
- Produces: `--live-activity` => `required`, `--no-live-activity` => `disabled`, omission => `auto`.

- [ ] **Step 1: Write failing CLI tests**

Assert exact request JSON for both flags/default, mutual exclusion, text rejection, stable JSON output containing `activityDelivery`, and unchanged exit codes for approve/deny/timeout.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter relayctl test`
Expected: FAIL because the flags are unknown.

- [ ] **Step 3: Implement flags and documentation**

Add both Boolean flags, validate them before making a request, include `liveActivity`, update help/README, and teach the Relay skill to use `--live-activity` for high-value binary checkpoints without leaking commands, patches, secrets, or file contents.

- [ ] **Step 4: Run CLI tests and typecheck**

Run: `pnpm --filter relayctl test && pnpm --filter relayctl typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayctl/src/cli.ts packages/relayctl/src/cli.test.ts packages/relayctl/README.md skills/relay/SKILL.md
git commit -m "feat: expose Live Activity asks in relayctl"
```

### Task 5: Native App Intent and Interactive Widget UI

**Files:**
- Create: `ios/RelayCore/LiveActivityInteraction.swift`
- Create: `ios/RelayCoreTests/LiveActivityInteractionTests.swift`
- Create: `ios/RelayShared/RelayLiveActivityIntent.swift`
- Modify: `ios/RelayShared/RelayActivityAttributes.swift`
- Modify: `ios/RelayWidget/RelayLiveActivityWidget.swift`
- Modify: `ios/RelayApp/ActivityTokenCoordinator.swift`
- Modify: `ios/RelayCore/Models.swift`
- Modify: `ios/project.yml`
- Regenerate: `ios/Relay.xcodeproj/project.pbxproj`

**Interfaces:**
- Produces: `RelayLiveActivityAction` closed enum and request mapping.
- Produces: `RelayLiveActivityResponseIntent: LiveActivityIntent` with interaction/action parameters.
- Consumes: paired URL from `relayServerURL` and credential from Keychain account `deviceCredential`.

- [ ] **Step 1: Write failing Swift unit tests**

Test approval/yes-no action mapping, authenticated request path/body, rejection of kind/action mismatches, and decoding task/checkpoint/acknowledged content states without any credential property.

- [ ] **Step 2: Run Swift tests and verify failure**

Run: `cd ios && swift test --scratch-path /tmp/relay-live-activity-swift-test`
Expected: FAIL because the new mapper/types do not exist.

- [ ] **Step 3: Implement shared state and testable response mapping**

Add codable `Presentation`, `Checkpoint.Kind`, and `Checkpoint.Result` enums. Keep existing task fields for backwards compatibility and decode absent presentation as `.task`. Add an authenticated request builder for `/v1/device/interactions/:id/respond` using the existing response enum.

- [ ] **Step 4: Implement the LiveActivityIntent**

Load HTTPS URL and Keychain credential directly, submit asynchronously with a bounded URLSession request, accept an already-terminal matching result, and update the matching `Activity<RelayActivityAttributes>` locally to `.acknowledged` only after server success. Return without opening the app. Handle errors inside `perform()` and never display a false acknowledgement.

- [ ] **Step 5: Render interactive Lock Screen and Dynamic Island layouts**

For `.checkpoint`, show prompt, expiry, and two `Button(intent:)` controls in the Lock Screen and expanded bottom region. Compact/minimal regions show `questionmark.circle.fill`; task and ended layouts retain their current progress UI. Add VoiceOver labels and long-prompt truncation.

- [ ] **Step 6: Register client capability and regenerate the project**

Send `{ liveActivityInteractions: 1 }` with push-token registration. Add target membership for the shared intent source, increment `CURRENT_PROJECT_VERSION` from 2 to 3, and run `xcodegen generate` from `ios/`.

- [ ] **Step 7: Run Swift tests and simulator build**

Run: `cd ios && swift test --scratch-path /tmp/relay-live-activity-swift-test`
Expected: PASS.

Run: `xcodebuild -project ios/Relay.xcodeproj -scheme Relay -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/relay-live-activity-derived CODE_SIGNING_ALLOWED=NO build`
Expected: `BUILD SUCCEEDED`.

- [ ] **Step 8: Commit**

```bash
git add ios/RelayCore ios/RelayCoreTests ios/RelayShared ios/RelayWidget ios/RelayApp/ActivityTokenCoordinator.swift ios/project.yml ios/Relay.xcodeproj/project.pbxproj
git commit -m "feat: add interactive Relay Live Activities"
```

### Task 6: End-to-End Verification, Deployment, and TestFlight Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook.md`
- Modify: `.github/workflows/ci.yml` only if the existing commands need the new Swift test target.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: deployable ARM64 server image and TestFlight build 3 with explicit physical gate results.

- [x] **Step 1: Run the complete local verification suite**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all packages PASS.

Run: `cd ios && swift test --scratch-path /tmp/relay-live-activity-swift-test`
Expected: PASS.

Run: `xcodebuild -project ios/Relay.xcodeproj -scheme Relay -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/relay-live-activity-derived CODE_SIGNING_ALLOWED=NO build`
Expected: `BUILD SUCCEEDED`.

- [x] **Step 2: Build and smoke-test the ARM64 container**

Run the repository's existing ARM64 Docker build, migrations, `/healthz`, and `/readyz` checks. Verify version-1 and deployed version-2 databases upgrade to version 3 before touching the Pi database.

- [x] **Step 3: Update runbook and commit verification documentation**

Document CLI examples, APNs-vs-user-response reporting, rollback, migration backup, checkpoint reconciliation, and the still-manual physical gates.

```bash
git add README.md docs/runbook.md .github/workflows/ci.yml
git commit -m "docs: add interactive Live Activity operations"
```

- [x] **Step 4: Back up and deploy to the Raspberry Pi**

Inspect `relay-host.local` first. Back up the live SQLite database and current Compose configuration, deploy the ARM64 image without publishing a host port, run the migration once, and verify both `relay` and `tunnel` containers plus public health/readiness. Do not configure or alter NAS backup destinations without confirmed credentials and target paths.

- [x] **Step 5: Archive, validate, and upload TestFlight build 3**

Use the existing App Store Connect signing and TestFlight workflow. Validate the archive before upload and confirm processing state separately from installation/testing.

- [ ] **Step 6: Ping the user through Relay for physical validation**

Send only the required action and context, for example:

```text
Relay build 3 is ready. Please install it from TestFlight and reply when Activity access is enabled.
```

Then exercise existing-task checkpoint, temporary activity, approve, deny, yes, no, locked-device authentication, terminated UI, cancellation, expiry, late/duplicate taps, tunnel interruption, and Pi restart. Record APNs acceptance, visible Live Activity, and CLI-confirmed response as separate evidence.

Completed on build 3: Relay install ping, capability registration, production remote start, existing-task Approve and Yes checkpoint actions, task restoration, update, and end. The remaining physical gates are recorded explicitly in `docs/operations/physical-acceptance.md`.

- [x] **Step 7: Push the branch and update the draft pull request**

Run: `git push origin codex/relay-implementation`
Expected: remote branch advances; GitHub Actions may remain unavailable and is not substituted for local/device evidence.
