"""Contenance cadastrale du terrain vendu, lue dans une désignation de parcelles (ha / a / ca).

Audit du 03/11/2026 : la première parcelle d'une liste était affichée comme terrain du bien
(« 01a 12ca » au lieu de « Total 01ha 28a 17ca », « 24 a 00 ca » pour deux parcelles), une liste
complète n'était pas additionnée (« 29 a 52 ca, … 28 a 47 ca, … 27 a 60 ca, … 70 a 97 ca »), la
contenance totale d'une résidence de 10 ha était affichée pour un lot de copropriété, et des formes
courantes n'étaient pas lues (« 04 a et 69 ca », « 25 centiares », « 00ha01a12ca »).

Règles (une valeur manquante vaut mieux qu'une valeur fausse) :

1. un total écrit (« Total 01ha 28a 17ca », « contenance totale de… », « soit… ») fait foi ;
2. sinon une liste de parcelles est additionnée seulement si chaque parcelle citée a sa contenance ;
   une parcelle citée sans contenance rend le terrain inconnu ;
3. plusieurs listes qui ne donnent pas le même terrain : terrain inconnu ;
4. lot de copropriété (parties communes, tantièmes) : la contenance est celle de l'immeuble ou de la
   résidence, jamais celle du lot vendu.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal

_LETTER = r"(?![a-zà-ÿ])"
_AMOUNT_RE = re.compile(
    rf"(?<![\d.,])(?:(?P<ha>\d{{1,4}})\s*(?P<ha_unit>hectares?|ha){_LETTER}\s*(?:et\s+)?)?"
    rf"(?:(?P<a>\d{{1,3}})\s*(?P<a_unit>ares?|a){_LETTER}\s*(?:et\s+)?)?"
    rf"(?:(?P<ca>\d{{1,3}})\s*(?:centiares?|ca){_LETTER})?",
    re.I,
)
_TOTAL_BEFORE_RE = re.compile(
    r"(?:\btotal(?:e|es)?|\bau\s+total|\bsoit|\ben\s+tout|\bensemble)\b[^.;\n\d]{0,40}$",
    re.I,
)
_PARCEL_REF_RE = re.compile(r"(?<!lot\s)(?<!lots\s)\b(?:n\s*[°ºo]|num[ée]ro)\s*\d+", re.I)
_COPROPERTY_RE = re.compile(
    r"parties\s+communes|tanti[èe]mes|milli[èe]mes|\b\d+\s*/\s*1[ .]?000(?:[ .]?000)?\s*(?:[èe]mes)?\b"
    r"|en\s+copropri[ée]t[ée]",
    re.I,
)
# Un droit de jouissance exclusive (lot d'un ensemble) : les parcelles cadastrales sont celles de l'ensemble, le
# terrain du bien est la parcelle en jouissance (lue ailleurs, en ares ou en m²).
EXCLUSIVE_USE_BASIS = "estate_parcels_with_exclusive_use_plot"
_ESTATE_RE = re.compile(r"jouissance\s+(?:exclusive|privative)", re.I)
# Chaque contenance additionnée doit être annoncée comme telle (« pour une contenance de », « Surface »).
_AREA_LABEL_BEFORE_RE = re.compile(r"(?:contenance|surface|superficie)\b[^.;\n\d]{0,25}$", re.I)
_RUN_GAP_CHARS = 220
_REF_WINDOW_AFTER_LAST = 80


@dataclass(frozen=True)
class ParcelReading:
    """``value`` vaut ``None`` quand une contenance est écrite mais ne peut pas être attribuée au bien."""

    value: Decimal | None
    evidence: str
    basis: str


@dataclass(frozen=True)
class _Amount:
    start: int
    end: int
    value: Decimal
    is_total: bool


def read_parcel_land_surface(text: str | None) -> ParcelReading | None:
    """Terrain du bien d'après les contenances cadastrales du texte ; ``None`` sans contenance écrite."""
    if not text:
        return None
    amounts = _amounts(text)
    if not amounts:
        return None
    evidence = _evidence(text, amounts[0].start, amounts[-1].end)
    if _COPROPERTY_RE.search(text[max(0, amounts[0].start - 600) : amounts[-1].end + 600]):
        return ParcelReading(None, evidence, "coproperty_lot_land_is_the_building_plot")
    if _ESTATE_RE.search(text[max(0, amounts[0].start - 600) : amounts[-1].end + 600]):
        return ParcelReading(None, evidence, EXCLUSIVE_USE_BASIS)
    readings: list[tuple[Decimal | None, bool, str]] = [_read_run(text, run) for run in _runs(text, amounts)]
    totals = {value for value, is_total, _ in readings if is_total and value is not None}
    values = {value for value, _, _ in readings}
    if len(totals) == 1 and len(values - totals - {None}) == 0:
        value = next(iter(totals))
    elif len(values) == 1 and None not in values:
        value = next(iter(values))
    elif len(totals) == 1:
        # Une liste incomplète ailleurs ne contredit pas un total écrit.
        value = next(iter(totals))
    else:
        return ParcelReading(None, evidence, "parcel_lists_disagree_or_are_incomplete")
    run_evidence = next((item for item_value, _, item in readings if item_value == value), evidence)
    return ParcelReading(value, run_evidence, "cadastral_contenance")


