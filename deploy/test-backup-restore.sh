#!/bin/sh
set -eu

image="${1:-relay:local}"
platform="linux/$(docker image inspect --format '{{.Architecture}}' "$image")"
suffix="$$"
server_name="relay-backup-test-server-$suffix"
data_volume="relay-backup-test-data-$suffix"
backup_volume="relay-backup-test-repository-$suffix"

cleanup() {
  docker rm -f "$server_name" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$backup_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "$data_volume" >/dev/null
docker volume create "$backup_volume" >/dev/null
docker run -d --name "$server_name" --platform "$platform" \
  -v "$data_volume:/data" \
  -e RELAY_DATABASE_URL=/data/relay.sqlite \
  -e RELAY_TOKEN_HASH_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE= \
  -e RELAY_ENCRYPTION_KEY=AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI= \
  -e RELAY_CLI_TOKEN=relay_cli_backup-test-token-with-entropy \
  -e APNS_KEY_ID=VERIFY -e APPLE_TEAM_ID=VERIFY -e APNS_PRIVATE_KEY=dummy \
  -e APNS_BUNDLE_ID=com.example.relay \
  "$image" >/dev/null

attempt=0
until docker exec "$server_name" node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { docker logs "$server_name"; exit 1; }
  sleep 1
done
docker rm -f "$server_name" >/dev/null

docker run --rm --platform "$platform" \
  -v "$backup_volume:/backup" \
  -e RESTIC_REPOSITORY=/backup/repository \
  -e RESTIC_PASSWORD=relay-backup-test-password \
  --entrypoint restic "$image" init

docker run --rm --platform "$platform" \
  -v "$data_volume:/data" -v "$backup_volume:/backup" \
  -e RELAY_DATABASE_URL=/data/relay.sqlite \
  -e RESTIC_REPOSITORY=/backup/repository \
  -e RESTIC_PASSWORD=relay-backup-test-password \
  -e BACKUP_ONCE=1 \
  --entrypoint /app/scripts/backup-loop.sh "$image"

docker run --rm --platform "$platform" \
  -v "$backup_volume:/backup" \
  -e RESTIC_REPOSITORY=/backup/repository \
  -e RESTIC_PASSWORD=relay-backup-test-password \
  --entrypoint sh "$image" -c \
  'restic restore latest --target /backup/restore && node /app/dist/ops.js integrity /backup/restore/backup/relay-snapshot.sqlite'
