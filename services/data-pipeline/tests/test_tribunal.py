from src.normalize import normalize_sale
from src.tribunal import fill_tribunal


def test_fill_tribunal_from_city_mapping() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/biganos",
            "city": "Biganos",
            "department": "33",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"


def test_fill_tribunal_prefers_explicit_raw_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/1.html",
            "city": "Ondres",
            "department": "40",
            "raw_text": "Tribunal Judiciaire de Bayonne",
        }
    )

    assert fill_tribunal(sale).tribunal == "TJ Bayonne"


def test_fill_tribunal_rejects_non_aquitaine_without_explicit_proof() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/tribunal-lyon",
            "department": "33",
            "city": "Bordeaux",
            "tribunal": "TJ Lyon",
            "raw_text": "Annonce sans mention explicite de Lyon.",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"
    assert "tribunal_inconsistent" in sale.quality_flags


def test_fill_tribunal_canonicalizes_noisy_tribunal_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/noisy-tribunal",
            "department": "33",
            "city": "Floirac",
            "tribunal": "TJ BORDEAUX CAHIER DES CHARGES ET CONDITIONS DE VENTE",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_fill_tribunal_does_not_infer_tj_for_voluntary_notarial_sale() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://example.test/vente-volontaire",
            "department": "33",
            "city": "Bordeaux",
            "raw_text": (
                "Type de vente: En ligne - Vente volontaire. "
                "OFFICE NOTARIAL DU JEU DE PAUME. En ligne sur immo-interactif.fr."
            ),
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal is None
    assert sale.tribunal_code is None
    assert "non_judicial_sale_context" in sale.quality_flags


def test_fill_tribunal_keeps_explicit_judicial_context_even_with_notaire_word() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/judicial-explicit",
            "department": "33",
            "city": "Bordeaux",
            "raw_text": "Tribunal Judiciaire de Bordeaux. Vente sur saisie immobilière. Notaire indiqué pour formalités.",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"
