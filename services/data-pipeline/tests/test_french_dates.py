"""Tables de mois et fuseau de Paris partagés (``src/french_dates.py``).

L'instantané ``fixtures/french_months_outputs.json`` a été calculé avec les tables d'origine,
recopiées dans chaque module avant leur regroupement : chaque lecture de date garde ses sorties.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from src import (
    admission,
    dedupe,
    information_agent_semantic,
    normalize,
    pdf_offer_deadline,
    personal_data,
)
from src.enrichment import display_consistency, display_evidence
from src.reference_data import tension
from src.sources import (
    cessions_etat_procedure,
    encheres_immobilieres,
    encheres_immobilieres_payload,
    encheres_publiques,
    encheres_publiques_extraction,
    licitor_extraction,
    notaires_text_terms,
)

SNAPSHOT = Path(__file__).parent / "fixtures" / "french_months_outputs.json"

_FULL = (
    "janvier", "février", "fevrier", "mars", "avril", "mai", "juin", "juillet", "août", "aout",
    "septembre", "octobre", "novembre", "décembre", "decembre",
)  # fmt: skip
_ABBREVIATIONS = (
    "janv", "janv.", "févr", "fevr", "févr.", "avr", "avr.", "juil", "aoû", "aou", "sept", "sept.", "oct", "nov",
    "déc", "dec", "déc.",
)  # fmt: skip
_NOT_MONTHS = ("maison", "marsupial", "mais", "juinn", "fevriers", "fvrier", "aoüt")
WORDS: tuple[str, ...] = tuple(
    dict.fromkeys(
        variant
        for word in (*_FULL, *_ABBREVIATIONS, *_NOT_MONTHS)
        for variant in (word, word.upper(), word.capitalize())
    )
)


def _iso(value: object) -> object:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def _probes(word: str) -> dict[str, object]:
    deadline = pdf_offer_deadline._first_deadline(f"le 3 {word} 2026 à 12h", local_timezone="Europe/Paris")
    paris_today = encheres_immobilieres._paris_today
    encheres_immobilieres._paris_today = lambda: date(2026, 6, 15)  # type: ignore[assignment]
    try:
        card_date = encheres_immobilieres._list_sale_date(f"3 {word.upper()}")
    finally:
        encheres_immobilieres._paris_today = paris_today  # type: ignore[assignment]
    return {
        "normalize.parse_french_datetime": _iso(normalize.parse_french_datetime(f"3 {word} 2026")),
        "normalize._VISIT_DATE_PATTERN": bool(normalize._VISIT_DATE_PATTERN.search(f"samedi 3 {word} 2026 à 10h")),
        "display_consistency._dates": [_iso(day) for day in display_consistency._dates(f"le 3 {word} 2026")],
        "display_evidence._dates": display_evidence._dates(f"le 3 {word} 2026"),
        "tension.decree_reference_date": _iso(tension.decree_reference_date(f"Décret n° 2025-1267 du 22 {word} 2025")),
        "pdf_offer_deadline._first_deadline": None if deadline is None else [_iso(deadline[0]), deadline[1]],
        "encheres_publiques_extraction.text_event_sale_date": encheres_publiques_extraction.text_event_sale_date(
            f"Vente immobilière au Tribunal judiciaire de Paris le 9 {word} 2026"
        ),
        "licitor_extraction._french_date": _iso(licitor_extraction._french_date(f"3 {word} 2026")),
        "licitor_extraction._sale_datetime": _iso(licitor_extraction._sale_datetime(f"3 {word} 2026 à 14h30")),
        "notaires_text_terms.text_sale_date": notaires_text_terms.text_sale_date(
            f"La réception des offres se terminera le 3 {word} 2026 à 12h00"
        ),
        "cessions_etat_procedure.find_dates": [
            found.iso() for found in cessions_etat_procedure.find_dates(f"le 3 {word} 2026 à 14h", date(2026, 1, 1))
        ],
        "cessions_etat_procedure._day_range_window": cessions_etat_procedure._day_range_window(
            f"Vente aux enchères du 1er au 3 {word}", date(2026, 1, 1)
        ),
        "encheres_immobilieres._list_sale_date": card_date,
        "information_agent_semantic._date_is_grounded": [
            month
            for month in range(1, 13)
            if information_agent_semantic._date_is_grounded(date(2026, month, 3), f"le 3 {word} 2026")
        ],
        "personal_data._DATE": bool(re.fullmatch(personal_data._DATE, f"3 {word} 2026")),
        "personal_data._DATE_ignorecase": bool(re.fullmatch(personal_data._DATE, f"3 {word} 2026", re.I)),
    }


def snapshot() -> dict[str, object]:
    return {
        "words": list(WORDS),
        "probes": {word: _probes(word) for word in WORDS},
        "normalize.FRENCH_MONTHS": list(normalize.FRENCH_MONTHS.items()),
        "encheres_immobilieres_payload._day_label": [
            encheres_immobilieres_payload._day_label(datetime(2026, month, 3)) for month in range(1, 13)
        ],
    }


def test_month_readers_keep_their_frozen_outputs() -> None:
    expected = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    actual = json.loads(json.dumps(snapshot(), ensure_ascii=False))

    assert actual["words"] == expected["words"]
    for word in expected["words"]:
        assert actual["probes"][word] == expected["probes"][word], word
    assert actual["normalize.FRENCH_MONTHS"] == expected["normalize.FRENCH_MONTHS"]
    assert actual["encheres_immobilieres_payload._day_label"] == expected["encheres_immobilieres_payload._day_label"]


def test_paris_time_zone_is_one_shared_constant() -> None:
    from src.french_dates import PARIS

    assert PARIS == ZoneInfo("Europe/Paris")
    for module in (
        admission,
        dedupe,
        display_consistency,
        licitor_extraction,
        encheres_immobilieres_payload,
        cessions_etat_procedure,
    ):
        assert module.PARIS is PARIS, module.__name__
    assert encheres_publiques.PARIS is PARIS
