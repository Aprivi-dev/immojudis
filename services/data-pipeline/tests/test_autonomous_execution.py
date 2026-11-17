import os
import subprocess
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from src import autonomous_runner, catalogue_lock, config, document_reading
from src.enrichment_queue_limits import (
    ENRICHMENT_BUDGET_SECONDS,
    ENRICHMENT_BUDGET_SECONDS_ENV,
    ENRICHMENT_MAX_JOBS,
    ENRICHMENT_MAX_JOBS_ENV,
)
from src.sources import licitor, petites_affiches


@pytest.mark.parametrize(
    "source,returncode,previous_completion,expected_budget,expected_completion,budget_env,expected_source_budget",
    [
        ("licitor", 0, "complete", 50 * 60, "complete", licitor.SOURCE_BUDGET_ENV, 42 * 60),
        ("petites_affiches", 1, "partial_success", 35 * 60, "partial_success", petites_affiches.SOURCE_BUDGET_ENV, 30 * 60),
    ],
)
def test_automatic_run_keeps_publication_budget_and_partial_result(
    monkeypatch,
    source,
    returncode,
    previous_completion,
    expected_budget,
    expected_completion,
    budget_env,
    expected_source_budget,
) -> None:
    run_id = "00000000-0000-0000-0000-000000000001"
    updates = []
    subprocess_calls = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: (source,))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({"completion_status": previous_completion},))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **kwargs: subprocess_calls.append((command, kwargs)) or SimpleNamespace(returncode=returncode),
    )

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == returncode
    assert subprocess_calls[0][1]["timeout"] == expected_budget
    # Le budget de la source est posé sous le nom que la source lit.
    assert subprocess_calls[0][1]["env"][budget_env] == str(expected_source_budget)
    assert updates[0][2].obj["completion_status"] == expected_completion
    assert updates[0][0] == ("failed" if returncode else "succeeded")


@pytest.mark.parametrize("exhausted", [0, 1])
def test_exhausted_enrichment_job_keeps_run_partial_when_worker_completed_jobs(
    monkeypatch, exhausted
) -> None:
    run_id = "00000000-0000-0000-0000-000000000002"
    updates = []
    subprocess_calls = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("completed", 31), ("failed", 10)])
            if "select id,job_type,attempt_count,max_attempts" in statement:
                return SimpleNamespace(fetchall=lambda: [
                    ("job-exhausted", "pdf", 4, 4),
                ])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (exhausted,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **kwargs: subprocess_calls.append((command, kwargs)) or SimpleNamespace(returncode=0),
    )

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 0
    assert updates[0][0] == "succeeded"
    assert updates[0][2].obj["enrichment_jobs_exhausted"] == exhausted
    assert updates[0][2].obj["enrichment_jobs_completed"] == 31
    assert updates[0][2].obj["completion_status"] == "partial_success"
    # Le travailleur reçoit ses propres plafonds, sous les noms qu'il lit.
    assert subprocess_calls[0][1]["env"][ENRICHMENT_BUDGET_SECONDS_ENV] == str(ENRICHMENT_BUDGET_SECONDS)
    assert subprocess_calls[0][1]["env"][ENRICHMENT_MAX_JOBS_ENV] == str(ENRICHMENT_MAX_JOBS)
    # After the queue: the attachment catch-up, the document reading, the batch positions, the photos of the
    # attachments, then one tick of the Licitor history collector.
    assert [call[0][2] for call in subprocess_calls[1:]] == [
        "src.document_backlog",
        "src.document_reading",
        "src.address_positions",
        "src.pdf_photos",
        "src.sources.licitor_history_refresh",
    ]
    assert subprocess_calls[1][0][3:] == ["--max-sales", "6", "--budget-minutes", "8"]
    assert subprocess_calls[1][1]["timeout"] == autonomous_runner.DOCUMENT_BACKLOG_BUDGET_SECONDS
    # The reading step that follows reads the texts: the catch-up does not run its own.
    assert subprocess_calls[1][1]["env"][document_reading.READING_ENABLED_ENV] == "false"
    assert subprocess_calls[3][0][3:] == ["--max-sales", "500", "--budget-seconds", "170"]
    assert subprocess_calls[3][1]["timeout"] == autonomous_runner.ADDRESS_POSITIONS_BUDGET_SECONDS
    assert subprocess_calls[4][0][3:] == ["--max-sales", "25", "--budget-seconds", "180"]
    assert subprocess_calls[4][1]["timeout"] == autonomous_runner.PDF_PHOTOS_BUDGET_SECONDS
    assert subprocess_calls[5][1]["timeout"] == autonomous_runner.LICITOR_HISTORY_BUDGET_SECONDS
    assert updates[0][2].obj["document_backlog_exit_code"] == 0
    assert updates[0][2].obj["address_positions_exit_code"] == 0
    assert updates[0][2].obj["pdf_photos_exit_code"] == 0
    assert updates[0][2].obj["licitor_history_exit_code"] == 0
    if exhausted:
        assert updates[0][1].obj["enrichment_jobs"] == [
            "1 enrichment job(s) exhausted their retry budget"
        ]
        assert updates[0][2].obj["enrichment_jobs_exhausted_details"] == [
            {
                "job_id": "job-exhausted",
                "job_type": "pdf",
                "attempt_count": 4,
                "max_attempts": 4,
            }
        ]


