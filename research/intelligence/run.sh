#!/usr/bin/env bash
# Merge Intelligence offline research prototype.
# First run creates a private Python environment in .venv (about a minute); later runs start at once.
#
#   ./run.sh demo ~/MergeIntelligence/demo         # synthetic workspace to try everything
#   ./run.sh check ~/MergeIntelligence/worship     # what was recognised in your files
#   ./run.sh all ~/MergeIntelligence/worship       # profile + every mix + every speech set
#   ./run.sh test                                  # regression suite
#   ./run.sh --help
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3.9 or newer is needed (macOS: install from python.org, or 'xcode-select --install')." >&2
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "Setting up the Python environment in $(pwd)/.venv ..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r requirements.txt
fi
if [ "${1:-}" = "test" ]; then
  shift
  exec .venv/bin/python -m pytest -q -W ignore "$@"
fi
exec .venv/bin/python -W ignore -m mi.cli "$@"
