# Contributing to Relay

Thanks for helping with Relay. Read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part. Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Start with the problem

Use the [issue forms](https://github.com/artemf375/relay/issues/new/choose) for reproducible bugs and feature proposals. Check existing issues first. For a large change, describe the problem and proposed behavior before writing code. Small fixes and documentation improvements can go straight to a pull request.

Relay is a self-hosted bridge for one operator and one paired iPhone. Several agent hosts can connect to it. Changes must preserve authentication, encrypted stored tokens, request idempotency, and the rule that the phone can answer only server-created interactions. Discuss changes to this scope before implementation.

The repository owner maintains Relay and makes final decisions on scope and merges. Reviews are on a best-effort basis; there is no promised response time.

## Set up a fork

Fork the public repository, clone your fork, and create a branch from `main`. Open pull requests against `artemf375/relay:main`.

For server, CLI, and documentation work, use Node.js 22 or later and the pinned pnpm version in `package.json`. You do not need Apple credentials to run the TypeScript tests.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The [README](README.md#workspace) maps the source directories. Use [cloud deployment](docs/operations/cloud-deployment.md) or [local hosting](docs/operations/pi-deployment.md) if you need a running server. Unit tests use test credentials and a local database. Never connect tests to your live database or phone.

For iOS work, use macOS, Xcode with the iOS 26 SDK, Swift 6.2 or later, and XcodeGen. The exact CI toolchain is in [.github/workflows/ci.yml](.github/workflows/ci.yml). Generate the project with `xcodegen generate --spec ios/project.yml`. Keep the generated project out of Git. Use native SwiftUI for UI changes.

## Make and check the change

Keep one purpose per pull request. Reuse existing code and dependencies. Explain why a new dependency is needed. Do not add compatibility layers or database downgrade paths without prior agreement.

For TypeScript changes, run:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Add a regression test for changed behavior. Test the observable result, not just implementation details. Documentation-only changes need working links and correct commands; they do not need new application tests.

For iOS changes, run the relevant Swift and app tests:

```sh
swift test --package-path ios --disable-sandbox
xcodegen generate --spec ios/project.yml
xcodebuild test -project ios/Relay.xcodeproj -scheme Relay -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RelayAppTests CODE_SIGNING_ALLOWED=NO
```

Select an installed simulator if that device is unavailable. A simulator build does not verify APNs or Live Activities on a physical phone. State when a device check is still needed. Signing a device build requires your own Apple team, bundle ID, and matching server settings.

For container or deployment changes, Docker must be running:

```sh
sh deploy/test-compose-health.sh
pnpm deploy:check
sh deploy/test-backup-restore.sh relay-relaycontainer:worker
```

The dry run builds the Worker and container without publishing. The backup check uses disposable test volumes. Vercel's provider build needs a linked test project. Never deploy a contributor branch to a live service as part of a test.

## Open a pull request

Explain the problem, the resulting behavior, and how you checked it. Link the related issue, if one exists. Include screenshots for visible UI changes and list checks you could not run. Describe database schema changes, deployment impact, and any required operator action.

Do not include tokens, `.env` files, signing keys, device identifiers, database exports, or private notification content in commits, logs, or screenshots. Use made-up values in examples. If you find an exposed credential, follow [SECURITY.md](SECURITY.md).

By submitting a contribution, you agree that it can be distributed under the repository's [MIT license](LICENSE). Submit only material you have the right to contribute. If you use generated code, review it and verify its behavior before submission.