def test_each_setting_of_a_scheduled_unit_is_read_back_by_its_reader(monkeypatch) -> None:
    """Rejoué dans l'environnement du passage lancé, chaque lecteur retrouve le réglage posé par le lanceur."""
    run_id = "00000000-0000-0000-0000-000000000009"
    subprocess_calls = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            return SimpleNamespace(fetchone=lambda: (0,), fetchall=lambda: [])

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **kwargs: subprocess_calls.append((command, kwargs)) or SimpleNamespace(returncode=0),
    )
    # Valeurs héritées de l'environnement du job, que le lanceur doit écraser.
    monkeypatch.setenv(config.AUTONOMOUS_RUN_ID_ENV, "run-du-job")
    monkeypatch.setenv(config.CADASTRE_ENRICH_ENABLED_ENV, "true")
    monkeypatch.setenv(config.DPE_ENRICH_ENABLED_ENV, "true")
    monkeypatch.setenv(config.REPLICATE_CANCEL_AFTER_ENV, "30m")
    monkeypatch.setenv(catalogue_lock.LOCK_WAIT_ENV, "60")
    monkeypatch.setenv(document_reading.READING_ENABLED_ENV, "true")

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 0

    def replay(env: dict[str, str]) -> None:
        for name, value in env.items():
            if os.environ.get(name) != value:
                monkeypatch.setenv(name, value)

    replay(subprocess_calls[0][1]["env"])
    assert config.autonomous_run_id() == run_id
    settings = config.load_settings()
    assert settings["cadastre_enrich_enabled"] is False
    assert settings["dpe_enrich_enabled"] is False
    assert settings["replicate_cancel_after"] == config.DEFAULT_REPLICATE_CANCEL_AFTER
    assert catalogue_lock._lock_wait_seconds() == 300
    # Le rattrapage des pièces (deuxième passage) ne lance pas sa propre lecture.
    assert subprocess_calls[1][0][2] == "src.document_backlog"
    replay(subprocess_calls[1][1]["env"])
    assert document_reading.reading_enabled() is False


