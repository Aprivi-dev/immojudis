"""The AI synthesis must not be erased by the list-card / detail-page alternation.

Production (12/10/2026): description, raw_text, title, address and coordinates
flipped back and forth between a collection capture (list card merged with the
detail page, with a daily « J - N » countdown) and the recurring source_detail
capture (detail page alone). Each flip invalidated and erased the synthesis.
"""

from copy import deepcopy
from datetime import UTC, datetime

from src.config import load_settings
from src.dedupe import _merge_into
from src.display_invalidation import (
    CONTENT_CHANGE_ERASE_DISPLAY,
    CONTENT_CHANGE_KEEP_DISPLAY,
    OPERATIONAL_CHANGE,
    capture_kind,
    count_display_invalidation,
    normalize_display_text,
)
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION, has_current_display
from src.freshness import record_source_checks
from src.models import AuctionSale
from src.pipeline_health import summarize_display_invalidations

URL = "https://www.vench.fr/vente-166341-lot-1-de-la-vente-un-appartement-toulon.html"
SYNTHESIS = "Appartement de trois pièces au sixième étage à Toulon, occupé, vendu aux enchères. " * 2


def _collection_capture(countdown: int = 4) -> dict:
    """List card merged with its detail page, as a collection run reads it."""
    return {
        "source_name": "vench",
        "source_url": URL,
        "source_detail_status": "complete",
        "title": "LOT 1 DE LA VENTE : UN APPARTEMENT",
        "description": "LOT 1 DE LA VENTE : UN APPARTEMENT",
        "raw_text": (
            f"UN APPARTEMENT • 62m² • Toulon Mise à prix : 31 500.00 € Date de la vente : 13/10/26 J - {countdown}\n"
            "Premier lot de la vente UN APPARTEMENT n° 462 B, au 6ème étage. Occupation Bien occupé"
        ),
        "address": "Toulon",
        "city": "Toulon",
        "property_type": "appartement",
        "surface_m2": 62,
        "rooms_count": 3,
        "occupancy_status": "occupé",
        "starting_price_eur": 31500,
        "sale_date": "2026-10-13",
        "status": "upcoming",
        "latitude": 43.136696,
        "longitude": 5.928,
    }


def _detail_job_capture() -> dict:
    """The same page read alone by the recurring source_detail job."""
    return {
        "source_name": "vench",
        "source_url": URL,
        "source_detail_status": "complete",
        "title": "Appartement • 62m² 83000 Toulon",
        "description": "Premier lot de la vente UN APPARTEMENT n° 462 B, au 6ème étage. Occupation Bien occupé",
        "raw_text": "Premier lot de la vente UN APPARTEMENT n° 462 B, au 6ème étage. Occupation Bien occupé",
        "address": "Bloc B4, 83000 Toulon",
        "city": "Toulon",
        "property_type": "appartement",
        "surface_m2": 62,
        "rooms_count": 3,
        "occupancy_status": "occupé",
        "starting_price_eur": 31500,
        "sale_date": "2026-10-13",
        "status": "upcoming",
        "latitude": 43.1275466,
        "longitude": 5.93,
        "lawyer_contact": "Maître Exemple",
    }


def _with_synthesis(payload: dict) -> dict:
    settings = load_settings()
    payload = deepcopy(payload)
    for key in ("source_content_changed", "source_content_change_reason", "source_operational_changed"):
        payload.pop(key, None)
    payload.update(
        llm_display_description=SYNTHESIS,
        llm_display_status="accepted",
        llm_display_quality_version=DISPLAY_QUALITY_VERSION,
        llm_prompt_version=settings["llm_prompt_version"],
        llm_display_prompt_version=settings["llm_display_prompt_version"],
        llm_display_model=settings["replicate_model"],
        llm_fact_coverage={"complete": True},
        llm_fact_input_key="proof",
    )
    return payload


def _capture(raw: dict, stored: dict, *, capture: str = "collection") -> dict:
    """Record ``raw`` against the stored row and return the resulting payload."""
    raw = deepcopy(raw)
    for key in (
        "llm_display_description",
        "llm_display_status",
        "llm_display_quality_version",
        "llm_prompt_version",
        "llm_display_prompt_version",
        "llm_display_model",
        "llm_fact_coverage",
        "llm_fact_input_key",
        "source_content_changed",
    ):
        if key in stored:
            raw[key] = deepcopy(stored[key])
    record_source_checks([raw], {URL: {"raw_payload": stored}}, capture=capture)
    return raw


