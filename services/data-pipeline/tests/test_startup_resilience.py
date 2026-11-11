"""A job that fails before the pipeline starts: bounded apt retries, and its run closed at once.

Incident of 11/11/2026 (docs/audits/2026-11-11-collecte-echec-avant-demarrage.md).
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest
from test_workflow_security import WORKFLOWS, parse_jobs

from scripts import close_unstarted_run

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
INSTALLER = SCRIPTS / "install_system_packages.sh"
CLOSER = SCRIPTS / "close_unstarted_run.py"

RUN_ID = "11111111-1111-4111-8111-111111111111"
OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222"
SERVICE_KEY = "service-role-key-that-must-never-be-printed"

# --- install_system_packages.sh ---------------------------------------------------------------

# Stand-in for apt-get: journals each call, then fails, hangs or succeeds according to FAKE_APT_MODE.
FAKE_APT = """#!/usr/bin/env bash
echo "$*" >> "$FAKE_APT_LOG"
calls=$(wc -l < "$FAKE_APT_LOG")
case "$FAKE_APT_MODE" in
  ok) exit 0 ;;
  fail-first) if [ "$calls" -le "$FAKE_APT_FAILURES" ]; then echo "Temporary failure resolving 'mirror.invalid'" >&2; exit 100; fi; exit 0 ;;
  fail-download-once) if [[ "$*" == *--download-only* ]] && [ ! -e "$FAKE_APT_LOG.failed" ]; then touch "$FAKE_APT_LOG.failed"; exit 100; fi; exit 0 ;;
  always-fail) exit 100 ;;
  fail-update-only) if [ "$1" = "update" ]; then exit 100; fi; exit 0 ;;
  hang) sleep 60 ;;
  hang-update) if [ "$1" = "update" ]; then sleep 60; fi; exit 0 ;;
  fail-local) if [[ "$*" == *--no-download* ]]; then exit 7; fi; exit 0 ;;
