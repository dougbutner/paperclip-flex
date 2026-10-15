#!/usr/bin/env bash
# Paperclip process-adapter entrypoint for the Hermes bridge.
# Register this script as the process command. It does not modify Paperclip.

set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$BRIDGE_DIR/../.." && pwd)"

export HERMES_CREW_ROOT="${HERMES_CREW_ROOT:-$REPO_ROOT}"
if [[ -z "${PYTHONPATH:-}" ]]; then
  export PYTHONPATH="$HERMES_CREW_ROOT"
elif [[ ":${PYTHONPATH}:" != *":${HERMES_CREW_ROOT}:"* ]]; then
  export PYTHONPATH="${HERMES_CREW_ROOT}:${PYTHONPATH}"
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'node is required to run the Hermes bridge\n' >&2
  exit 127
fi

exec node "$BRIDGE_DIR/hermes-runner.mjs" "$@"