def _both_kinds_recorded() -> dict:
    first = _capture(_collection_capture(), {})
    second = _capture(_detail_job_capture(), _with_synthesis(first), capture="source_detail")
    return _with_synthesis(second)


def test_alternating_list_and_detail_captures_keep_the_synthesis_current():
    stored = _both_kinds_recorded()
    invalidations_before = stored["source_checks"][URL]["display_invalidations"]
    captures = [
        (_collection_capture(3), "collection"),
        (_detail_job_capture(), "source_detail"),
        (_collection_capture(2), "collection"),
        (_detail_job_capture(), "source_detail"),
        (_collection_capture(1), "collection"),
    ]
    for raw, capture in captures:
        result = _capture(raw, stored, capture=capture)
        assert result["source_checks"][URL]["fingerprint"] != stored["source_checks"][URL]["fingerprint"]
        assert "source_content_changed" not in result
        assert result["llm_display_description"] == SYNTHESIS
        assert result["llm_display_status"] == "accepted"
        assert has_current_display(result)
        assert result["source_checks"][URL]["display_invalidations"] == invalidations_before
        stored = _with_synthesis(result)
    assert set(stored["source_checks"][URL]["capture_fingerprints"]) == {
        "listing+complete",
        "detail_page+complete",
    }


def test_non_textual_fields_and_countdown_do_not_invalidate():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    raw = _collection_capture(countdown=2)
    raw.update(
        latitude=43.2,
        longitude=5.9,
        title="UN APPARTEMENT",
        address="6ème étage, Toulon",
        lawyer_name="Maître Autre",
        lawyer_contact="04 00 00 00 00",
        surface_source="pdf",
        surface_evidence="62 m² habitables",
        risk_notes=["copropriété"],
    )
    result = _capture(raw, stored)
    assert result["source_checks"][URL]["fingerprint"] != stored["source_checks"][URL]["fingerprint"]
    assert "source_content_changed" not in result
    assert result["llm_display_status"] == "accepted"


def test_newly_extracted_lawyer_does_not_requeue_the_display_text():
    # Extraction de l'avocat poursuivant (Vench, Petites Affiches) : nom, contact et blocs source « avocat »
    # apparaissent sur des fiches déjà publiées. Leur capture de même nature est déjà connue : le texte reste courant.
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    raw = _collection_capture()
    raw.update(
        lawyer_name="SCP TESTARD ET ASSOCIES (Maître Camille TESTARD)",
        lawyer_contact="01 00 00 00 01 · cabinet@testard.example",
        source_blocks={
            "avocat": "SCP TESTARD ET ASSOCIES (Maître Camille TESTARD)",
            "contact_avocat": "01 00 00 00 01 · cabinet@testard.example",
        },
    )
    result = _capture(raw, stored)
    before, after = stored["source_checks"][URL], result["source_checks"][URL]

    assert "source_content_changed" not in result
    assert result["llm_display_status"] == "accepted"
    assert has_current_display(result)
    assert after["display_invalidations"] == before["display_invalidations"]
    # L'empreinte de preuve, elle, change : elle pilote le manifeste des faits LLM (voir docs/pipeline-reliability.md).
    assert after["evidence_fingerprint"] != before["evidence_fingerprint"]
    assert after["capture_fingerprints"] == before["capture_fingerprints"]


def test_ordinary_text_change_keeps_the_old_text_as_stale_and_requeues():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    before = stored["source_checks"][URL]["display_invalidations"]["count"]
    raw = _collection_capture()
    raw["raw_text"] += " Balcon donnant sur cour."
    result = _capture(raw, stored)
    assert result["source_content_changed"] is True
    assert result["source_content_change_reason"] == "source_content_changed"
    assert result["llm_display_description"] == SYNTHESIS
    assert result["llm_display_status"] == "stale"
    assert not has_current_display(result)
    assert "llm_fact_coverage" not in result
    assert "superseded_analysis" not in result
    assert result["source_checks"][URL]["display_invalidations"]["count"] == before + 1


