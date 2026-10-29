"""Porte de publication : le minimum d'une annonce se juge à l'écriture, pas à l'admission (données fictives)."""

from decimal import Decimal

import pytest
from test_main import _fake_geocode, _raw_sale, _settings

from src import listing_minimum, main
from src.admission import admit_sales, publication_rejection
from src.information_sufficiency import GATE_ENV, ContactBlocklist, publication_gate, set_active_blocklist
from src.models import AuctionSale
from src.sources.common import ScrapeResult


@pytest.fixture(autouse=True)
def gate_on(monkeypatch):
    monkeypatch.setenv(GATE_ENV, "on")


def sale(**fields) -> AuctionSale:
    base = {"source_name": "licitor", "source_url": "https://example.test/vente", "city": "Exempleville",
            "starting_price_eur": Decimal("50000")}
    base.update(fields)
    return AuctionSale(**base)


def test_admission_codes_are_expired_then_price_and_never_the_minimum():
    assert publication_rejection(sale()) is None  # le minimum se juge à l'écriture, avec la base
    assert publication_rejection(AuctionSale(source_name="x", source_url="https://example.test/y")) == (
        "missing_price_and_surface"
    )


def test_admit_sales_does_not_refuse_a_listing_for_its_minimum():
    recorded = []
    kept = admit_sales([sale()], lambda group, decision, reason=None: recorded.append((decision, reason)))
    assert len(kept) == 1 and recorded == []


def test_the_gate_judges_a_new_sale_with_the_one_minimum_rule():
    assert not publication_gate(sale()).sufficient
    assert publication_gate(sale(address="3 rue des Lilas, 59000 Exempleville")).sufficient
    assert publication_gate(sale(lawyer_contact="me.exemple@cabinet-exemple.test")).sufficient


def test_admit_sales_records_a_sale_past_its_catalogue_cutoff_but_within_retention_as_expired():
    """Le dépôt l'écarterait sans décision : restée ``admitted``, elle bloquerait la publication de la source."""
    from datetime import UTC, datetime, timedelta

    from src.admission import is_catalogue_expired, is_expired

    recorded: list[tuple[int, str, str | None]] = []

    def record(group, decision, reason=None):
        recorded.append((len(group), decision, reason))

    ended = sale(
        address="3 rue des Lilas, 59000 Exempleville",
        surface_m2=Decimal("40"),
        sale_date=(datetime.now(UTC) - timedelta(hours=5)).isoformat(),
    )
    postponed = sale(
        source_url="https://example.test/reportee",
        address="3 rue des Lilas, 59000 Exempleville",
        surface_m2=Decimal("40"),
        status="postponed",
        sale_date=(datetime.now(UTC) - timedelta(days=7)).isoformat(),
    )
    for case in (ended, postponed):
        assert not is_expired(case) and is_catalogue_expired(case)

    assert admit_sales([ended, postponed], record) == []
    assert recorded == [(2, "expired", "catalogue_date_passed_not_evidence_of_sale")]


def test_a_blocked_contact_does_not_keep_the_sale():
    contact = "me.exemple@cabinet-exemple.test"
    with_contact = sale(lawyer_contact=contact, id="sale-1")
    assert publication_gate(with_contact).sufficient
    set_active_blocklist(ContactBlocklist(global_emails=frozenset({contact})))
    try:
        assert not publication_gate(with_contact).sufficient
        assert listing_minimum.assess(with_contact).reason == "insufficient_listing"
    finally:
        set_active_blocklist(ContactBlocklist())


def test_gate_off_lets_every_sale_through(monkeypatch):
    monkeypatch.setenv(GATE_ENV, "off")
    assert publication_gate(sale()).sufficient


def _run_pipeline(monkeypatch, raw_sales):
    captured: dict[str, object] = {}
    upserted: list[list[str]] = []
    monkeypatch.setattr(main, "load_settings", lambda: _settings())
    # In GitHub Actions GITHUB_ENV is set and the run id must be a UUID; never
    # write this fake run into the runner's real environment file.
    monkeypatch.delenv("GITHUB_ENV", raising=False)
    monkeypatch.setattr(
        main, "create_run_in_supabase", lambda *args, **kwargs: "00000000-0000-4000-8000-000000000001"
    )
    monkeypatch.setattr(
        main, "finish_run_in_supabase", lambda run_id, status, summary, errors: captured.update(summary=summary)
    )
    monkeypatch.setattr(main, "fetch_enriched_content_hashes", lambda hashes, **kwargs: set())
    monkeypatch.setattr(main, "fetch_known_sale_details", lambda: {})
    monkeypatch.setattr(main, "scrape_avoventes_aquitaine_result", lambda known=None: ScrapeResult(raw_sales, []))
    monkeypatch.setattr(main, "geocode_sale", _fake_geocode)
    monkeypatch.setattr(main, "fill_tribunal", lambda sale: None)
    monkeypatch.setattr(main, "normalize_asset_features", lambda sale: sale)
    monkeypatch.setattr(main, "export_sales", lambda sales: ("out.json", "out.csv"))
    monkeypatch.setattr(main, "build_quality_report", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "format_quality_report", lambda report: [])
    monkeypatch.setattr(main, "mark_past_sales_in_supabase", lambda: 0)
    monkeypatch.setattr(main, "delete_vench_sales_without_surface_in_supabase", lambda: 0)
    monkeypatch.setattr(
        main, "upsert_sales_to_supabase", lambda sales, **kw: upserted.append([s.source_url for s in sales]) or len(sales)
    )
    monkeypatch.setattr(main, "upsert_observations_to_supabase", lambda sales: len(sales))
    options = main.PipelineOptions(source="avoventes", use_llm=False, heavy_enrichment=False, upsert=True)
    assert main.run_pipeline(options) == 0
    return captured["summary"], upserted


def test_run_summary_carries_the_refusal_counters_and_the_old_key_is_gone(monkeypatch):
    summary, upserted = _run_pipeline(monkeypatch, [_raw_sale()])
    # L'écriture est simulée ici : le refus lui-même est testé avec la base simulée (test_listing_minimum.py).
    assert upserted
    assert summary["rejected_insufficient_listing"] == {
        "total": 0, "by_source": {}, "examples": {}, "detail_unread_not_written": {}, "skipped_recently_rejected": {},
    }
    assert "admission_rejected_insufficient_information" not in summary
