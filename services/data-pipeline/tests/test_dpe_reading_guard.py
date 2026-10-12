from __future__ import annotations

import src.pdf_enrichment  # noqa: F401  (import order used across the pipeline tests)
from src import document_reading as reading
from src.dpe_reading_guard import checked_energy_point, claimed_class, dpe_class_from_figures

# OCR of a real DPE page (production reading of 12/10/2026, read as "classé F").
DPE_PAGE = (
    "Diagnostic de performance énergétique (logement). consommation: 126 kwhim'an "
    "émissions: 14 kg COZm*an logement extrémement peu performant A B C D E F G"
)


def _point(title: str, explanation: str, quote: str, importance: str = "attention") -> dict[str, object]:
    return {
        "theme": "diagnostics",
        "importance": importance,
        "title": title,
        "explanation": explanation,
        "quote": quote,
        "document_index": 1,
        "page": 54,
        "page_corrected": False,
    }


def test_the_class_follows_the_worse_of_energy_and_climate() -> None:
    assert dpe_class_from_figures(126, 14) == "C"
    assert dpe_class_from_figures(390, 119) == "G"  # energy F, climate G
    assert dpe_class_from_figures(70, 6) == "A"
    assert dpe_class_from_figures(421, 5) == "G"


def test_a_class_read_from_the_scale_legend_is_replaced_by_the_figures() -> None:
    point = _point(
        "Performance énergétique très faible (F)",
        "Le logement est classé F avec une consommation élevée.",
        "consommation: 126 kwhim'an émissions: 14 kg COZm*an logement extrémement peu performant",
    )

    checked = checked_energy_point(point, DPE_PAGE)

    assert checked["title"] == "Performance énergétique : classe C d'après les chiffres du DPE"
    assert "126 kWh/m²/an et 14 kg CO₂/m²/an, soit la classe C" in str(checked["explanation"])
    assert checked["importance"] == "info"
    assert checked["energy_class_corrected"] is True
    assert checked["quote"] == point["quote"]


def test_a_class_consistent_with_the_figures_or_written_on_the_page_is_kept() -> None:
    consistent = _point(
        "Passoire énergétique (Classe G)",
        "Le DPE classe le logement en G.",
        "état actuel consommation: 390 kwh/m*/an émissions: 119 kg CO2/m*/an",
        "alerte",
    )
    assert checked_energy_point(consistent, consistent["quote"]) == consistent

    written = _point("DPE classe D", "Le logement est en classe D.", "Classe énergie : D, logement")
    assert checked_energy_point(written, "Classe énergie : D, logement") == written


def test_an_unproven_letter_is_removed_but_the_point_is_kept() -> None:
    point = _point(
        "Performance énergétique très faible (F)",
        "Le logement est classé F.",
        "logement extrémement peu performant selon le diagnostic",
    )

    checked = checked_energy_point(point, "logement extrémement peu performant selon le diagnostic")

    assert claimed_class(checked["title"], checked["explanation"]) is None
    assert checked["title"] == "Performance énergétique très faible"
    assert checked["quote"] == point["quote"]


def test_two_figures_on_the_page_are_not_used_to_guess() -> None:
    page = "état actuel consommation: 300 kwh/m²/an émissions: 40 kg CO2/m²/an avec travaux 105 kwh/m²/an 12 kg CO2"
    point = _point("Performance énergétique (F)", "Classé F.", "état actuel consommation: 300 kwh/m²/an")

    checked = checked_energy_point(point, page)

    assert "F" not in str(checked["title"]).split()
    assert checked["energy_class_corrected"] is True


def test_the_reading_validation_applies_the_guard() -> None:
    documents = [
        reading.ReadingDocument(index=1, label="DPE", url=None, document_type="diagnostics", pages={54: DPE_PAGE})
    ]
    raw = [
        {
            "theme": "diagnostics",
            "importance": "attention",
            "title": "Performance énergétique très faible (F)",
            "explanation": "Le logement est classé F.",
            "document": "D1",
            "page": 54,
            "quote": "consommation: 126 kwhim'an émissions: 14 kg COZm*an",
        }
    ]

    [point] = reading.validate_reading_points(raw, documents)

    assert point["title"] == "Performance énergétique : classe C d'après les chiffres du DPE"
    assert reading.DOCUMENT_READING_VERSION == "document_reading_v2"
