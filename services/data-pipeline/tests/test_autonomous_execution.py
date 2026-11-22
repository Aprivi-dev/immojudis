import os
import subprocess
import time
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
    # After the queue: the attachment catch-up, the document reading, the reading of the pieces by Claude, the batch
    # positions, the photos of the attachments, then one tick of the Licitor history collector.
    assert [call[0][2] for call in subprocess_calls[1:]] == [
        "src.document_backlog",
        "src.document_reading",
        "src.document_vision_pass",
        "src.address_positions",
        "src.pdf_photos",
        "src.sources.licitor_history_refresh",
    ]
    assert subprocess_calls[1][0][3:] == ["--max-sales", "6", "--budget-minutes", "8"]
    assert subprocess_calls[1][1]["timeout"] == autonomous_runner.DOCUMENT_BACKLOG_BUDGET_SECONDS
    # The reading step that follows reads the texts: the catch-up does not run its own.
    assert subprocess_calls[1][1]["env"][document_reading.READING_ENABLED_ENV] == "false"
    # Ten sales and ten minutes per pass (lot V3b-1).
    assert subprocess_calls[3][0][3:] == ["--max-sales", "10", "--budget-minutes", "10"]
    assert subprocess_calls[3][1]["timeout"] == autonomous_runner.DOCUMENT_VISION_BUDGET_SECONDS
    assert subprocess_calls[4][0][3:] == ["--max-sales", "500", "--budget-seconds", "170"]
    assert subprocess_calls[4][1]["timeout"] == autonomous_runner.ADDRESS_POSITIONS_BUDGET_SECONDS
    assert subprocess_calls[5][0][3:] == ["--max-sales", "25", "--budget-seconds", "180"]
    assert subprocess_calls[5][1]["timeout"] == autonomous_runner.PDF_PHOTOS_BUDGET_SECONDS
    assert subprocess_calls[6][1]["timeout"] == autonomous_runner.LICITOR_HISTORY_BUDGET_SECONDS
    assert updates[0][2].obj["document_backlog_exit_code"] == 0
    assert updates[0][2].obj["document_vision_exit_code"] == 0
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


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        # Retour arrière : la lecture des pièces par Claude seule, comme au lot V3b-1.
        ("replicate", ["src.document_vision_pass"]),
        # Appels de texte à Claude : le travailleur de la file (faits) et la lecture IA des pièces en plus. Ni la
        # collecte, ni le rattrapage des pièces, ni les positions, ni les photos des pièces jointes.
        ("anthropic", ["src.queued_runner", "src.document_reading", "src.document_vision_pass"]),
    ],
)
def test_only_the_processes_that_call_claude_get_the_anthropic_key(monkeypatch, provider, expected) -> None:
    run_id = "00000000-0000-0000-0000-000000000010"
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
    monkeypatch.setenv(config.ANTHROPIC_API_KEY_ENV, "test-key-never-shown")
    monkeypatch.setenv(config.LLM_PROVIDER_ENV, provider)
    monkeypatch.delenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", raising=False)

    assert autonomous_runner.execute(run_id, connect=lambda _url: nullcontext(FakeDb())) == 0

    with_key = [command[2] for command, kwargs in subprocess_calls if config.ANTHROPIC_API_KEY_ENV in kwargs["env"]]
    assert with_key == expected
    assert {command[2] for command, _kwargs in subprocess_calls} > set(expected)
    assert all(kwargs["env"].get(config.ANTHROPIC_API_KEY_ENV) in (None, "test-key-never-shown") for _c, kwargs in subprocess_calls)


