#!/bin/sh
set -eu

config="$({
  RELAY_TOKEN_HASH_KEY=test-token-hash-key \
  RELAY_ENCRYPTION_KEY=test-encryption-key \
  RELAY_CLI_TOKEN=relay_cli_test \
  APNS_KEY_ID=TEST \
  APPLE_TEAM_ID=TEST \
  APNS_BUNDLE_ID=com.example.relay \
  CLOUDFLARE_TUNNEL_TOKEN=test-tunnel-token \
  RESTIC_REPOSITORY=/backup/repository \
  NAS_SSH_KEY_PATH=/tmp/test-nas-key \
  NAS_KNOWN_HOSTS_PATH=/tmp/test-known-hosts \
  docker compose config --format json
})"

printf '%s' "$config" | node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  if (config.services.backup.healthcheck?.disable !== true) {
    console.error("Backup service must disable the Relay HTTP healthcheck");
    process.exit(1);
  }
'