def test_systemic_worker_failure_keeps_nonzero_code_with_exhausted_signal(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000003"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("completed", 2), ("failed", 1)])
            if "select id,job_type,attempt_count,max_attempts" in statement:
                return SimpleNamespace(fetchall=lambda: [("job-exhausted", "pdf", 4, 4)])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (1,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    commands = []
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **_kwargs: commands.append(command) or SimpleNamespace(returncode=7),
    )

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 7
    # A failed worker: neither the document reading nor the address positions run (they wait for the next tick).
    modules = [command[2] for command in commands if len(command) > 2]
    assert "src.document_backlog" not in modules
    assert "src.document_reading" not in modules and "src.address_positions" not in modules
    assert "src.pdf_photos" not in modules
    assert "address_positions_exit_code" not in updates[0][2].obj
    assert "pdf_photos_exit_code" not in updates[0][2].obj
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"] == ["Worker exited with status 7"]
    assert updates[0][1].obj["enrichment_jobs"] == [
        "1 enrichment job(s) exhausted their retry budget"
    ]
    assert updates[0][2].obj["worker_exit_code"] == 7
    assert updates[0][2].obj["completion_status"] == "interrupted"


def test_exhausted_enrichment_without_completed_job_stays_failed(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000004"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("failed", 1)])
            if "select id,job_type,attempt_count,max_attempts" in statement:
                return SimpleNamespace(fetchall=lambda: [("job-exhausted", "pdf", 4, 4)])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (1,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda _command, **_kwargs: SimpleNamespace(returncode=0),
    )

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 1
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"] == [
        "Exhausted enrichment jobs reported without worker progress"
    ]
    assert updates[0][2].obj["completion_status"] == "retry_exhausted"


def test_worker_timeout_remains_failed_and_visible(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000005"
    updates = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("licitor",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda _command, **_kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(cmd="worker", timeout=10)
        ),
    )

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 1
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"] == [
        "Execution budget exceeded; committed checkpoints preserved"
    ]
    assert updates[0][2].obj["worker_exit_code"] == 1
    assert updates[0][2].obj["completion_status"] == "interrupted"


def test_worker_failure_reaches_the_errors_of_a_run_src_main_already_closed(monkeypatch) -> None:
    """src.main a clos son run : close_open_run n'y touche plus, mais l'erreur du lanceur est fusionnée avec le bilan."""
    run_id = "00000000-0000-0000-0000-000000000006"
    merges = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("licitor",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({"completion_status": "complete"},))
            if "update public.auction_runs set summary=" in statement:
                merges.append((statement, params))
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(autonomous_runner.subprocess, "run", lambda _command, **_kwargs: SimpleNamespace(returncode=1))

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 1
    [(statement, params)] = merges
    assert "status" not in statement
    assert "errors=coalesce(errors,'{}') || %s" in statement
    assert params[0].obj["worker_exit_code"] == 1
    assert params[1].obj == {"runner": ["Worker exited with status 1"]}
    assert params[2] == run_id


