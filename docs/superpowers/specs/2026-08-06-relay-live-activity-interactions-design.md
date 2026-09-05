# Relay Interactive Live Activity Checkpoints

## Summary

Relay will let an approval or yes/no interaction temporarily take over the existing task Live Activity. The Lock Screen and expanded Dynamic Island will show the prompt and native action buttons. After the phone submits a terminal response, Relay briefly acknowledges the choice and restores the task's latest state. If there is no task activity, callers may explicitly request a temporary interaction-only Live Activity that ends after the response, cancellation, or expiry.

This preserves Relay's single-user, one-iPhone, one-active-Live-Activity model. It does not let the phone originate work or instructions; every button can only answer a server-created pending interaction.

## Goals

- Answer approval and yes/no prompts from a Live Activity without opening Relay.
- Treat the prompt as a checkpoint in a continuing task, not as a second task.
- Preserve the existing notification actions as an independent fallback.
- Resolve notification, inbox, and Live Activity responses through one transactional state transition.
- Recover the Live Activity after response, cancellation, expiry, APNs failure, server restart, or duplicate taps.
- Keep reusable device credentials out of ActivityKit content and APNs payloads.

## Non-goals

- Inline text entry in a Live Activity. Text interactions continue through notification text input and the inbox.
- More than one visible checkpoint or more than one active Live Activity.
- Phone-created prompts, Codex instructions, or permission-hook integration.
- Claiming that APNs acceptance proves the device displayed an update.
- Replacing ordinary actionable notifications.

## User Experience

### Task checkpoint

When an approval or yes/no interaction is created while a task Live Activity is active, the server associates the interaction with that activity and advances the activity into `checkpoint` mode. The underlying task row remains active and continues to own its title, status, detail, progress, symbol, accent color, and key.

The Lock Screen and expanded Dynamic Island show:

- the task title;
- the interaction prompt;
- an expiry indication;
- Approve and Deny, or Yes and No buttons;
- accessible labels that include both the action and prompt context.

The compact Dynamic Island remains glanceable and shows an attention symbol rather than attempting to fit two actions. Expanding it reveals the buttons. Deny is visually distinct but is not represented as a system-destructive operation because it does not delete user data.

After a successful response, the activity briefly displays `Approved`, `Denied`, `Yes`, or `No`. It then returns to the latest task state, including any task updates received while the checkpoint was visible. Cancellation and expiry display a short terminal acknowledgement before restoring the task.

### Temporary interaction activity

If no task activity is active, the default interaction behavior remains an actionable notification. A caller may explicitly require Live Activity presentation. The server then remotely starts a temporary activity whose title and task state are derived from the interaction. It ends after acknowledgement, cancellation, or expiry.

If ActivityKit has no usable push-to-start token, APNs rejects the start, or Live Activities are disabled, the ordinary actionable notification remains valid. The interaction response path and CLI wait behavior do not depend on Live Activity presentation.

### Locked devices

The buttons use App Intents. iOS requires the person to authenticate before a button or toggle performs its action on a locked device. Relay does not attempt to bypass or weaken that system behavior.

## CLI and Contract Changes

`relayctl ask` gains Live Activity presentation controls for approval and yes/no interactions:

```text
relayctl ask <prompt> --approval|--yes-no [--live-activity|--no-live-activity]
```

The create-interaction contract adds:

```ts
liveActivity: "auto" | "required" | "disabled" // default: "auto"
```

- `auto`: checkpoint an active task activity; otherwise use the actionable notification only.
- `required`: checkpoint an active task activity or start a temporary interaction activity.
- `disabled`: do not create or modify a Live Activity for this interaction.

`required` requires Relay to create the Live Activity transition, not to claim that the device displayed it. APNs rejection and disabled Live Activities remain observable delivery failures with the notification/inbox fallback.

`--live-activity` maps to `required`, `--no-live-activity` maps to `disabled`, and omission maps to `auto`. Either flag is rejected for text interactions. Mutating commands retain their idempotency key behavior, and idempotency hashes include the presentation value.