@pytest.mark.parametrize(("provider", "with_key"), [("anthropic", True), ("replicate", False)])
def test_parallel_lane_workers_get_the_key_only_for_text_calls_to_claude(monkeypatch, provider, with_key) -> None:
    started: list[dict[str, str]] = []

    class FakeProcess:
        stdout = None

        def wait(self, timeout=None):
            return 0

        def poll(self):
            return 0

    def popen(command, *, env, **_kwargs):
        started.append((command[command.index("--family") + 1], env))
        return FakeProcess()

    monkeypatch.setattr(autonomous_runner.subprocess, "Popen", popen)
    monkeypatch.setenv(config.ANTHROPIC_API_KEY_ENV, "test-key-never-shown")
    monkeypatch.setenv(config.LLM_PROVIDER_ENV, provider)
    runner_env = {"PATH": "/usr/bin"}  # execute() has already removed the key from the unit's environment

    autonomous_runner._run_enrichment_cycle(
        runner_env,
        autonomous_runner.EnrichmentUnit(),
        db_url="postgresql://test",
        budget=60,
        deadline=time.monotonic() + 1,  # no time left for the optional passes: the workers alone
        licitor_withdrawn=True,
        external_pass_due=lambda _key: False,
        general_workers=2,
    )

    assert [family for family, _env in started] == ["source_detail", "enrichment", "enrichment"]
    # Only the general workers make AI calls: the source-detail worker never gets the key.
    assert [config.ANTHROPIC_API_KEY_ENV in env for _family, env in started] == [False, with_key, with_key]
    assert config.ANTHROPIC_API_KEY_ENV not in runner_env


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

ORIGINAL_CATALOGUE_WRITER = autonomous_runner._catalogue_writer
LANE_RUN_ID = "00000000-0000-0000-0000-0000000000a1"


def _lane_db(updates: list, statements: list, *, source: str = "enrichment-queue", lease: str | None = "7200",
             queued_source: str | None = None, lease_until: str | None = None, on_update=None):
    class FakeDb:
        def execute(self, statement, params):
            statements.append(statement)
            if "select source, summary" in statement:
                return SimpleNamespace(fetchone=lambda: (queued_source, lease_until) if queued_source else None)
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
                if on_update is not None:
                    on_update()
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
    clock = [0.0]
    calls = _lane_setup(monkeypatch, ["collection_pending", "queues_empty"], clock=clock)
    monkeypatch.setattr(collection_priority, "collection_pending_now", lambda: True)
    waits = iter([0.0, 600.0])

    def wait(*, deadline: float) -> None:
        clock[0] += next(waits)

    monkeypatch.setattr(collection_priority, "wait_while_collection_pending", wait)

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


def _recording_locks(monkeypatch, events: list, statements: list, *, granted: bool = True,
                     refused_labels: frozenset[str] = frozenset()):
    """Le tour des sources et le verrou du catalogue, notés à leur prise et à leur rendu.

    ``refused_labels`` : demandes refusées même quand ``granted`` est vrai.
    """
    from contextlib import contextmanager

    from src import source_traffic

    held: dict[str, int] = {"traffic": 0, "catalogue": 0}

    def recorder(name):
        @contextmanager
        def lock(_db_url, *, label, wait_seconds, **_kwargs):
            events.append((name, "take", wait_seconds, len(statements)))
            held[name] += 1
            try:
                yield granted and label not in refused_labels
            finally:
                held[name] -= 1
                events.append((name, "release", None, len(statements)))

        return lock

    monkeypatch.setattr(source_traffic, "source_traffic_turn", recorder("traffic"))
    monkeypatch.setattr(autonomous_runner, "_catalogue_writer", recorder("catalogue"))
    return held


def test_a_collection_takes_its_source_turn_and_waits_for_the_catalogue_writer_before_its_claim(monkeypatch) -> None:
    updates, statements, events = [], [], []
    _lane_setup(monkeypatch, [])
    held = _recording_locks(monkeypatch, events, statements)

    connect = _lane_db(updates, statements, source="vench", queued_source="vench")
    assert autonomous_runner.execute(LANE_RUN_ID, connect=connect) == 0

    claim_index = next(index for index, statement in enumerate(statements) if "returning source" in statement)
    budget = autonomous_runner.COLLECTION_CATALOGUE_PREWAIT_SECONDS
    # Statements executed before each event: only the read of the queued run precedes the claim.
    assert events[0][:2] == ("traffic", "take") and events[0][3] <= claim_index
    assert abs(events[0][2] - budget) < 5
    assert events[1][:2] == ("catalogue", "take") and events[2][:2] == ("catalogue", "release")
    assert events[2][3] <= claim_index
    # The source turn is kept until the very end: the run is closed and finish_source runs inside it.
    assert events[-1][:2] == ("traffic", "release")
    assert held == {"traffic": 0, "catalogue": 0}
    assert updates[0][2].obj["catalogue_prewait"]["timed_out"] is False