def test_worker_watchdog_exit_is_explained_and_armed_before_the_hard_kill(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000006"
    updates = []
    subprocess_calls = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("licitor",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **kwargs: subprocess_calls.append((command, kwargs))
        or SimpleNamespace(returncode=autonomous_runner.WATCHDOG_EXIT_CODE),
    )

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == autonomous_runner.WATCHDOG_EXIT_CODE

    budget = subprocess_calls[0][1]["timeout"]
    watchdog = int(subprocess_calls[0][1]["env"][autonomous_runner.WATCHDOG_ENV])
    assert budget == 50 * 60
    assert watchdog == budget - autonomous_runner.WATCHDOG_MARGIN_SECONDS
    # Room remains for the source budget (budget minus 8 min) to run out first.
    assert watchdog > budget - autonomous_runner.LICITOR_BUDGET_MARGIN_SECONDS
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"][0].startswith("Worker watchdog fired")
    assert updates[0][2].obj["completion_status"] == "interrupted"


def test_licitor_history_budget_overrun_still_refreshes_the_scenarios_copy(monkeypatch) -> None:
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        if len(calls) == 1:
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(autonomous_runner.subprocess, "run", run)

    assert autonomous_runner._run_licitor_history_refresh({}) == 1
    assert "--snapshot-only" not in calls[0][0]
    assert calls[1][0][-1] == "--snapshot-only"
    assert calls[1][1]["timeout"] == autonomous_runner.LICITOR_SNAPSHOT_ONLY_SECONDS


def test_licitor_history_snapshot_only_failure_does_not_raise(monkeypatch) -> None:
    def run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(autonomous_runner.subprocess, "run", run)

    assert autonomous_runner._run_licitor_history_refresh({}) == 1


def test_document_backlog_failure_is_reported_and_never_raises(monkeypatch) -> None:
    def run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(autonomous_runner.subprocess, "run", run)

    assert autonomous_runner._run_document_backlog({}) == 1


def test_address_positions_failure_is_reported_and_never_raises(monkeypatch) -> None:
    def run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(autonomous_runner.subprocess, "run", run)

    assert autonomous_runner._run_address_positions({}) == 1


def test_pdf_photos_failure_is_reported_and_never_raises(monkeypatch) -> None:
    def run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(autonomous_runner.subprocess, "run", run)

    assert autonomous_runner._run_pdf_photos({}) == 1


# --- Voie d'enrichissement séparée des collectes (17/11/2026) ---------------------------------------------------

ORIGINAL_CATALOGUE_WRITER_FREE = autonomous_runner._catalogue_writer_free
LANE_RUN_ID = "00000000-0000-0000-0000-0000000000a1"


def _lane_db(updates: list, statements: list, *, source: str = "enrichment-queue", lease: str | None = "7200",
             queued_source: str | None = None):
    class FakeDb:
        def execute(self, statement, params):
            statements.append(statement)
            if "select source from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: (queued_source,) if queued_source else None)
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: (source,))
            if "running_lease_seconds" in statement:
                return SimpleNamespace(fetchone=lambda: (lease,))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("completed", 3)])
            if "jsonb_object_agg" in statement:
                return SimpleNamespace(fetchone=lambda: ({"source_detail": {"completed": 2}, "pdf": {"completed": 1}},))
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (0,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    return lambda _url: nullcontext(FakeDb())


def _lane_setup(monkeypatch, stops: list[str], *, worker_seconds: float = 0.0, clock: list[float] | None = None):
    """Le travailleur écrit son compte rendu ; ``clock`` avance de ``worker_seconds`` à chaque passage."""
    import json as json_module

    from src.enrichment_queue_limits import ENRICHMENT_WORKER_REPORT_ENV

    calls: list[tuple[list[str], dict]] = []
    remaining = list(stops)

    def run(command, **kwargs):
        calls.append((command, kwargs))
        if command[2] == "src.queued_runner":
            if clock is not None:
                clock[0] += worker_seconds
            with open(kwargs["env"][ENRICHMENT_WORKER_REPORT_ENV], "w", encoding="utf-8") as handle:
                json_module.dump({"stop_reason": remaining.pop(0), "handled": 4}, handle)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id, connect: None)
    monkeypatch.setattr(autonomous_runner.subprocess, "run", run)
    if clock is not None:
        monkeypatch.setattr(autonomous_runner.time, "monotonic", lambda: clock[0])
    return calls


def _workers(calls):
    return [kwargs for command, kwargs in calls if command[2] == "src.queued_runner"]