def test_major_documentary_change_removes_the_text():
    changes = [
        {"surface_m2": 48},
        {"raw_text": _collection_capture()["raw_text"] + " Cave de 8 m²."},
        {"occupancy_status": "libre"},
        {"property_type": "maison"},
        {"documents": [{"url": "https://www.vench.fr/upload/ccv.pdf", "label": "CCV"}]},
    ]
    for change in changes:
        stored = _with_synthesis(_capture(_collection_capture(), {}))
        result = _capture({**_collection_capture(), **change}, stored)
        assert result["llm_display_status"] == "pending", change
        assert "llm_display_description" not in result, change
        assert result["superseded_analysis"]["description"] == SYNTHESIS, change


def test_price_change_keeps_the_operational_path_and_price_in_prose_erases():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    raw = _collection_capture()
    raw["starting_price_eur"] = 25000
    result = _capture(raw, stored)
    assert result["source_operational_changed"] is True
    assert result["superseded_analysis"]["reason"] == "source_operational_changed"
    assert result["superseded_analysis"]["operational_refreshable"] is True
    assert result["llm_fact_coverage"] == {"complete": True}

    raw["raw_text"] = raw["raw_text"].replace("31 500.00", "25 000.00")
    result = _capture(raw, stored)
    assert "source_operational_changed" not in result
    assert "llm_display_description" not in result
    assert result["llm_display_status"] == "pending"


def test_first_detail_job_after_deploy_never_erases_on_kind_switch_alone():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    result = _capture(_detail_job_capture(), stored, capture="source_detail")
    # Different kind, same major facts: at most one regeneration, text kept.
    assert result["llm_display_status"] == "stale"
    assert result["llm_display_description"] == SYNTHESIS
    assert result["source_checks"][URL]["capture_kind"] == "detail_page+complete"


def test_capture_kind_and_text_normalisation():
    assert capture_kind({"source_detail_status": "complete"}) == "listing+complete"
    assert capture_kind({"source_detail_status": "restricted"}, "source_detail") == "detail_page+restricted"
    assert capture_kind({}) == "listing"
    assert normalize_display_text("Date : 13/10/26  J - 4 Bien OCCUPÉ") == normalize_display_text(
        "Date : 13/10/26 J-3 bien occupe"
    )
    assert CONTENT_CHANGE_ERASE_DISPLAY != CONTENT_CHANGE_KEEP_DISPLAY != OPERATIONAL_CHANGE


def test_invalidation_counter_is_daily():
    morning = datetime(2026, 10, 12, 8, tzinfo=UTC)
    first = count_display_invalidation({}, invalidated=True, now=morning)
    assert first == {"day": "2026-10-12", "count": 1}
    second = count_display_invalidation({"display_invalidations": first}, invalidated=True, now=morning)
    assert second == {"day": "2026-10-12", "count": 2}
    assert count_display_invalidation({"display_invalidations": second}, invalidated=False, now=morning) == second
    next_day = datetime(2026, 10, 13, 1, tzinfo=UTC)
    assert count_display_invalidation({"display_invalidations": second}, invalidated=False, now=next_day) is None


def test_health_summary_of_invalidations_per_sale():
    assert summarize_display_invalidations([1, 4, None, 3]) == {
        "sales": 3,
        "invalidations": 8,
        "per_sale_avg": 2.67,
        "per_sale_max": 4,
        "sales_with_3_or_more": 2,
    }
    assert summarize_display_invalidations([])["per_sale_avg"] == 0


def test_cross_source_merge_keeps_a_stale_text_and_erases_on_major_change():
    def sale(url: str, payload: dict) -> AuctionSale:
        return AuctionSale(source_name="vench", source_url=url, raw_payload=deepcopy(payload))

    canonical = {"llm_display_description": SYNTHESIS, "llm_display_status": "accepted", "llm_prompt_version": "v"}
    stale = sale("https://example.test/b", {"source_content_changed": True, "llm_display_status": "stale"})
    merged = _merge_into(sale(URL, canonical), stale, confidence="source_url")
    assert merged.raw_payload["llm_display_description"] == SYNTHESIS
    assert merged.raw_payload["llm_display_status"] == "stale"

    pending = sale("https://example.test/b", {"source_content_changed": True, "llm_display_status": "pending"})
    merged = _merge_into(sale(URL, canonical), pending, confidence="source_url")
    assert "llm_display_description" not in merged.raw_payload
    assert merged.raw_payload["llm_display_status"] == "pending"
