"""Nombres de pièces, de chambres et de stationnements lus dans une fiche (valeurs ou texte libre).

Extrait de ``normalize.py`` (plafond de taille des fichiers) ; ``normalize`` en ré-exporte les
fonctions publiques.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from src.null_text import clean_text


def parse_rooms_count(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        rooms = int(value)
        return rooms if rooms > 0 else None
    text = clean_text(value)
    if not text:
        return None
    match = re.search(r"[1-9][0-9]?", text)
    return int(match.group(0)) if match else None


def parse_parking_count(value: object | None) -> int | None:
    """Parse a non-negative parking count while preserving an explicit zero."""

    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            numeric = Decimal(str(value))
        except (InvalidOperation, ValueError):
            return None
        if not numeric.is_finite() or numeric != numeric.to_integral_value():
            return None
        count = int(numeric)
        return count if count >= 0 else None
    text = clean_text(value)
    if not text:
        return None
    decimal_match = re.search(r"(?<!\d)([0-9]+[.,][0-9]+)(?!\d)", text)
    if decimal_match:
        try:
            numeric = Decimal(decimal_match.group(1).replace(",", "."))
        except InvalidOperation:
            return None
        if not numeric.is_finite() or numeric != numeric.to_integral_value():
            return None
        return int(numeric) if numeric >= 0 else None
    if re.fullmatch(r"0+", text):
        return 0
    match = re.search(r"\b([1-9][0-9]?)\b", text)
    return int(match.group(1)) if match else None


def parse_bedrooms_count(value: object) -> int | None:
    return parse_rooms_count(value)


def extract_rooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    for match in re.finditer(r"\bstudio\b", text, re.I):
        if not _is_rooms_count_false_positive(text, match.start(), match.end()):
            return 1

    patterns = (
        # « elle comprend 4 pièces principales », « 3 pièces principales » : le compte annoncé.
        rf"\b({_COUNT_TOKEN})\s*pi[eèé]ces?\s+principales\b",
        # « VILLA MITOYENNE DE 4 PIÈCES », « maison en R+1 de 4 pièces », « appartement … de trois pièces ».
        rf"\b(?:appartement|maison|villa|pavillon|logement|duplex|habitation)\b[^.;:,]{{0,40}}?\bde\s+({_COUNT_TOKEN})\s*pi[eèé]ces?\b",
        r"\b(?:appartement|maison|villa)\b.{0,80}?\blots?\s+\d+\s*,\s*"
        r"([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+[1-9][0-9]?\s*chambres?\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+"
        r"[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s+(?:superficie|surface)\b",
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\s+(?:à\s+propos\s+du\s+bien|a\s+propos\s+du\s+bien)\b",
        r"\b(?:appartement|maison|villa|immeuble)\s+(?:de\s+)?([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b(?:appartement|maison|villa)\s+de\s+[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s*,?\s+de\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*pi[eèé]ces?\b",
        r"\b(?:nombre\s+de\s+)?pi[eèé]ces?\s*(?:principales?)?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\bappartement\s+(?:de\s+)?type\s*([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\btype\s+([1-9]|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(1), match.end(1)):
                continue
            return _parse_count_token(match.group(1))

    # « une pièce principale » est un studio, sauf quand le texte cite aussi des chambres : la maison de
    # c3fbac51 a « une pièce principale (34,57 m2) » et trois chambres, pas une pièce.
    if re.search(r"\b(?:(?:une|1)\s+)?pi[eèé]ce\s+principale\b", text, re.I) and not _mentions_bedrooms(text):
        return 1
    return None


def extract_bedrooms_count_from_text(*values: object) -> int | None:
    text = clean_text(" ".join(str(value) for value in values if value))
    if not text:
        return None

    numbered = _count_numbered_bedrooms(text)
    if numbered is not None:
        return numbered

    # Un compte annoncé (« 5 pièces 2 chambres », « nombre de chambres : 3 ») fait foi.
    explicit = (
        r"\b[1-9][0-9]?\s*pi[eèé]ces?\s+([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
        r"\b(?:nombre\s+de\s+)?chambres?\s*:\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
    )
    for pattern in explicit:
        for match in re.finditer(pattern, text, re.I):
            if not _is_rooms_count_false_positive(text, match.start(), match.end()):
                return _parse_count_token(match.group(1))
    # Sinon les chambres citées étage par étage s'additionnent (« deux chambres … À l'étage : trois chambres »).
    composition = composition_bedroom_count(text)
    if composition is not None:
        return composition
    patterns = (
        r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*chambres?\b",
        r"\bchambres?\s*:?\s*([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_count_false_positive(text, match.start(), match.end()):
                continue
            return _parse_count_token(match.group(1))
    return None


def _parse_count_token(value: str) -> int | None:
    value = value.lower().strip()
    if value.isdigit():
        rooms = int(value)
        return rooms if rooms > 0 else None
    mapping = {
        "un": 1,
        "une": 1,
        "deux": 2,
        "trois": 3,
        "quatre": 4,
        "cinq": 5,
        "six": 6,
        "sept": 7,
        "huit": 8,
        "neuf": 9,
        "dix": 10,
    }
    return mapping.get(value)


def _count_numbered_bedrooms(text: str) -> int | None:
    matches = re.findall(r"\bchambre\s*(?:n[°o]\s*)?([1-9][0-9]?)\b", text, re.I)
    if not matches:
        return None
    numbers = {int(match) for match in matches}
    if len(numbers) >= 2 and numbers == set(range(1, max(numbers) + 1)):
        return max(numbers)
    return None


def _is_rooms_count_false_positive(text: str, start: int, end: int) -> bool:
    nearby = text[max(0, start - 20) : min(len(text), end + 30)]
    if re.search(r"\bchambres?\s+froides?\b", nearby, re.I):
        return True
    after_number = text[end : min(len(text), end + 20)]
    if re.match(r"\s*[,.]\d+\s*m(?:2|²)\b", after_number, re.I):
        return True
    # « (fonds travaux) T2 en 2026 » : un trimestre ; « servitudes AS 1 ; T 1 » : un code de servitude.
    if re.match(r"\s*(?:en\s+|de\s+)?20\d\d\b", after_number) or re.search(
        r"\b(?:trimestre|servitudes?|AS\s*\d+\s*;)\b[^.]{0,20}$", text[max(0, start - 40) : start], re.I
    ):
        return True
    nearby = text[max(0, start - 40) : min(len(text), end + 80)]
    if re.search(r"\b(?:d[ée]pendance|annexe|remise)\b", nearby, re.I):
        return True
    before = text[max(0, start - 180) : start]
    after = text[end : min(len(text), end + 160)]
    context = before + after
    return bool(
        re.search(
            r"donnn?[ée]es?\s+des\s+valeurs\s+fonci[èe]res|prix\s+de\s+vente|date\s+de\s+vente|nb\s+de\s+pi[eèé]ces|article|page|"
            r"tous\s+les\s+biens|villa\s+maison\s+appartement\s+studio\s+terrain",
            context,
            re.I,
        )
    )


_COUNT_TOKEN = r"[1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix"
_ROOM_LIST_WORD_RE = re.compile(
    r"\b(?:entr[ée]e|cuisine|s[ée]jour|salon|salle\s+(?:d['’]eau|de\s+bains?|[àa]\s+manger|de\s+douche)|wc|w\.c"
    r"|toilettes?|d[ée]gagement|couloir|palier|bureau|cellier|buanderie|dressing)\b",
    re.I,
)
_NUMBERED_BEDROOMS_RE = re.compile(rf"\b({_COUNT_TOKEN})\s+chambres\b", re.I)
_NOT_A_BEDROOM = (
    r"(?!\s*(?:froides?|d['’]\s*h[ôo]tel|d['’]\s*h[ôo]tes|des\s|de\s+commerce|d['’]agriculture|syndicale"
    r"|d[ée]partementale|r[ée]gionale|nationale|interd[ée]partementale|civile|criminelle|correctionnelle))"
)
_SINGLE_BEDROOM_RE = re.compile(
    r"(?:^|[,:;•\-–−]|\bet\b|\bune\b|\bpremi[eè]re\b|\bseconde\b|\bdeuxi[eè]me\b|\btroisi[eè]me\b)\s*chambre\b"
    + _NOT_A_BEDROOM,
    re.I,
)


def _mentions_bedrooms(text: str) -> bool:
    return bool(re.search(r"\bchambres?\b" + _NOT_A_BEDROOM, text, re.I))


def _mention_key(text: str, start: int, token: str) -> str:
    """Une mention recopiée (description, texte de la page) garde le même libellé juste avant elle."""
    words = re.findall(r"[^\W_]+", text[max(0, start - 60) : start].lower())
    # Les trois mots qui précèdent : « salon, salle à manger, 3 chambres » recopié garde la même clé, alors que
    # « Au 1er étage : palier, deux chambres » et « Au 2ème étage : palier, deux chambres » restent distincts.
    return f"{' '.join(words[-3:])}|{token.lower()}"


def composition_bedroom_count(text: str) -> int | None:
    """Chambres d'une description pièce par pièce, additionnées sur tous les niveaux.

    « Au rez-de-chaussée : …, deux chambres, … À l'étage : palier, deux chambres » = 4 ;
    « une chambre (13,66 m2) … À l'étage : un bureau, une chambre SUD EST, une chambre SUD OUEST » = 3.
    Seules les mentions au milieu d'une énumération de pièces sont lues (la « chambre des notaires » n'est pas
    une chambre), et une mention recopiée (même libellé juste avant) n'est comptée qu'une fois.
    """
    text = re.sub(r"\s+", " ", text)
    seen: set[str] = set()
    total = 0
    masked = text
    for match in _NUMBERED_BEDROOMS_RE.finditer(text):
        masked = masked[: match.start()] + " " * (match.end() - match.start()) + masked[match.end() :]
        if _is_rooms_count_false_positive(text, match.start(1), match.end(1)) or not _in_room_list(text, match.start()):
            continue
        key = _mention_key(text, match.start(), match.group(0))
        if key not in seen:
            seen.add(key)
            total += _parse_count_token(match.group(1)) or 0
    for match in _SINGLE_BEDROOM_RE.finditer(masked):
        if not _in_room_list(text, match.start()):
            continue
        key = _mention_key(text, match.start(), match.group(0))
        if key not in seen:
            seen.add(key)
            total += 1
    return total or None


def _in_room_list(text: str, position: int) -> bool:
    window = text[max(0, position - 150) : position + 150]
    return len(_ROOM_LIST_WORD_RE.findall(window)) >= 2


def reconcile_room_counts(sale: object, text: str) -> None:
    """Pièces et chambres sans preuve cohérente : retirées plutôt que devinées.

    - un terrain n'a ni pièces ni chambres ;
    - un immeuble ou un ensemble de plusieurs logements n'a pas de compte de pièces d'un seul logement ;
    - un logement a au moins une pièce de plus que de chambres (le séjour) : sinon le nombre de pièces est retiré
      (c'est lui qui est faux dans les cas relevés : « une pièce principale » d'une maison à trois chambres,
      « T2 en 2026 » d'un appartement à deux chambres, « 3 pièces 3 chambres » pour séjour + 3 chambres).
    """
    property_type = getattr(sale, "property_type", None)
    rooms, bedrooms = getattr(sale, "rooms_count", None), getattr(sale, "bedrooms_count", None)
    if rooms is None and bedrooms is None:
        return
    reason = None
    if property_type in {"land", "parking"}:
        reason = "no_rooms_for_this_property_type"
    elif _describes_several_dwellings(sale, text):
        reason = "several_dwellings_without_total"
    elif property_type in {"house", "apartment"} and rooms is not None and bedrooms is not None and rooms <= bedrooms:
        reason = "rooms_not_greater_than_bedrooms"
    if reason is None:
        return
    sale.rooms_count = None
    if reason != "rooms_not_greater_than_bedrooms":
        sale.bedrooms_count = None
    payload = getattr(sale, "raw_payload", None)
    if isinstance(payload, dict):
        payload["room_count_reconciliation"] = {
            "status": "withheld",
            "rejected_rooms_count": rooms,
            "rejected_bedrooms_count": bedrooms if sale.bedrooms_count is None else None,
            "reason": reason,
        }
    flags = getattr(sale, "quality_flags", None)
    if isinstance(flags, list) and "room_count_conflict" not in flags:
        flags.append("room_count_conflict")


def _describes_several_dwellings(sale: object, text: str) -> bool:
    flags = getattr(sale, "quality_flags", None) or []
    if "multi_lot_sale" in flags:
        return True
    # « les trois maisons disposent d'une surface habitable d'environ 95 m² » (5003b2a5) : trois logements.
    if re.search(
        r"\b(?:les|des|ces)\s+(?:deux|trois|quatre|cinq|six|[2-9])\s+(?:maisons|villas|pavillons|appartements|logements)\b",
        text,
        re.I,
    ):
        return True
    if getattr(sale, "property_type", None) not in {"building", "mixed"}:
        return False
    lowered = text.lower()
    counted = re.search(
        r"\b(?:[2-9]|[1-9][0-9]|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:appartements?|logements?|studios?)\b",
        lowered,
    )
    # « un appartement de 67.55 m² … un appartement de 75.37 m² » : deux logements (une phrase recopiée n'en
    # fait pas deux, d'où l'ensemble des surfaces citées).
    listed = set(
        re.findall(r"\b(?:un|1)\s+(?:appartement|logement|studio)\s+(?:de|d['’]une\s+surface\s+de)\s+([0-9]+(?:[.,][0-9]+)?)", lowered)
    )
    return bool(counted) or len(listed) >= 2


def source_rooms_counter(*values: object) -> int | None:
    """Compteur de la fiche de la source (« 4 pièces 2 chambres », « 4 pièces 120 m² superficie »), seul.

    Pour un bien « mixte », la prose peut décrire un seul des locaux ; le compteur de la fiche, lui, est
    celui que la source annonce pour la vente.
    """
    text = clean_text(" ".join(str(value) for value in values if value)) or ""
    for pattern in (
        rf"\b({_COUNT_TOKEN})\s*pi[eèé]ces?\s+[1-9][0-9]?\s*chambres?\b",
        rf"\b({_COUNT_TOKEN})\s*pi[eèé]ces?\s+[0-9]+(?:[,.][0-9]+)?\s*m(?:2|²)\s+(?:superficie|surface)\b",
    ):
        match = re.search(pattern, text, re.I)
        if match:
            return _parse_count_token(match.group(1))
    return None
