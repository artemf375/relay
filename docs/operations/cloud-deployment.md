# Cloud deployment

Relay runs one private phone bridge per deployment. Each deployment needs its own database and secrets. Do not point separate test and production deployments at the same database.

## Before you click Deploy

1. Create an empty [Turso database](https://docs.turso.tech/introduction) and a database auth token. Use its `libsql://` URL. Relay creates its tables on first start. A compatible hosted libSQL service with interactive transactions also works.
2. Create your own Apple App ID with Push Notifications and an APNs signing key. Build the iOS app with your own team and bundle ID. See [Apple setup](apple-testflight.md).
3. Generate the Relay secrets below. Keep each value in your password manager. Enter them as provider secrets, never as source code or build arguments.
4. Select a button in the root README. Import the **whole repository**, with its root directory unchanged.

The buttons start a guided setup. They cannot create your Apple developer account, sign an iPhone app, or supply your private credentials.

## Required values

| Variable | Value |
| --- | --- |
| `RELAY_DATABASE_URL` | Your remote `libsql://` or `https://` database URL. Local files are rejected in cloud deployments. |
| `RELAY_DATABASE_AUTH_TOKEN` | A token that can read and write that database. |
| `RELAY_TOKEN_HASH_KEY` | A random 32-byte key, encoded as base64. |
| `RELAY_ENCRYPTION_KEY` | A different random 32-byte key, encoded as base64. |
| `RELAY_CLI_TOKEN` | A random CLI bootstrap credential beginning with `relay_cli_`. |
| `APNS_KEY_ID` | Your Apple push signing key ID. |
| `APPLE_TEAM_ID` | Your Apple developer team ID. |
| `APNS_PRIVATE_KEY` | The contents of your `.p8` key. Literal `\n` sequences are accepted. |
| `APNS_BUNDLE_ID` | The exact bundle ID of the app you signed. There is no default. |
| `CRON_SECRET` | Vercel only: a random secret for the maintenance endpoint. |

Generate each hash/encryption key separately:

```sh
openssl rand -base64 32
```

Generate the CLI token:

```sh
printf 'relay_cli_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
```

Generate the Vercel cron secret:

```sh
openssl rand -hex 32
```

Optional values:

- `APNS_ENVIRONMENT`: `production` by default. Set `sandbox` for an Apple development build. TestFlight uses `production`.
- `RELAY_ALLOWED_URL_HOSTS`: comma-separated HTTPS hostnames allowed in notification tap links. Empty disables these links.

Keep the encryption and hash keys stable across deploys. Changing them makes stored credentials or encrypted tokens unusable. Use `relayctl auth rotate` to rotate a linked host credential. The bootstrap token does not replace an existing active host on restart.

## Cloudflare Workers with Containers

This deployment uses a Worker to route to one Node.js Container. The Container runs the same server as local hosting, including its HTTP/2 Apple push client. The database is remote because container disks are temporary. This is not a plain Worker-isolate deployment.

A paid Workers account with Containers enabled is required. The minute cron keeps the server awake so it can expire interactions and retry checkpoint delivery. Budget for a running container plus database usage.

The deploy button reads the required secrets from `.dev.vars.example`. Keep the generated Worker and Container binding configuration. No account IDs, zone IDs, tunnel tokens, or personal domains are needed. The root build command is `pnpm build`; the default provider deploy command is `npx wrangler deploy`.

For a CLI deployment, set the same secrets with `pnpm exec wrangler secret put NAME`, then run `pnpm deploy:cloudflare`. Docker must be running for the container image build. `pnpm deploy:check` checks the Worker bundle without publishing it.

See [Cloudflare deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/), [Containers setup](https://developers.cloudflare.com/containers/get-started/), and [Containers pricing](https://developers.cloudflare.com/containers/pricing/).

## Vercel

The template uses Node.js Functions, with a 60-second invocation limit for long polling and push delivery. Vercel Pro is required for the included one-minute cron. Hobby cannot run this schedule. Keep the default root directory and `vercel.json` settings.

Set `CRON_SECRET` as a Vercel environment secret. Vercel sends it as a bearer credential to `/api/maintenance`. Unauthenticated requests are rejected. The job expires interactions, retries checkpoint delivery, and removes old records. Scheduled delivery can be delayed; cron is not an exact timer.

Checkpoint acknowledgements complete within the current request. The server does not rely on untracked timers after a function response. The database uses transactions and delivery claims across instances.

Use separate database credentials for Preview and Production, or leave Preview unconfigured. Do not enable real phone delivery from arbitrary pull-request previews. If Vercel Deployment Protection covers your production URL, configure it to permit the CLI and phone to reach the production API; Relay still requires its own credentials.

See [Vercel deploy buttons](https://vercel.com/docs/deploy-button), [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), and [function duration](https://vercel.com/docs/functions/configuring-functions/duration).

## Verify the result

Use the provider's production HTTPS URL:

```sh
curl --fail https://YOUR-SERVER/readyz
relayctl configure --url https://YOUR-SERVER --token YOUR-CLI-TOKEN
relayctl doctor
relayctl pair create
```

Pair the signed iPhone app, then send a test notification and a question. Restart or redeploy the server and check that the linked hosts, phone, and inbox remain. Test Live Activity start, update, response, and end on a physical iPhone.

Cloud database backups are managed by the database provider. The local restic backup service is not deployed to either cloud platform. Set a retention policy and test restoration with your provider. Relay's local backup-status endpoint does not report cloud backup success.