def test_the_closing_writes_of_a_collection_hold_the_catalogue_writer_lock(monkeypatch) -> None:
    """Point M3 : src.main a rendu le verrou ; la clôture du run et finish_source le reprennent."""
    updates, statements, events = [], [], []
    _lane_setup(monkeypatch, [])
    held = _recording_locks(monkeypatch, events, statements)
    seen: list[tuple[str, int, int]] = []
    monkeypatch.setattr(
        autonomous_runner,
        "finish_source",
        lambda _db_url, _run_id, connect: seen.append(("finish_source", held["catalogue"], held["traffic"])),
    )

    connect = _lane_db(
        updates, statements, source="vench", queued_source="vench",
        on_update=lambda: seen.append(("close", held["catalogue"], held["traffic"])),
    )
    assert autonomous_runner.execute(LANE_RUN_ID, connect=connect) == 0

    assert seen == [("close", 1, 1), ("finish_source", 1, 1)]


def test_a_collection_never_waits_past_its_dispatch_lease(monkeypatch) -> None:
    """Point F1 : la pré-attente s'arrête 5 minutes avant le bail de la ligne en file."""
    from datetime import UTC, datetime, timedelta

    updates, statements, events = [], [], []
    _lane_setup(monkeypatch, [])
    _recording_locks(monkeypatch, events, statements)
    lease_until = (datetime.now(UTC) + timedelta(minutes=12)).isoformat()

    connect = _lane_db(updates, statements, source="vench", queued_source="vench", lease_until=lease_until)
    assert autonomous_runner.execute(LANE_RUN_ID, connect=connect) == 0

    assert 400 < events[0][2] <= 12 * 60 - autonomous_runner.QUEUED_LEASE_MARGIN_SECONDS
    assert updates[0][2].obj["catalogue_prewait"]["budget_seconds"] <= 7 * 60


def test_an_expired_dispatch_lease_leaves_no_wait(monkeypatch) -> None:
    from datetime import UTC, datetime, timedelta

    statements: list = []
    lease_until = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    connect = _lane_db([], statements, queued_source="licitor", lease_until=lease_until)
    assert autonomous_runner._collection_wait_budget("postgresql://test", LANE_RUN_ID, connect=connect) == 0.0


def test_an_enrichment_run_takes_no_collection_lock(monkeypatch) -> None:
    updates, statements, events = [], [], []
    _lane_setup(monkeypatch, ["queues_empty"])
    _recording_locks(monkeypatch, events, statements)

    connect = _lane_db(updates, statements, queued_source="enrichment-queue")
    assert autonomous_runner.execute(LANE_RUN_ID, connect=connect) == 0
    assert not [event for event in events if event[0] == "catalogue"]
    assert "catalogue_prewait" not in updates[0][2].obj


def test_optional_passes_that_contact_a_site_run_inside_the_source_traffic_turn(monkeypatch) -> None:
    """Point M4 : une collecte qui démarre pendant une passe externe attend son tour."""
    updates, statements, events = [], [], []
    calls = _lane_setup(monkeypatch, ["queues_empty"])
    held = _recording_locks(monkeypatch, events, statements)
    during: dict[str, int] = {}
    run = autonomous_runner.subprocess.run

    def run_and_note(command, **kwargs):
        during[command[2]] = held["traffic"]
        return run(command, **kwargs)

    monkeypatch.setattr(autonomous_runner.subprocess, "run", run_and_note)
    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    assert len(calls) == 7
    for module in ("src.document_backlog", "src.document_vision_pass", "src.address_positions", "src.pdf_photos",
                   "src.sources.licitor_history_refresh"):
        assert during[module] == 1, module
    # The worker takes the turn itself, batch by batch (src.collection_priority.yield_to_sources).
    assert during["src.queued_runner"] == 0 and during["src.document_reading"] == 0


def test_an_external_pass_is_skipped_when_the_source_turn_does_not_come(monkeypatch) -> None:
    updates, statements, events = [], [], []
    _lane_setup(monkeypatch, ["queues_empty"])
    # The unit's own wait before the cycle gets its turn; each external pass is refused it.
    _recording_locks(monkeypatch, events, statements, refused_labels=autonomous_runner.EXTERNAL_PASS_KEYS)

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0
    skipped = updates[0][2].obj["enrichment_unit"]["cycles"][0]["passes_skipped"]
    assert set(skipped) == autonomous_runner.EXTERNAL_PASS_KEYS
    assert set(skipped.values()) == {"source_traffic_busy"}


