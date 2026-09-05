#!/bin/sh
set -eu

CANDIDATE_REF=${1:-HEAD}
MAIN_REF=${2:-origin/main}
REPOSITORY=${3:-.}

if ! CANDIDATE_COMMIT=$(git -C "$REPOSITORY" rev-parse --verify "$CANDIDATE_REF^{commit}" 2>/dev/null); then
  echo "Release candidate ref does not resolve to a commit: $CANDIDATE_REF" >&2
  exit 1
fi

if ! MAIN_COMMIT=$(git -C "$REPOSITORY" rev-parse --verify "$MAIN_REF^{commit}" 2>/dev/null); then
  echo "Main ref does not resolve to a commit: $MAIN_REF" >&2
  exit 1
fi

if ! git -C "$REPOSITORY" merge-base --is-ancestor "$CANDIDATE_COMMIT" "$MAIN_COMMIT"; then
  echo "Release blocked: $CANDIDATE_REF is not reachable from $MAIN_REF" >&2
  exit 1
fi

echo "Release lineage verified: $CANDIDATE_REF is reachable from $MAIN_REF"