The interaction representation gains optional, non-secret presentation metadata:

```ts
activity?: {
  id: string
  presentation: "checkpoint" | "temporary"
}
```

APNs acceptance for the alert and activity transitions is reported separately. A failed Live Activity update does not change a successfully recorded interaction answer.

## Activity State

`RelayActivityAttributes.ContentState` gains a presentation discriminator and optional checkpoint data:

```swift
enum Presentation: String, Codable, Hashable {
    case task
    case checkpoint
    case acknowledged
}

struct Checkpoint: Codable, Hashable {
    let interactionID: String
    let kind: Kind              // approval or yesNo
    let prompt: String
    let expiresAt: Date
    let result: Result?         // set only for acknowledgement
}
```

Content state never contains a CLI token, device credential, response credential, command, patch, secret, or unnecessary file content. The activity's existing monotonic `sequence` remains authoritative for remote updates.

The database adds a one-to-zero-or-one checkpoint association. It records the interaction ID, activity ID, presentation type, checkpoint state, and transition timestamps. Task data is not snapshotted into the checkpoint: restoration renders the current activity row, so task updates that arrive during a prompt are not lost.

Only one unresolved checkpoint may own the active activity. Creation uses a SQLite transaction:

- `auto` with a busy activity creates the interaction and its normal alert but skips Live Activity presentation.
- `required` with a busy activity fails with `409 activity_checkpoint_busy` and creates no interaction.
- `auto` with an older app that has not advertised checkpoint support skips Live Activity presentation; `required` fails with `409 live_activity_interactions_unsupported` and creates no interaction.
- idempotent replay returns the original interaction and transition deliveries without producing another checkpoint.

For a temporary presentation, the server creates the interaction, activity, checkpoint association, alert delivery, and start delivery as one logical idempotent mutation.

## Response and Recovery State Machine

Notification actions, the inbox, and Live Activity intents all call the existing device-authenticated response route. The store validates that the interaction is pending, unexpired, and permits the submitted action. One transaction then:

1. records the terminal interaction response;
2. consumes any one-use response credential involved in the request;
3. changes the associated checkpoint to `acknowledged`;
4. advances the activity sequence;
5. records a durable acknowledgement transition for APNs processing.

The first valid response wins. A competing tap receives the existing terminal result and cannot overwrite it. Action-kind mismatches remain validation failures.

After the acknowledgement update is accepted or its short display interval elapses, the server records a second durable transition:

- task checkpoint: clear the association and update the Live Activity from the current task row;
- temporary activity: end the activity and clear the association.

Cancellation and expiry enter the same transition path. Expiry reconciliation must run when interactions are read, during periodic maintenance, and at server startup so a restart cannot leave a checkpoint permanently visible.

Activity transition intents use the existing deliveries mechanism or an equivalent durable outbox. State changes and their delivery intent are committed together; APNs calls occur after commit. Pending and retryable failed transitions are replayed on startup with bounded backoff. Permanent token errors mark the delivery failed and allow future token rotation/reconciliation to retry the current desired state.

Task update and end operations remain valid while a checkpoint is visible:

- updates persist the latest task fields and sequence but render the checkpoint until it resolves;
- ending the task cancels any pending checkpoint presentation, ends the Live Activity, and leaves the interaction pending through its ordinary notification/inbox channels unless the interaction is separately canceled;
- replacing the task follows the existing monotonic end/start ordering and does not transfer a pending checkpoint implicitly.

## iOS Implementation

The app target defines a `LiveActivityIntent` for binary interaction responses. Its declaration is also available to the widget target so the widget can construct `Button(intent:)` values with only the interaction ID and action. Apple runs a Live Activity intent in the app process without opening the UI, so `perform()` can load Relay's URL and paired device credential from the app's existing configuration and Keychain stores.

The intent:

1. validates the fixed action enum locally;
2. loads the paired configuration directly, without depending on a foreground scene;
3. submits through `/v1/device/interactions/:id/respond`;
4. treats an already-terminal server result as success for duplicate UI taps;
5. applies a local acknowledgement update to the matching active Activity after server acceptance;
6. handles transport and authentication errors without falsely showing success.

