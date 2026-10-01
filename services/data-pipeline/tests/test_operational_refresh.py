from copy import deepcopy

import pytest

from src.config import load_settings
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION, has_current_display
from src.enrichment.operational_display import refresh_operational_display
from src.freshness import record_source_checks
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
               llm_display_quality_version=DISPLAY_QUALITY_VERSION,
               llm_display_status="accepted",
               llm_prompt_version=load_settings()["llm_prompt_version"],
               llm_display_prompt_version=load_settings()["llm_display_prompt_version"],
               llm_display_model=load_settings()["replicate_model"])
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
    known[raw["source_url"]]["raw_payload"]["source_checks"][raw["source_url"]].pop("evidence_fingerprint")
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    assert "llm_fact_coverage" not in raw


def test_operational_display_is_new_and_network_free():
    raw, known = _revision()
    raw["starting_price_eur"] = 80000
    record_source_checks([raw], known)
    sale = AuctionSale(source_name="avoventes", source_url=raw["source_url"], city="Bordeaux",
                       property_type="apartment", rooms_count=3, raw_payload=raw)
    assert refresh_operational_display(sale)
    assert has_current_display(sale.raw_payload)
    text = sale.raw_payload["llm_display_description"]
    assert "100000" not in text and "novembre" not in text
    assert "3 pièces" in text
    assert "source_content_changed" not in sale.raw_payload


def test_operational_refresh_preserves_source_legal_constraints():
    settings = load_settings()
    sale = AuctionSale(source_name="avoventes", source_url="https://example.test/risk",
                       city="Bordeaux", property_type="apartment",
                       raw_payload={
                           "source_operational_changed": True,
                           "source_content_changed": True,
                           "source_content_change_reason": "source_operational_changed",
                           "description": "Appartement à Bordeaux. Le bien est en indivision.",
                           "superseded_analysis": {
                               "reason": "source_operational_changed",
                               "operational_refreshable": True,
                               "prompt_version": settings["llm_prompt_version"],
                               "display_prompt_version": settings["llm_display_prompt_version"],
                               "model": settings["replicate_model"],
                               "quality_version": DISPLAY_QUALITY_VERSION,
                               "status": "accepted",
                               "source_content_changed_before": False,
                               "source_content_change_reason_before": None,
                           },
                       })
    assert refresh_operational_display(sale)
    assert "indivision" in sale.raw_payload["llm_display_description"]


@pytest.mark.parametrize("description", [
    "La vente est fixée au 1 novembre 2026, avec une servitude de passage.",
    "Le prix initial s'élève à 100 000 euros, avec une servitude de passage.",
    "La visite est prévue lundi prochain, avec une servitude de passage.",
    "La vente est fixée au premier novembre, avec une servitude de passage.",
    "La vente est reportée à lundi, avec une servitude de passage.",
    "Le prix initial s'élève à cent mille euros, avec une servitude de passage.",
])
def test_operational_refresh_rejects_operational_reference_inside_source_quote(description):
    payload = _eligible_operational_payload()
    payload["description"] = description
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/operational-quote",
        property_type="apartment",
        city="Bordeaux",
        raw_payload=payload,
    )
    assert not refresh_operational_display(sale)
    assert sale.raw_payload["source_content_changed"] is True
    assert sale.raw_payload["source_operational_changed"] is True


def test_document_backed_refresh_requires_current_documentary_facts():
    payload = _eligible_operational_payload()
    payload.update(
        llm_fact_extraction={"display_description": "Ancien résumé PDF", "servitudes": []},
        llm_fact_coverage={"complete": True},
        llm_fact_input_key="old-document-input",
    )
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/document-backed",
        documents=[{"url": "https://example.test/pv.pdf", "label": "PV"}],
        raw_payload=payload,
    )
    assert not refresh_operational_display(sale)
    assert sale.raw_payload["source_content_changed"] is True
    assert sale.raw_payload["source_operational_changed"] is True


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


def _eligible_operational_payload() -> dict:
    settings = load_settings()
    return {
        "source_operational_changed": True,
        "source_content_changed": True,
        "source_content_change_reason": "source_operational_changed",
        "description": "Appartement à Bordeaux.",
        "superseded_analysis": {
            "reason": "source_operational_changed",
            "operational_refreshable": True,
            "prompt_version": settings["llm_prompt_version"],
            "display_prompt_version": settings["llm_display_prompt_version"],
            "model": settings["replicate_model"],
            "quality_version": DISPLAY_QUALITY_VERSION,
            "status": "accepted",
            "source_content_changed_before": False,
            "source_content_change_reason_before": None,
        },
    }


