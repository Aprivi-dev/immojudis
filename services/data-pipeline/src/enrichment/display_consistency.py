"""Consistency of the public synthesis with the canonical facts (audit of 03/11/2026).

About thirty published syntheses repeated a figure that the evidence does hold
but that is not the sale's own (the surface of one bedroom, of another lot or
of the caretaker's flat, « 21 chambres »), invented a procedure (« par
adjudication » for an online Agorastore sale), wrote « vendu le » for a coming
sale, leaked the prompt's vocabulary (« faits canoniques ») or put an area
after « au prix de ». The existing check accepted every number found anywhere
in the evidence; the rules below compare the text with the structured fields.

``consistency_issues`` reports these errors; the evidence check
(``display_evidence``) then refuses the text. It now guards the model's summary
before it replaces a sale's description.

Text between « » is a verbatim source quotation appended by the pipeline and is
left out of these rules, as in ``display_semantics``.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from src.enrichment.display_facts import known_offer_amounts, sale_listing_text, sale_nature
from src.french_dates import MONTH_NUMBERS, MONTH_PATTERN, PARIS

NUMBER = r"(?<![\w.,+])\d+(?:[   ]\d{3})*(?:[.,]\d+)?"
WORD_VALUES = {
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
COUNT_WORD = r"\d+|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix"
QUOTED = re.compile(r"«[^»]*»")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
AREA = re.compile(rf"(?P<value>{NUMBER})\s*(?:m[²2]|mètres?\s+carrés?)\b", re.I)
MONEY = re.compile(rf"(?P<value>{NUMBER})\s*(?:€|euros?\b)", re.I)
COUNTS = {
    # kind: (claim pattern, canonical field)
    "rooms": (re.compile(rf"(?P<value>{COUNT_WORD})\s+pièces?\b(?!\s+jointes?)", re.I), "rooms_count"),
    "bedrooms": (re.compile(rf"(?P<value>{COUNT_WORD})\s+chambres?\b", re.I), "bedrooms_count"),
    "bathrooms": (
        re.compile(r"(?P<value>\d+)\s+salles?\s+(?:d['’]\s*eau|de\s+bains?)\b", re.I),
        "bathrooms_count",
    ),
    "parking": (
        re.compile(
            rf"(?P<value>{COUNT_WORD})\s+(?:places?\s+de\s+(?:stationnement|parking)|"
            r"emplacements?\s+de\s+(?:stationnement|parking)|stationnements?|parkings?)\b",
            re.I,
        ),
        "parking_count",
    ),
}
# The noun right before (or after) an area tells what it measures.
AREA_LABEL = re.compile(
    r"\b(?P<land>terrains?|parcelles?|contenance|fonci(?:er|ère)s?|cadastr\w*)\b"
    r"|\b(?P<built>habitables?|carrez|bâtie?s?|plancher|privatives?|utiles?)\b"
    r"|\b(?P<property>maisons?|appartements?|immeubles?|logements?|locaux|local|bien|ensemble|pavillons?|"
    r"villas?|studios?|bâtiments?|bureaux|entrepôts?|propriétés?|retenue|totale)\b"
    r"|\b(?P<part>caves?|celliers?|garages?|box|parkings?|stationnements?|balcons?|terrasses?|loggias?|"
    r"vérandas?|greniers?|combles|jardins?|cours?|séjours?|salons?|cuisines?|chambres?|salles?|dépendances?|"
    r"annexes?|ateliers?|hangars?|granges?|abris?|cabanons?|piscines?|remises?|buanderies?|bureau|"
    r"mezzanines?|entrées?|dégagements?|débarras|wc)\b",
    re.I,
)
AREA_LABEL_AFTER = re.compile(r"^\s*(?:\(|de\s+|d['’]\s*|en\s+)?\s*(?:loi\s+)?(?P<label>[\wÀ-ÿ]+)", re.I)
PRICE_LABEL = re.compile(r"\b(?:mise\s+à\s+prix|prix|offres?|à\s+partir\s+de|montant)\b", re.I)
AREA_WORD = re.compile(r"\b(?:surfaces?|superficies?|contenance|terrains?|parcelles?)\b", re.I)
# Procedure vocabulary: (claim, what supports it in the nature label or the listing).
PROCEDURE_TERMS = {
    "adjudication": (re.compile(r"\badjudications?\b", re.I), re.compile(r"\badjudication", re.I)),
    "online": (
        re.compile(r"\ben\s+ligne\b|\binteracti(?:f|ve)s?\b", re.I),
        re.compile(r"\ben\s+ligne\b|\binteracti|\bagora\s?store\b", re.I),
    ),
    "tender": (re.compile(r"\bappels?\s+d['’]\s*offres?\b", re.I), re.compile(r"\bappels?\s+d['’]\s*offres?\b", re.I)),
    "notarial": (
        re.compile(r"\bnotari(?:al|ale|ales|aux|é|ée|és|ées)\b|\bnotaires?\b", re.I),
        re.compile(r"\bnotai|\bnotari", re.I),
    ),
    "amicable": (
        re.compile(r"\bamiable\b|\bgr[ée]\s+[àa]\s+gr[ée]\b", re.I),
        re.compile(r"\bamiable\b|\bgr[ée]\s+[àa]\s+gr[ée]\b", re.I),
    ),
    "expression_of_interest": (
        re.compile(r"\bmanifestation\s+d['’]\s*int[ée]r[êe]t\b", re.I),
        re.compile(r"\bmanifestation\s+d['’]\s*int[ée]r[êe]t\b", re.I),
    ),
}
AUCTION_NATURES = {"judicial", "notarial_judicial", "notarial_auction", "unknown"}
SOLD = re.compile(r"\b(?P<aux>(?:a|ont)\s+été\s+)?vendu(?P<suffix>es|e|s)?\b", re.I)
FUTURE_AUXILIARY = re.compile(r"\b(?:sera|seront|être|est|sont|va|vont)\s+$", re.I)
DATE = re.compile(
    r"\b(?:(?P<d>\d{1,2})/(?P<m>\d{1,2})/(?P<y>\d{4})|(?P<d2>\d{1,2})(?:er)?\s+(?P<month>"
    + MONTH_PATTERN
    + r")\s+(?P<y2>\d{4}))\b",
    re.I,
)
INTERNAL_JARGON = re.compile(
    r"\bfaits?\s+(?:canoniques?|structurés?)\b|\bcanoni(?:que|ques|cal)\b|\bNATURE_VENTE\b"
    r"|\b[a-z]+(?:_[a-z0-9]+)+\b|\bdonnées\s+structurées\b|\bcontexte\s+fourni\b"
    r"|\b(?:éléments|données|documents)\s+fournis\b|\binformations\s+fournies\b|\bUNTRUSTED\b|\bSOURCE\s+DATA\b",
    re.I,
)
CANONICAL_SECTION = re.compile(
    r"\[FAITS CANONIQUES\].*?(?=\[(?!FAITS CANONIQUES)[A-ZÉ][A-ZÉ0-9 _/-]+\]|$)"
    r"|\[FAITS STRUCTURES A VALIDER POUR AFFICHAGE\][^\n]*",
    re.S,
)


def _today() -> date:
    return datetime.now(PARIS).date()


def _number(raw: str) -> Decimal | None:
    word = WORD_VALUES.get(raw.lower())
    if word is not None:
        return Decimal(word)
    try:
        value = Decimal(re.sub(r"\s", "", raw).replace(",", "."))
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def _decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() and number > 0 else None


def _same_area(claim: Decimal, known: Decimal) -> bool:
    # « 126 m² » for 125,80 m² is a rounding, « 130 m² » for 125,50 m² is another figure.
    if claim == claim.to_integral_value():
        return abs(known - claim) < Decimal("0.5")
    return known == claim


def _prose(text: str) -> str:
    return QUOTED.sub(" ", text or "")


def _sentences(text: str) -> list[str]:
    return [sentence for sentence in SENTENCE_SPLIT.split(text.strip()) if sentence.strip()]


def _window_before(text: str, start: int, size: int = 60) -> str:
    """Same sentence, after the previous figure: a label further back belongs to another number."""
    window = text[max(0, start - size) : start]
    cut = max((m.end() for m in re.finditer(r"[.!?;]\s|\d\s*(?:m[²2]|€|%)", window)), default=0)
    return window[cut:]


def _label_kind(match: re.Match[str] | None) -> str | None:
    if match is None:
        return None
    return next(kind for kind in ("land", "built", "property", "part") if match.group(kind))


def area_label(text: str, start: int, end: int) -> str | None:
    """``land``, ``built``, ``property`` (the asset itself), ``part`` (a room, an annex) or None."""
    after = AREA_LABEL_AFTER.match(text[end : end + 30])
    if after:
        kind = _label_kind(AREA_LABEL.fullmatch(after["label"]))
        if kind in {"land", "built", "part"}:
            return kind
    labels = list(AREA_LABEL.finditer(_window_before(text, start)))
    return _label_kind(labels[-1]) if labels else None


def _strip_canonical(evidence: str) -> str:
    """The prompt's own fact block cannot prove what a figure measures."""
    return CANONICAL_SECTION.sub(" ", evidence or "")


