#!/usr/bin/env bash
# Create crews/.venv and install the pinned CrewAI packages.
# The virtualenv stays out of Paperclip's Node/pnpm tree.

set -euo pipefail

CREW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$CREW_DIR/.venv"
PYTHON="${PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  printf 'python3 is required\n' >&2
  exit 127
fi

version="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
  || {
    printf 'Python 3.10 or newer is required (found %s)\n' "$version" >&2
    exit 1
  }

"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$CREW_DIR/requirements.txt"
printf 'CrewAI environment ready: %s\n' "$VENV/bin/python"
