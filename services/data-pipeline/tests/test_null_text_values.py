"""P1-10 : « nan », « None »… ne doivent jamais être écrits comme du texte."""
import pytest

from src.dpe import text_value
from src.models import AuctionSale
from src.normalize import clean_text, normalize_sale
from src.urban_planning import _clean_text as urban_clean_text

PLACEHOLDERS = ["nan", "NaN", "NAN", "none", "None", "null", "NULL", "undefined", " nan ", "\xa0None\xa0"]


@pytest.mark.parametrize("value", PLACEHOLDERS)
def test_clean_text_turns_placeholders_into_none(value):
    assert clean_text(value) is None


def test_clean_text_turns_float_nan_into_none():
    assert clean_text(float("nan")) is None


@pytest.mark.parametrize("value", ["Nantes", "Nancy", "Nano", "None of the above", "Aucune", "0", "Null-sur-Mer"])
def test_clean_text_keeps_real_text(value):
    assert clean_text(value) == value


def test_normalize_sale_never_keeps_placeholder_fields():
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/placeholders",
            "city": "nan",
            "address": "None",
            "postal_code": "null",
            "department": "NaN",
            "tribunal": "undefined",
            "lawyer_name": "nan",
            "lawyer_contact": "None",
            "title": "Maison à Samois",
            "description": "nan",
            "risk_notes": "NaN",
        }
    )

    assert sale.city is None
    assert sale.address is None
    assert sale.postal_code is None
    assert sale.department is None
    assert sale.tribunal is None
    assert sale.lawyer_name is None
    assert sale.lawyer_contact is None
    assert sale.description is None
    assert sale.risk_notes is None
    assert sale.title == "Maison à Samois"


def test_source_block_placeholders_do_not_fill_fields():
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/placeholders-blocks",
            "source_blocks": {"ville": "nan", "avocat": "None", "adresse": "null"},
        }
    )

    assert sale.city is None
    assert sale.lawyer_name is None
    assert sale.address is None


def test_model_drops_placeholders_set_at_construction_and_after():
    sale = AuctionSale(
        source_name="x", source_url="https://example.test/a", city="nan", lawyer_name="None",
        visit_dates=["nan", "12 mars 2027"],
    )
    assert sale.city is None
    assert sale.lawyer_name is None
    assert sale.visit_dates == ["12 mars 2027"]

    sale.address = "NaN"
    sale.tribunal = "Tribunal de Meaux"
    row = sale.to_storage_dict(exclude_none=False)
    assert row["address"] is None
    assert row["tribunal"] == "Tribunal de Meaux"
    assert "address" not in sale.to_storage_dict()


def test_enrichment_text_helpers_drop_placeholders():
    assert text_value("nan") is None
    assert text_value("Samois-sur-Seine") == "Samois-sur-Seine"
    assert urban_clean_text("None") is None
    assert urban_clean_text("zone UA") == "zone UA"
