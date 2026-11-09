"""The analysis must not be discarded by the list-card / detail-page alternation.

Production (12/10/2026): description, raw_text, title, address and coordinates
flipped back and forth between a collection capture (list card merged with the
detail page, with a daily « J - N » countdown) and the recurring source_detail
capture (detail page alone). Each flip invalidated the analysis of the sale.
"""

from copy import deepcopy

from src.config import load_settings
from src.dedupe import _merge_into
from src.display_invalidation import (
    CONTENT_CHANGE_ERASE_DISPLAY,
    CONTENT_CHANGE_KEEP_DISPLAY,
    OPERATIONAL_CHANGE,
    capture_kind,
    normalize_display_text,
)
from src.freshness import record_source_checks
from src.models import AuctionSale

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
    """A stored row with complete facts and a former AI synthesis (still present in the database)."""
    settings = load_settings()
    payload = deepcopy(payload)
    for key in ("source_content_changed", "source_content_change_reason", "source_operational_changed"):
        payload.pop(key, None)
    payload.update(
        llm_display_description=SYNTHESIS,
        llm_display_status="accepted",
        llm_prompt_version=settings["llm_prompt_version"],
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
        "llm_prompt_version",
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


def test_alternating_list_and_detail_captures_keep_the_analysis_current():
    stored = _both_kinds_recorded()
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
        assert result["llm_fact_coverage"] == {"complete": True}
        assert result["llm_fact_input_key"] == "proof"
        assert "display_invalidations" not in result["source_checks"][URL]
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
    assert result["llm_fact_coverage"] == {"complete": True}


def test_newly_extracted_lawyer_does_not_invalidate_the_analysis():
    # Extraction de l'avocat poursuivant (Vench, Petites Affiches) : nom, contact et blocs source « avocat »
    # apparaissent sur des fiches déjà publiées. Leur capture de même nature est déjà connue : l'analyse reste courante.
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
    assert result["llm_fact_coverage"] == {"complete": True}
    # L'empreinte de preuve, elle, change : elle pilote le manifeste des faits LLM (voir docs/pipeline-reliability.md).
    assert after["evidence_fingerprint"] != before["evidence_fingerprint"]
    assert after["capture_fingerprints"] == before["capture_fingerprints"]


def test_ordinary_text_change_discards_the_facts_and_the_former_synthesis():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    raw = _collection_capture()
    raw["raw_text"] += " Balcon donnant sur cour."
    result = _capture(raw, stored)
    assert result["source_content_changed"] is True
    assert result["source_content_change_reason"] == "source_content_changed"
    assert "llm_fact_coverage" not in result
    assert "llm_fact_input_key" not in result
    assert "llm_display_description" not in result
    assert "superseded_analysis" not in result
    assert "display_invalidations" not in result["source_checks"][URL]


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
        assert result["source_content_changed"] is True, change
        assert "llm_fact_coverage" not in result, change
        assert "llm_display_description" not in result, change
        assert "superseded_analysis" not in result, change


def test_price_change_keeps_the_operational_path_and_price_in_prose_erases():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    raw = _collection_capture()
    raw["starting_price_eur"] = 25000
    result = _capture(raw, stored)
    assert result["source_operational_changed"] is True
    assert "superseded_analysis" not in result
    assert "llm_display_description" not in result
    assert result["llm_fact_coverage"] == {"complete": True}

    raw["raw_text"] = raw["raw_text"].replace("31 500.00", "25 000.00")
    result = _capture(raw, stored)
    assert "source_operational_changed" not in result
    assert "llm_fact_coverage" not in result


def test_first_detail_job_after_deploy_invalidates_once_on_kind_switch():
    stored = _with_synthesis(_capture(_collection_capture(), {}))
    result = _capture(_detail_job_capture(), stored, capture="source_detail")
    # Different kind, same major facts: one documentary invalidation, then the kinds are compared separately.
    assert result["source_content_changed"] is True
    assert result["source_content_change_reason"] == "source_content_changed"
    assert result["source_checks"][URL]["capture_kind"] == "detail_page+complete"


def test_capture_kind_and_text_normalisation():
    assert capture_kind({"source_detail_status": "complete"}) == "listing+complete"
    assert capture_kind({"source_detail_status": "restricted"}, "source_detail") == "detail_page+restricted"
    assert capture_kind({}) == "listing"
    assert normalize_display_text("Date : 13/10/26  J - 4 Bien OCCUPÉ") == normalize_display_text(
        "Date : 13/10/26 J-3 bien occupe"
    )
    assert CONTENT_CHANGE_ERASE_DISPLAY != CONTENT_CHANGE_KEEP_DISPLAY != OPERATIONAL_CHANGE


def test_cross_source_merge_of_a_new_change_erases_the_former_synthesis():
    def sale(url: str, payload: dict) -> AuctionSale:
        return AuctionSale(source_name="vench", source_url=url, raw_payload=deepcopy(payload))

    canonical = {"llm_display_description": SYNTHESIS, "llm_display_status": "accepted", "llm_prompt_version": "v"}
    for status in ("stale", "pending"):
        incoming = sale("https://example.test/b", {"source_content_changed": True, "llm_display_status": status})
        merged = _merge_into(sale(URL, canonical), incoming, confidence="source_url")
        assert "llm_display_description" not in merged.raw_payload, status
        assert merged.raw_payload["llm_display_status"] == "pending", status
        assert merged.raw_payload["source_content_changed"] is True, status


def test_relative_deadlines_do_not_change_the_display_fingerprint() -> None:
    """06/11/2026 : Cessions écrit l'échéance par rapport au jour (« dans 34 jours ») ; chaque premier passage du jour
    voyait 20 pages modifiées et effaçait la lecture de leurs pièces."""
    from src.display_invalidation import capture_fingerprints, normalize_display_text

    yesterday = "Offres à déposer dans 35 jours. Publiée aujourd'hui. Visite il y a 2 heures, 12 jours restants."
    today = "Offres à déposer dans 34 jours. Publiée hier. Visite il y a 3 heures, 11 jours restants."
    assert normalize_display_text(yesterday) == normalize_display_text(today)
    sale = {"description": "Terrain de 1 200 m²", "city": "Saint-Alexandre"}
    assert capture_fingerprints({**sale, "raw_text": yesterday})["display"] == capture_fingerprints(
        {**sale, "raw_text": today}
    )["display"]


def test_a_real_text_change_still_changes_the_display_fingerprint() -> None:
    from src.display_invalidation import capture_fingerprints, normalize_display_text

    sale = {"description": "Terrain de 1 200 m²", "city": "Saint-Alexandre"}
    before = capture_fingerprints({**sale, "raw_text": "Offres dans 34 jours. Terrain constructible."})
    after = capture_fingerprints({**sale, "raw_text": "Offres dans 34 jours. Terrain non constructible."})
    assert before["display"] != after["display"]
    # « hier » n'est retiré que comme mot entier.
    assert "hierarchie" in normalize_display_text("Hiérarchie des normes")
