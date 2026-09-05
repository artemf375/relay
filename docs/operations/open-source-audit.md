# Open-source privacy audit

Audit date: 2026-09-05.

## Current files

- Removed personal names, production hostnames, device activity records, deployment evidence, and private backup paths from tracked documentation.
- Replaced the iOS signing team and bundle identifiers with operator settings. The app and widget read their shared storage groups from generated bundle metadata. Set your own `RELAY_BUNDLE_ID`, `DEVELOPMENT_TEAM`, and matching server `APNS_BUNDLE_ID` before signing.
- Added ignore rules for environment variants, APNs keys, signing exports, local serverless state, build output, and local session state.
- A pattern scan found credential-shaped test fixtures only. Gitleaks 8.30.1 then scanned the current tracked and new publishable text files (about 721 KB) and reported no leaks. This scan is not proof that all possible secrets are absent.

## Historical findings and publication

The original private repository contains personal author metadata, Apple team identifiers, deployment hostnames and paths, and deleted local brainstorming session state.

Gitleaks 8.30.1 scanned all 61 commits available at the initial audit. It found one token in deleted brainstorming server metadata. Inspection confirmed that this was the access key for a local preview server bound to `127.0.0.1`. The preview tool can reuse its local key across restarts, so the key is not assumed expired. It was not an Apple, Cloudflare, Vercel, or Relay production credential.

No production credential was confirmed in the scan. A path audit found no committed `.env`, `.p8`, `.pem`, `.sqlite`, or `.xcconfig` files. These checks do not cover remote-only branches, release assets, external logs, or provider secret stores.

The public repository starts from a fresh source snapshot with no parent commits. It excludes the old history, local session state, ignored secrets, and build output. The original repository remains private. Public GitHub ownership and the new commit author are retained; this is a credential cleanup, not an anonymity claim.

## Verification

XcodeGen generated the project. Both app and widget plists and entitlements passed `plutil` validation, and their shared storage settings match. Xcode resolved the placeholder bundle settings successfully. Ignore rules were checked against local environment, signing, build, and session paths. `git diff --check` passed. The app and widget also passed a generic Simulator build with signing disabled. Their compiled shared storage settings match. All 21 Swift package tests passed with the native build backend; the default backend hit local generated-file signing metadata. A signed device build and production push delivery were not verified.

## Deployment verification

All 129 existing and updated JavaScript/TypeScript tests passed. Two added Vercel tests passed. Project builds and type checks passed, including the Worker and Vercel entry points. The Cloudflare Worker bundle and Linux container image passed `pnpm deploy:check`. The built image also passed startup, backup, and restore checks. Vercel's provider build could not run without a linked project. No live cloud deployment or production Apple push was performed.

The deployment buttons currently reference this repository's GitHub account. That source reference is public identity information, not a runtime credential. Change the source URLs when publishing under another account.
