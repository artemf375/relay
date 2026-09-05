# Recovery and rotation

## Restore SQLite

Stop Relay and the backup sidecar, choose a known-good restic snapshot, and restore it into an empty temporary directory. Run the offline integrity command against the restored file before replacing the database:

```sh
docker compose stop relay backup
restic snapshots --tag relay-sqlite
restic restore latest --tag relay-sqlite --target /safe/temporary/restore
node apps/server/dist/ops.js integrity /safe/temporary/restore/backup/relay-snapshot.sqlite
```

Preserve the existing database as a rollback copy, install the verified restored snapshot as `relay.sqlite`, then start Relay and verify `/readyz`, authenticated integrity, pairing state, and a real notification. Do not run two writers against the database.

## Credential and key rotation

- CLI token: run `relayctl auth rotate`. If the only CLI credential is lost, stop the service and deliberately provision a new database/bootstrap token or use a documented break-glass procedure; do not add an unauthenticated reset endpoint.
- Phone: choose Unpair in the app, create a new pairing code, then pair again. An app reinstall may retain Keychain data, but treat it as a re-pairing event if registration is uncertain.
- APNs key: mount the replacement `.p8`, update the key ID, recreate Relay, then send a test. Revoke the old key in Apple only after the new key is confirmed.
- Encryption master key: existing encrypted push tokens cannot be re-encrypted without the old key. With both keys available, add an explicit offline migration; otherwise revoke/re-pair the phone so fresh tokens are encrypted with the new key.
- Token-hash key: changing it invalidates all stored credential and pairing-code hashes. Plan a CLI bootstrap rotation and phone re-pairing during the same maintenance window.

## Service interruption

After Pi restart or tunnel loss, pending interactions and checkpoint delivery intents remain in SQLite. Startup reconciliation expires overdue prompts, restores task activities or ends temporary activities, and retries pending checkpoint transitions with bounded backoff. A failed task-end transition retains its per-activity token and remains in the app's activity controls for an explicit retry. A CLI wait timeout does not cancel the interaction; retrieve it later. The app queues failed notification replies locally and retries when launched or foregrounded. Live Activity button failures remain visible for an explicit retry and are not silently queued, avoiding a race with another deliberate response. Confirm the response reached the server before authorizing any sensitive follow-on work.
