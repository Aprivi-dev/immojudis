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


def test_a_run_reads_the_base_then_publishes_without_echo_and_reports_the_counter(monkeypatch) -> None:
    """Lecture des détails connus, base changée pendant le passage, publications anticipée et finale, compteur.

    Les étapes sont les vraies ; seules la base (``fake_sale_base``), les tables voisines et les journaux du passage
    sont simulés.
    """
    from datetime import UTC, datetime, timedelta

    from fake_sale_base import SETTINGS, FakeSaleBase, patch_publication

    from src import base_reads
    from src.models import AuctionSale

    url = "https://www.licitor.com/annonce/09/99/99/vente-aux-encheres/une-maison/alphaville/gironde/099998.html"
    sale_date = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0).isoformat()
    listing = {"surface_m2": 50, "app_surface_m2": 50, "app_surface_kind": "built", "surface_source": "listing_text",
               "surface_confidence": 0.7, "rooms_count": 2, "occupancy_status": "occupied"}
    posed = {"surface_m2": 54, "app_surface_m2": 54, "app_surface_kind": "declared", "surface_source": "declared",
             "surface_confidence": 0.9, "rooms_count": 3, "occupancy_status": "rented"}
    base = FakeSaleBase([{
        "source_name": "licitor", "source_url": url, "source_urls": [url], "primary_source": "licitor",
        "status": "upcoming", "sale_date": sale_date, "starting_price_eur": 90000, "department": "33",
        "city": "Alphaville", "postal_code": "33000", "address": "12 rue des Lilas, 33000 Alphaville",
        "property_type": "house", "title": "Une maison", "description": "Une maison d'habitation.",
        "raw_text": "Une maison d'habitation.", "visit_dates": [], "documents": [], "quality_flags": [],
        "land_surface_m2": 800, "habitable_surface_m2": None, "carrez_surface_m2": None,
        "raw_payload": {"source_checks": {}, "source_factual_snapshot": {"source_name": "licitor", "source_url": url}},
        **posed,
    }])
    patch_publication(monkeypatch, base)
    settings = {**main.load_settings(), **SETTINGS, "incremental_enrichment": True}
    monkeypatch.setattr(main, "load_settings", lambda: settings)
    monkeypatch.setattr(main, "create_run_in_supabase", lambda *_args, **_kwargs: "99900000-0000-4000-8000-00000000000a")
    finished: list[tuple] = []
    monkeypatch.setattr(main, "finish_run_in_supabase", lambda *args: finished.append(args))
    for name in ("register_run", "set_active_blocklist", "set_active_court_registry", "record_items",
                 "record_sale_decisions", "ensure_catalogue_lock_held", "warm_image_validations",
                 "update_run_progress_in_supabase"):
        monkeypatch.setattr(main, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "load_contact_blocklist", lambda _settings: None)
    monkeypatch.setattr(main, "load_court_registry", lambda _settings: None)
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales: len(sales))
    monkeypatch.setattr(main, "export_sales", lambda _sales: (None, None))

    # Les lectures et le compteur d'un passage précédent du même processus ne survivent pas à l'ouverture du passage.
    stale = {"id": base.rows[url]["id"], "source_name": "licitor", "source_url": url}
    base_reads.note({**stale, "rooms_count": 9})
    base_reads.note_locked({**stale, "rooms_count": 8})
    base_reads.suppress_echo(AuctionSale(**stale, rooms_count=8), AuctionSale(**stale, rooms_count=9))
    assert base_reads.suppressed_count() == 1
    run = main._open_run(main.PipelineOptions(source="licitor", use_llm=False, heavy_enrichment=False))
    assert base_reads.suppressed_count() == 0
    assert main._load_known_sale_details(run) is True
    run.raw_sales = [{"source_name": "licitor", "source_url": url, "sale_date": sale_date, "starting_price_eur": 90000,
                      "status": "upcoming", "city": "Alphaville", "_known_unchanged": True}]
    main._restore_known_unchanged_sales(run)
    main._normalize_and_deduplicate(run)
    assert [sale.rooms_count for sale in run.canonical_sales] == [3]

    base.move(url, **listing)  # la valeur lue est retirée pendant le passage
    main._prepare_and_publish_early(run)

    assert run.early_upserted == 1
    assert {key: base.rows[url][key] for key in listing} == listing
    assert run.timings["base_echo_suppressed"] == 3

    main._apply_admission_and_reports(run)
    run.app_ready[0].investment_summary = "Synthèse ajoutée après la publication anticipée."
    assert run.app_ready[0].land_surface_m2 == 800
    base.move(url, land_surface_m2=None)  # un second retrait, après la publication anticipée
    main._publish_run(run)

    assert run.final_upserted == 1 and not run.publication_failed
    assert {key: base.rows[url][key] for key in listing} == listing
    assert base.rows[url]["land_surface_m2"] is None
    # Le compteur du passage est repris après la publication finale : il compte aussi ce qu'elle a retenu.
    assert run.timings["base_echo_suppressed"] == 4
    (_run_id, status, summary, _errors), = finished
    assert status == "succeeded"
    assert summary["timings"]["base_echo_suppressed"] == 4
    # Le résumé nomme les couples (vente, groupe), sans valeur, dans la limite prévue.
    sale_id = str(base.rows[url]["id"])
    assert summary["base_echo_suppressed_sample"] == [
        {"sale_id": sale_id, "group": group} for group in ("land", "occupancy", "rooms", "surface")
    ]
    assert main.BASE_ECHO_SAMPLE_SIZE == 50


def test_the_echo_counter_is_reported_as_zero_when_nothing_was_suppressed(monkeypatch) -> None:
    run = main._PipelineRun(
        options=main.PipelineOptions(upsert=False), settings={"pipeline_pdf_workers": 1, "pipeline_llm_workers": 1},
        run_id=None,
    )

    main._prepare_and_publish_early(run)

    assert run.timings["base_echo_suppressed"] == 0


def test_run_pipeline_stays_a_short_orchestrator() -> None:
    source = Path(main.__file__).read_text(encoding="utf-8")
    function = next(
        node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "run_pipeline"
    )

    assert function.end_lineno - function.lineno + 1 <= 50