esac
"""


def _install(tmp_path: Path, mode: str, *packages: str, **settings: str) -> tuple[subprocess.CompletedProcess[str], list[str], float]:
    fake = tmp_path / "fake-apt-get"
    fake.write_text(FAKE_APT, encoding="utf-8")
    fake.chmod(0o755)
    log = tmp_path / "apt.log"
    log.touch()
    env = {
        "PATH": os.environ["PATH"],
        "SYSTEM_PACKAGES_APT_COMMAND": str(fake),
        "SYSTEM_PACKAGES_BACKOFF_SECONDS": "1",
        "FAKE_APT_MODE": mode,
        "FAKE_APT_LOG": str(log),
        **settings,
    }
    started = time.monotonic()
    result = subprocess.run(
        ["bash", str(INSTALLER), *packages], env=env, capture_output=True, text=True, timeout=60, check=False
    )
    return result, log.read_text(encoding="utf-8").splitlines(), time.monotonic() - started


def test_a_healthy_mirror_installs_in_one_attempt_network_first_then_local(tmp_path: Path) -> None:
    result, calls, _ = _install(tmp_path, "ok", "antiword", "tesseract-ocr")

    assert result.returncode == 0, result.stdout + result.stderr
    assert len(calls) == 3
    update, download, install = calls
    assert update.startswith("update ") and "APT::Update::Error-Mode=any" in update
    assert "--download-only" in download and download.endswith("antiword tesseract-ocr")
    assert "--no-download" in install and install.endswith("antiword tesseract-ocr")
    # The network commands carry apt's own bounded retry and timeouts; the local one needs none.
    for call in (update, download):
        assert "Acquire::Retries=1" in call and "Acquire::http::Timeout=15" in call
    assert "Acquire::" not in install
    assert "::error" not in result.stdout


def test_a_passing_outage_is_retried_and_the_job_goes_on(tmp_path: Path) -> None:
    # The first two `apt-get update` fail (the DNS outage of 11/11/2026), the third works.
    result, calls, _ = _install(tmp_path, "fail-first", "antiword", FAKE_APT_FAILURES="2")

    assert result.returncode == 0, result.stdout + result.stderr
    assert [call.split()[0] for call in calls] == ["update", "update", "update", "install", "install"]
    assert "tentative 3/3" in result.stdout and "nouvelle tentative dans 1 s" in result.stdout
    assert "nouvelle tentative dans 2 s" in result.stdout  # the wait grows
    assert "::error" not in result.stdout


def test_a_failed_download_restarts_from_the_index(tmp_path: Path) -> None:
    result, calls, _ = _install(tmp_path, "fail-download-once", "antiword")

    assert result.returncode == 0, result.stdout + result.stderr
    assert [("update" if call.startswith("update") else "download" if "--download-only" in call else "local")
            for call in calls] == ["update", "download", "update", "download", "local"]


def test_a_lasting_failure_stops_after_the_last_attempt_with_an_explicit_error(tmp_path: Path) -> None:
    result, calls, _ = _install(tmp_path, "always-fail", "antiword", "tesseract-ocr")

    assert result.returncode == 100  # apt's own code, not swallowed
    # Three index refreshes, then one last download with the indexes at hand, which fails as well.
    assert [call.split()[0] for call in calls] == ["update", "update", "update", "install"]
    assert "--download-only" in calls[-1]
    assert not any("--no-download" in call for call in calls)  # nothing is installed
    errors = [line for line in result.stdout.splitlines() if line.startswith("::error")]
    assert len(errors) == 1
    assert "Installation des paquets système impossible" in errors[0]
    assert "antiword tesseract-ocr" in errors[0] and "3 tentative(s)" in errors[0]


def test_a_broken_repository_the_packages_do_not_need_does_not_stop_the_job(tmp_path: Path) -> None:
    # `apt-get update` keeps failing (one unrelated repository is down) but the packages download.
    result, calls, _ = _install(tmp_path, "fail-update-only", "antiword")

    assert result.returncode == 0, result.stdout + result.stderr
    assert [call.split()[0] for call in calls] == ["update", "update", "update", "install", "install"]
    assert "--download-only" in calls[3] and "--no-download" in calls[4]
    assert "::warning title=Index apt incomplet::" in result.stdout and "::error" not in result.stdout


def test_a_repository_that_hangs_leaves_the_time_of_the_last_download(tmp_path: Path) -> None:
    # Every `apt-get update` hangs (a repository that does not answer), the packages themselves download.
    # The last attempt keeps the 3 s of the download instead of spending them on one more update.
    result, calls, elapsed = _install(
        tmp_path, "hang-update", "antiword",
        SYSTEM_PACKAGES_DEADLINE_SECONDS="10", SYSTEM_PACKAGES_UPDATE_TIMEOUT="2", SYSTEM_PACKAGES_DOWNLOAD_TIMEOUT="3",
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert elapsed < 20
    kinds = [call.split()[0] for call in calls]
    assert kinds[:2] == ["update", "update"] and kinds[-2:] == ["install", "install"]
    assert "--download-only" in calls[-2] and "--no-download" in calls[-1]
    assert "::warning title=Index apt incomplet::" in result.stdout and "::error" not in result.stdout


def test_the_default_budget_reserves_the_last_download() -> None:
    # Two updates cut at their timeout and the two waits: what is left must cover a download attempt.
    text = INSTALLER.read_text(encoding="utf-8")
    d = {name: int(value) for name, value in re.findall(r'"\$\{SYSTEM_PACKAGES_([A-Z_]+):-(\d+)\}"', text)}
    spent = 2 * d["UPDATE_TIMEOUT"] + d["BACKOFF_SECONDS"] + 2 * d["BACKOFF_SECONDS"]

    assert d["DEADLINE_SECONDS"] - spent >= 30


def test_the_apt_stand_in_is_refused_on_a_runner(tmp_path: Path) -> None:
    result, calls, _ = _install(tmp_path, "ok", "antiword", GITHUB_ACTIONS="true")

    assert result.returncode == 64 and calls == []
    assert "SYSTEM_PACKAGES_APT_COMMAND est réservée aux tests" in result.stdout


def test_a_hanging_mirror_is_cut_at_the_deadline(tmp_path: Path) -> None:
    # Each apt-get would hang for 60 s: the 4 s budget of the network phase ends the script.
    result, calls, elapsed = _install(
        tmp_path, "hang", "antiword",
        SYSTEM_PACKAGES_DEADLINE_SECONDS="4", SYSTEM_PACKAGES_UPDATE_TIMEOUT="2", SYSTEM_PACKAGES_MAX_ATTEMPTS="5",
    )

    assert result.returncode == 124
    assert elapsed < 12
    assert 1 <= len(calls) <= 3 and all(call.startswith("update") for call in calls)
    assert "interrompue par le délai d'attente" in result.stdout
    assert "::error title=Installation des paquets système impossible::" in result.stdout


def test_a_failed_local_installation_is_reported_and_not_retried(tmp_path: Path) -> None:
    result, calls, _ = _install(tmp_path, "fail-local", "antiword")

    assert result.returncode == 7
    assert len(calls) == 3
    assert "installation locale a échoué (code 7)" in result.stdout


def test_default_budget_of_a_lasting_outage_stays_under_three_minutes() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    defaults = {name: int(value) for name, value in re.findall(r'"\$\{SYSTEM_PACKAGES_([A-Z_]+):-(\d+)\}"', text)}

    assert defaults["MAX_ATTEMPTS"] == 3
    # The network phase, the only one that depends on the mirror, plus the 5 s granted to a kill.
    assert defaults["DEADLINE_SECONDS"] + 5 <= 180
    assert defaults["UPDATE_TIMEOUT"] + defaults["DOWNLOAD_TIMEOUT"] <= defaults["DEADLINE_SECONDS"]


def test_invalid_usage_is_refused(tmp_path: Path) -> None:
    assert _install(tmp_path, "ok")[0].returncode == 64
    result, calls, _ = _install(tmp_path, "ok", "antiword", SYSTEM_PACKAGES_MAX_ATTEMPTS="0")
    assert result.returncode == 64 and calls == []


# --- close_unstarted_run.py -------------------------------------------------------------------


class FakeSupabase:
    """Just enough of PostgREST: `eq.` and `gt.` filters on two tables, GET and PATCH."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, object]]] = {"auction_runs": [], "auction_source_state": []}
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.fail_with: int | None = None
        self.fail_patch_of: str | None = None
        store = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                return

            def _handle(self, method: str) -> None:
                parts = urlsplit(self.path)
                table = parts.path.removeprefix("/rest/v1/")
                filters = dict(parse_qsl(parts.query))
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                store.requests.append((method, table, {name.lower(): value for name, value in self.headers.items()}))
                status, payload = store.answer(method, table, filters, body)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:  # noqa: N802
                self._handle("GET")

            def do_PATCH(self) -> None:  # noqa: N802
                self._handle("PATCH")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, method: str, table: str, filters: dict[str, str], body: object) -> tuple[int, object]:
        if self.fail_with is not None or (method == "PATCH" and table == self.fail_patch_of):
            return self.fail_with or 503, {"message": f"secret detail {SERVICE_KEY}"}
        if table not in self.tables:
            return 404, {}
        filters.pop("select", None)
        matched = []
        for row in self.tables[table]:
            for column, condition in filters.items():
                operator, _, value = condition.partition(".")
                current = row.get(column)
                if operator == "eq" and str(current).lower() != value.lower():
                    break
                if operator == "gt" and not str(current) > value:
                    break
            else:
                matched.append(row)
        if method == "PATCH":
            for row in matched:
                row.update(body)  # type: ignore[arg-type]
        return 200, matched

    def run(self, run_id: str) -> dict[str, object]:
        return next(row for row in self.tables["auction_runs"] if row["id"] == run_id)

    def source(self, name: str) -> dict[str, object]:
        return next(row for row in self.tables["auction_source_state"] if row["source_name"] == name)


