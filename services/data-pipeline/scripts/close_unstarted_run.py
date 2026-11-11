"""Close the requested run when the job failed before the pipeline started.

Standard library only: this script runs when the system packages or the Python dependencies could
not be installed, so nothing of requirements.lock (and nothing of ``src``) may be imported here. The
workflow calls it with ``python3 -I -S`` (no environment variable, no site-packages) when the pipeline
step was skipped.

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
network error (it names the host). The key is only sent to an ``https`` address and never follows a
redirection.

Time: the requests stop being retried after ``TOTAL_BUDGET_SECONDS``; a watchdog ends the process at
``WATCHDOG_SECONDS`` whatever it is blocked on (a name resolution has no timeout of its own). Both
stay under the timeout of the workflow step.
"""
from __future__ import annotations

import http.client
import json
import os
import sys
import threading
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
# No new attempt after this many seconds, and no request allowed to last beyond it.
TOTAL_BUDGET_SECONDS = 100.0
# Hard stop of the process. The step of data-pipeline.yml allows 180 s (tests/test_startup_resilience.py
# checks the margin).
WATCHDOG_SECONDS = 140.0
# The service key is never sent in clear text.
ALLOWED_SCHEMES: tuple[str, ...] = ("https",)

# Preparation steps of data-pipeline.yml, in their order of execution: (environment variable that
# carries the outcome of the step, stage written in the run, wording shown to the operator).
STAGES: tuple[tuple[str, str, str], ...] = (
    ("STARTUP_SYSTEM_PACKAGES_OUTCOME", "system_packages", "installation des paquets système (apt)"),
    ("STARTUP_PYTHON_DEPENDENCIES_OUTCOME", "python_dependencies", "installation des dépendances Python (pip)"),
    ("STARTUP_JUSTICE_REFERENCES_OUTCOME", "justice_references", "vérification des référentiels Justice"),
)
OTHER_STAGE = ("job_preparation", "préparation du job (avant l'installation des paquets)")
# `job.status` of the workflow: tells a cancellation from a failure when no listed step had started.
JOB_STATUS_VARIABLE = "STARTUP_JOB_STATUS"


class CloseError(Exception):
    """A request could not be completed. The message never carries a secret."""


def failed_stage(environ: dict[str, str]) -> tuple[str, str, str]:
    """Return (stage, wording, outcome) of the first preparation step that did not succeed."""
    for variable, stage, wording in STAGES:
        outcome = environ.get(variable, "").strip().lower()
        if outcome in {"failure", "cancelled"}:
            return stage, wording, outcome
    job_status = environ.get(JOB_STATUS_VARIABLE, "").strip().lower()
    return (*OTHER_STAGE, job_status if job_status in {"failure", "cancelled"} else "unknown")


def failure_sentence(wording: str, outcome: str) -> str:
    what = "Annulation" if outcome == "cancelled" else "Échec"
    return (
        f"{what} avant démarrage : {wording}. Le pipeline n'a pas démarré : "
        "aucune donnée collectée ni modifiée par ce passage."
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirection would carry the service key to another address: it is an error instead."""

    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _valid_base_url(value: str) -> bool:
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return parts.scheme.lower() in ALLOWED_SCHEMES and bool(parts.netloc)


def _request(
    method: str, url: str, key: str, body: dict[str, object] | None = None, *, deadline: float
) -> list[dict[str, object]]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "return=representation"
    problem = "délai global dépassé"
    for attempt in range(1, REQUEST_ATTEMPTS + 1):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            with _OPENER.open(request, timeout=min(REQUEST_TIMEOUT_SECONDS, left)) as response:
                payload = json.loads(response.read().decode("utf-8") or "[]")
            if not isinstance(payload, list):
                raise CloseError("réponse inattendue de l'API")
            return [row for row in payload if isinstance(row, dict)]
        except urllib.error.HTTPError as exc:
            problem = f"HTTP {exc.code}"
            if exc.code < 500 and exc.code not in {408, 429}:
                break  # A refusal will not change on a retry.
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError) as exc:
            # The text of these errors names the host or the address: only their type is kept.
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
    # Checked before anything is sent: the key only ever leaves for an https address.
    if not _valid_base_url(base_url) or not key:
        print(
            "::error title=Clôture du run impossible::SUPABASE_URL (https obligatoire) ou "
            f"SUPABASE_SERVICE_ROLE_KEY absent ou invalide : le run {run_id} reste ouvert jusqu'à "
            "l'expiration de son bail."
        )
        return 1
    deadline = time.monotonic() + TOTAL_BUDGET_SECONDS
    run_query = _endpoint(base_url, "auction_runs", {
        "id": f"eq.{run_id}",
        "select": "id,status,source,scheduler_owned,summary,errors",
    })

    stage, wording, outcome = failed_stage(environ)
    sentence = failure_sentence(wording, outcome)
    try:
        rows = _request("GET", run_query, key, deadline=deadline)
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
            }), key, {"next_inventory_at": now, "updated_at": now}, deadline=deadline)
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
        }, deadline=deadline)
        already_closed = False
        if not closed:
            # Either a worker claimed the run meanwhile, or the answer to a first PATCH was lost and its
            # retry found nothing left to close: read the run again before saying which.
            current = (_request("GET", run_query, key, deadline=deadline) or [{}])[0]
            current_summary = current.get("summary") if isinstance(current.get("summary"), dict) else {}
            already_closed = (
                current.get("status") == "failed" and current_summary.get("completion_status") == COMPLETION_STATUS
            )
            if not already_closed:
                print(
                    f"Run {run_id} : état modifié entre la lecture et la clôture "
                    f"(« {current.get('status') or 'inconnu'} »), laissé intact."
                )
                return 0
    except CloseError as exc:
        print(
            f"::error title=Clôture du run impossible::Base injoignable ou requête refusée ({exc}) : "
            f"le run {run_id} reste ouvert jusqu'à l'expiration de son bail."
        )
        return 1

    if already_closed:
        print(f"Run {run_id} déjà clos en échec ({COMPLETION_STATUS}) : la réponse à la clôture s'était perdue.")
    else:
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


def _abort() -> None:
    print(
        "::error title=Clôture du run impossible::Délai global dépassé (réseau ou résolution de nom bloqués) : "
        "le run reste ouvert jusqu'à l'expiration de son bail.",
        flush=True,
    )
    os._exit(1)


def main() -> int:
    # A thread, not a signal: it also ends a main thread blocked in a name resolution.
    watchdog = threading.Timer(WATCHDOG_SECONDS, _abort)
    watchdog.daemon = True
    watchdog.start()
    try:
        return close_unstarted_run(dict(os.environ))
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    sys.exit(main())