def test_an_enrichment_unit_whose_source_turn_does_not_come_ends_cleanly(monkeypatch) -> None:
    """17/11/2026 : une attente du tour coupée ne fait plus mourir l'unité ; elle s'arrête, raison lisible."""
    updates, statements, events = [], [], []
    calls = _lane_setup(monkeypatch, ["budget"])
    _recording_locks(monkeypatch, events, statements, granted=False)

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0
    summary = updates[0][2].obj
    assert summary["enrichment_unit"]["stop_reason"] == "source_traffic_busy"
    assert summary["enrichment_unit"]["cycles"] == []
    assert not _workers(calls)
    assert "runner" not in updates[0][1].obj


@pytest.mark.parametrize("acquired", [True, False])
def test_the_catalogue_writer_helper_yields_whether_it_holds_the_lock(monkeypatch, acquired) -> None:
    from contextlib import contextmanager

    seen: list[dict] = []

    @contextmanager
    def lock(db_url, **kwargs):
        seen.append(kwargs)
        if not acquired:
            raise catalogue_lock.CatalogueLockTimeout("busy")
        yield None

    monkeypatch.setattr(autonomous_runner, "catalogue_writer_lock", lock)
    with ORIGINAL_CATALOGUE_WRITER("postgresql://test", label="t", wait_seconds=12.0) as held:
        assert held is acquired
    assert seen[0]["wait_seconds"] == 12.0 and seen[0]["heartbeat_seconds"] == 0


def test_passes_that_contact_a_site_keep_their_daily_volume(monkeypatch) -> None:
    """Pas une requête de plus par site : au plus une fois par unité, et 24 h / 17 après la précédente."""
    updates, statements = [], []
    calls = _lane_setup(monkeypatch, ["budget", "budget", "queues_empty"])

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    modules = [command[2] for command, _ in calls]
    # Three cycles: the LLM-only reading every cycle, the passes that contact a host once.
    assert modules.count("src.document_reading") == 3
    for module in ("src.document_backlog", "src.document_vision_pass", "src.address_positions", "src.pdf_photos",
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


# --- Voie parallèle : 1 processus de fiches + N processus de pièces et de faits (17/11/2026) ------------------


def _parallel_setup(monkeypatch, reports: dict[str, list[dict]], *, codes: dict[str, int] | None = None):
    """Les travailleurs lancés côte à côte (``subprocess.Popen``) écrivent leur compte rendu, par famille."""
    import json as json_module

    from src.enrichment_queue_limits import ENRICHMENT_WORKER_REPORT_ENV

    calls = _lane_setup(monkeypatch, [])
    launched: list[tuple[list[str], dict]] = []
    remaining = {family: list(items) for family, items in reports.items()}

    class FakeProcess:
        def __init__(self, command, env, **_streams):
            launched.append((command, env))
            self.family = command[command.index("--family") + 1]
            self.stdout = None
            report = remaining[self.family].pop(0)
            if report is not None:
                with open(env[ENRICHMENT_WORKER_REPORT_ENV], "w", encoding="utf-8") as handle:
                    json_module.dump(report, handle)

        def wait(self, timeout=None):
            return (codes or {}).get(self.family, 0)

        def poll(self):
            return self.wait()

        def kill(self):
            pass

        def terminate(self):
            pass

    monkeypatch.setattr(autonomous_runner.subprocess, "Popen", FakeProcess)
    return calls, launched


def test_the_parallel_lane_runs_one_source_detail_worker_and_n_general_workers(monkeypatch) -> None:
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "2")
    monkeypatch.setenv(config.AUTONOMOUS_RUN_ID_ENV, "inherited-value-is-replaced")
    detail = {"stop_reason": "budget", "handled": 6, "handled_by_family": {"source_detail": 6},
              "claimed_by_job_type": {"source_detail": 6}, "host_turns": {"waits": 1}}
    general = {"stop_reason": "budget", "handled": 2, "handled_by_family": {"enrichment": 2},
               "claimed_by_job_type": {"pdf": 2}, "ocr_seconds": 12.5, "publication_lock_deferrals": 1}
    empty = {"stop_reason": "queues_empty", "handled": 0, "handled_by_family": {}}
    calls, launched = _parallel_setup(
        monkeypatch, {"source_detail": [detail, empty], "enrichment": [general, general, empty, empty]}
    )
    updates, statements = [], []

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    families = [command[command.index("--family") + 1] for command, _ in launched]
    assert families == ["source_detail", "enrichment", "enrichment"] * 2
    assert all(command[:4] == list(autonomous_runner.ENRICHMENT_WORKER_COMMAND) for command, _ in launched)
    # One execution, one AI cap: every worker carries the unit's run id (reserve_pipeline_prediction counts per run).
    assert {env[config.AUTONOMOUS_RUN_ID_ENV] for _, env in launched} == {LANE_RUN_ID}
    from src.enrichment_queue_limits import ENRICHMENT_WORKER_REPORT_ENV

    assert len({env[ENRICHMENT_WORKER_REPORT_ENV] for _, env in launched[:3]}) == 3
    # 4 vCPUs shared by 3 workers: one compute thread each.
    assert all(env["OMP_NUM_THREADS"] == "1" and env["OPENBLAS_NUM_THREADS"] == "1" for _, env in launched)
    assert not _workers(calls), "no mixed worker in the parallel lane"
    unit = updates[0][2].obj["enrichment_unit"]
    assert unit["general_workers"] == 2
    assert unit["stop_reason"] == "queues_empty"
    first = unit["cycles"][0]
    assert first["worker_handled"] == 10
    assert first["worker_handled_by_family"] == {"source_detail": 6, "enrichment": 4}
    assert [worker["family"] for worker in first["workers"]] == ["source_detail", "enrichment", "enrichment"]
    assert first["workers"][1]["claimed_by_job_type"] == {"pdf": 2}
    assert first["workers"][1]["ocr_seconds"] == 12.5
    assert first["workers"][1]["publication_lock_deferrals"] == 1
    assert first["workers"][0]["host_turns"] == {"waits": 1}
    # The optional passes run once all the workers have ended, as after the single worker.
    assert [command[2] for command, _ in calls].count("src.document_reading") == 2


