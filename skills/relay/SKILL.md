---
name: using-relay
description: Use when a user is away and Relay is available for notifications, approval and decision buttons in Live Activities, bounded choices, short replies, or task progress.
---

# Using Relay

## Purpose

Relay is a narrow phone bridge. Use it to notify the user, request one bounded response, or show meaningful progress. It does not grant authority and the phone cannot initiate instructions.

## Approvals and decisions

Use Relay when you need the user's approval or a choice to continue. Actionable notifications and Live Activities support buttons, so the user can answer from the phone. Do not ask again for an action already authorized.

- Use `ask --approval` for an exact action that needs permission. The buttons are Approve and Deny.
- Use `ask --yes-no` for a binary decision. The buttons are Yes and No; state clearly what each answer means.
- For more than two choices, use `ask --text`, list short option labels in the prompt, and ask the user to reply with one label. Relay does not support custom choice buttons. Validate the reply against the offered choices before you act.
- Use `--activity <id|key> --live-activity` to put approval or Yes/No buttons on the task's Live Activity. Use `--no-live-activity` for an actionable notification without a Live Activity.
- Wait for a confirmed response before the dependent action. Continue independent work while the question is pending; without `--wait`, save the returned interaction ID and use `interaction wait` when needed. Sending the question is not approval.

## Safety

- Send the minimum context needed to understand the notice or decision.
- Never send secrets, tokens, raw commands, patches, prompts, file contents, absolute paths, customer data, or detailed vulnerability information.
- A phone approval covers only the exact action described. It does not broaden the current task's authority.
- Treat deny, no, timeout, expiry, cancellation, malformed output, and transport errors as no authorization. Leave external state unchanged.
- Do not repeatedly prompt. Send at most one concise follow-up when a response is still genuinely needed.

## Commands

Use JSON output whenever the result drives agent behavior:

```bash
relayctl notify "Verification finished; review is ready." --title "Codex" --json
relayctl ask "Publish the committed branch to the configured remote?" --approval --wait --timeout 10m --json
relayctl ask "Deploy the verified build?" --approval --activity relay-task-7f3a --live-activity --wait --timeout 10m --json
relayctl ask "Include screenshots in the report? Yes includes them; No uses text only." --yes-no --activity relay-task-7f3a --live-activity --wait --timeout 10m --json
relayctl ask "Choose the report format: brief, detailed, or checklist. Reply with one label." --text --wait --timeout 10m --json
relayctl ask "Which short release label should I use?" --text --wait --timeout 10m --json
relayctl interaction wait int_123 --timeout 10m --json
relayctl doctor --json
```

For work lasting several minutes, maintain one activity:

```bash
relayctl activity start --title "Codex task" --status "Building" --key relay-task-7f3a --json
relayctl activity update relay-task-7f3a --status "Testing" --progress 0.8 --json
relayctl activity end relay-task-7f3a --status "Complete" --progress 1 --json
```

Give every task its own stable, non-sensitive key; never reuse a shared key such as `codex-task` across agents. Keep that key for the task lifetime and pass it to related binary asks with `--activity`. Use `--replace` only to deliberately replace an earlier activity owned by the same task. Do not create an activity only to immediately end it.

An untargeted binary ask checkpoints the active task only when exactly one exists; with concurrent tasks it uses a temporary activity. Prefer `--activity <id|key>` so the decision appears on the requesting agent's activity. Use `--live-activity` when an approval or yes/no decision is important enough to require Live Activity presentation. Use `--no-live-activity` for low-value or potentially distracting questions. Never use Live Activity presentation for text replies, and never put a raw command, patch, secret, file path, or file content in the checkpoint prompt.

Several machines may be linked to the same phone, and every notification and interaction records the host that sent it. Run `relayctl host list --json` to see the linked hosts. Do not enroll, revoke, or rotate host credentials on your own initiative; treat `relayctl host enroll`, `relayctl host revoke`, and `relayctl auth rotate` as operations the user requests explicitly, and never send an enrollment code or token through Relay.

## Result handling

- Exit `0`: request accepted or affirmative/text response returned. Inspect JSON status; APNs acceptance is not proof the user saw a notification.
- Inspect `activityDelivery` separately from the top-level alert `accepted` field. A failed ActivityKit push does not invalidate a successful actionable notification or a later confirmed response.
- Exit `4`: timeout, expiry, or cancellation. The interaction can still be queried if it remains pending.
- Exit `5`: deny or no. Do not perform the proposed action.
- Exit `1`: configuration, validation, authentication, or transport failure. Run `relayctl doctor --json` once for actionable diagnostics, then report the bridge failure through the current task rather than guessing.