The intent implementation uses an injected response client so action mapping and error behavior can be unit tested. It is included where required for App Intents discovery and widget compilation, but credential access remains app-process code. No App Group or shared reusable credential is introduced solely for this feature.

The ordinary notification response queue remains unchanged and independent. A failed Live Activity intent is not silently inserted into that queue because a user may retry the still-visible button and automatic replay could race with a different explicit response.

## Security and Privacy

- Only a pending server-created interaction can be answered.
- The intent action is a closed enum and must match the interaction kind.
- The reusable device credential stays in Keychain and is not serialized into ActivityKit state.
- Activity state includes only display text, identifiers, allowed presentation type, expiry, and terminal acknowledgement.
- Server logs redact authorization headers, APNs tokens, response credentials, prompts, and activity detail.
- Existing request body limits and prompt bounds apply; the encoded ActivityKit content plus APS envelope must remain below Apple's 4 KB update limit.
- Authentication, expiry, cancellation, revocation, and constant-time credential verification remain server-authoritative.
- The phone cannot attach arbitrary text, commands, or new instructions to a binary response.

## Failure Semantics

- APNs acceptance means only that Apple accepted the push.
- If alert delivery succeeds and activity delivery fails, the interaction remains answerable through the notification and inbox.
- If the response succeeds but restore delivery fails, CLI receives the real answer and reconciliation keeps retrying the desired activity state.
- If the app is unpaired or its credential is revoked, the intent shows no success state and the inbox requires re-pairing.
- If an interaction expires before the intent reaches the server, the activity transitions through expiry reconciliation and the tap cannot revive it.
- If no update token is available for an already-started activity, the server records the failed transition and retains enough desired state to reconcile after token rotation.

## Verification

Automated checks will cover:

- contract validation, text-interaction rejection, and ActivityKit payloads below 4 KB;
- `auto`, `required`, `disabled`, busy-checkpoint, idempotent replay, and temporary-activity creation;
- response, cancellation, expiry, duplicate-tap, and notification-versus-Live-Activity races;
- task updates during a checkpoint, task end/replace behavior, monotonic sequences, durable transition replay, and restart reconciliation;
- APNs start/update/end topics, priorities, payloads, and token-error handling;
- CLI parsing, JSON stability, wait exit codes, and idempotency conflicts;
- Swift intent action mapping, Keychain/configuration failure, transport failure, duplicate terminal results, and local acknowledgement;
- Lock Screen, Dynamic Island, stale, ended, accessibility, and long-prompt widget previews;
- iOS app and widget simulator builds.

Physical TestFlight gates over cellular remain explicit:

- checkpoint an existing remotely started task activity;
- approve, deny, yes, and no from the Lock Screen and expanded Dynamic Island;
- verify locked-device authentication and operation while Relay's UI is not open;
- update task state while the checkpoint is visible and confirm restoration uses the newest state;
- exercise expiry, cancellation, duplicate notification/activity taps, and late taps;
- start and end a temporary interaction activity;
- interrupt the tunnel and restart the Pi between response and restoration, then verify reconciliation;
- rotate the ActivityKit update token and verify recovery;
- distinguish APNs acceptance, visible UI, and confirmed user response in the release record.

## Rollout

The schema migration is additive. The server deploys before the app and treats clients that omit `liveActivity` as `auto`, while it must not send checkpoint content until a paired app version advertises support. Device registration therefore gains an app capability/version marker. Older TestFlight builds continue receiving actionable notifications and never receive undecodable checkpoint state.

After the new TestFlight build is installed and registers checkpoint support, the feature is enabled for `auto` and `required` interactions. Rollback disables checkpoint creation server-side, lets pending interactions continue through notifications/inbox, reconciles or ends any active checkpoint, and leaves the underlying task activity data intact.

## References

- [Adding interactivity to widgets and Live Activities](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities)
- [Displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [LiveActivityIntent](https://developer.apple.com/documentation/appintents/liveactivityintent)