def test_an_idle_source_detail_worker_does_not_end_the_unit_while_a_general_one_works(monkeypatch) -> None:
    """M1 : le processus des fiches à vide en quelques secondes n'arrête pas l'unité ; il attend le cycle suivant."""
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "1")
    empty = {"stop_reason": "queues_empty", "handled": 0, "handled_by_family": {}}
    busy = {"stop_reason": "budget", "handled": 5, "handled_by_family": {"enrichment": 5}}
    _calls, launched = _parallel_setup(
        monkeypatch, {"source_detail": [empty, empty], "enrichment": [busy, empty]}
    )
    updates, statements = [], []

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    unit = updates[0][2].obj["enrichment_unit"]
    assert [cycle["worker_stop_reason"] for cycle in unit["cycles"]] == ["budget", "queues_empty"]
    assert unit["stop_reason"] == "queues_empty"
    # One detail process per cycle: an idle one ends and is started again with the next cycle, never in a loop.
    families = [command[command.index("--family") + 1] for command, _ in launched]
    assert families == ["source_detail", "enrichment"] * 2


def test_workers_still_running_are_terminated_when_the_unit_stops(monkeypatch, tmp_path) -> None:
    """F1 : une exception (ou SIGTERM, changé en SystemExit) du parent ne laisse aucun processus orphelin."""
    events: list[str] = []

    class Hanging:
        def __init__(self, command, env, **_streams):
            self.index = len(events)
            self.stdout = None
            self.ended = False
            events.append("start")

        def wait(self, timeout=None):
            if not self.ended and timeout is not None and timeout > autonomous_runner.LANE_WORKER_TERMINATE_SECONDS:
                raise KeyboardInterrupt  # the job is cancelled while the parent waits
            self.ended = True
            return -15

        def poll(self):
            return -15 if self.ended else None

        def terminate(self):
            events.append("terminate")

        def kill(self):
            events.append("kill")

    monkeypatch.setattr(autonomous_runner.subprocess, "Popen", Hanging)
    with pytest.raises(KeyboardInterrupt):
        autonomous_runner._run_lane_workers(1, {}, 600, str(tmp_path))
    assert events == ["start", "start", "terminate", "terminate"]