def _amounts(text: str) -> list[_Amount]:
    found: list[_Amount] = []
    for match in _AMOUNT_RE.finditer(text):
        if not match.group(0).strip():
            continue
        hectares, ares, centiares = (int(match.group(key) or 0) for key in ("ha", "a", "ca"))
        has_unit = match.group("ha") or match.group("ca") or (match.group("a_unit") or "").lower().startswith("are")
        if not has_unit:
            continue
        value = Decimal(hectares * 10000 + ares * 100 + centiares)
        if value <= 0:
            continue
        before = text[max(0, match.start() - 60) : match.start()]
        is_total = bool(_TOTAL_BEFORE_RE.search(before))
        found.append(_Amount(match.start(), match.end(), value, is_total))
    return found


def _runs(text: str, amounts: list[_Amount]) -> list[list[_Amount]]:
    runs: list[list[_Amount]] = []
    for amount in amounts:
        if runs and amount.start - runs[-1][-1].end <= _RUN_GAP_CHARS:
            runs[-1].append(amount)
        else:
            runs.append([amount])
    return runs


def _read_run(text: str, run: list[_Amount]) -> tuple[Decimal | None, bool, str]:
    evidence = _evidence(text, run[0].start, run[-1].end)
    totals = [item for item in run if item.is_total]
    if totals:
        return totals[-1].value, True, evidence
    tail = text[run[-1].end : run[-1].end + _REF_WINDOW_AFTER_LAST]
    tail = re.split(r"[.;\n]", tail, maxsplit=1)[0]
    references_after_first = len(_PARCEL_REF_RE.findall(text[run[0].end : run[-1].end] + tail))
    if references_after_first > len(run) - 1:
        # « N° 365 pour une contenance de 24 a 00 ca, N° 366 lieudit BEDATS » : une parcelle sans contenance.
        return None, False, evidence
    if len(run) > 1 and not all(
        _AREA_LABEL_BEFORE_RE.search(text[max(0, item.start - 40) : item.start]) for item in run
    ):
        # « Section AO 91 pour 5a 71ca ; AO 95 pour 10a 5ca ; jardin AO 88 pour 5a 62ca » : rien ne dit que ces
        # parcelles forment ensemble le terrain vendu.
        return None, False, evidence
    return sum((item.value for item in run), Decimal("0")), False, evidence


def _evidence(text: str, start: int, end: int) -> str:
    return re.sub(r"\s+", " ", text[max(0, start - 160) : min(len(text), end + 40)]).strip()


_M2_VALUE = r"(\d{1,3}(?:[\s.]\d{3})+|\d+)"
_M2_UNIT = r"\s*m\s*(?:2|²)"
# « Parcelle YE n°53 de 15 840 m² Parcelle Yi n°75 de 10 065 m² »
_PARCEL_M2_RE = re.compile(
    rf"\bparcelle\s+[a-z]{{1,3}}\s*n\s*[°ºo]\s*\d+\s+(?:de|d['’]une\s+(?:surface|superficie)\s+de)\s+{_M2_VALUE}{_M2_UNIT}",
    re.I,
)
# « deux parcelles … Superficie : 912 et 871 m2 », « d'une superficie respective de 170 m² et 605 m² »
_PARCEL_PAIR_RE = re.compile(
    rf"\bsuperficies?\s*(?:respectives?\s+)?(?::|de)?\s*{_M2_VALUE}(?:{_M2_UNIT})?\s+et\s+{_M2_VALUE}{_M2_UNIT}",
    re.I,
)
_SEVERAL_PARCELS_RE = re.compile(r"\b(?:deux|trois|quatre|des|les|[2-9])\s+parcelles\b|\brespectives?\b", re.I)


def parcel_m2_list(text: str | None) -> list[Decimal]:
    """Surfaces en m² de plusieurs parcelles vendues ensemble, quand le texte les énumère toutes."""
    if not text:
        return []
    values = [_m2(match.group(1)) for match in _PARCEL_M2_RE.finditer(text)]
    if len(set(values)) >= 2:
        return list(dict.fromkeys(values))
    for match in _PARCEL_PAIR_RE.finditer(text):
        if _SEVERAL_PARCELS_RE.search(text[max(0, match.start() - 250) : match.end()]):
            return [_m2(match.group(1)), _m2(match.group(2))]
    return []


def _m2(value: str) -> Decimal:
    return Decimal(re.sub(r"[\s.]", "", value))