def test_the_enrichment_lane_chains_worker_passes_until_the_queue_is_empty(monkeypatch) -> None:
    updates, statements = [], []
    calls = _lane_setup(monkeypatch, ["budget", "queues_empty"])

    connect = _lane_db(updates, statements)
    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=connect) == 0

    workers = _workers(calls)
    assert len(workers) == 2
    assert all(kwargs["env"][ENRICHMENT_BUDGET_SECONDS_ENV] == str(ENRICHMENT_BUDGET_SECONDS) for kwargs in workers)
    assert all(kwargs["timeout"] == autonomous_runner.ENRICHMENT_WORKER_TIMEOUT_SECONDS for kwargs in workers)
    # Each cycle: the worker, then the optional passes, as a unit did before the lane.
    assert [command[2] for command, _ in calls].count("src.document_reading") == 2
    summary = updates[0][2].obj
    unit = summary["enrichment_unit"]
    assert unit["mode"] == "lane"
    assert unit["unit_seconds"] == 7200 - autonomous_runner.ENRICHMENT_LEASE_MARGIN_SECONDS
    assert unit["stop_reason"] == "queues_empty"
    assert [cycle["worker_stop_reason"] for cycle in unit["cycles"]] == ["budget", "queues_empty"]
    assert summary["scheduler_budget_seconds"] == unit["unit_seconds"]
    assert summary["enrichment_jobs_by_type"] == {"source_detail": {"completed": 2}, "pdf": {"completed": 1}}
    assert summary["document_reading_exit_code"] == 0


def test_the_enrichment_lane_waits_for_a_collection_and_skips_its_passes(monkeypatch) -> None:
    from src import collection_priority

    updates, statements = [], []
    calls = _lane_setup(monkeypatch, ["collection_pending", "queues_empty"])
    monkeypatch.setattr(collection_priority, "collection_pending_now", lambda: True)
    waits = iter([0.0, 600.0])
    monkeypatch.setattr(collection_priority, "wait_while_collection_pending", lambda *, deadline: next(waits))

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    # No optional pass next to a collection: they also fetch from the sources.
    assert [command[2] for command, _ in calls] == ["src.queued_runner", "src.queued_runner"]
    unit = updates[0][2].obj["enrichment_unit"]
    assert unit["collection_wait_seconds"] == 600.0
    assert set(unit["cycles"][0]["passes_skipped"].values()) == {"collection_pending"}
    assert "document_backlog_exit_code" not in updates[0][2].obj


def test_the_enrichment_lane_never_outlasts_its_lease(monkeypatch) -> None:
    updates, statements = [], []
    clock = [0.0]
    calls = _lane_setup(monkeypatch, ["budget"] * 10, worker_seconds=1500.0, clock=clock)

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    unit_seconds = 7200 - autonomous_runner.ENRICHMENT_LEASE_MARGIN_SECONDS
    unit = updates[0][2].obj["enrichment_unit"]
    assert unit["stop_reason"] == "unit_budget"
    assert clock[0] <= unit_seconds
    # The last cycle has no time left for its optional passes: they are skipped, never cut.
    assert set(unit["cycles"][-1]["passes_skipped"].values()) == {"unit_budget"}
    for kwargs in _workers(calls):
        assert int(kwargs["env"][ENRICHMENT_BUDGET_SECONDS_ENV]) >= autonomous_runner.ENRICHMENT_MIN_PASS_SECONDS


@pytest.mark.parametrize("lane,lease", [(False, "7200"), (True, None)])
def test_without_the_lane_or_its_lease_an_enrichment_unit_runs_one_cycle(monkeypatch, lane, lease) -> None:
    """Ancien planificateur (pas de bail écrit) ou ENRICHMENT_LANE=off : un seul passage, comme avant."""
    updates, statements = [], []
    calls = _lane_setup(monkeypatch, ["budget", "budget"])

    assert autonomous_runner.execute(
        LANE_RUN_ID, enrichment_lane=lane, connect=_lane_db(updates, statements, lease=lease)
    ) == 0

    assert len(_workers(calls)) == 1
    unit = updates[0][2].obj["enrichment_unit"]
    assert unit["mode"] == "single_cycle"
    assert updates[0][2].obj["scheduler_budget_seconds"] == autonomous_runner.ENRICHMENT_WORKER_TIMEOUT_SECONDS


