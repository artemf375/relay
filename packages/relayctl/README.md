# relayctl

`relayctl` is the agent-facing client for a private Relay deployment.

```bash
pnpm --filter relayctl build
npm install --global ./packages/relayctl
relayctl configure --url https://relay.example.com --token relay_cli_...
relayctl doctor
relayctl notify "Build finished" --title Codex
relayctl ask "Deploy?" --approval --wait --timeout 10m
relayctl ask "Deploy?" --approval --activity codex-task --live-activity --wait --timeout 10m
```

The configuration is stored at `~/.config/relay/config.json` with mode `0600`. Use `--json` for stable machine-readable output. Exit code `4` means timeout/expiry/cancellation and `5` means deny/no.

Binary asks can target a specific concurrent task activity with `--activity <id|key>`. An untargeted ask uses the only active task, or starts a temporary activity when several tasks are active. Use `--live-activity` to require ActivityKit presentation or `--no-live-activity` to keep the ask in notifications and the inbox. Text asks do not support Live Activity presentation.

Transient DNS, connection, timeout, rate-limit, and server failures receive bounded retries. `relayctl doctor` checks health and authenticated access. With `--json`, transport failures include stable `code`, `retryable`, and `status` fields. The top-level `accepted` field reports the actionable alert; `activityDelivery` independently reports ActivityKit APNs acceptance and is not proof that the phone displayed it.
