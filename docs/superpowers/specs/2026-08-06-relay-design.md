# Relay Design

Relay is a private, single-user notification bridge. A local `relayctl` client sends notifications, questions, and task progress to a Raspberry Pi 5. The Pi persists state and sends standard and Live Activity pushes directly through APNs. A native iPhone app displays messages and can answer only server-created pending interactions.

## Modules

- **Relay server:** the durable state owner and only public HTTP interface. It authenticates CLI and device callers, enforces interaction/activity state machines, and hides APNs, SQLite, encryption, and retry behavior behind a compact interface.
- **Relay iPhone app:** pairs once, registers APNs and ActivityKit tokens, handles actionable notifications, retries responses, and displays an inbox plus one task Live Activity.
- **relayctl:** exposes stable commands and JSON output for human and agent callers. It may create work for the phone, but the phone cannot create unsolicited agent instructions.
- **Pi deployment:** runs the server and Cloudflare Tunnel without publishing the server port, and backs up encrypted state to a NAS with restic over SFTP.

## Invariants

- CLI and device credentials are separate, revocable, and stored as keyed hashes.
- APNs tokens are encrypted at rest; Apple provider keys are mounted read-only and never logged.
- Response credentials authorize one unexpired interaction and one allowed action set, once.
- Mutations are idempotent. Live Activity sequences only increase.
- APNs acceptance is not represented as confirmed device delivery.
- Full notification text is allowed by default; iOS preview settings remain the lock-screen privacy control.

## Scope

Version 1 supports one user, one iPhone, ordinary notifications, approval/yes-no/text prompts, a pending/recent inbox, and one task Live Activity. Accounts, billing, analytics, phone-initiated messages, automatic Codex permission hooks, and multi-device routing are excluded.