def test_worker_output_is_prefixed_with_its_family_and_number(capsys) -> None:
    """F2 : les sorties des processus côte à côte se distinguent ; les commandes GitHub restent en tête de ligne."""
    import io

    autonomous_runner._relay_output(io.BytesIO(b"Batch claimed\n::warning title=x::y\n"), "[enrichment#1]")
    assert capsys.readouterr().out.splitlines() == ["[enrichment#1] Batch claimed", "::warning title=x::y"]


def test_a_failed_worker_does_not_stop_the_others_and_stops_the_unit(monkeypatch) -> None:
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "1")
    report = {"stop_reason": "budget", "handled": 3, "handled_by_family": {"source_detail": 3}}
    calls, launched = _parallel_setup(
        monkeypatch, {"source_detail": [report], "enrichment": [None]}, codes={"enrichment": 1}
    )
    updates, statements = [], []

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 1

    assert len(launched) == 2
    unit = updates[0][2].obj["enrichment_unit"]
    assert unit["stop_reason"] == "worker_failed"
    workers = unit["cycles"][0]["workers"]
    assert [(worker["family"], worker["exit_code"], worker["handled"]) for worker in workers] == [
        ("source_detail", 0, 3), ("enrichment", 1, None)
    ]
    assert updates[0][1].obj["runner"] == ["Worker (enrichment) exited with status 1"]


@pytest.mark.parametrize(
    "reasons,expected",
    [
        (["queues_empty", "queues_empty"], "queues_empty"),
        # 17/11/2026: fact passes refused by the AI budget are left; readable stop reason, not an empty queue.
        (["queues_empty", "llm_budget_exhausted"], "llm_budget_exhausted"),
        (["queues_empty", "llm_budget_exhausted", "llm_budget_exhausted"], "llm_budget_exhausted"),
        # A general worker still reading documents keeps the unit going.
        (["queues_empty", "llm_budget_exhausted", "budget"], "budget"),
        (["budget", "queues_empty"], "budget"),
        # M1: the source-detail worker (first) is idle within seconds while a general one runs to its budget.
        (["queues_empty", "budget"], "budget"),
        (["queues_empty", "budget", "queues_empty"], "budget"),
        (["queues_empty", "queues_empty", "budget"], "budget"),
        (["llm_budget_exhausted", "queues_empty", "budget"], "budget"),
        (["budget", "collection_pending"], "collection_pending"),
        (["budget", None], None),
    ],
)
def test_one_stop_reason_per_cycle(reasons, expected) -> None:
    workers = [
        autonomous_runner.LaneWorker("x", 0, None, 1.0, {} if reason is None else {"stop_reason": reason})
        for reason in reasons
    ]
    assert autonomous_runner._cycle_stop_reason(workers) == expected


def test_the_unit_goes_on_while_document_readings_are_left_under_the_ai_budget(monkeypatch) -> None:
    """Incident du 17/11/2026 : unité terminée « queues_empty » au bout de 24 min, 189 pièces échues en file.

    Le processus des fiches a vidé sa file ; les processus généraux, refusés par le budget IA, lisent les pièces jusqu'à
    leur budget : l'unité continue. Elle ne s'arrête que lorsqu'il ne reste que des faits refusés par le budget IA, avec
    une raison lisible.
    """
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "2")
    empty = {"stop_reason": "queues_empty", "handled": 0, "handled_by_family": {}}
    reading = {"stop_reason": "budget", "handled": 8, "handled_by_family": {"enrichment": 8},
               "claimed_by_job_type": {"pdf": 7, "fact_extraction": 1}, "llm_budget_refusals": 1}
    blocked = {"stop_reason": "llm_budget_exhausted", "handled": 0, "handled_by_family": {}, "llm_budget_refusals": 1}
    _calls, launched = _parallel_setup(
        monkeypatch,
        {"source_detail": [empty, empty, empty], "enrichment": [reading, reading, reading, blocked, blocked, blocked]},
    )
    updates, statements = [], []

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    unit = updates[0][2].obj["enrichment_unit"]
    assert [cycle["worker_stop_reason"] for cycle in unit["cycles"]] == ["budget", "budget", "llm_budget_exhausted"]
    assert unit["stop_reason"] == "llm_budget_exhausted"
    assert unit["cycles"][0]["workers"][1]["llm_budget_refusals"] == 1
    # The first general worker claims the document readings first, the second one keeps the score order.
    general = [command for command, _ in launched if command[command.index("--family") + 1] == "enrichment"]
    assert [autonomous_runner.PDF_FIRST_WORKER_ARGUMENT in command for command in general] == [True, False] * 3
    assert [worker["family"] for worker in unit["cycles"][0]["workers"]] == ["source_detail", "enrichment", "enrichment"]


