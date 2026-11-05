"""Tribunal lu dans les pièces jointes d'une vente sans tribunal sur sa page (audit avoventes 03/11/2026)."""

from __future__ import annotations

import pytest

from src.court_competence import OfficialCourt, OfficialCourtLabelIndex
from src.normalize import normalize_sale
from src.pdf_tribunal import PDF_TRIBUNAL_EXTRACTION_FIELD, apply_pdf_tribunal
from src.tribunal import fill_tribunal


def _court(city: str, department: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=f"justice_tj_1_{department}",
        court_name=f"TJ {city}",
        official_court_name=f"Tribunal judiciaire de {city}",
        court_origin_code="1",
        court_srj_code=department,
        court_department=department,
        court_city=city,
    )


REGISTRY = OfficialCourtLabelIndex([
    _court("Bobigny", "93"),
    _court("Draguignan", "83"),
    _court("Albertville", "73"),
    _court("Évreux", "27"),
    _court("Fort-de-France", "972"),
    _court("Dijon", "21"),
    _court("Paris", "75"),
])


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.pdf_tribunal.resolve_court_by_label", REGISTRY.resolve)
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", REGISTRY.resolve)


def _sale(**extra: object):
    return normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/synthetic",
        "title": "Appartement",
        "city": "Saint-Denis",
        **extra,
    })


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Poursuivie par-devant le Juge de l'exécution du Tribunal Judiciaire de BOBIGNY SUR SAISIE IMMOBILIERE "
         "EN UN SEUL LOT Dans un ensemble", "TJ Bobigny"),
        ("ADJUDICATION LE VENDREDI 20 NOVEMBRE 2026 A 09H30 AU PALAIS DE JUSTICE DU TRIBUNAL JUDICIAIRE DE "
         "DRAGUIGNAN (VAR) AU LIEU ORDINAIRE", "TJ Draguignan"),
        ("Le Juge de l'Exécution près le Tribunal Judiciaire d’ALBERTVILLE, Département de la Savoie", "TJ Albertville"),
        ("Conditions auxquelles sera adjugé à l'audience des Saisies Immobilières du Juge de l’Exécution du "
         "Tribunal Judiciaire d'EVREUX, 4 Bis rue de Verdun", "TJ Évreux"),
        ("auxquelles sera adjugé en l'audience des saisies immobilières du Tribunal Judiciaire de FORT DE FRANCE "
         "séant dite ville au Palais de Justice", "TJ Fort-de-France"),
    ],
)
def test_single_court_named_by_the_documents_fills_the_tribunal(text: str, expected: str) -> None:
    sale = _sale()
    apply_pdf_tribunal(sale, [{"url": "https://avoventes.fr/doc/ccv.pdf", "text": text}])

    assert sale.tribunal == expected
    assert sale.raw_payload[PDF_TRIBUNAL_EXTRACTION_FIELD]["court_name"] == expected
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_ocr_misspellings_do_not_count_and_the_readable_mention_wins() -> None:
    # 97dc9d7c : « Tribunal Judiciaire de DION », « de DUON » (OCR) puis « de DIJON ».
    sale = _sale(city="DIJON")
    apply_pdf_tribunal(sale, [
        {"url": "a", "text": "à l'audience de vente du Juge de l'Exécution près le Tribunal Judiciaire de DION au plus "
         "offrant ALC 20251337 Tribunal Judiciaire de DUON Juge de l'Exécution"},
        {"url": "b", "text": "VENTE AUX ENCHERES PUBLIQUES MERCREDI 16 DECEMBRE 2026 A 10H30 — SALLE A A l'audience "
         "du Juge de l'Exécution du Tribunal Judiciaire de DIJON, Cité Judiciaire"},
    ])

    assert sale.tribunal == "TJ Dijon"


def test_a_judgment_of_another_court_is_ignored_when_the_sale_venue_is_explicit() -> None:
    sale = _sale()
    apply_pdf_tribunal(sale, [{"url": "a", "text": (
        "En vertu d'un jugement rendu le 3 mars 2025 par le Tribunal Judiciaire de PARIS. "
        "L'adjudication aura lieu à l'audience du Juge de l'exécution du Tribunal Judiciaire de BOBIGNY."
    )}])

    assert sale.tribunal == "TJ Bobigny"


def test_two_courts_without_sale_venue_context_stay_unknown() -> None:
    sale = _sale()
    apply_pdf_tribunal(sale, [{"url": "a", "text": (
        "Jugement du Tribunal Judiciaire de PARIS. Copie au Tribunal Judiciaire de BOBIGNY."
    )}])

    assert sale.tribunal is None
    assert PDF_TRIBUNAL_EXTRACTION_FIELD not in sale.raw_payload


def test_page_tribunal_is_never_replaced() -> None:
    sale = _sale(tribunal="TJ Paris")
    apply_pdf_tribunal(sale, [{"url": "a", "text": "à l'audience du Tribunal Judiciaire de BOBIGNY"}])

    assert sale.tribunal == "TJ Paris"


def test_notarial_source_is_not_given_a_court_from_its_documents() -> None:
    sale = normalize_sale({
        "source_name": "notaires", "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/1",
        "title": "Maison",
    })
    apply_pdf_tribunal(sale, [{"url": "a", "text": "autorisée par le Juge du Tribunal Judiciaire de BOBIGNY"}])

    assert sale.tribunal is None


def test_stored_document_tribunal_survives_a_cold_source_pass() -> None:
    first = _sale()
    apply_pdf_tribunal(first, [{"url": "a", "text": "à l'audience du Tribunal Judiciaire de BOBIGNY"}])
    # Passage suivant : la page ne donne toujours aucun tribunal, la trace des pièces est reprise.
    again = _sale(**{PDF_TRIBUNAL_EXTRACTION_FIELD: first.raw_payload[PDF_TRIBUNAL_EXTRACTION_FIELD]})
    fill_tribunal(again)

    assert again.tribunal == "TJ Bobigny"
    assert again.tribunal_code == "justice_tj_1_93"
