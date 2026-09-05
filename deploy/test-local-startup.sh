#!/bin/sh
set -eu
image="${1:-relay:local}"
name="relay-local-test-$$"
volume="$name-data"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker volume create "$volume" >/dev/null
for start in first second; do
  docker run -d --name "$name" --read-only --tmpfs /tmp \
    -v "$volume:/data" \
    -e APNS_KEY_ID=VERIFY -e APPLE_TEAM_ID=VERIFY \
    -e APNS_PRIVATE_KEY=dummy -e APNS_BUNDLE_ID=com.example.relay \
    "$image" >/dev/null
  attempt=0
  until docker exec "$name" node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || { docker logs "$name"; exit 1; }
    sleep 1
  done
  fingerprint=$(docker exec "$name" node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); console.log(crypto.createHash("sha256").update(fs.readFileSync("/data/relay-secrets.json")).digest("hex"))')
  if [ "$start" = first ]; then first_fingerprint="$fingerprint"; else [ "$fingerprint" = "$first_fingerprint" ]; fi
  docker exec "$name" node -e '
    const { RELAY_CLI_TOKEN } = JSON.parse(require("node:fs").readFileSync("/data/relay-secrets.json", "utf8"));
    fetch("http://127.0.0.1:8787/v1/hosts", { headers: { authorization: `Bearer ${RELAY_CLI_TOKEN}` } })
      .then(r => { if (!r.ok) throw new Error("Generated token failed authentication"); })
      .catch(e => { console.error(e.message); process.exit(1); });
  '
  docker rm -f "$name" >/dev/null
done
echo "Local startup, generated token, and container replacement passed"