def _queued_run(run_id: str = RUN_ID, source: str = "agrasc", **changes: object) -> dict[str, object]:
    return {
        "id": run_id,
        "status": "queued",
        "source": source,
        "scheduler_owned": True,
        "finished_at": None,
        "updated_at": "2026-11-11T14:30:02+00:00",
        "summary": {"trigger": "autonomous", "github_dispatch": {"state": "accepted", "attempt": 1}},
        "errors": {},
        **changes,
    }


def _source_state(name: str, run_id: str) -> dict[str, object]:
    # The scheduler's placeholder while the dispatched run is pending: far in the future.
    return {"source_name": name, "last_run_id": run_id, "next_inventory_at": "2999-01-01T00:00:00+00:00",
            "consecutive_failures": 0, "updated_at": "2026-11-11T14:30:02+00:00"}


@pytest.fixture
def supabase() -> Iterator[FakeSupabase]:
    fake = FakeSupabase()
    try:
        yield fake
    finally:
        fake.server.shutdown()
        fake.server.server_close()


def _environment(supabase: FakeSupabase, run_id: str = RUN_ID, **extra: str) -> dict[str, str]:
    return {
        "SUPABASE_URL": supabase.url,
        "SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY,
        "REQUESTED_RUN_ID": run_id,
        "STARTUP_SYSTEM_PACKAGES_OUTCOME": "failure",
        "STARTUP_PYTHON_DEPENDENCIES_OUTCOME": "skipped",
        "STARTUP_JUSTICE_REFERENCES_OUTCOME": "skipped",
        **extra,
    }


