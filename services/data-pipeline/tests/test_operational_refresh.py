from copy import deepcopy

from fake_publication import inside_publication

from src.config import load_settings
from src.freshness import record_source_checks, settle_source_change_without_documents
from src.models import AuctionSale


def _revision():
    raw = {"source_url": "https://example.test/operational", "source_name": "avoventes",
           "raw_text": "Appartement de trois pièces à Bordeaux.", "starting_price_eur": 100000,
           "sale_date": "2026-11-01", "status": "upcoming"}
    record_source_checks([raw], {})
    raw.pop("source_content_changed", None)
    raw.update(llm_display_description="Synthèse courante fondée sur les informations vérifiées du dossier. " * 3,
               llm_fact_extraction={"rooms_count": 3, "display_description": "Ancien texte"},
               llm_fact_coverage={"complete": True}, llm_fact_input_key="proof",
               document_facts_version="current", investment_analysis={"price": 100000},
               llm_display_status="accepted",
               llm_prompt_version=load_settings()["llm_prompt_version"])
    known = {raw["source_url"]: {"raw_payload": deepcopy(raw)}}
    return raw, known


def test_operational_revision_preserves_facts_and_removes_old_prose():
    raw, known = _revision()
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    assert raw["source_operational_changed"] is True
    assert raw["llm_fact_coverage"]["complete"]
    assert raw["llm_fact_input_key"] == "proof"
    assert raw["document_facts_version"] == "current"
    assert raw["llm_fact_extraction"]["display_description"] is None
    assert "llm_display_description" not in raw
    assert "superseded_analysis" not in raw
    assert "investment_analysis" not in raw


def test_changed_evidence_invalidates_fact_completion():
    raw, known = _revision()
    raw["raw_text"] += " Occupation sans titre."
    record_source_checks([raw], known)
    assert "source_operational_changed" not in raw
    assert "llm_fact_coverage" not in raw
    assert "llm_fact_input_key" not in raw


def test_identical_rescan_keeps_display_and_fact_coverage():
    raw, known = _revision()
    record_source_checks([raw], known)
    assert "source_content_changed" not in raw
    assert "llm_display_description" in raw
    assert raw["llm_fact_coverage"]["complete"]


def test_legacy_revision_is_not_assumed_operational_only():
    raw, known = _revision()
    legacy_check = known[raw["source_url"]]["raw_payload"]["source_checks"][raw["source_url"]]
    legacy_check.pop("evidence_fingerprint")
    legacy_check.pop("capture_fingerprints")
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    assert "llm_fact_coverage" not in raw


def test_source_check_records_detail_proof_only_for_validated_detail():
    source_url = "https://example.test/detail-proof"
    validated = {
        "source_url": source_url,
        "source_name": "avoventes",
        "raw_text": "Appartement à Bordeaux.",
        "source_detail_status": "complete",
    }
    record_source_checks([validated], {})
    assert validated["source_checks"][source_url]["detail_status"] == "complete"

    known = {source_url: {"raw_payload": deepcopy(validated)}}
    listing_capture = {
        "source_url": source_url,
        "source_name": "avoventes",
        "raw_text": "Appartement à Bordeaux.",
    }
    record_source_checks([listing_capture], known)
    assert "detail_status" not in listing_capture["source_checks"][source_url]


def test_pending_documentary_flag_survives_a_later_operational_rescan():
    from src.known_enrichment import preserve_known_enrichment_payloads

    source_url = "https://example.test/documentary-then-operational"
    base = {
        "source_name": "avoventes",
        "source_url": source_url,
        "raw_text": "Appartement documenté à Bordeaux.",
        "starting_price_eur": 100000,
        "sale_date": "2026-11-01",
        "status": "upcoming",
    }
    record_source_checks([base], {})
    known_payload = deepcopy(base)
    known_payload.update(
        source_content_changed=True,
        source_content_change_reason="source_content_changed",
    )
    incoming = deepcopy(base)
    incoming["starting_price_eur"] = 90000
    preserve_known_enrichment_payloads(
        [incoming], {source_url: {"raw_payload": known_payload}},
    )
    record_source_checks([incoming], {source_url: {"raw_payload": known_payload}})
    assert incoming["source_content_changed"] is True
    assert incoming["source_content_change_reason"] == "source_content_changed"
    assert incoming["source_operational_changed"] is True


def _publish(monkeypatch, sale):
    from src.storage import supabase_client as storage

    events = []
    monkeypatch.setattr(storage, "tribunal_reference_rows", lambda _: [])
    inside_publication(
        monkeypatch,
        on_write=lambda table, rows, _conflict: (
            events.append(("write", rows[0]["raw_payload"].copy())) if table == "auction_sales" else None
        ),
    )
    monkeypatch.setattr(storage, "_write_fact_claims_postgres", lambda *args, **kwargs: 0)
    monkeypatch.setattr(storage, "_sync_normalized_sale_tables", lambda *args, **kwargs: None)
    monkeypatch.setattr(storage, "_upsert_asset_tables", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        storage,
        "_enqueue_due_enrichment",
        lambda rows, *_args: events.append(("enqueue", rows[0].raw_payload.copy())),
    )
    assert storage._write_sale_revisions([sale], refresh_last_seen=False) == 1
    assert [event[0] for event in events] == ["write", "enqueue"]
    return events


def test_publication_clears_the_change_flags_of_a_sale_without_documents(monkeypatch):
    raw, known = _revision()
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    sale = AuctionSale(
        source_name="avoventes",
        source_url=raw["source_url"],
        city="Bordeaux",
        property_type="apartment",
        rooms_count=3,
        starting_price_eur=80000,
        raw_payload=raw,
    )

    events = _publish(monkeypatch, sale)

    written_payload = events[0][1]
    # No fact pass would ever clear them: they are cleared at the write, and no text is written.
    assert "source_content_changed" not in written_payload
    assert "source_operational_changed" not in written_payload
    assert "llm_display_description" not in written_payload
    assert "llm_display_origin" not in written_payload
    assert "source_content_changed" not in events[1][1]
    assert written_payload["llm_fact_coverage"] == {"complete": True}


def test_change_flags_of_a_sale_with_documents_wait_for_the_fact_pass():
    flags = {"source_content_changed": True, "source_content_change_reason": "source_content_changed"}
    with_documents = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/with-documents",
        documents=[{"label": "CCV", "url": "https://example.test/ccv.pdf"}],
        raw_payload=dict(flags),
    )
    assert settle_source_change_without_documents(with_documents) is False
    assert with_documents.raw_payload == flags

    without_documents = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/without-documents",
        raw_payload={**flags, "source_operational_changed": True},
    )
    assert settle_source_change_without_documents(without_documents) is True
    assert without_documents.raw_payload == {}
    assert settle_source_change_without_documents(without_documents) is False
