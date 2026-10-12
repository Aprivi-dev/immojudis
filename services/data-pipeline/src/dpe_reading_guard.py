"""Keep the AI document reading from inventing a DPE class.

Production case of 12/10/2026: a DPE page reads "consommation : 126 kWh/m²/an,
émissions : 14 kg CO2/m²/an, logement extrêmement peu performant". The last
words are the label printed at the end of the A-G scale, not the verdict, yet
the reading said "classé F". 126 kWh and 14 kg are a class C.

When a point claims a class, the claim is checked against what its own page
proves:

* an explicit class written for the dwelling ("classe énergie : C",
  "étiquette C") is kept as is;
* otherwise, when the page gives both the consumption and the emissions, the
  class follows from the national thresholds of the 2021 DPE (the worse of the
  energy and climate classes); a different claimed class is replaced by a
  factual title and explanation built from those figures;
* otherwise the class letter is not proven: the point keeps its figures and
  quote but loses the letter.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

# 2021 DPE, metropolitan dwellings: upper bound of each class (kWh EP/m²/an and
# kg CO2/m²/an). Class G is above the F bound.
ENERGY_BOUNDS = (("A", 70), ("B", 110), ("C", 180), ("D", 250), ("E", 330), ("F", 420))
CLIMATE_BOUNDS = (("A", 6), ("B", 11), ("C", 30), ("D", 50), ("E", 70), ("F", 100))
CLASSES = "ABCDEFG"

_NUMBER = r"(\d{1,4}(?:[.,]\d+)?)"
_CONSUMPTION = re.compile(_NUMBER + r"\s*kwh\s*(?:ep)?\s*[/i]?\s*m", re.I)
_EMISSIONS = re.compile(_NUMBER + r"\s*kg\s*(?:eq\s*)?co", re.I)
_CLAIM = re.compile(
    r"\b(?:class(?:e|é|ée)s?|étiquette|etiquette|dpe)\s*(?:énergie|energie|énergétique|energetique|dpe)?\s*"
    r"(?:[:=-]\s*)?(?-i:([A-G]))\b"
    r"|\((?-i:([A-G]))\)"
    r"|\ben\s+(?-i:([A-G]))\b",
    re.I,
)
_EXPLICIT_ON_PAGE = re.compile(
    r"\b(?:classe|etiquette|étiquette)\s*(?:énergie|energie|énergétique|energetique|dpe)?\s*(?:[:=-]\s*)?(?-i:([A-G]))\b"
    r"(?!\s*[,;/]?\s*(?-i:[A-G])\b)",
    re.I,
)


def _single_value(pattern: re.Pattern[str], text: str) -> float | None:
    """The figure when the text gives exactly one ("avec travaux" pages give two)."""
    values: set[float] = set()
    for match in pattern.finditer(text):
        try:
            values.add(float(match.group(1).replace(",", ".")))
        except ValueError:
            continue
    return values.pop() if len(values) == 1 else None


def _figure(pattern: re.Pattern[str], quote: str, page_text: str) -> float | None:
    if pattern.search(quote):
        return _single_value(pattern, quote)
    return _single_value(pattern, page_text)


def class_for(value: float, bounds: tuple[tuple[str, int], ...]) -> str:
    for letter, upper in bounds:
        if value <= upper:
            return letter
    return "G"


def dpe_class_from_figures(consumption: float, emissions: float) -> str:
    """The worse of the energy and climate classes (2021 method)."""
    energy = class_for(consumption, ENERGY_BOUNDS)
    climate = class_for(emissions, CLIMATE_BOUNDS)
    return max(energy, climate, key=CLASSES.index)


def claimed_class(*texts: object) -> str | None:
    for text in texts:
        if isinstance(text, str):
            match = _CLAIM.search(text)
            if match:
                return next(group for group in match.groups() if group)
    return None


def _without_class(text: str, letter: str) -> str:
    text = re.sub(rf"\s*\(\s*{letter}\s*\)", "", text)
    text = re.sub(
        rf"\b(?:est\s+)?(?:class(?:e|é|ée)s?|étiquette|etiquette)\s*(?:énergie|energie|énergétique|energetique|dpe)?\s*"
        rf"(?:[:=-]\s*)?(?:en\s+)?{letter}\b",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(rf"\ben\s+{letter}\b", "", text)
    return re.sub(r"\s{2,}", " ", text).strip(" ,.;") + ("." if text.strip().endswith(".") else "")


def _format(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def checked_energy_point(point: dict[str, object], page_text: str) -> dict[str, object]:
    """Return the point with any unproven DPE class corrected or removed."""
    title = str(point.get("title") or "")
    explanation = str(point.get("explanation") or "")
    letter = claimed_class(title, explanation)
    if letter is None:
        return point
    quote = str(point.get("quote") or "")
    explicit = _EXPLICIT_ON_PAGE.search(quote) or _EXPLICIT_ON_PAGE.search(page_text)
    if explicit and explicit.group(1) == letter:
        return point
    consumption = _figure(_CONSUMPTION, quote, page_text)
    emissions = _figure(_EMISSIONS, quote, page_text)
    corrected = dict(point)
    if consumption is not None and emissions is not None:
        derived = dpe_class_from_figures(consumption, emissions)
        if derived == letter:
            return point
        corrected["title"] = f"Performance énergétique : classe {derived} d'après les chiffres du DPE"
        corrected["explanation"] = (
            f"Le DPE indique {_format(consumption)} kWh/m²/an et {_format(emissions)} kg CO₂/m²/an, "
            f"soit la classe {derived} selon les seuils nationaux. Vérifiez l'étiquette sur la pièce."
        )
        corrected["importance"] = "alerte" if derived == "G" else "attention" if derived in "EF" else "info"
    else:
        corrected["title"] = _without_class(title, letter) or "Performance énergétique"
        corrected["explanation"] = _without_class(explanation, letter) or None
    corrected["energy_class_corrected"] = True
    return corrected


def is_energy_point(point: Mapping[str, object]) -> bool:
    text = f"{point.get('title') or ''} {point.get('explanation') or ''}".casefold()
    return point.get("theme") == "diagnostics" and any(
        word in text for word in ("dpe", "énerg", "energ", "passoire", "classe")
    )
