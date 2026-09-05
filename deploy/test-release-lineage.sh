#!/bin/sh
set -eu

REPOSITORY_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEST_REPOSITORY=$(mktemp -d "${TMPDIR:-/tmp}/relay-release-lineage.XXXXXX")
trap 'rm -rf "$TEST_REPOSITORY"' EXIT

git -C "$TEST_REPOSITORY" init -q -b main
git -C "$TEST_REPOSITORY" config user.name "Relay Test"
git -C "$TEST_REPOSITORY" config user.email "relay-test@example.invalid"
printf 'base\n' > "$TEST_REPOSITORY/state.txt"
git -C "$TEST_REPOSITORY" add state.txt
git -C "$TEST_REPOSITORY" commit -q -m base
MAIN_COMMIT=$(git -C "$TEST_REPOSITORY" rev-parse HEAD)

git -C "$TEST_REPOSITORY" switch -q -c feature
printf 'feature\n' > "$TEST_REPOSITORY/state.txt"
git -C "$TEST_REPOSITORY" commit -q -am feature
FEATURE_COMMIT=$(git -C "$TEST_REPOSITORY" rev-parse HEAD)

sh "$REPOSITORY_ROOT/deploy/verify-release-lineage.sh" "$MAIN_COMMIT" main "$TEST_REPOSITORY"
if sh "$REPOSITORY_ROOT/deploy/verify-release-lineage.sh" "$FEATURE_COMMIT" main "$TEST_REPOSITORY"; then
  echo "off-main release candidate was incorrectly accepted" >&2
  exit 1
fi

git -C "$TEST_REPOSITORY" switch -q main
git -C "$TEST_REPOSITORY" merge -q --no-ff feature -m "merge feature"
sh "$REPOSITORY_ROOT/deploy/verify-release-lineage.sh" "$FEATURE_COMMIT" main "$TEST_REPOSITORY"

echo "Release lineage guard passed"
