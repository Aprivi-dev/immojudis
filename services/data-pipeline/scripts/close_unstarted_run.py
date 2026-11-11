"""Close the requested run when the job failed before the pipeline started.

Standard library only: this script runs when the system packages or the Python dependencies could
not be installed, so nothing of requirements.lock (and nothing of ``src``) may be imported here. The
workflow calls it with ``python3 -I`` when the pipeline step was skipped.

Incident of 11/11/2026 (docs/audits/2026-11-11-collecte-echec-avant-demarrage.md): ``apt-get`` failed,
``src.run_finalizer`` could not even be imported, and the scheduled run stayed ``queued`` until its
one-hour lease expired. Nothing else was dispatched in the meantime.

What it writes, through the Supabase REST API:

* the run named by ``REQUESTED_RUN_ID``, and only while it is still ``queued`` (never claimed by a
  worker): ``status = failed``, ``summary.completion_status = failed_before_start``, the failed stage in
  ``summary.startup_failure`` and a sentence in ``errors.runner``. A ``running`` or finished run is left
  untouched, and so is every other run;
* for a scheduled collection, the source of that run becomes due again
  (``auction_source_state.next_inventory_at``), exactly as the scheduler does after an expired lease.
  Without it the source would wait for the twelve-hour placeholder set when the run was dispatched.
  The failure counter of the source is not touched: the source was never contacted.

The source is made due before the run is closed: if the second request fails, the run stays ``queued``
and the lease expiry (unchanged) does the same work one hour later.

Nothing secret is printed: neither the address, nor the key, nor a response body, nor the text of a
network error (it names the host).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from uuid import UUID

COMPLETION_STATUS = "failed_before_start"
ENRICHMENT_QUEUE = "enrichment-queue"
REQUEST_TIMEOUT_SECONDS = 15
REQUEST_ATTEMPTS = 3
REQUEST_BACKOFF_SECONDS = 2.0

# Preparation steps of data-pipeline.yml, in their order of execution: (environment variable that
# carries the outcome of the step, stage written in the run, wording shown to the operator).
STAGES: tuple[tuple[str, str, str], ...] = (
    ("STARTUP_SYSTEM_PACKAGES_OUTCOME", "system_packages", "installation des paquets système (apt)"),
    ("STARTUP_PYTHON_DEPENDENCIES_OUTCOME", "python_dependencies", "installation des dépendances Python (pip)"),
    ("STARTUP_JUSTICE_REFERENCES_OUTCOME", "justice_references", "vérification des référentiels Justice"),
)
OTHER_STAGE = ("job_preparation", "préparation du job (avant l'installation des paquets)")


class CloseError(Exception):
    """A request could not be completed. The message never carries a secret."""


def failed_stage(environ: dict[str, str]) -> tuple[str, str, str]:
    """Return (stage, wording, outcome) of the first preparation step that did not succeed."""
    for variable, stage, wording in STAGES:
        outcome = environ.get(variable, "").strip().lower()
        if outcome in {"failure", "cancelled"}:
            return stage, wording, outcome
    return (*OTHER_STAGE, "unknown")


def failure_sentence(wording: str, outcome: str) -> str:
    what = "Annulation" if outcome == "cancelled" else "Échec"
    return (
        f"{what} avant démarrage : {wording}. Le pipeline n'a pas démarré : "
        "aucune donnée collectée ni modifiée par ce passage."
    )


def _request(method: str, url: str, key: str, body: dict[str, object] | None = None) -> list[dict[str, object]]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "return=representation"
    problem = "aucune tentative"
    for attempt in range(1, REQUEST_ATTEMPTS + 1):
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8") or "[]")
            if not isinstance(payload, list):
                raise CloseError("réponse inattendue de l'API")
            return [row for row in payload if isinstance(row, dict)]
        except urllib.error.HTTPError as exc:
            problem = f"HTTP {exc.code}"
            if exc.code < 500 and exc.code not in {408, 429}:
                break  # A refusal will not change on a retry.
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            # The text of these errors names the host: only their type is kept.
            problem = type(exc).__name__
        if attempt < REQUEST_ATTEMPTS:
            time.sleep(REQUEST_BACKOFF_SECONDS * attempt)
    raise CloseError(problem)


def _endpoint(base_url: str, table: str, filters: dict[str, str]) -> str:
    return f"{base_url.rstrip('/')}/rest/v1/{table}?{urllib.parse.urlencode(filters)}"


def _summary(lines: list[str]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    except OSError:
        print("Résumé du job non écrit.")


def close_unstarted_run(environ: dict[str, str]) -> int:
    requested = environ.get("REQUESTED_RUN_ID", "").strip()
    if not requested:
        print("Aucun run demandé : rien à clore.")
        return 0
    try:
        run_id = str(UUID(requested))
    except ValueError:
        print("::error title=Clôture du run impossible::REQUESTED_RUN_ID n'est pas un identifiant de run valide.")
        return 1
    base_url = environ.get("SUPABASE_URL", "").strip()
    key = environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not base_url.lower().startswith("https://") and not base_url.lower().startswith("http://"):
        base_url = ""
    if not base_url or not key:
        print(
            "::error title=Clôture du run impossible::SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY absent : "
            f"le run {run_id} reste ouvert jusqu'à l'expiration de son bail."
        )
        return 1

    stage, wording, outcome = failed_stage(environ)
    sentence = failure_sentence(wording, outcome)
    try:
        rows = _request("GET", _endpoint(base_url, "auction_runs", {
            "id": f"eq.{run_id}",
            "select": "id,status,source,scheduler_owned,summary,errors",
        }), key)
        if not rows:
            print(f"Run {run_id} introuvable : rien à clore.")
            return 0
        run = rows[0]
        status = str(run.get("status") or "")
        if status != "queued":
            # « running » : un travailleur l'a réclamé, ce n'est pas à ce job de le clore.
            print(f"Run {run_id} en état « {status} » : laissé intact (seul un run encore « queued » est clos ici).")
            return 0

        now = datetime.now(UTC).isoformat()
        source = str(run.get("source") or "")
        source_due = False
        if run.get("scheduler_owned") is True and source and source != ENRICHMENT_QUEUE:
            rewound = _request("PATCH", _endpoint(base_url, "auction_source_state", {
                "source_name": f"eq.{source}",
                "last_run_id": f"eq.{run_id}",
                "next_inventory_at": f"gt.{now}",
            }), key, {"next_inventory_at": now, "updated_at": now})
            source_due = bool(rewound)

        summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
        errors = run.get("errors") if isinstance(run.get("errors"), dict) else {}
        previous_runner_errors = errors.get("runner") if isinstance(errors.get("runner"), list) else []
        startup_failure: dict[str, object] = {"stage": stage, "outcome": outcome, "reason": wording}
        for name, variable in (("github_run_id", "GITHUB_RUN_ID"), ("github_run_attempt", "GITHUB_RUN_ATTEMPT")):
            if environ.get(variable, "").isdigit():
                startup_failure[name] = int(environ[variable])
        closed = _request("PATCH", _endpoint(base_url, "auction_runs", {
            "id": f"eq.{run_id}",
            "status": "eq.queued",
        }), key, {
            "status": "failed",
            "finished_at": now,
            "updated_at": now,
            "summary": {**summary, "completion_status": COMPLETION_STATUS, "startup_failure": startup_failure},
            "errors": {**errors, "runner": [*previous_runner_errors, sentence]},
        })
    except CloseError as exc:
        print(
            f"::error title=Clôture du run impossible::Base injoignable ou requête refusée ({exc}) : "
            f"le run {run_id} reste ouvert jusqu'à l'expiration de son bail."
        )
        return 1

    if not closed:
        print(f"Run {run_id} : état modifié entre la lecture et la clôture, laissé intact.")
        return 0
    print(f"Run {run_id} clos en échec ({COMPLETION_STATUS}, étape {stage}). {sentence}")
    if source_due:
        print(f"Source {source} : de nouveau due, sans attendre l'expiration du bail.")
    _summary([
        "### Échec avant démarrage",
        f"{sentence}",
        f"Le run `{run_id}` est clos en échec (`{COMPLETION_STATUS}`) : le prochain passage n'attend pas "
        "l'expiration du bail.",
    ])
    return 0


def main() -> int:
    return close_unstarted_run(dict(os.environ))


if __name__ == "__main__":
    sys.exit(main())
