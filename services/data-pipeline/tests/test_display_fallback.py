"""Deterministic fallback synthesis, queue hygiene and monitoring (audit of 11/10/2026)."""

import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from src.admission import display_job_block_reason
from src.config import load_settings
from src.enrichment.display_fallback import ABSENCE_SENTENCE_RE, scrub_public_text
from src.enrichment.extract_structured import (
    REJECTED_DISPLAY_MAX_CHARS,
    LLMExtraction,
    _fallback_display_description,
    _structured_sale_context,
    apply_cached_llm_extraction_to_sale,
)
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.pipeline_health import summarize_synthesis_quality
from src.storage import supabase_client as storage

FUTURE = datetime.now(UTC) + timedelta(days=20)

# notaires f9151f97 (Nogent-sur-Vernisson): the template lost the cellar, the
# greenhouse, the outbuildings, the land and the notarial sale mode.
NOGENT_TEXT = (
    "Immobilier.notaires et l'office notarial SARL NORIAL Les Notaires vous proposent : Maison à vendre en "
    "Immo-interactif - Ancienne maison forestière pleine de charme. Elle se compose au rez-de-chaussée d’un séjour, "
    "d’une cuisine, d’une chambre ainsi que d’une salle de bains avec WC. À l’étage, un escalier dessert deux chambres "
    "supplémentaires, une petite pièce pouvant faire office de bureau ou de dressing. En complément, la propriété "
    "dispose d’une cave, d’une serre idéale pour les amateurs de jardinage et de deux dépendances. Conditions de la "
    "vente : 1ère offre possible : à partir de 58 800,00 euros. Réception des offres du 29/10/2026 18:30 au "
    "30/10/2026 18:30 sur le site Immobilier.notaires. VNI 0238537085 | negociation-immobiliere@norial.notaires.fr"
)
# info_encheres c137bbaa (Annemasse): the template pasted this text, truncated,
# with the lawyer's name.
ANNEMASSE_TEXT = (
    "Vente aux enchères publiques en un seul lot : Sur la commune de ANNEMASSE (74100), 16 route des Vallées, "
    "UN APPARTEMEN T au 5ème étage, d’une superficie de 61,65 m² , lot numéro 1455 de la copropriété UNE CAVE au "
    "2ème sous-sol, lot numéro 1407 de la copropriété BIENS INOCCUPES Renseignements : Cahier des conditions de la "
    "vente n°26/00027, S'adresser : - À Maître Sandrine FUSTER Avocat au Barreau de THONON LES BAINS"
)


def _nogent() -> AuctionSale:
    return AuctionSale(
        source_name="notaires",
        source_url="https://www.immo-interactif.fr/encheres-en-ligne/maison/nogent-sur-vernisson-45/1912387",
        city="Nogent-sur-Vernisson",
        department="45",
        property_type="house",
        title="Maison 77 m²",
        description=NOGENT_TEXT,
        raw_text=NOGENT_TEXT,
        surface_m2=Decimal("76.72"),
        app_surface_m2=Decimal("76.72"),
        habitable_surface_m2=Decimal("76.72"),
        land_surface_m2=Decimal("1470"),
        starting_price_eur=Decimal("58800"),
        sale_date=datetime(2026, 10, 30, 17, 30, tzinfo=UTC),
        occupancy_status="vacant",
        rooms_count=5,
        bedrooms_count=3,
        parking_count=1,
        has_garden=False,
        has_garage=False,
        sale_venue_type="notary",
        sale_procedure={"participation_mode": "online"},
        raw_payload={
            "source_procedure_profile": {"family": "notarial"},
            "source_sale_schedule": {"opens_at": "2026-10-29T17:30:00+00:00", "closes_at": "2026-10-30T17:30:00+00:00"},
        },
    )


def _annemasse() -> AuctionSale:
    return AuctionSale(
        source_name="info_encheres",
        source_url="https://www.info-encheres.com/annonce/6081",
        city="Annemasse",
        department="74",
        property_type="apartment",
        title="Appartement 62 m²",
        description=ANNEMASSE_TEXT,
        raw_text=ANNEMASSE_TEXT,
        surface_m2=Decimal("61.65"),
        app_surface_m2=Decimal("61.65"),
        starting_price_eur=Decimal("60000"),
        sale_date=datetime(2026, 10, 16, 13, 0, tzinfo=UTC),
        occupancy_status="vacant",
        raw_payload={"source_procedure_profile": {"family": "judicial"}},
    )


def _licitor_occupied() -> AuctionSale:
    # licitor 63338f8b: "garage, 1 stationnement. L'occupation est indiquée comme occupé."
    text = "Un appartement de 74,10 m² comprenant : entrée, séjour, cuisine, trois chambres. Cave. Garage. Occupé"
    return AuctionSale(
        source_name="licitor",
        source_url="https://www.licitor.com/annonce/11/00/29/vente/110029.html",
        city="Montpellier",
        department="34",
        property_type="apartment",
        description=text,
        raw_text=text,
        surface_m2=Decimal("74.10"),
        app_surface_m2=Decimal("74.10"),
        starting_price_eur=Decimal("90000"),
        sale_date=datetime(2026, 11, 5, 13, 0, tzinfo=UTC),
        occupancy_status="occupied",
        rooms_count=4,
        bedrooms_count=3,
        parking_count=1,
        has_garage=True,
    )


