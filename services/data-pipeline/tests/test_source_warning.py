"""A broken or empty enabled source must be visible without blocking later steps (P3-06)."""

from __future__ import annotations

import subprocess
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_main import _raw_sale, _settings

from src import autonomous_runner, main
from src.source_health import (
    SOURCE_WARNING_EXIT_CODE,
    failed_sources,
    warning_annotations,
)
from src.sources.common import ScrapeResult

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "allow_source_warning.sh"


# --- classification -----------------------------------------------------------


def test_exit_code_is_two() -> None:
    assert SOURCE_WARNING_EXIT_CODE == 2


def test_sources_with_errors_or_no_listing_are_failed_and_healthy_ones_are_not() -> None:
    failed = failed_sources(
        ["licitor", "vench", "avoventes", "notaires"],
        {"licitor": 12, "vench": 0, "avoventes": 3, "notaires": 0},
        {"licitor": [], "vench": [], "avoventes": ["HTTP 500 on page 2", "timeout"], "notaires": []},
    )

    assert set(failed) == {"vench", "avoventes", "notaires"}
    assert failed["vench"] == "0 annonce collectée"
    assert failed["avoventes"].startswith("2 erreur(s), première : HTTP 500 on page 2")


def test_a_source_with_listings_and_no_error_is_healthy_even_if_unchanged() -> None:
    assert failed_sources(["licitor"], {"licitor": 40}, {}) == {}


def test_only_enabled_sources_are_judged() -> None:
    assert failed_sources([], {"licitor": 0}, {"licitor": ["boom"]}) == {}


def test_annotations_follow_the_workflow_command_format_and_escape_data() -> None:
    lines = warning_annotations({"vench": "0 annonce collectée", "licitor": "1 erreur(s), première : a\nb 100%"})

    assert lines[0] == "::warning::Source vench en échec (0 annonce collectée)"
    assert lines[1] == "::warning::Source licitor en échec (1 erreur(s), première : a%0Ab 100%25)"
    assert all("\n" not in line for line in lines)


# --- run_pipeline exit code ---------------------------------------------------


def _run(monkeypatch, scraper, *, upsert=lambda sales, **kwargs: len(sales), publish=True, pdf=lambda sale: None):
    settings = _settings()
    settings["pipeline_pdf_max_targets"] = 5
    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *a, **k: "run-1")
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *a, **k: None)
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **k: set())
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", scraper)
    monkeypatch.setattr(main, "geocode_sale", lambda sale: sale)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "enrich_sale_from_pdfs", pdf)
    monkeypatch.setattr(main, "enrich_sale_with_llm", lambda *a, **k: main.LLMEnrichmentStats())
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *a, **k: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales, **k: len(sales))
    return main.run_pipeline(main.PipelineOptions(source="avoventes", use_llm=False, upsert=publish))


def test_healthy_source_exits_zero(monkeypatch, capsys) -> None:
    code = _run(monkeypatch, lambda known=None: ScrapeResult([_raw_sale()], []))

    assert code == 0
    assert "::warning::" not in capsys.readouterr().out


def test_source_returning_nothing_exits_two_with_an_annotation(monkeypatch, capsys) -> None:
    code = _run(monkeypatch, lambda known=None: ScrapeResult([], []))

    assert code == 2
    assert "::warning::Source avoventes en échec (0 annonce collectée)" in capsys.readouterr().out


def test_source_that_raises_is_annotated_and_the_unpublished_run_exits_two(monkeypatch, capsys) -> None:
    def broken(known=None):
        raise RuntimeError("site down\nsecond line")

    code = _run(monkeypatch, broken, publish=False)

    out = capsys.readouterr().out
    assert code == 2
    assert "::warning::Source avoventes en échec (1 erreur(s), première : site down second line)" in out


def test_collection_errors_keep_the_failed_run_exit_code_but_are_annotated(monkeypatch, capsys) -> None:
    """With upsert, an incomplete collection already finished the run as failed (exit 1)."""
    code = _run(monkeypatch, lambda known=None: ScrapeResult([_raw_sale()], ["page 3: HTTP 503"]))

    assert code == 1
    assert "::warning::Source avoventes en échec (1 erreur(s), première : page 3: HTTP 503)" in capsys.readouterr().out