AREA_FIELDS = ("surface_m2", "app_surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2")


def _canonical_areas(fields: dict[str, Any]) -> dict[str, Decimal]:
    return {name: value for name in AREA_FIELDS if (value := _decimal(fields.get(name))) is not None}


def _area_issues(prose: str, evidence: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    canonical = _canonical_areas(fields)
    property_type = str(fields.get("property_type") or "")
    source = _strip_canonical(evidence)
    for claim in AREA.finditer(prose):
        value = _number(claim["value"])
        if value is None:
            continue
        label = area_label(prose, claim.start(), claim.end())
        matched = [key for key, known in canonical.items() if _same_area(value, known)]
        # A land figure is compared with the land field, any other with the built fields;
        # with no field of that kind the figure only needs the evidence (checked elsewhere).
        relevant = [
            name for name in canonical if property_type == "land" or (name == "land_surface_m2") == (label == "land")
        ]
        if relevant and not matched and label != "part":
            issues.append({"code": "area_contradicts_canonical", "claim": claim.group()})
            continue
        if property_type == "land" and label == "built":
            issues.append({"code": "area_kind_mismatch", "claim": claim.group(), "reason": "built_area_on_land"})
            continue
        if label in {"land", "built"}:
            seen = {
                area_label(source, m.start(), m.end())
                for m in AREA.finditer(source)
                if (number := _number(m["value"])) is not None and _same_area(value, number)
            } - {None, "property", "part"}
            other = "built" if label == "land" else "land"
            if seen == {other}:
                issues.append({"code": "area_kind_mismatch", "claim": claim.group(), "reason": f"source_says_{other}"})
    return issues


def _count_value(kind: str, prose: str, claim: re.Match[str]) -> Decimal | None:
    raw = claim["value"]
    value = _number(raw)
    if value is None or raw.isdigit():
        return value
    # « une chambre » is a room named in a list; « de une pièce » / « deux chambres » are counts.
    if value > 1 or (
        kind == "rooms" and re.search(r"\bd(?:e\s+|['’]\s*)$", prose[max(0, claim.start() - 4) : claim.start()], re.I)
    ):
        return value
    return None


def _count_issues(prose: str, evidence: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    land = str(fields.get("property_type") or "") == "land"
    for kind, (pattern, field) in COUNTS.items():
        claims = [
            (claim, value)
            for claim in pattern.finditer(prose)
            if (value := _count_value(kind, prose, claim)) is not None
        ]
        if not claims:
            continue
        if land and kind in {"rooms", "bedrooms", "bathrooms"}:
            issues.extend({"code": "count_on_land", "claim": claim.group()} for claim, _ in claims)
            continue
        known = fields.get(field)
        if isinstance(known, int) and not isinstance(known, bool) and known > 0:
            values = [value for _, value in claims]
            # « deux chambres au rez-de-chaussée et deux à l'étage » adds up to the canonical four.
            if known in values or sum(values) == known:
                continue
            issues.extend(
                {"code": "count_contradicts_canonical", "claim": claim.group(), "field": field}
                for claim, value in claims
                if value != known
            )
        elif kind == "parking":
            source = {_number(m["value"]) for m in pattern.finditer(_strip_canonical(evidence))}
            issues.extend(
                {"code": "unsupported_parking", "claim": claim.group()}
                for claim, value in claims
                if value not in source
            )
    return issues


def _price_issues(prose: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    known = set(known_offer_amounts(fields))
    adjudication = _decimal(fields.get("adjudication_price_eur"))
    if adjudication is not None:
        known.add(adjudication)
    issues: list[dict[str, str]] = []
    for claim in MONEY.finditer(prose):
        window = _window_before(prose, claim.start(), 40)
        if not PRICE_LABEL.search(window) or AREA_WORD.search(window):
            continue
        value = _number(claim["value"])
        if known and value not in known:
            issues.append({"code": "price_contradicts_canonical", "claim": claim.group()})
    for claim in AREA.finditer(prose):
        window = _window_before(prose, claim.start(), 40)
        if PRICE_LABEL.search(window) and not AREA_WORD.search(window):
            issues.append({"code": "unit_mismatch", "claim": window.strip() + " " + claim.group()})
    for claim in MONEY.finditer(prose):
        window = _window_before(prose, claim.start(), 40)
        if (
            AREA_WORD.search(window)
            and not PRICE_LABEL.search(window)
            and not re.match(r"\s*(?:/|par|le|du)\s*m", prose[claim.end() :])
        ):
            issues.append({"code": "unit_mismatch", "claim": window.strip() + " " + claim.group()})
    return issues


def _procedure_issues(prose: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    nature = sale_nature(fields)
    procedure = fields.get("sale_procedure")
    online = isinstance(procedure, dict) and procedure.get("participation_mode") == "online"
    support = " ".join(filter(None, (nature.label, sale_listing_text(fields))))
    issues = []
    for term, (claim_re, support_re) in PROCEDURE_TERMS.items():
        claim = claim_re.search(prose)
        if claim is None or support_re.search(support):
            continue
        if term == "adjudication" and (nature.code in AUCTION_NATURES or fields.get("adjudication_price_eur")):
            continue
        if term == "online" and online:
            continue
        issues.append({"code": "procedure_unsupported", "claim": claim.group(), "sale_nature": nature.code})
    return issues


def _dates(text: str) -> list[date]:
    found = []
    for match in DATE.finditer(text):
        try:
            if match["d"]:
                found.append(date(int(match["y"]), int(match["m"]), int(match["d"])))
            else:
                found.append(date(int(match["y2"]), MONTH_NUMBERS[match["month"].lower()], int(match["d2"])))
        except ValueError:
            continue
    return found


def _past_tense_claims(sentence: str, today: date) -> list[re.Match[str]]:
    if not any(day >= today for day in _dates(sentence)):
        return []
    return [
        match
        for match in SOLD.finditer(sentence)
        if match["aux"] or not FUTURE_AUXILIARY.search(sentence[max(0, match.start() - 12) : match.start()])
    ]


def _tense_issues(prose: str, today: date) -> list[dict[str, str]]:
    return [
        {"code": "past_tense_future_sale", "claim": match.group()}
        for sentence in _sentences(prose)
        for match in _past_tense_claims(sentence, today)
    ]


def consistency_issues(text: str, evidence: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    prose = _prose(text)
    return [
        *_area_issues(prose, evidence or "", fields),
        *_count_issues(prose, evidence or "", fields),
        *_price_issues(prose, fields),
        *_procedure_issues(prose, fields),
        *_tense_issues(prose, _today()),
        *({"code": "internal_jargon", "claim": match.group()} for match in INTERNAL_JARGON.finditer(prose)),
    ]