def test_the_script_imports_nothing_outside_the_standard_library() -> None:
    tree = ast.parse(CLOSER.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0
            imported.add((node.module or "").split(".")[0])

    assert imported - {"__future__"} <= sys.stdlib_module_names
    assert "src" not in imported


def test_an_open_run_is_closed_as_failed_before_start_in_an_isolated_interpreter(
    supabase: FakeSupabase, tmp_path: Path
) -> None:
    supabase.tables["auction_runs"] += [_queued_run(), _queued_run(OTHER_RUN_ID, "licitor")]
    supabase.tables["auction_source_state"] += [_source_state("agrasc", RUN_ID), _source_state("licitor", OTHER_RUN_ID)]
    untouched_run = json.dumps(supabase.run(OTHER_RUN_ID))
    untouched_source = json.dumps(supabase.source("licitor"))
    step_summary = tmp_path / "summary.md"

    # As in the workflow: isolated mode, from a directory where no installed package is reachable.
    result = subprocess.run(
        [sys.executable, "-I", str(CLOSER)],
        env={**_environment(supabase), "GITHUB_STEP_SUMMARY": str(step_summary), "GITHUB_RUN_ID": "4209",
             "GITHUB_RUN_ATTEMPT": "1", "PATH": os.environ["PATH"]},
        cwd=tmp_path, capture_output=True, text=True, timeout=60, check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    run = supabase.run(RUN_ID)
    assert run["status"] == "failed"
    assert run["finished_at"] and run["updated_at"] == run["finished_at"]
    summary = run["summary"]
    assert isinstance(summary, dict)
    assert summary["completion_status"] == "failed_before_start"
    assert summary["startup_failure"] == {
        "stage": "system_packages", "outcome": "failure", "reason": "installation des paquets système (apt)",
        "github_run_id": 4209, "github_run_attempt": 1,
    }
    # What the scheduler had written is kept.
    assert summary["trigger"] == "autonomous" and summary["github_dispatch"] == {"state": "accepted", "attempt": 1}
    assert run["errors"] == {"runner": [
        "Échec avant démarrage : installation des paquets système (apt). Le pipeline n'a pas démarré : "
        "aucune donnée collectée ni modifiée par ce passage."
    ]}
    # The source of the run is due again; its failure counter is not touched.
    agrasc = supabase.source("agrasc")
    assert str(agrasc["next_inventory_at"]) == run["finished_at"]
    assert agrasc["consecutive_failures"] == 0
    # The run and the source of another pass are untouched.
    assert json.dumps(supabase.run(OTHER_RUN_ID)) == untouched_run
    assert json.dumps(supabase.source("licitor")) == untouched_source
    # Nothing secret in the log or in the job summary.
    written = result.stdout + result.stderr + step_summary.read_text(encoding="utf-8")
    assert SERVICE_KEY not in written and supabase.url not in written and "127.0.0.1" not in written
    assert "Échec avant démarrage : installation des paquets système" in step_summary.read_text(encoding="utf-8")
    assert [(method, table) for method, table, _ in supabase.requests] == [
        ("GET", "auction_runs"), ("PATCH", "auction_source_state"), ("PATCH", "auction_runs"),
    ]
    assert all(
        headers.get("apikey") == SERVICE_KEY and headers.get("authorization") == f"Bearer {SERVICE_KEY}"
        for _, _, headers in supabase.requests
    )


@pytest.mark.parametrize("status", ["running", "succeeded", "failed"])
def test_a_run_that_is_running_or_already_closed_is_left_untouched(
    supabase: FakeSupabase, status: str, capsys: pytest.CaptureFixture[str]
) -> None:
    supabase.tables["auction_runs"].append(_queued_run(status=status))
    supabase.tables["auction_source_state"].append(_source_state("agrasc", RUN_ID))
    before = json.dumps(supabase.tables)

    assert close_unstarted_run.close_unstarted_run(_environment(supabase)) == 0

    assert json.dumps(supabase.tables) == before
    assert [method for method, _, _ in supabase.requests] == ["GET"]
    assert f"« {status} » : laissé intact" in capsys.readouterr().out


def test_a_run_claimed_between_the_read_and_the_close_stays_running(
    supabase: FakeSupabase, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    supabase.tables["auction_runs"].append(_queued_run(source="enrichment-queue"))
    original = close_unstarted_run._request

    def claimed_meanwhile(method: str, url: str, key: str, body: dict[str, object] | None = None):
        if method == "PATCH":
            supabase.run(RUN_ID)["status"] = "running"  # a worker wins the queued -> running claim
        return original(method, url, key, body)

    monkeypatch.setattr(close_unstarted_run, "_request", claimed_meanwhile)

    assert close_unstarted_run.close_unstarted_run(_environment(supabase)) == 0
    assert supabase.run(RUN_ID)["status"] == "running"
    assert supabase.run(RUN_ID)["finished_at"] is None
    assert "laissé intact" in capsys.readouterr().out


def test_an_enrichment_run_or_a_manual_run_is_closed_without_touching_any_source(supabase: FakeSupabase) -> None:
    supabase.tables["auction_runs"] += [
        _queued_run(source="enrichment-queue"),
        _queued_run(OTHER_RUN_ID, "licitor", scheduler_owned=False, errors={"runner": ["earlier note"]}),
    ]
    supabase.tables["auction_source_state"].append(_source_state("licitor", "33333333-3333-4333-8333-333333333333"))
    before = json.dumps(supabase.tables["auction_source_state"])

    assert close_unstarted_run.close_unstarted_run(_environment(supabase)) == 0
    assert close_unstarted_run.close_unstarted_run(_environment(supabase, OTHER_RUN_ID)) == 0

    assert supabase.run(RUN_ID)["status"] == "failed" and supabase.run(OTHER_RUN_ID)["status"] == "failed"
    assert json.dumps(supabase.tables["auction_source_state"]) == before
    assert {table for _, table, _ in supabase.requests} == {"auction_runs"}
    errors = supabase.run(OTHER_RUN_ID)["errors"]
    assert isinstance(errors, dict) and errors["runner"][0] == "earlier note" and len(errors["runner"]) == 2


def test_a_source_already_due_keeps_its_own_deadline(supabase: FakeSupabase) -> None:
    supabase.tables["auction_runs"].append(_queued_run())
    supabase.tables["auction_source_state"].append(
        {**_source_state("agrasc", RUN_ID), "next_inventory_at": "2020-01-01T00:00:00+00:00"}
    )

    assert close_unstarted_run.close_unstarted_run(_environment(supabase)) == 0

    assert supabase.source("agrasc")["next_inventory_at"] == "2020-01-01T00:00:00+00:00"
    assert supabase.run(RUN_ID)["status"] == "failed"


@pytest.mark.parametrize(
    ("outcomes", "stage", "sentence"),
    [
        (("failure", "skipped", "skipped"), "system_packages", "Échec avant démarrage : installation des paquets système (apt)."),
        (("success", "failure", "skipped"), "python_dependencies", "Échec avant démarrage : installation des dépendances Python (pip)."),
        (("success", "success", "failure"), "justice_references", "Échec avant démarrage : vérification des référentiels Justice."),
        (("cancelled", "skipped", "skipped"), "system_packages", "Annulation avant démarrage : installation des paquets système (apt)."),
        (("skipped", "skipped", "skipped"), "job_preparation", "Échec avant démarrage : préparation du job (avant l'installation des paquets)."),
    ],
)
def test_the_reason_names_the_preparation_step_that_failed(
    supabase: FakeSupabase, outcomes: tuple[str, str, str], stage: str, sentence: str
) -> None:
    supabase.tables["auction_runs"].append(_queued_run(source="enrichment-queue"))
    environ = _environment(
        supabase,
        STARTUP_SYSTEM_PACKAGES_OUTCOME=outcomes[0],
        STARTUP_PYTHON_DEPENDENCIES_OUTCOME=outcomes[1],
        STARTUP_JUSTICE_REFERENCES_OUTCOME=outcomes[2],
    )

    assert close_unstarted_run.close_unstarted_run(environ) == 0

    run = supabase.run(RUN_ID)
    assert run["status"] == "failed"  # never « succeeded »
    assert run["summary"]["startup_failure"]["stage"] == stage  # type: ignore[index]
    assert run["errors"]["runner"][0].startswith(sentence)  # type: ignore[index]


def test_no_run_requested_means_no_request_at_all(supabase: FakeSupabase) -> None:
    assert close_unstarted_run.close_unstarted_run(_environment(supabase, "")) == 0
    assert close_unstarted_run.close_unstarted_run(_environment(supabase, RUN_ID)) == 0  # unknown run: nothing to close
    assert [method for method, _, _ in supabase.requests] == ["GET"]


def test_an_invalid_identifier_or_a_missing_secret_is_an_error_without_any_request(
    supabase: FakeSupabase, capsys: pytest.CaptureFixture[str]
) -> None:
    assert close_unstarted_run.close_unstarted_run(_environment(supabase, "not-a-uuid")) == 1
    assert close_unstarted_run.close_unstarted_run(_environment(supabase, SUPABASE_SERVICE_ROLE_KEY="")) == 1
    assert close_unstarted_run.close_unstarted_run(_environment(supabase, SUPABASE_URL="")) == 1

    assert supabase.requests == []
    assert capsys.readouterr().out.count("::error title=Clôture du run impossible::") == 3


@pytest.mark.parametrize(("status", "attempts"), [(503, 3), (401, 1)])
def test_an_unreachable_or_refusing_database_fails_the_step_without_leaking(
    supabase: FakeSupabase, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    status: int, attempts: int,
) -> None:
    monkeypatch.setattr(close_unstarted_run, "REQUEST_BACKOFF_SECONDS", 0)
    supabase.tables["auction_runs"].append(_queued_run())
    supabase.fail_with = status

    assert close_unstarted_run.close_unstarted_run(_environment(supabase)) == 1

    output = capsys.readouterr().out
    assert f"(HTTP {status})" in output and "reste ouvert jusqu'à l'expiration de son bail" in output
    assert SERVICE_KEY not in output and supabase.url not in output
    assert len(supabase.requests) == attempts  # a refusal is not retried, an outage is, a bounded number of times
    assert supabase.run(RUN_ID)["status"] == "queued"


def test_a_network_error_is_reported_by_its_type_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(close_unstarted_run, "REQUEST_BACKOFF_SECONDS", 0)
    environ = {"SUPABASE_URL": "http://127.0.0.1:9", "SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY, "REQUESTED_RUN_ID": RUN_ID}

    assert close_unstarted_run.close_unstarted_run(environ) == 1

    output = capsys.readouterr().out
    assert "(URLError)" in output
    assert "127.0.0.1" not in output and SERVICE_KEY not in output


def test_when_the_close_fails_after_the_source_was_made_due_the_run_stays_open(
    supabase: FakeSupabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The lease expiry (unchanged) then closes the run; the source is simply due a little earlier.
    monkeypatch.setattr(close_unstarted_run, "REQUEST_BACKOFF_SECONDS", 0)
    supabase.tables["auction_runs"].append(_queued_run())
    supabase.tables["auction_source_state"].append(_source_state("agrasc", RUN_ID))
    supabase.fail_patch_of = "auction_runs"

    assert close_unstarted_run.close_unstarted_run(_environment(supabase)) == 1

    assert supabase.run(RUN_ID)["status"] == "queued"
    assert not str(supabase.source("agrasc")["next_inventory_at"]).startswith("2999")


# --- workflows --------------------------------------------------------------------------------


def _pipeline_steps() -> dict[str, object]:
    jobs = {job.name: job for job in parse_jobs((WORKFLOWS / "data-pipeline.yml").read_text(encoding="utf-8"))}
    return {step.name: step for step in jobs["run"].steps}


def _condition(step: object) -> str:
    match = re.search(r"^\s+if: (.+)$", step.text, re.M)  # type: ignore[attr-defined]
    return match.group(1) if match else ""


def test_no_workflow_calls_apt_get_directly() -> None:
    offenders = []
    users = []
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for job in parse_jobs(path.read_text(encoding="utf-8")):
            for step in job.steps:
                if "apt-get" in step.run:
                    offenders.append(f"{path.name}/{step.name}")
                if "install_system_packages.sh" in step.run:
                    users.append(path.name)

    assert offenders == []
    assert users == ["data-pipeline.yml", "information-agent-evidence.yml"]


def test_the_pipeline_installs_its_packages_through_the_bounded_script() -> None:
    steps = _pipeline_steps()
    install = steps["Install document extraction packages"]

    assert 'bash scripts/install_system_packages.sh "${packages[@]}"' in install.run  # type: ignore[attr-defined]
    assert "id: system-packages" in install.text  # type: ignore[attr-defined]
    assert "id: python-deps" in steps["Install Python dependencies"].text  # type: ignore[attr-defined]
    assert "id: justice-references" in steps["Refresh and verify official Justice references"].text  # type: ignore[attr-defined]
    assert "continue-on-error" not in install.text  # type: ignore[attr-defined]


def test_a_job_that_never_started_closes_its_run_without_python_dependencies() -> None:
    steps = _pipeline_steps()
    names = list(steps)
    close = steps["Close run that never started"]

    assert names.index("Close run that never started") == names.index("Run manually requested pipeline") + 1
    assert names.index("Finalize unfinished run") == names.index("Close run that never started") + 1
    assert _condition(close) == (
        "always() && steps.pipeline.outcome == 'skipped' && inputs.publication_check != true && inputs.run_id != ''"
    )
    # System interpreter, isolated mode: neither the virtual environment nor requirements.lock is needed.
    assert close.run.strip() == "python3 -I scripts/close_unstarted_run.py"  # type: ignore[attr-defined]
    assert "continue-on-error" not in close.text  # type: ignore[attr-defined]
    assert set(re.findall(r"secrets\.([A-Z_]+)", close.env)) == {"SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"}  # type: ignore[attr-defined]
    for variable, step_id in (
        ("STARTUP_SYSTEM_PACKAGES_OUTCOME", "system-packages"),
        ("STARTUP_PYTHON_DEPENDENCIES_OUTCOME", "python-deps"),
        ("STARTUP_JUSTICE_REFERENCES_OUTCOME", "justice-references"),
    ):
        assert f"{variable}: ${{{{ steps.{step_id}.outcome }}}}" in close.env  # type: ignore[attr-defined]
    assert {variable for variable, _, _ in close_unstarted_run.STAGES} <= set(re.findall(r"^\s+([A-Z_]+):", close.env, re.M))  # type: ignore[attr-defined]
    # The two closing steps never both run: one when the pipeline step ran, the other when it did not.
    assert _condition(steps["Finalize unfinished run"]) == (
        "always() && steps.pipeline.outcome != 'skipped' && inputs.publication_check != true"
    )


def test_steps_that_need_python_dependencies_are_skipped_when_they_are_not_installed() -> None:
    steps = _pipeline_steps()

    assert _condition(steps["Invalidate public cache"]) == "always() && steps.python-deps.outcome == 'success'"
    assert _condition(steps["Report source coverage and enrichment backlog"]) == (
        "always() && steps.python-deps.outcome == 'success'"
    )
    assert _condition(steps["Copie des photos principales"]) == (
        "always() && steps.python-deps.outcome == 'success' && inputs.automatic == true"
    )
    # Every other `always()` step that runs `python -m src.…` is guarded as well.
    for name, step in steps.items():
        if "always()" in _condition(step) and "python -m src." in step.run:  # type: ignore[attr-defined]
            assert "steps.python-deps.outcome == 'success'" in _condition(step) or (
                "steps.pipeline.outcome != 'skipped'" in _condition(step)
            ), name


def test_the_fix_changes_neither_the_concurrency_group_nor_the_job_timeout() -> None:
    text = (WORKFLOWS / "data-pipeline.yml").read_text(encoding="utf-8")

    assert "(inputs.documents_backlog && 'immojudis-document-backlog' || 'immojudis-data-pipeline')" in text
    assert re.search(r"^  cancel-in-progress: false$", text, re.M)
    assert re.search(r"^    timeout-minutes: 180$", text, re.M)
