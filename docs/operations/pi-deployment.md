# Raspberry Pi deployment

## Host preparation

Use a Raspberry Pi 5 running a 64-bit Raspberry Pi OS/Debian installation with the repository and Docker data on the NVMe/USB SSD. Install Docker Engine and its Compose plugin from Docker's Debian repository. Do not expose TCP 8787 on the host or router.

Create `deploy/secrets/AuthKey.p8` and `deploy/secrets/restic-password`, both mode `0600`. Copy `.env.example` to `.env`, fill the values, and keep all three files out of version control. Generate the two 32-byte keys and CLI bootstrap token exactly as shown in `.env.example`. Store an offline copy of the encryption key, token-hash key, APNs key, restic password, and NAS SSH key; loss of the encryption key makes stored push tokens unrecoverable.

Set `RELAY_ALLOWED_URL_HOSTS` to the exact comma-separated hostnames that notification tap links may open. Leave it empty to disable tap links; wildcards are not supported.

Create a restricted NAS account that can write only the Relay restic repository. Pin the NAS host key in the `known_hosts` file and give its SSH key no shell access if the NAS supports that restriction.

Initialize the encrypted repository once from a trusted host with the same `RESTIC_REPOSITORY`, SSH identity, host-key pin, and restic password that the backup sidecar will use: `restic init`. Confirm a restore to a temporary directory before relying on the schedule.

## Tunnel and startup

Create a remotely managed Cloudflare Tunnel and map one public HTTPS hostname to `http://relay:8787`. Put its scoped tunnel token in `.env`. The Compose file publishes no host port; `cloudflared` reaches Relay only on the private Compose network.

```sh
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 relay tunnel backup
```

The server and backup containers run as the image's unprivileged `node` user with read-only roots. The APNs `.p8` key and restic password are read-only Compose secrets. `restart: unless-stopped`, a server health check, redacted structured server errors, SQLite WAL, and a daily backup loop are enabled.

Before deploying a server version with a database migration, take a consistent SQLite backup and record the running image/commit. Relay schema version 5 adds activity end reasons and a separate encrypted update-token row for every device/activity pair, copying existing matching activity tokens into the new table. Schema version 6 adds the `hosts` table for multiple linked agent machines, scopes enrollment codes to `device` or `host`, and records the originating host on notifications and interactions. A task remains controllable after its ActivityKit stale date until the agent, the app, or an observed user dismissal ends it. The server reconciles expired checkpoints and retries durable ActivityKit transitions at startup and every 30 seconds. Keep the previous image and pre-migration database snapshot until health, readiness, concurrent activity routing, a notification, and a real checkpoint response pass.

## Upgrading to schema 6 (multiple agent hosts)

Relay 0.2.0 is already deployed at schema 5, so this upgrade runs only the version 6 step: it creates `hosts` and adds columns to `enrollment_codes`, `notifications`, and `interactions`. The migration runs automatically at startup inside one transaction; adopting the existing CLI credential as the first host happens immediately afterwards, on the same startup, outside that transaction. Take a snapshot first. Relay is unavailable while the container restarts; send the pre-change Relay notice before starting and a restoration notice after the checks pass.

```sh
relayctl notify "Relay will be briefly unavailable for a schema 6 upgrade. Follow-up after recovery." --title Relay
make backup-once
docker compose build --pull && docker compose up -d relay
docker compose logs --tail=50 relay
```

`make backup-once` takes the same consistent snapshot the sidecar uses and pushes it to restic; keep the resulting snapshot id. Verify the upgrade before linking anything:

```sh
docker compose exec relay node dist/ops.js integrity /data/relay.sqlite
relayctl doctor --json
relayctl host list --json
```

The integrity command must report `ok`, `doctor` must still authenticate with the credential this machine already holds, and `host list` must show exactly one host — the migration adopts the active CLI credential, so the Pi keeps working without reconfiguration. Notifications and interactions created before the upgrade report no origin; that is expected and not a failed migration. A startup log line reporting a schema newer than the server supports means the image predates the database.

Then link another machine. Run the first command on the Pi and the second on the machine being linked, within the 10-minute window:

```sh
relayctl host enroll --json
relayctl configure --url https://relay.example.com --enroll <code> --name mac
relayctl doctor --json
relayctl notify "Linked from the Mac" --title Relay --json
```

Confirm on the phone that the notification arrives, then confirm both hosts are listed and that the Pi still works. `relayctl auth rotate` now replaces only the calling host's credential, and the server refuses to revoke the last linked host. To unlink a machine, run `relayctl host revoke <id|name>` from a different host.

To roll back, redeploy the previous image and restore the pre-upgrade restic snapshot as described in [recovery](recovery.md). An older server refuses to open a schema 6 database, so restoring that snapshot is the only supported downgrade path, and any interaction recorded after the upgrade is lost with it.

## Operational checks

```sh
curl -fsS https://relay.example.com/healthz
relayctl pair create --json
curl -fsS -H "Authorization: Bearer $RELAY_CLI_TOKEN" https://relay.example.com/v1/operations/integrity
curl -fsS -H "Authorization: Bearer $RELAY_CLI_TOKEN" https://relay.example.com/v1/operations/backup-status
```

Avoid putting tokens directly into shell history in routine operation; the curl examples are diagnostic placeholders. Rotate the installed CLI credential with `relayctl auth rotate`, which replaces the local mode-0600 config only after the server atomically issues the new token.

`RELAY_CLI_TOKEN` is used only to bootstrap an empty database, where it becomes the first linked host; `RELAY_CLI_HOST_NAME` names that host and defaults to `primary`. After rotation, the active keyed hash in SQLite remains authoritative across restarts; the original environment value is not reinstalled and cannot undo the rotation. Once at least one host is linked, the environment token is never reinstalled, so link further machines with `relayctl host enroll` rather than by copying the bootstrap token.

The backup sidecar takes a consistent SQLite snapshot, encrypts it with restic, applies 7 daily/5 weekly/12 monthly retention, runs a partial data check, and records its last completion status. Monitor container health, backup age, disk space, tunnel connectivity, and APNs rejection reasons without logging message bodies or credentials.

For checkpoint diagnostics, inspect the CLI JSON fields separately: top-level `accepted`/`apnsId` describe the actionable alert, while `activityDelivery` describes the Live Activity start/update/end request. Neither proves display. A terminal interaction status returned to `relayctl wait` is the authoritative user-response evidence.
