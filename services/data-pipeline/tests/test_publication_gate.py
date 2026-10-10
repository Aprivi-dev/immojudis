"""Porte de publication « informations suffisantes » : intégration dans l'admission et dans le run (données fictives)."""

import logging
from decimal import Decimal

import pytest
from test_main import _fake_geocode, _raw_sale, _settings

from src import main
from src.admission import admit_sales, publication_rejection, split_insufficient
from src.information_sufficiency import GATE_ENV, ContactBlocklist, set_active_blocklist
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


def test_publication_rejection_codes_are_ordered_expired_then_price_then_information():
    assert publication_rejection(sale(address="3 rue des Lilas, 59000 Exempleville", surface_m2=Decimal("40"))) is None
    assert publication_rejection(sale()) == "insufficient_information:missing_address+missing_surface"
    assert publication_rejection(AuctionSale(source_name="x", source_url="https://example.test/y")) == (
        "missing_price_and_surface"
    )


def test_admit_sales_records_every_rejection_by_code_only():
    recorded: list[tuple[int, str, str | None]] = []

    def record(group, decision, reason=None):
        recorded.append((len(group), decision, reason))

    good = sale(address="3 rue des Lilas, 59000 Exempleville", surface_m2=Decimal("40"))
    bad = sale(source_url="https://example.test/bad")
    assert admit_sales([good, bad], record) == [good]
    assert recorded == [(1, "excluded", "insufficient_information:missing_address+missing_surface")]


def test_a_blocked_contact_does_not_keep_the_sale():
    contact = "me.exemple@cabinet-exemple.test"
    with_contact = sale(lawyer_contact=contact, id="sale-1")
    assert publication_rejection(with_contact) is None
    set_active_blocklist(ContactBlocklist(global_emails=frozenset({contact})))
    try:
        assert publication_rejection(with_contact) == "insufficient_information:missing_address+missing_surface"
    finally:
        set_active_blocklist(ContactBlocklist())


def test_split_insufficient_counts_by_reason_and_source_and_logs_no_personal_data(caplog):
    contact = "me.exemple@cabinet-exemple.test"
    sales = [
        sale(source_url="https://example.test/a", lawyer_contact=contact),
        sale(source_url="https://example.test/b", address="3 rue des Lilas, 59000 Exempleville"),
        sale(source_url="https://example.test/c", source_name="vench", primary_source="vench"),
    ]
    with caplog.at_level(logging.INFO):
        kept, summary = split_insufficient(sales, logging.getLogger("test"))
    assert [item.source_url for item in kept] == ["https://example.test/a"]
    assert summary == {
        "total": 2,
        "by_reason": {
            "insufficient_information:missing_surface": 1,
            "insufficient_information:missing_address+missing_surface": 1,
        },
        "by_source": {"licitor": 1, "vench": 1},
    }
    assert contact not in caplog.text and "Lilas" not in caplog.text


def test_gate_off_restores_the_previous_admission(monkeypatch):
    monkeypatch.setenv(GATE_ENV, "off")
    assert publication_rejection(sale()) is None


def test_paid_llm_and_checkpoint_follow_the_same_gate(monkeypatch):
    assert main._can_use_paid_llm(sale()) is False
    assert main._can_use_paid_llm(sale(address="3 rue des Lilas, 59000 Exempleville", surface_m2=Decimal("40")))
    monkeypatch.setattr(main, "upsert_sales_to_supabase", lambda *args, **kwargs: pytest.fail("published"))
    assert main._checkpoint_enrichment(sale()) is False


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


def test_run_pipeline_does_not_publish_an_insufficient_sale_and_reports_why(monkeypatch):
    insufficient = _raw_sale()  # prix et adresse précise, mais ni superficie ni contact e-mail
    summary, upserted = _run_pipeline(monkeypatch, [insufficient])
    assert upserted == []
    assert summary["admission_rejected_insufficient_information"] == {
        "total": 1,
        "by_reason": {"insufficient_information:missing_surface": 1},
        "by_source": {"avoventes": 1},
    }


def test_run_pipeline_publishes_the_same_sale_when_a_usable_contact_exists(monkeypatch):
    with_contact = _raw_sale()
    with_contact["lawyer_contact"] = "me.exemple@cabinet-exemple.test"
    summary, upserted = _run_pipeline(monkeypatch, [with_contact])
    assert upserted and all(urls == ["https://example.test/vente"] for urls in upserted)
    assert summary["admission_rejected_insufficient_information"]["total"] == 0
