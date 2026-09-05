# Relay

Relay is a self-hosted, single-user notification bridge. A `relayctl` command on any linked machine sends a notification or question to your server. The server stores the request and forwards it to one paired iPhone through APNs. The phone may answer only a pending server-created interaction. Relay does not run an AI model and does not accept phone-initiated commands.

## Deploy the server

**Local hosting:** use the [Docker setup](docs/operations/local-hosting.md). The image contains the server and SQLite. Relay generates its own keys on first start and keeps them in a persistent volume. Supply your Apple push credentials and an HTTPS address.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fartemf375%2Frelay&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22database%22%2C%22integrationSlug%22%3A%22tursocloud%22%7D%5D&env=RELAY_TOKEN_HASH_KEY%2CRELAY_ENCRYPTION_KEY%2CRELAY_CLI_TOKEN%2CAPNS_KEY_ID%2CAPPLE_TEAM_ID%2CAPNS_PRIVATE_KEY%2CAPNS_BUNDLE_ID%2CCRON_SECRET&envDescription=Turso+creates+the+database.+Supply+Relay+secrets+and+Apple+push+settings.+Vercel+Pro+is+required+for+minute+cron+jobs.&envLink=https%3A%2F%2Fgithub.com%2Fartemf375%2Frelay%2Fblob%2Fmain%2Fdocs%2Foperations%2Fcloud-deployment.md)

**Vercel:** the deploy flow creates a Turso database and connects it. Supply the Relay secrets and Apple push credentials. Vercel Pro is required for the one-minute maintenance schedule. See the [cloud setup guide](docs/operations/cloud-deployment.md).

**Advanced Cloudflare setup:** [deploy Workers with Containers](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fartemf375%2Frelay). This still needs a separate Turso database and a paid Workers plan.

The server does not build or sign the iPhone app. See [Apple setup](docs/operations/apple-testflight.md) and the [publication audit](docs/operations/open-source-audit.md).

## Workspace

- `apps/server`: Hono, SQLite/libSQL with Drizzle, direct HTTP/2 APNs provider.
- `packages/contracts`: strict shared TypeScript request contracts.
- `packages/relayctl`: local CLI with human and stable JSON output.
- `ios`: SwiftUI app, RelayCore tests, and ActivityKit widget generated with XcodeGen.
- `skills/relay`: conservative Codex guidance for using `relayctl`.
- `deploy`: non-root Compose services and encrypted restic backup loop.

## Local development

Requires Node.js 22+, pnpm 11, Swift/Xcode, and XcodeGen 2.45.4.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
swift test --package-path ios --disable-sandbox --scratch-path /tmp/relay-swift-build
xcodegen generate --spec ios/project.yml
```

The generated `ios/Relay.xcodeproj` and build products are intentionally ignored. Pass your own `DEVELOPMENT_TEAM` and `RELAY_BUNDLE_ID` to Xcode when signing. Set the server `APNS_BUNDLE_ID` to the same value. No developer account is included.

## CLI

```sh
relayctl configure --url https://relay.example.com --token relay_cli_...
relayctl doctor
relayctl configure --url https://relay.example.com --enroll B37TWPCS --name mac
relayctl pair create
relayctl host enroll
relayctl host list
relayctl host revoke mac
relayctl notify "Build finished" --title Codex
relayctl ask "Deploy?" --approval --wait --timeout 10m
relayctl ask "Deploy?" --approval --activity codex-task --live-activity --wait --timeout 10m
relayctl activity start --title "Codex task" --status "Building" --key codex-task
relayctl auth rotate
```

Several agent hosts may drive one phone. Each machine holds its own CLI credential: run `relayctl host enroll` on a linked host to mint a 10-minute single-use code, then `relayctl configure --url <url> --enroll <code>` on the new machine, which names itself after its hostname unless `--name` is given. Notifications and interactions record the host that sent them, `relayctl host list` shows every linked host with its last API call, and `relayctl host revoke <id|name>` unlinks one machine without touching the others. `relayctl auth rotate` replaces only the calling host's credential. The server refuses to revoke the last linked host.

Every mutating command accepts `--idempotency-key`; otherwise the CLI generates one. `--json` emits one stable JSON value. Exit codes are `0` for accepted/affirmative/text, `4` for timeout/expiry/cancellation, `5` for deny/no, and `1` for local or transport errors. An APNs accepted response is not proof that the phone displayed a notification or that the user acted.

Relay supports multiple concurrent task Live Activities. Target an approval or yes/no checkpoint with `--activity <id|key>`; an untargeted ask uses the only active activity, or a temporary activity when several tasks are active. `--live-activity` requires ActivityKit presentation and `--no-live-activity` disables it. The iPhone app lists every active display and can end one without canceling its agent. Text replies remain in actionable notifications and the inbox.

Transport failures are retried with bounded delays. `relayctl doctor` checks DNS/connectivity, server health, and authenticated API access; JSON errors include a stable diagnostic code instead of the opaque `fetch failed` message.

See [Pi deployment](docs/operations/pi-deployment.md), [Apple/TestFlight setup](docs/operations/apple-testflight.md), and [recovery](docs/operations/recovery.md).

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and pull requests. Read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part. Use [SUPPORT.md](SUPPORT.md) for help and [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE).