def test_a_collection_waits_for_the_catalogue_writer_before_its_claim(monkeypatch) -> None:
    updates, statements = [], []
    waited: list[tuple[float, int]] = []
    _lane_setup(monkeypatch, [])
    monkeypatch.setattr(
        autonomous_runner,
        "_catalogue_writer_free",
        lambda db_url, *, wait_seconds: waited.append((wait_seconds, len(statements))) or True,
    )

    connect = _lane_db(updates, statements, source="vench", queued_source="vench")
    assert autonomous_runner.execute(LANE_RUN_ID, connect=connect) == 0

    claim_index = next(index for index, statement in enumerate(statements) if "returning source" in statement)
    assert waited == [(autonomous_runner.COLLECTION_CATALOGUE_PREWAIT_SECONDS, claim_index)]
    assert updates[0][2].obj["catalogue_prewait"]["timed_out"] is False


def test_an_enrichment_run_does_not_wait_for_the_catalogue_writer(monkeypatch) -> None:
    updates, statements = [], []
    _lane_setup(monkeypatch, ["queues_empty"])
    monkeypatch.setattr(
        autonomous_runner, "_catalogue_writer_free", lambda db_url, *, wait_seconds: pytest.fail("no wait")
    )

    connect = _lane_db(updates, statements, queued_source="enrichment-queue")
    assert autonomous_runner.execute(LANE_RUN_ID, connect=connect) == 0
    assert "catalogue_prewait" not in updates[0][2].obj


@pytest.mark.parametrize("acquired", [True, False])
def test_the_collection_prewait_takes_and_releases_the_catalogue_writer_lock(monkeypatch, acquired) -> None:
    from contextlib import contextmanager

    seen: list[dict] = []

    @contextmanager
    def lock(db_url, **kwargs):
        seen.append(kwargs)
        if not acquired:
            raise catalogue_lock.CatalogueLockTimeout("busy")
        yield None

    monkeypatch.setattr(autonomous_runner, "catalogue_writer_lock", lock)
    assert ORIGINAL_CATALOGUE_WRITER_FREE("postgresql://test", wait_seconds=12.0) is acquired
    assert seen[0]["wait_seconds"] == 12.0 and seen[0]["heartbeat_seconds"] == 0


def test_passes_that_contact_a_site_keep_their_daily_volume(monkeypatch) -> None:
    """Pas une requête de plus par site : au plus une fois par unité, et 24 h / 17 après la précédente."""
    updates, statements = [], []
    calls = _lane_setup(monkeypatch, ["budget", "budget", "queues_empty"])

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    modules = [command[2] for command, _ in calls]
    # Three cycles: the LLM-only reading every cycle, the passes that contact a host once.
    assert modules.count("src.document_reading") == 3
    for module in ("src.document_backlog", "src.address_positions", "src.pdf_photos",
                   "src.sources.licitor_history_refresh"):
        assert modules.count(module) == 1, module
    skipped = updates[0][2].obj["enrichment_unit"]["cycles"][1]["passes_skipped"]
    assert set(skipped) == autonomous_runner.EXTERNAL_PASS_KEYS
    assert set(skipped.values()) == {"site_cadence"}


@pytest.mark.parametrize("minutes_ago,due", [(None, True), (90, True), (80, False)])
def test_a_site_pass_waits_for_its_interval_after_the_last_unit_that_ran_it(minutes_ago, due) -> None:
    from datetime import UTC, datetime, timedelta

    seen = []
    finished = None if minutes_ago is None else datetime.now(UTC) - timedelta(minutes=minutes_ago)

    class FakeDb:
        def execute(self, statement, params):
            seen.append(params)
            return SimpleNamespace(fetchone=lambda: (finished,))

    assert autonomous_runner._external_pass_due(
        "postgresql://test", "run-1", "licitor_history_exit_code", connect=lambda _url: nullcontext(FakeDb())
    ) is due
    assert seen == [("run-1", "licitor_history_exit_code")]
    assert autonomous_runner.EXTERNAL_PASS_MIN_INTERVAL == timedelta(hours=24) / 17