def test_a_single_general_worker_keeps_the_score_order(monkeypatch) -> None:
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "1")
    empty = {"stop_reason": "queues_empty", "handled": 0, "handled_by_family": {}}
    _calls, launched = _parallel_setup(monkeypatch, {"source_detail": [empty], "enrichment": [empty]})

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db([], [])) == 0
    assert not any(autonomous_runner.PDF_FIRST_WORKER_ARGUMENT in command for command, _ in launched)


def test_the_single_mixed_worker_ends_the_unit_with_a_readable_budget_reason(monkeypatch) -> None:
    """PIPELINE_ENRICHMENT_GENERAL_WORKERS=0 : même fin d'unité que la voie parallèle."""
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "0")
    calls = _lane_setup(monkeypatch, ["budget", "llm_budget_exhausted"])
    updates, statements = [], []

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    unit = updates[0][2].obj["enrichment_unit"]
    assert unit["stop_reason"] == "llm_budget_exhausted"
    assert len(_workers(calls)) == 2


def test_zero_general_workers_keeps_the_single_mixed_worker_unchanged(monkeypatch) -> None:
    """Le retour arrière : PIPELINE_ENRICHMENT_GENERAL_WORKERS=0 lance le travailleur mixte d'avant, à l'identique."""
    monkeypatch.setenv("PIPELINE_ENRICHMENT_GENERAL_WORKERS", "0")
    monkeypatch.setattr(autonomous_runner.subprocess, "Popen", lambda *a, **k: pytest.fail("no parallel worker"))
    updates, statements = [], []
    calls = _lane_setup(monkeypatch, ["queues_empty"])

    assert autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements)) == 0

    workers = [(command, kwargs) for command, kwargs in calls if command[2] == "src.queued_runner"]
    assert [command for command, _ in workers] == [list(autonomous_runner.ENRICHMENT_WORKER_COMMAND)]
    assert not any(name in workers[0][1]["env"] and workers[0][1]["env"][name] != os.environ.get(name)
                   for name in autonomous_runner.THREAD_LIMIT_ENVS)
    unit = updates[0][2].obj["enrichment_unit"]
    assert "general_workers" not in unit
    assert set(unit["cycles"][0]) == {
        "worker_exit_code", "worker_seconds", "worker_stop_reason", "worker_handled", "worker_handled_by_family",
        "seconds",
    }


@pytest.mark.parametrize(
    "settings",
    [
        {"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "2", "PIPELINE_WORKER_LOCK_MODE": "exclusive"},
        {"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "2", "PIPELINE_HOST_TURNS": "off"},
        {"PIPELINE_ENRICHMENT_GENERAL_WORKERS": "4"},
    ],
)
def test_incoherent_lane_settings_are_refused_before_any_worker(monkeypatch, capsys, settings) -> None:
    for name, value in settings.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(autonomous_runner, "_run_enrichment_unit", lambda *a, **k: pytest.fail("no worker"))
    updates, statements = [], []
    _lane_setup(monkeypatch, [])

    code = autonomous_runner.execute(LANE_RUN_ID, enrichment_lane=True, connect=_lane_db(updates, statements))

    assert code == autonomous_runner.LANE_SETTINGS_EXIT_CODE
    assert updates[0][0] == "failed"
    assert updates[0][1].obj["runner"][0].startswith("Enrichment lane settings refused: PIPELINE_")
    assert "Réglages de la voie d'enrichissement refusés" in capsys.readouterr().out