def test_publication_failure_stays_a_failure(monkeypatch) -> None:
    def failing_upsert(sales, **kwargs):
        raise RuntimeError("database unavailable")

    assert _run(monkeypatch, lambda known=None: ScrapeResult([_raw_sale()], []), upsert=failing_upsert) == 1
    # A failed publication outranks the source warning.
    assert _run(monkeypatch, lambda known=None: ScrapeResult([], []), upsert=failing_upsert) in {1, 2}


def test_later_stage_errors_do_not_flag_a_healthy_source(monkeypatch, capsys) -> None:
    calls: list[str] = []

    def pdf_boom(sale):
        calls.append(sale.source_url)
        raise RuntimeError("pdf boom")

    code = _run(monkeypatch, lambda known=None: ScrapeResult([_raw_sale()], []), pdf=pdf_boom)

    assert calls, "the PDF stage must actually run and fail for this test to mean anything"
    assert code == 0
    assert "::warning::" not in capsys.readouterr().out


# --- autonomous runner --------------------------------------------------------


def _autonomous(monkeypatch, returncode: int, source: str = "licitor"):
    run_id = "00000000-0000-0000-0000-0000000000a1"
    updates: list[tuple] = []

    class FakeDb:
        def execute(self, statement, params):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: (source,))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({"completion_status": "partial_success"},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (0,))
            if "update public.auction_runs set status=%s" in statement:
                updates.append(params)
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess, "run", lambda command, **kwargs: SimpleNamespace(returncode=returncode)
    )
    return autonomous_runner.execute(run_id), updates


def test_scheduled_run_keeps_its_succeeded_status_but_forwards_the_warning(monkeypatch) -> None:
    code, updates = _autonomous(monkeypatch, SOURCE_WARNING_EXIT_CODE)

    assert code == SOURCE_WARNING_EXIT_CODE
    assert updates[0][0] == "succeeded"
    assert updates[0][1].obj == {}
    assert updates[0][2].obj["source_warning"] is True
    assert updates[0][2].obj["worker_exit_code"] == SOURCE_WARNING_EXIT_CODE


def test_scheduled_run_still_fails_on_a_real_worker_failure(monkeypatch) -> None:
    code, updates = _autonomous(monkeypatch, 1)

    assert code == 1
    assert updates[0][0] == "failed"
    assert "source_warning" not in updates[0][2].obj


def test_enrichment_queue_exit_two_is_not_reinterpreted(monkeypatch) -> None:
    code, updates = _autonomous(monkeypatch, 2, source="enrichment-queue")

    assert code == 2
    assert updates[0][0] == "failed"


# --- workflow helper ----------------------------------------------------------


def _helper(tmp_path, *command: str):
    output = tmp_path / "github_output"
    result = subprocess.run(
        ["bash", str(SCRIPT), *command],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "GITHUB_OUTPUT": str(output)},
        check=False,
    )
    return result, output.read_text() if output.exists() else ""


def test_helper_turns_exit_two_into_a_warning_that_does_not_stop_the_job(tmp_path) -> None:
    result, output = _helper(tmp_path, "bash", "-c", "echo collecting; exit 2")

    assert result.returncode == 0
    assert "source_warning=true" in output
    assert "::warning::Collecte partielle" in result.stdout
    assert "collecting" in result.stdout


@pytest.mark.parametrize("code", [1, 3, 64, 137])
def test_helper_preserves_real_failures(tmp_path, code) -> None:
    result, output = _helper(tmp_path, "bash", "-c", f"exit {code}")

    assert result.returncode == code
    assert output == ""


def test_helper_is_silent_on_success_and_requires_a_command(tmp_path) -> None:
    result, output = _helper(tmp_path, "true")
    assert (result.returncode, output, result.stdout) == (0, "", "")

    missing, _ = _helper(tmp_path)
    assert missing.returncode == 64


def test_workflow_routes_every_pipeline_command_through_the_helper() -> None:
    workflow = (Path(__file__).resolve().parents[3] / ".github/workflows/data-pipeline.yml").read_text()

    for command in (
        "scripts/allow_source_warning.sh python -m src.main",
        "scripts/allow_source_warning.sh python -m src.autonomous_runner",
        "scripts/allow_source_warning.sh python -m src.queued_runner --enrichment-only",
    ):
        assert command in workflow
    assert "steps.pipeline.outputs.source_warning == 'true'" in workflow
