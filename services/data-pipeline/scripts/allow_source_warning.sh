#!/usr/bin/env bash
# Run a pipeline command and treat its "source warning" exit code (2) as a
# warning instead of a failure.
#
# src.main (and src.autonomous_runner) exit with 2 when everything was
# published but at least one enabled source returned no listing or raised an
# error. That must stay visible (the ::warning:: annotations printed by the
# command, plus the step output below) without stopping the later steps of the
# job: cache save, run finalizer, coverage report.
#
# Usage: bash scripts/allow_source_warning.sh python -m src.main --source all
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: allow_source_warning.sh COMMAND [ARGS...]" >&2
  exit 64
fi

code=0
"$@" || code=$?

if [ "$code" -eq 2 ]; then
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "source_warning=true" >> "$GITHUB_OUTPUT"
  fi
  echo "::warning::Collecte partielle : au moins une source activée est en échec (voir les annotations « Source … en échec »)."
  exit 0
fi

exit "$code"
