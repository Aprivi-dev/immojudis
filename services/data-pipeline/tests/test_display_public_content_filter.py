"""P2-20 : aucun numéro, lien ou consigne adressée au lecteur ne passe dans le texte publié."""
import logging
from decimal import Decimal

import pytest

from src.config import load_settings
from src.enrichment.display_evidence import verify_display_claims
from src.enrichment.extract_structured import apply_cached_llm_extraction_to_sale
from src.models import AuctionSale


def _codes(text):
    issues = verify_display_claims(text, "Maison de 91 m².", {})["issues"]
    return {issue["code"] for issue in issues if issue["code"].startswith("public_")}


def _cached_payload(extraction):
    return {
        "llm_prompt_version": "v1",
        "llm_display_prompt_version": str(load_settings()["llm_display_prompt_version"]),
        "llm_extraction": extraction,
    }


# --- numéros de téléphone ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Contact : 06 12 34 56 78.",
        "Appelez le 06 12 34 56 78 pour visiter.",
        "Maison de 91 m², renseignements au 0612345678.",
        "Renseignements 06.12.34.56.78",
        "Renseignements 06-12-34-56-78",
        "Cabinet : 05 56 12 34 56",
        "Joignable au +33 6 12 34 56 78.",
        "Joignable au +33 (0)6 12 34 56 78.",
        "Joignable au 0033 6 12 34 56 78.",
        "Joignable au +44 20 7946 0958.",
        "Tél : 05 56 12",
        "Tel. 0556",
        "Portable : +33",
        "WhatsApp 06",
    ],
)
def test_phone_numbers_are_refused(text):
    assert "public_phone_number" in _codes(text)


@pytest.mark.parametrize(
    "text",
    [
        "Maison de 91 m² avec trois pièces, mise à prix 100 000 €.",
        "Audience le 01 02 2027 14h au tribunal judiciaire.",
        "Audience le 1er février 2027 à 14h30.",
        "Vente le 22/10/2026, visite le 12/10/2026.",
        "Parcelles cadastrées section AB n° 0123 et 0456, soit 1 234 m².",
        "Société inscrite au RCS de Paris sous le numéro 012 345 678.",
        "Terrain de 12 345 m² et prix de 150 000 euros.",
        "Mobile home à rénover, portable de chantier non inclus.",
        "Appartement au 3e étage, lot 12, cave n° 4.",
    ],
)
def test_ordinary_numbers_are_not_mistaken_for_phones(text):
    assert "public_phone_number" not in _codes(text)


# --- consignes adressées au lecteur -----------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Contactez l'avocat poursuivant.",
        "Appelez le cabinet.",
        "Téléchargez le cahier des conditions de vente.",
        "Renseignez-vous auprès du greffe.",
        "N'hésitez pas à visiter le bien.",
        "Profitez d'une belle opportunité.",
        "Découvrez cette maison de 91 m².",
        "Venez visiter le bien.",
        "Demandez le dossier complet.",
        "Faites une offre avant l'audience.",
        "Investissez dans ce bien.",
        "Veuillez contacter l'étude.",
        "Merci de vous présenter avec un chèque.",
        "Rendez-vous sur le site du tribunal.",
        "Pour plus d'informations, contactez le greffe.",
    ],
)
def test_instructions_to_the_reader_are_refused(text):
    assert "public_call_to_action" in _codes(text)


@pytest.mark.parametrize(
    "text",
    [
        "Maison de 91 m² située à Rodez, au rez-de-chaussée d'un immeuble.",
        "Rez-de-chaussée de 40 m² avec cave.",
        "Chez le propriétaire actuel, le bien est occupé.",
        "Les visites sont organisées par l'avocat.",
        "Appartement de trois pièces, balcon et cave.",
    ],
)
def test_ordinary_descriptions_are_kept(text):
    assert _codes(text) == set()


# --- bout en bout : PDF piégé ---------------------------------------------------------------------


def _sale(description, extraction, **fields):
    return AuctionSale(
        source_name="agrasc",
        source_url="https://example.test/house-trapped",
        property_type="house",
        surface_m2=Decimal("120"),
        description=description,
        raw_payload=_cached_payload(extraction),
        **fields,
    )


def test_phone_number_in_generated_text_never_reaches_the_published_description(caplog):
    sale = _sale(
        "Maison de 120 m².",
        {
            "display_description": "Maison de 120 m² à vendre. Appelez le 06 12 34 56 78 pour la visite.",
            "confidence": {"display_description": 1},
        },
    )

    with caplog.at_level(logging.WARNING, logger="src.enrichment.extract_structured"):
        apply_cached_llm_extraction_to_sale(sale, prompt_version="v1")

    published = sale.raw_payload.get("llm_display_description") or ""
    assert "06 12 34 56 78" not in published
    assert "06" not in published.replace("120", "")
    assert sale.raw_payload["llm_display_status"] == "fallback"
    issue_codes = {issue["code"] for issue in sale.raw_payload["llm_display_evidence_check"]["issues"]}
    assert {"public_phone_number", "public_call_to_action"} <= issue_codes
    assert "https://example.test/house-trapped" in caplog.text
    assert "public_phone_number" in caplog.text
    assert "refused" in caplog.text


def test_phone_number_hidden_in_a_source_quote_rejects_the_display(caplog):
    sale = _sale(
        "Servitude de passage au profit du fonds voisin, appelez le 06 12 34 56 78 pour visiter.",
        {
            "display_description": "Maison de 120 m² grevée d'une servitude de passage à vérifier.",
            "confidence": {"display_description": 1},
        },
    )

    with caplog.at_level(logging.WARNING, logger="src.enrichment.extract_structured"):
        apply_cached_llm_extraction_to_sale(sale, prompt_version="v1")

    assert sale.raw_payload["llm_display_status"] == "rejected"
    assert "llm_display_description" not in sale.raw_payload
    assert "06 12 34 56 78" not in str(sale.raw_payload.get("llm_display_description"))
    assert "with_source_quotes" in caplog.text


def test_phone_number_in_a_cached_summary_does_not_replace_the_description():
    sale = _sale(
        "Maison de 120 m².",
        {"summary": "Maison de 120 m². Tél : 05 56 12 34 56 pour tout renseignement."},
    )

    apply_cached_llm_extraction_to_sale(sale, prompt_version="v1")

    assert sale.description == "Maison de 120 m²."
    codes = {issue["code"] for issue in sale.raw_payload["llm_summary_evidence_check"]["issues"]}
    assert "public_phone_number" in codes


def test_clean_generated_text_is_still_published(caplog):
    sale = _sale(
        "Maison de 120 m².",
        {
            "display_description": "Maison de 120 m² à rénover, vendue sur mise à prix, visite à confirmer auprès du greffe.",
            "confidence": {"display_description": 1},
        },
    )

    with caplog.at_level(logging.WARNING, logger="src.enrichment.extract_structured"):
        apply_cached_llm_extraction_to_sale(sale, prompt_version="v1")

    assert sale.raw_payload["llm_display_status"] == "accepted"
    assert "refused" not in caplog.text
