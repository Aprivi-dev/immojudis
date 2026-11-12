"""Mois français et fuseau de Paris, partagés par les lectures de dates du pipeline."""

from __future__ import annotations

from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")

# Noms écrits, dans l'ordre du calendrier : ``MONTH_NAMES[month - 1]``.
MONTH_NAMES = (
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
)  # fmt: skip

# Numéro du mois, avec et sans accents (« février » et « fevrier »), en minuscules.
MONTH_NUMBERS: dict[str, int] = {
    "janvier": 1,
    "février": 2,
    "fevrier": 2,
    "mars": 3,
    "avril": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7,
    "août": 8,
    "aout": 8,
    "septembre": 9,
    "octobre": 10,
    "novembre": 11,
    "décembre": 12,
    "decembre": 12,
}

# Abréviations sans point final, avec et sans accents : « janv », « févr », « aoû », « déc ».
MONTH_ABBREVIATIONS: dict[str, int] = {
    "janv": 1,
    "févr": 2,
    "fevr": 2,
    "avr": 4,
    "juil": 7,
    "aoû": 8,
    "aou": 8,
    "sept": 9,
    "oct": 10,
    "nov": 11,
    "déc": 12,
    "dec": 12,
}

# Alternative d'expression régulière des noms complets (aucun n'est le début d'un autre).
MONTH_PATTERN = "|".join(MONTH_NUMBERS)
