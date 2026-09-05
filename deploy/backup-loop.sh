#!/bin/sh
set -eu
umask 077

database_path="${RELAY_DATABASE_URL:-/data/relay.sqlite}"
snapshot_path="/backup/relay-snapshot.sqlite"
interval_seconds="${BACKUP_INTERVAL_SECONDS:-86400}"

while true; do
  node /app/dist/ops.js snapshot "$database_path" "$snapshot_path"
  restic backup "$snapshot_path" --tag relay-sqlite
  restic forget --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
  restic check --read-data-subset=5%
  date -u +'{"ok":true,"completedAt":"%Y-%m-%dT%H:%M:%SZ"}' > /data/backup-status.json
  [ "${BACKUP_ONCE:-0}" = "1" ] && exit 0
  sleep "$interval_seconds"
done
