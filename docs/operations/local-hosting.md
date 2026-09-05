# Local hosting

The Relay image includes Node.js, the server, SQLite, and automatic database setup. You do not need Node.js, pnpm, or a database service on the host. Images support Intel/AMD machines and ARM64 machines, including Raspberry Pi.

1. Install Docker with Compose.
2. Download [compose.local.yaml](../../compose.local.yaml) into an empty folder.
3. Put your Apple push key in that folder as `AuthKey.p8`. Create a `.env` file with these values:

```dotenv
APNS_KEY_ID=YOUR_KEY_ID
APPLE_TEAM_ID=YOUR_TEAM_ID
APNS_BUNDLE_ID=YOUR_APP_BUNDLE_ID
```

Use the bundle ID of your signed iPhone app. For development builds, also set `APNS_ENVIRONMENT=sandbox`. See [Apple setup](apple-testflight.md).

Start the server:

```sh
docker compose -f compose.local.yaml up -d
curl --fail http://localhost:8787/readyz
```

On first start, Relay generates its keys and CLI token. It stores them with the database in the Docker volume. Restarting or replacing the container preserves them. It never writes credentials to the container log.

Read the CLI token locally:

```sh
docker compose -f compose.local.yaml exec relay node -p 'JSON.parse(require("node:fs").readFileSync("/data/relay-secrets.json", "utf8")).RELAY_CLI_TOKEN'
```

Put the server behind an HTTPS reverse proxy or tunnel, then use that HTTPS address for both the CLI and iPhone. Both clients require HTTPS. `localhost` is only for health checks on the server machine. The [Pi guide](pi-deployment.md) includes a Cloudflare Tunnel and scheduled encrypted backups.

```sh
relayctl configure --url https://YOUR-SERVER --token YOUR_CLI_TOKEN
relayctl pair create
```

Back up the data volume, including `relay-secrets.json`. Stop the server before a file-based volume backup so the SQLite files are consistent. Do not use `docker compose down -v` unless you intend to delete the database and keys. Existing databases still need their original keys; Relay refuses to generate replacement keys for them.

To update:

```sh
docker compose -f compose.local.yaml pull
docker compose -f compose.local.yaml up -d
```

For a fixed version, replace `latest` in the Compose file with the release tag.
