"""``run_pipeline`` is a sequence of named stages (P6-05): order and early exits."""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from src import main

STAGES_IN_ORDER = [
    "_open_run",
    "_load_known_sale_details",
    "_scrape_sources",
    "_hydrate_collected_payloads",
    "_assess_collection",
    "_restore_known_unchanged_sales",
    "_normalize_and_deduplicate",
    "_lookup_incremental_hashes",
    "_prepare_and_publish_early",
    "_select_enrichment_scope",
    "_enrich_pdf_documents",
    "_enrich_with_llm",
    "_finalize_enriched_sales",
    "_apply_admission_and_reports",
    "_publish_run",
    "_print_run_summary",
]


def _record_stages(monkeypatch, *, results: dict[str, object] | None = None) -> list[str]:
    calls: list[str] = []
    fake_run = SimpleNamespace(publication_failed=False, broken_sources=None)
    results = results or {}

    for name in STAGES_IN_ORDER:
        def stage(*_args, _name=name, **_kwargs):
            calls.append(_name)
            if _name == "_open_run":
                return fake_run
            return results.get(_name, {} if _name == "_scrape_sources" else True)

        monkeypatch.setattr(main, name, stage)
    return calls


def test_run_pipeline_runs_every_stage_in_order(monkeypatch) -> None:
    calls = _record_stages(monkeypatch)

    assert main.run_pipeline(main.PipelineOptions()) == 0
    assert calls == STAGES_IN_ORDER


@pytest.mark.parametrize(
    ("failing_stage", "last_called"),
    [
        ("_load_known_sale_details", "_load_known_sale_details"),
        ("_hydrate_collected_payloads", "_hydrate_collected_payloads"),
    ],
)
def test_run_pipeline_stops_with_exit_code_one_when_a_lookup_stage_fails(
    monkeypatch, failing_stage: str, last_called: str
) -> None:
    calls = _record_stages(monkeypatch, results={failing_stage: False})

    assert main.run_pipeline(main.PipelineOptions()) == 1
    assert calls[-1] == last_called
    assert "_publish_run" not in calls
    assert "_print_run_summary" not in calls


def test_run_pipeline_exit_code_reflects_publication_and_broken_sources(monkeypatch) -> None:
    _record_stages(monkeypatch)
    fake_run = SimpleNamespace(publication_failed=False, broken_sources=["avoventes"])
    monkeypatch.setattr(main, "_open_run", lambda options: fake_run)
    assert main.run_pipeline(main.PipelineOptions()) == main.SOURCE_WARNING_EXIT_CODE

    fake_run.publication_failed = True
    assert main.run_pipeline(main.PipelineOptions()) == 1


def test_run_pipeline_stays_a_short_orchestrator() -> None:
    source = Path(main.__file__).read_text(encoding="utf-8")
    function = next(
        node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "run_pipeline"
    )

    assert function.end_lineno - function.lineno + 1 <= 50