def _fallback(sale: AuctionSale) -> str:
    text = _fallback_display_description(sale, LLMExtraction(), _structured_sale_context(sale) or "")
    assert text
    return text


def test_notarial_fallback_keeps_annexes_land_date_and_interactive_sale_mode():
    text = _fallback(_nogent())

    assert text == (
        "Maison à Nogent-sur-Vernisson (45). Vente notariale interactive du 29/10/2026 au 30/10/2026, première "
        "offre à partir de 58 800 €. Les éléments disponibles mentionnent une surface de 76,72 m², 5 pièces, "
        "3 chambres, un terrain de 1470 m² et des annexes ou équipements : cave, serre, dépendances, "
        "1 stationnement. La maison est indiquée comme libre."
    )
    assert "judiciaire" not in text and "mise à prix" not in text


def test_fallback_never_pastes_the_source_description_or_a_lawyer():
    text = _fallback(_annemasse())

    assert text == (
        "Appartement à Annemasse (74). Vente aux enchères judiciaire le 16/10/2026, mise à prix de 60 000 €. "
        "Les éléments disponibles mentionnent une surface de 61,65 m² et une annexe ou un équipement : cave. "
        "L'appartement est indiqué comme libre."
    )
    for leaked in ("Maître", "FUSTER", "Barreau", "APPARTEMEN T", "S'adresser", "copropriété"):
        assert leaked not in text


def test_fallback_agreement_and_garage_counts_once():
    text = _fallback(_licitor_occupied())

    assert "L'appartement est indiqué comme occupé." in text
    assert "indiquée comme occupé" not in text
    assert "garage" in text and "stationnement" not in text
    assert "cave" in text
    assert "Vente aux enchères le 05/11/2026, mise à prix de 90 000 €." in text

    house = _licitor_occupied()
    house.property_type = "house"
    house.rooms_count = 1
    assert "La maison est indiquée comme occupée." in _fallback(house)
    assert "1 pièce," in _fallback(house)


@pytest.mark.parametrize(
    ("source", "description", "nature", "price"),
    [
        # agrasc 8d70e322 had "La vente judiciaire est prévue le 28 octobre 2026".
        (
            "agrasc",
            "Maison mitoyenne avec un sous-sol et une cour.",
            "Vente organisée par l'AGRASC",
            "prix de 120 000 €",
        ),
        # notaires 6a486c10: "VENTE AU PRIX – PAS D'ENCHERES SUR CE BIEN".
        (
            "notaires",
            "VENTE AU PRIX – PAS D’ENCHERES SUR CE BIEN -- Terrain à bâtir",
            "Vente au prix",
            "prix de 120 000 €",
        ),
        ("cessions_etat", "Pavillon cédé par l'État.", "Cession immobilière de l'État", "prix de 120 000 €"),
    ],
)
def test_non_judicial_sales_never_use_judicial_vocabulary(source, description, nature, price):
    sale = AuctionSale(
        source_name=source,
        source_url=f"https://example.test/{source}",
        city="Beauvais",
        department="60",
        property_type="house",
        description=description,
        surface_m2=Decimal("55"),
        starting_price_eur=Decimal("120000"),
        sale_date=datetime(2026, 10, 28, tzinfo=UTC),
        sale_venue_type="tribunal",
    )

    text = _fallback(sale)

    assert f"{nature} le 28/10/2026, {price}." in text
    assert "judiciaire" not in text.casefold()
    assert "mise à prix" not in text


def test_unsupported_fragment_is_dropped_alone():
    sale = _nogent()
    # Without the structured context, the land area is supported by nothing the
    # final public check reads: only that fragment disappears.
    text = _fallback_display_description(sale, LLMExtraction(), "")

    assert "terrain" not in text
    assert "surface de 76,72 m²" in text and "58 800 €" in text and "cave" in text


def test_fallback_has_no_absence_sentence_and_scrubs_contacts():
    extraction = LLMExtraction(
        occupancy_status="rented",
        occupancy_details="bail en cours, contact Maître Jean Dupont au 06 12 34 56 78",
        works_needed="Surface non précisée",
    )
    sale = _licitor_occupied()
    sale.occupancy_status = "rented"

    text = _fallback_display_description(sale, extraction, _structured_sale_context(sale) or "")

    assert "L'appartement est indiqué comme loué." in text
    assert "Dupont" not in text and "06 12" not in text
    assert not ABSENCE_SENTENCE_RE.search(text)
    for value in (_fallback(_nogent()), _fallback(_annemasse()), _fallback(_licitor_occupied())):
        assert not ABSENCE_SENTENCE_RE.search(value)


@pytest.mark.parametrize(
    "sentence",
    [
        "La date de vente et la mise à prix ne sont pas précisées.",
        "Aucune information fiable concernant la surface exacte n'est fournie.",
        "Les modalités de surenchère et de consignation restent à vérifier.",
        "La source ne précise pas l'occupation.",
    ],
)
def test_absence_pattern_matches_the_audit_sentences(sentence):
    assert ABSENCE_SENTENCE_RE.search(sentence)