def test_operational_refresh_requires_a_current_previous_presentation():
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/missing-display",
        raw_payload={
            "source_operational_changed": True,
            "source_content_changed": True,
            "source_content_change_reason": "source_operational_changed",
        },
    )
    assert not refresh_operational_display(sale)
    assert sale.raw_payload["source_content_changed"] is True
    assert sale.raw_payload["source_operational_changed"] is True


@pytest.mark.parametrize("metadata_key", ["prompt_version", "display_prompt_version", "model"])
def test_operational_refresh_requires_the_same_display_contract(metadata_key):
    payload = _eligible_operational_payload()
    payload["superseded_analysis"][metadata_key] = "changed-contract"
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/contract-change",
        raw_payload=payload,
    )
    assert not refresh_operational_display(sale)
    assert sale.raw_payload["source_content_changed"] is True


def test_current_display_with_a_known_model_change_is_not_current():
    settings = load_settings()
    payload = {
        "llm_display_description": "Synthèse vérifiée et suffisamment détaillée pour la fiche publique. " * 2,
        "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
        "llm_display_status": "accepted",
        "llm_prompt_version": settings["llm_prompt_version"],
        "llm_display_prompt_version": settings["llm_display_prompt_version"],
        "llm_display_model": "old/model",
    }
    assert not has_current_display(
        payload,
        settings["llm_prompt_version"],
        settings["llm_display_prompt_version"],
        settings["replicate_model"],
    )


def test_operational_refresh_does_not_clear_pending_documentary_enrichment():
    payload = _eligible_operational_payload()
    payload["source_content_change_reason"] = "source_content_changed"
    payload["superseded_analysis"].update(
        source_content_changed_before=True,
        source_content_change_reason_before="source_content_changed",
    )
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/documentary-pending",
        raw_payload=payload,
    )
    assert not refresh_operational_display(sale)
    assert sale.raw_payload["source_content_changed"] is True
    assert sale.raw_payload["source_operational_changed"] is True


def test_pending_documentary_flag_survives_a_later_operational_rescan():
    from src.main import _preserve_known_enrichment_payloads

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
    _preserve_known_enrichment_payloads(
        [incoming], {source_url: {"raw_payload": known_payload}},
    )
    record_source_checks([incoming], {source_url: {"raw_payload": known_payload}})
    assert incoming["source_content_changed"] is True
    assert incoming["source_content_change_reason"] == "source_content_changed"
    assert incoming["source_operational_changed"] is True


def test_publication_refreshes_before_enqueue(monkeypatch):
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

    from src.storage import supabase_client as storage

    events = []
    monkeypatch.setattr(storage, "tribunal_reference_rows", lambda _: [])
    monkeypatch.setattr(
        storage,
        "_upsert_with_rest",
        lambda _url, _key, rows: events.append(("write", rows[0]["raw_payload"].copy())),
    )
    monkeypatch.setattr(storage, "_write_fact_claims_rest", lambda *args, **kwargs: 0)
    monkeypatch.setattr(storage, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        storage,
        "_enqueue_due_enrichment",
        lambda rows, *_args: events.append(("enqueue", rows[0].raw_payload.copy())),
    )

    settings = load_settings()
    assert storage._write_sale_revisions([sale], settings, refresh_last_seen=False) == 1
    assert [event[0] for event in events] == ["write", "enqueue"]
    written_payload = events[0][1]
    assert written_payload["llm_display_origin"] == "operational_refresh"
    assert "source_content_changed" not in written_payload
    assert "source_operational_changed" not in written_payload
    assert "source_content_changed" not in events[1][1]


@pytest.mark.parametrize("facts", [
    {"servitudes": ["Passage imposé par le cahier des conditions de vente"]},
    {"occupancy_details": "Locataire dont le bail fait l'objet d'une contestation"},
])
def test_operational_refresh_does_not_drop_pdf_only_qualifiers(facts):
    sale = AuctionSale(source_name="avoventes", source_url="https://example.test/pdf-risk",
                       city="Bordeaux", property_type="apartment",
                       raw_payload={**_eligible_operational_payload(), "llm_fact_extraction": facts})
    assert not refresh_operational_display(sale)
    assert "llm_display_description" not in sale.raw_payload
