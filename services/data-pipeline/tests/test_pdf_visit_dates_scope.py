"""Visit dates never come from inspection reports or report paragraphs (real-run regression)."""

from __future__ import annotations

from src.pdf_enrichment import _extract_visit_dates_from_documents

# Shape observed on a real diagnostics PDF (info-encheres, 2026-10-11).
DIAGNOSTIC_PAGE = (
    "Compagnie d'assurance : MSIG EUROPE n° 2024PIR00000/142 4/11 Rapport du : 08/06/2026 "
    "3.2.5 Programme de repérage complémentaire (le cas échéant) En plus du programme de repérage "
    "réglementaire, le présent rapport porte sur les parties de composants suivantes : Composant de la "
    "construction Sur demande ou sur information Néant - 3.2.6 Le périmètre de repérage effectif Il s'agit "
    "de l'ensemble des locaux ou parties de l'immeuble concerné par la mission de repérage, visite du 08/06/2026"
)


def test_diagnostics_reports_do_not_feed_visit_dates() -> None:
    document = {
        "label": "• Diagnostics techniques",
        "url": "https://example.test/DDT.pdf",
        "type": "diagnostics",
        "pages": [{"page": 4, "text": "Visite sur place le 08/06/2026 à 10h"}],
    }
    assert _extract_visit_dates_from_documents([document]) is None


def test_report_paragraphs_are_not_visit_slots() -> None:
    document = {"label": "Annexe", "url": "https://example.test/annexe.pdf", "pages": [{"page": 1, "text": DIAGNOSTIC_PAGE}]}
    assert _extract_visit_dates_from_documents([document]) is None


def test_a_short_visit_line_in_the_conditions_of_sale_is_kept() -> None:
    document = {
        "label": "Cahier des conditions de vente",
        "url": "https://example.test/ccv.pdf",
        "pages": [{"page": 2, "text": "Visite sur place le mardi 3 novembre 2026 de 10h à 11h"}],
    }
    extracted = _extract_visit_dates_from_documents([document])
    assert extracted is not None
    assert extracted["visit_dates"] == ["Visite sur place le mardi 3 novembre 2026 de 10h à 11h"]
