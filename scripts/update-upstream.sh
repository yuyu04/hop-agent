#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
upstream_ref="${UPSTREAM_REF:-}"

if [[ -z "$upstream_ref" ]]; then
  echo "UPSTREAM_REF is required and must be a stable release tag such as v0.7.19." >&2
  echo "Preferred command: pnpm upstream:update -- v0.7.19" >&2
  exit 2
fi

exec node "$repo_root/scripts/update-rhwp-upstream.mjs" "$upstream_ref" "$@"
