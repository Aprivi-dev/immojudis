"""Surfaces lues dans les pièces jointes : audit du 03/11/2026 (extraits réels, préfixes d'id des ventes)."""

from decimal import Decimal

import src.pdf_enrichment  # noqa: F401  (resolves the pdf_enrichment / pdf_fact_extraction import cycle)
from src.models import AuctionSale
from src.pdf_fact_extraction import enrich_sale_from_pdf_text
from src.pdf_surface_patterns import (
    _extract_land_surface_candidates_with_evidence,
    _extract_surface_candidates_with_evidence,
)

PV = "https://example.test/proces-verbal-descriptif.pdf"
DIAG = "https://example.test/diagnostics.pdf"


def _values(text: str) -> list[Decimal]:
    return [Decimal(str(item["value"])) for item in _extract_surface_candidates_with_evidence(text)]


def _land_values(text: str) -> list[Decimal]:
    return [Decimal(str(item["value"])) for item in _extract_land_surface_candidates_with_evidence(text)]


def _enrich(property_type: str, *documents: tuple[str, str, str]) -> AuctionSale:
    sale = AuctionSale(source_name="info_encheres", source_url="https://example.test/vente", property_type=property_type)
    return enrich_sale_from_pdf_text(
        sale,
        [{"url": url, "label": url.rsplit("/", 1)[-1], "text": text, "document_type": kind} for url, kind, text in documents],
    )


def test_4bf49f1b_ground_area_is_not_a_document_surface() -> None:
    text = (
        "Le tout d’une superficie privative de 130,90 m² de surface habitable totale, 158,82 m² de surface au sol "
        "totale. Les biens sont"
    )
    assert Decimal("158.82") not in _values(text)
    assert _values("Surface au sol totale : 216,56 m²") == []


def test_8ff95700_room_surface_is_not_the_property_surface() -> None:
    text = "PREMIERE CHAMBRE ANGLE NORD-EST Surface: 10,5m2 Sol : parquet"
    assert _values(text) == []
    assert _values("SUPERFICIE DE LA MAISON : 79,40 m2 SUPERFICIE DU GARAGE : 15 m2") == [Decimal("79.40")]


def test_0a85767e_explicit_total_of_the_certificate_wins_over_the_first_room_of_the_table() -> None:
    pv = (
        "Suivant certificat de superficie réalisé par la société BATIVISA, la superficie totale du bien est de "
        "183,78 m². Je quitte les lieux à 15h10."
    )
    diag = (
        "l=I DETAIL DES SURFACES PAR LOCAL Pièce ou Local Etage Surface habitable Bureau n°1 ROC 13,450 m2 Entrée "
        "ROC 10,390 m2 WC n°1 ROC 0,930 m2 Studio ROC 29,490 m2 Bureau n°2 2ème 4,860 m2 Chambre n°2 2ème 11,810m 2 "
        "Total 183.780 m2"
    )
    sale = _enrich("house", (PV, "pv_huissier", pv), (DIAG, "diagnostics_techniques", diag))

    assert sale.surface_m2 == Decimal("183.78")
    assert sale.habitable_surface_m2 != Decimal("13.45")


def test_pdf_habitable_type_comes_from_the_label_of_the_value() -> None:
    # « surface habitable » est dans la fenêtre de contexte, pas dans le libellé de 45,45 m².
    text = "Surface habitable : voir ci-après. Le bien présente une superficie de 52,10 m2 selon le géomètre."
    sale = _enrich("apartment", (PV, "pv_huissier", text))

    assert sale.surface_m2 == Decimal("52.10")
    assert sale.habitable_surface_m2 is None


def test_ebafd1c4_built_surface_is_not_land() -> None:
    text = (
        "extérieurs : Cour intérieure, Annexe 1, Annexe 2 (- accès condamné), Jardin derrière Le tout représente "
        "une surface bâtie de 259,86 m² et cadastré : Section AD n°168 « 14 rue de la République » 04 a et 69 ca "
        "L’immeuble est inoccupé"
    )
    assert _land_values(text) == [Decimal("469")]


def test_d0880e3d_room_after_the_contenance_is_not_land() -> None:
    text = (
        "édifiée sur une parcelle cadastrée anciennement Section E, Numéro 717, et actuellement Section AA, Numéro "
        "120, pour une contenance de 25 centiares, composée : - Rez de chaussée : buanderie (17,63m²), wc (1,11m²)"
    )
    assert _land_values(text) == [Decimal("25")]


def test_20cb5dbc_pdf_parcel_list_gives_the_total_not_the_first_parcel() -> None:
    text = (
        "cadastrés dite commune sous les références suivantes : -Parcelle Section Q N° 1160, d’une contenance de "
        "00ha01a12ca -Parcelle Section Q N° 1162, d’une contenance de 00ha00a17ca -Parcelle Section Q N° 672, d’une "
        "contenance de 01ha24a08ca -Parcelle Section Q N° 673, d’une contenance de 00ha02a80ca."
    )
    sale = _enrich("house", (PV, "pv_huissier", text))

    assert sale.land_surface_m2 == Decimal("12817")