def test_scrub_removes_links_emails_phones_and_lawyer_names():
    text = scrub_public_text(
        "Bien libre. Maître Sandrine FUSTER Avocat au Barreau de THONON LES BAINS, tél 04 50 71 00 00, "
        "x@y.fr, www.example.fr."
    )
    assert text == "Bien libre."


def _cached(extraction: dict) -> dict:
    return {
        "llm_prompt_version": "v1",
        "llm_display_prompt_version": str(load_settings()["llm_display_prompt_version"]),
        "llm_extraction": extraction,
    }


def test_rejected_model_output_is_kept_privately_and_capped():
    generated = "Maison de 500 m². " + "Texte " * 600
    sale = AuctionSale(
        source_name="agrasc",
        source_url="https://example.test/house",
        property_type="house",
        surface_m2=Decimal("120"),
        description="Maison de 120 m².",
        raw_payload=_cached({"display_description": generated, "confidence": {"display_description": 1}}),
    )

    apply_cached_llm_extraction_to_sale(sale, prompt_version="v1")

    kept = sale.raw_payload["rejected_display_description"]
    assert sale.raw_payload["llm_display_status"] == "fallback"
    assert kept["text"].startswith("Maison de 500 m².")
    assert len(kept["text"]) == REJECTED_DISPLAY_MAX_CHARS and kept["truncated"] is True
    assert kept["issue_codes"] == ["unsupported_area"]
    assert "500" not in sale.raw_payload["llm_display_description"]


def test_accepted_model_output_clears_a_previous_rejection():
    sale = AuctionSale(
        source_name="agrasc",
        source_url="https://example.test/house",
        property_type="house",
        surface_m2=Decimal("120"),
        description="Maison de 120 m² avec jardin.",
        raw_payload={
            **_cached(
                {
                    "display_description": "Maison de 120 m² avec jardin, d'après la source.",
                    "confidence": {"display_description": 1},
                }
            ),
            "rejected_display_description": {"text": "old"},
        },
    )

    apply_cached_llm_extraction_to_sale(sale, prompt_version="v1")

    assert sale.raw_payload["llm_display_status"] == "accepted"
    assert "rejected_display_description" not in sale.raw_payload


def test_rejected_output_key_is_not_projected_by_public_sql():
    from pathlib import Path

    migrations = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    assert not any(
        "rejected_display_description" in path.read_text(encoding="utf-8") for path in migrations.glob("*.sql")
    )


def _queue_sale(**changes) -> AuctionSale:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/queue",
            "status": "upcoming",
            "sale_date": FUTURE.isoformat(),
            "starting_price_eur": 50000,
        }
    )
    sale.status = "upcoming"
    for key, value in changes.items():
        setattr(sale, key, value)
    return sale


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({}, None),
        ({"status": "withdrawn"}, "status_withdrawn"),
        ({"status": "past"}, "status_past"),
        ({"sale_date": datetime.now(UTC) - timedelta(days=2)}, "past_sale_date"),
        ({"sale_date": None}, None),
        ({"raw_payload": {"publication_identity_conflict": {"reason": "address"}}}, "quarantined"),
        ({"quality_flags": ["property_identity_conflict"]}, "quarantined"),
    ],
)
def test_display_job_block_reason(changes, reason):
    assert display_job_block_reason(_queue_sale(**changes)) == reason


def test_enqueue_skips_display_jobs_for_past_or_quarantined_sales(monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr(storage, "load_settings", lambda: {"llm_prompt_version": "v1"})
    monkeypatch.setattr(storage, "_has_current_llm_description", lambda *_args: False)
    monkeypatch.setattr("src.enrichment.extract_structured.needs_fact_extraction", lambda _sale: False)
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda _u, _k, _t, payload, _c: rows.extend(payload))

    live = _queue_sale()
    past = _queue_sale(source_url="https://example.test/past", sale_date=datetime.now(UTC) - timedelta(days=3))
    held = _queue_sale(source_url="https://example.test/held", raw_payload={"publication_quarantine": "x"})
    storage._enqueue_due_enrichment([live, past, held], "unused", "unused")

    assert [(row["source_url"], row["job_type"]) for row in rows] == [(live.source_url, "display_description")]


def test_health_reports_fallback_and_absence_rates():
    summary = summarize_synthesis_quality(
        [
            {
                "source": "notaires",
                "future": 10,
                "missing_synthesis": 6,
                "fallback_synthesis": 1,
                "absence_synthesis": 2,
            },
            {"source": "vench", "future": 3, "missing_synthesis": 3, "fallback_synthesis": 0, "absence_synthesis": 0},
        ]
    )

    assert summary["with_synthesis"] == 4
    assert summary["fallback_rate"] == 0.25 and summary["absence_sentence_rate"] == 0.5
    assert summary["by_source"]["vench"]["fallback_rate"] is None


def test_template_text_has_french_spacing_before_colons():
    assert re.search(r"\S:", _fallback(_nogent()).replace("29/10/2026", "")) is None
