"""Lecture de la phrase qui porte une information extraite d'une réponse de l'agent d'information.

Partagé par la lecture par l'IA (``information_agent_semantic``) ; le même contrôle existe pour les règles
TypeScript (``src/lib/information-agent-inbound/review-signals.ts``), avec la même liste de codes
(``REVIEW_REASON_LABELS``, figée par un test des deux côtés).

Trois issues pour une valeur :

- rejet (erreur de catégorie ou négation : ``StatementReview.rejected``) ;
- relecture : des motifs (``StatementReview.reasons``), jamais un fait net ;
- fait net : ni rejet ni motif.

Unités lues : la phrase (du point au point, une puce ou une ligne qui commence par une majuscule est une
phrase), la proposition (la phrase coupée aux virgules, points-virgules, parenthèses, « et », « mais »…),
et les deux phrases voisines quand elles contiennent une réserve ou renvoient à la valeur (« ce chiffre »).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from src.document_reading import SoldLot, names_another_lot
from src.occupancy_statements import fold

# Codes des motifs de relecture et leurs libellés. Même liste, mêmes libellés, dans
# `src/lib/information-agent-review-reasons.ts` (onglet Réponses et règles TypeScript).
REVIEW_REASON_LABELS: dict[str, str] = {
    "short_citation": "phrase de moins de 25 caractères",
    "hedged_statement": "valeur au conditionnel ou approximative",
    "reported_or_comparison": "valeur rapportée d’une autre source ou d’un autre bien",
    "pending_verification": "réserve : « à vérifier », « à confirmer », « sous réserve », « non contrôlé »",
    "value_range": "fourchette de valeurs",
    "corrected_or_stale_value": "valeur corrigée, périmée ou signalée comme erronée",
    "postponement": "renvoi ou report mentionné dans la phrase",
    "question": "la phrase est une question",
    "lot_unidentified": "vente à plusieurs lots : la phrase ne nomme aucun lot",
    "lot_unverified": "la phrase nomme un lot que l’on ne peut pas rapprocher de la vente",
    "rules_only_attachment": "pièce lue par les règles seules, sans confirmation par l’IA",
}

NUMERIC_FACT_KEYS = frozenset({"surface_m2", "land_surface_m2", "rooms_count", "starting_price_eur"})
MIN_STATEMENT_CHARS = 25


@dataclass(frozen=True)
class LotContext:
    """``multi_lot`` : l'annonce compte plusieurs lots ; ``sold_lot`` : le lot vendu, s'il est connu."""

    multi_lot: bool
    sold_lot: SoldLot | None = None


@dataclass(frozen=True)
class StatementReview:
    rejected: bool
    reasons: tuple[str, ...] = ()


# --- Phrases et propositions -------------------------------------------------------------------------
_ABBREVIATIONS_BEFORE_PERIOD = frozenset(
    {"env", "approx", "cf", "n", "no", "art", "m", "me", "mme", "mm", "st", "ste", "av", "bd", "p", "pp", "ch", "ref", "réf", "etc", "ex"}
)
_BULLET_RE = re.compile(r"^\s*(?:[-•*–·▪]|\d{1,2}[.)])\s+")
_LINE_START_SENTENCE_RE = re.compile(r"^\s*(?:[-•*–·▪(]|\d{1,2}[.)]\s|[A-ZÀ-ÖØ-Þ])")
_CLAUSE_SEPARATOR_RE = re.compile(
    r"(?<!\d),|,(?!\d)|;|\(|\)|\s[-–]\s|\b(?:et|mais|car|donc|puis|tandis\s+que|alors\s+que|or)\b",
    re.IGNORECASE,
)


def split_sentences(text: str) -> list[tuple[int, int]]:
    """Bornes des phrases : point (sauf décimale ou abréviation), « ! », « ? », « … », ligne vide, puce, ou
    ligne qui commence par une majuscule ou une parenthèse."""
    bounds: list[tuple[int, int]] = []
    start = 0
    index = 0
    length = len(text)
    while index < length:
        character = text[index]
        end: int | None = None
        if character in "!?…":
            end = index + 1
            while end < length and text[end] in "!?…":
                end += 1
        elif character == "." and _period_ends_sentence(text, index):
            end = index + 1
        elif character == "\n" and _newline_ends_sentence(text, index):
            end = index
        if end is not None:
            if text[start:end].strip():
                bounds.append((start, end))
            # Le retour à la ligne qui termine une phrase n'appartient à aucune.
            start = end + 1 if character == "\n" else end
            index = start
            continue
        index += 1
    if text[start:].strip():
        bounds.append((start, length))
    return bounds


def _period_ends_sentence(text: str, index: int) -> bool:
    before = text[index - 1] if index > 0 else ""
    after = text[index + 1] if index + 1 < len(text) else ""
    if before.isdigit() and after.isdigit():
        return False
    if after and not after.isspace():
        return False
    word = re.search(r"([^\W\d_]+)$", text[max(0, index - 12) : index])
    return not (word and word.group(1).casefold() in _ABBREVIATIONS_BEFORE_PERIOD)


def _newline_ends_sentence(text: str, index: int) -> bool:
    line_start = text.rfind("\n", 0, index) + 1
    current = text[line_start:index]
    rest = text[index + 1 :]
    if not rest.strip() or not current.strip():
        return True
    if rest.startswith("\n") or re.match(r"[ \t]*\n", rest):
        return True
    return bool(_BULLET_RE.match(current) or _LINE_START_SENTENCE_RE.match(rest))


def _clause_bounds(sentence: str, offset: int) -> tuple[int, int]:
    """Proposition (début, fin, relatifs à la phrase) qui contient la position ``offset``."""
    start = 0
    end = len(sentence)
    for match in _CLAUSE_SEPARATOR_RE.finditer(sentence):
        if match.end() <= offset:
            start = match.end()
        elif match.start() >= offset:
            end = match.start()
            break
    return start, end


def _clauses(sentence: str) -> list[str]:
    parts: list[str] = []
    start = 0
    for match in _CLAUSE_SEPARATOR_RE.finditer(sentence):
        parts.append(sentence[start : match.start()])
        start = match.end()
    parts.append(sentence[start:])
    return [part for part in parts if part.strip()]


# --- Repères -------------------------------------------------------------------------------------------
_CONDITIONAL_RE = re.compile(
    r"\b[^\W\d_]{2,}(?:rait|raient)\b|\bsembl(?:e|ent|erait|eraient)\b|\ba\s+priori\b|\bprobablement\b|"
    r"\bvraisemblablement\b|\bapparemment\b|\bpeut-[êe]tre\b|\bsans\s+doute\b|\bth[ée]oriquement\b|"
    r"\bpr[ée]sum[ée]e?s?\b|\bsuppos[ée]e?s?\b",
    re.IGNORECASE,
)
_APPROX_WORDS = (
    r"environ|env\.|approx(?:\.|imativement|imative)?|pr[èe]s\s+de|plus\s+de|moins\s+de|au\s+moins|au\s+plus|"
    r"jusqu['’]\s*[àa]|de\s+l['’]ordre\s+de|autour\s+de|aux\s+alentours\s+de|plus\s+ou\s+moins|quelque|"
    r"[àa]\s+peu\s+pr[èe]s|grosso\s+modo|~|≈|±|\+\s*/\s*-|\+-"
)
_APPROX_BEFORE_RE = re.compile(rf"(?:{_APPROX_WORDS})\s*(?:d['’]\s*)?$", re.IGNORECASE)
_APPROX_AFTER_RE = re.compile(
    r"^\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?|€|euros?|pi[èe]ces?)?\s*(?:habitables?|carrez)?\s*"
    r"(?:environ|approx\w*|±|\+\s*/\s*-|\+-|~|≈|au\s+moins|au\s+maximum|maximum|minimum|ou\s+plus|et\s+plus|\+(?!\s*\d))",
    re.IGNORECASE,
)
_APPROX_ANYWHERE_RE = re.compile(rf"(?<!\w)(?:{_APPROX_WORDS})", re.IGNORECASE)
_SOURCE_INTRO_RE = re.compile(r"\b(?:selon|d['’]apr[èe]s|suivant)\b", re.IGNORECASE)
# « selon » devant une pièce qui fait foi n'est pas une valeur rapportée (« selon le certificat Carrez »).
_DOCUMENTARY_SOURCE_RE = re.compile(
    r"^\s*(?:(?:le|la|les|l['’]|notre|votre|un|une)\s*)?(?:titre|acte|certificat|attestation|mesurage|"
    r"m[ée]tr(?:age|[ée])|diagnostic|dossier\s+de\s+diagnostic|cahier|proc[èe]s[-\s]verbal|pv|relev[ée]\s+de\s+g[ée]om[èe]tre)\b",
    re.IGNORECASE,
)
_DATED_OR_OLD_RE = re.compile(
    r"\b(?:de|du|en|dat[ée]e?\s+de)\s+(?:\d{4}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\b|\b(?:ancien(?:ne)?s?|pr[ée]c[ée]dent(?:e)?s?)\b",
    re.IGNORECASE,
)
_REPORTED_RE = re.compile(
    r"\bl['’]annonce\s+(?:indiqu|mentionn|pr[ée]cis|annon[cç]|parl|donn|affich)\w*|\bl['’]annonce\s+fait\s+[ée]tat|"
    r"\b(?:indiqu|mentionn|annonc|affich)[ée]e?s?\s+(?:dans|sur|par)\s+(?:l['’]annonce|le\s+site|internet|l['’]agence)|"
    r"\bpour\s+comparaison\b|\bpar\s+comparaison\b|\b[àa]\s+titre\s+de\s+(?:comparaison|r[ée]f[ée]rence|exemple)\b|"
    r"\bvoisin(?:e|s|es)?\b|\bcomparables?\b|\bje\s+reprends\b|\bon\s+m['’]a\s+(?:dit|indiqu[ée]|rapport[ée])|"
    r"\bil\s+para[iî]t\b|\bde\s+m[ée]moire\b|\bsi\s+je\s+me\s+souviens\b",
    re.IGNORECASE,
)
_PENDING_RE = re.compile(
    r"\b(?:sous\s+(?:toute\s+)?r[ée]serve|[àa]\s+(?:v[ée]rifier|confirmer|pr[ée]ciser|contr[ôo]ler)|"
    r"non\s+(?:confirm|v[ée]rifi|contr[ôo]l|valid)\w*|(?:pas|jamais)\s+(?:encore\s+)?(?:[ée]t[ée]\s+)?(?:contr[ôo]l|v[ée]rifi|mesur|confirm|valid)\w*|"
    r"[àa]\s+titre\s+indicatif|indicati(?:f|ve)s?|estimation|estim[ée]e?s?|provisoire)",
    re.IGNORECASE,
)
_ERROR_RE = re.compile(r"\b(?:erreur|erron[ée]e?s?|inexacte?s?|faute\s+de\s+frappe|coquille)\b", re.IGNORECASE)
_CORRECTION_RE = re.compile(
    r"\b(?:initialement|anciennement|pr[ée]c[ée]demment|ramen[ée]e?s?|baiss[ée]e?s?|abaiss[ée]e?s?|"
    r"r[ée]duite?s?\s+[àa]|rectifi[ée]e?s?|corrig[ée]e?s?|au\s+lieu\s+de|par\s+erreur|pr[ée]c[ée]dent(?:e|s|es)?|"
    r"ancien(?:ne|s|nes)?)\b",
    re.IGNORECASE,
)
_POSTPONEMENT_RE = re.compile(
    r"\b(?:renvoy[ée]e?s?|renvoi|report[ée]e?s?|report|ajourn[ée]e?s?|d[ée]cal[ée]e?s?|"
    r"remise?s?\s+(?:[àa]|au)\s+(?:une\s+)?(?:date|audience|plus\s+tard|\d))\b",
    re.IGNORECASE,
)
_AMOUNT = r"\d[\d\s.,]*(?:\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?|€|euros?|pi[èe]ces?))?"
_RANGE_RE = re.compile(
    rf"\bentre\s+{_AMOUNT}\s+et\s+\d|"
    rf"\bde\s+{_AMOUNT}\s+[àa]\s+\d[\d\s.,]*(?!\s*(?:min|minutes?|km|kilom[èe]tres?|h\b|heures?|pas\b))|"
    r"\d\s*(?:-|–|/|[àa])\s*\d+(?:[.,]\d+)?\s*(?:m\s?[²2]|€|pi[èe]ces?)(?!\w)",
    re.IGNORECASE,
)
_NEIGHBOUR_REFERENCE_RE = re.compile(
    r"\b(?:ce|cet|cette|ces)\s+(?:chiffres?|surfaces?|superficies?|valeurs?|points?|informations?|mesures?|"
    r"montants?|donn[ée]es?|dimensions?|prix|dates?|[ée]l[ée]ments?|indications?|m[ée]trages?)\b|"
    r"\b(?:il|elle)\s+s['’]agit\b",
    re.IGNORECASE,
)
_NEGATION_BEFORE_RE = re.compile(
    r"(?:\bn['’]|\bne\b)[^,;]{0,40}?\b(?:pas|plus|jamais|point)\b[^,;]{0,30}$|"
    r"\b(?:aucun(?:e)?|pas\s+de|non\s+pas)\b[^,;]{0,30}$",
    re.IGNORECASE,
)
_UNIT_KIND_RES: dict[str, re.Pattern[str]] = {
    "area": re.compile(r"\d\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?)(?!\w)", re.IGNORECASE),
    "money": re.compile(r"\d\s*(?:€|euros?)(?!\w)", re.IGNORECASE),
    "rooms": re.compile(r"\d\s*pi[èe]ces?\b", re.IGNORECASE),
}
_FACT_UNIT_KIND = {"surface_m2": "area", "land_surface_m2": "area", "starting_price_eur": "money", "rooms_count": "rooms"}
_SALE_EVENT_CUE_RE = re.compile(r"\b(?:vente|audience|adjudication|adjug[ée]e?)\b", re.IGNORECASE)
_VISIT_WORD_RE = re.compile(r"\bvisit(?:e|es|er|eurs?)\b", re.IGNORECASE)
_GES_RE = re.compile(r"\bGES\b|gaz\s+[àa]\s+effet\s+de\s+serre|[ée]missions?\s+de\s+(?:co2|gaz)", re.IGNORECASE)
_LOT_MENTION_RE = re.compile(r"\blots?\s*(?:n(?:°|o|os|um[ée]ros?)?\.?\s*)?(\d{1,3}(?:\s*(?:,|et|&|à|a|-)\s*\d{1,3})*)\b", re.IGNORECASE)
_CO_OWNERSHIP_LOT_CONTEXT = re.compile(r"copropriete|etat descriptif|tantiemes")


def _lot_mentions(text: str, start: int, end: int) -> list[tuple[int, set[int]]]:
    """Lots de la vente nommés entre ``start`` et ``end`` (position, numéros), hors lots de copropriété."""
    mentions: list[tuple[int, set[int]]] = []
    for match in _LOT_MENTION_RE.finditer(text, start, end):
        around = fold(text[max(0, match.start() - 30) : match.end() + 30])
        if _CO_OWNERSHIP_LOT_CONTEXT.search(around):
            continue
        numbers = {int(value) for value in re.findall(r"\d+", match.group(1))}
        if numbers:
            mentions.append((match.start(), numbers))
    return mentions


def _documentary_source(sentence: str, match: re.Match[str]) -> bool:
    rest = sentence[match.end() :]
    if not _DOCUMENTARY_SOURCE_RE.match(rest):
        return False
    clause_end = re.search(r"[,;:]", rest)
    clause = rest[: clause_end.start()] if clause_end else rest[:80]
    return _DATED_OR_OLD_RE.search(clause) is None


def _reported(sentence: str) -> bool:
    if _REPORTED_RE.search(sentence):
        return True
    return any(not _documentary_source(sentence, match) for match in _SOURCE_INTRO_RE.finditer(sentence))


def _range_at(sentence: str, clause: str, start: int, end: int, numeric: bool) -> bool:
    """Fourchette qui contient la valeur (« entre 60 et 70 m² », « de 60 à 70 m² ») ; dans la proposition
    pour une clé non numérique."""
    if not numeric:
        return _RANGE_RE.search(clause) is not None
    return any(match.start() <= end and match.end() >= start for match in _RANGE_RE.finditer(sentence))


def _other_unit_number(clause: str, fact_key: str) -> bool:
    kind = _FACT_UNIT_KIND.get(fact_key)
    return any(pattern.search(clause) for name, pattern in _UNIT_KIND_RES.items() if name != kind)


# --- Analyse -------------------------------------------------------------------------------------------


def review_statement(
    text: str,
    anchor: tuple[int, int],
    fact_key: str,
    lot_context: LotContext | None = None,
) -> StatementReview:
    """Rejet ou motifs de relecture pour la valeur située en ``anchor`` (début, fin) dans ``text``.

    Pour une clé numérique, ``anchor`` est la position du nombre ; sinon, celle de la citation.
    Sans ``lot_context``, les lots de la vente sont inconnus : un lot autre que le premier nommé part en relecture.
    """
    sentences = split_sentences(text)
    if not sentences:
        return StatementReview(False, ())
    position = min(max(anchor[0], 0), len(text) - 1)
    index = next(
        (i for i, (start, end) in enumerate(sentences) if start <= position < end),
        min(range(len(sentences)), key=lambda i: abs(sentences[i][0] - position)),
    )
    s_start, s_end = sentences[index]
    sentence = text[s_start:s_end]
    previous = text[slice(*sentences[index - 1])] if index > 0 else ""
    following = text[slice(*sentences[index + 1])] if index + 1 < len(sentences) else ""
    offset = position - s_start
    c_start, c_end = _clause_bounds(sentence, offset)
    clause = sentence[c_start:c_end]
    before_value = sentence[c_start:offset]
    after_value = sentence[min(len(sentence), anchor[1] - s_start) : c_end]
    numeric = fact_key in NUMERIC_FACT_KEYS

    # Rejets : négation de la valeur, autre lot, date de vente ou DPE mal lus.
    if numeric and _NEGATION_BEFORE_RE.search(before_value):
        return StatementReview(True)
    lot_rejected, lot_reasons = _lot_review(text, sentences, index, position, sentence, lot_context)
    if lot_rejected:
        return StatementReview(True)
    if fact_key == "sale_date" and (
        _SALE_EVENT_CUE_RE.search(sentence) is None
        or _VISIT_WORD_RE.search(sentence) is not None
        or _POSTPONEMENT_RE.search(sentence) is not None
    ):
        return StatementReview(True)
    if fact_key == "energy_diagnostics" and _GES_RE.search(sentence):
        return StatementReview(True)

    reasons: list[str] = []
    add = reasons.append
    if len(_BULLET_RE.sub("", sentence).strip()) < MIN_STATEMENT_CHARS:
        add("short_citation")
    hedged = bool(_CONDITIONAL_RE.search(clause))
    if numeric:
        hedged = hedged or bool(_APPROX_BEFORE_RE.search(before_value[-40:]) or _APPROX_AFTER_RE.search(after_value))
    else:
        hedged = hedged or bool(_APPROX_ANYWHERE_RE.search(clause))
    if hedged:
        add("hedged_statement")
    if _reported(sentence):
        add("reported_or_comparison")
    if _PENDING_RE.search(sentence) or _PENDING_RE.search(previous) or _PENDING_RE.search(following):
        add("pending_verification")
    if fact_key not in {"visit_information", "sale_date"} and _range_at(sentence, clause, offset, anchor[1] - s_start, numeric):
        add("value_range")
    corrected = bool(_ERROR_RE.search(sentence) or _ERROR_RE.search(previous) or _ERROR_RE.search(following))
    corrected = corrected or any(
        _CORRECTION_RE.search(part) and (part == clause or not _other_unit_number(part, fact_key))
        for part in [clause, *_clauses(sentence)]
    )
    if corrected:
        add("corrected_or_stale_value")
    if fact_key != "sale_date" and _POSTPONEMENT_RE.search(sentence):
        add("postponement")
    if sentence.rstrip().endswith("?"):
        add("question")
    # Phrase voisine qui renvoie à la valeur (« Ce chiffre serait… ») : ses doutes comptent.
    for neighbour in (previous, following):
        if not _NEIGHBOUR_REFERENCE_RE.search(neighbour):
            continue
        if _CONDITIONAL_RE.search(neighbour) or _APPROX_ANYWHERE_RE.search(neighbour):
            add("hedged_statement")
        if _reported(neighbour):
            add("reported_or_comparison")
        if _CORRECTION_RE.search(neighbour):
            add("corrected_or_stale_value")
    reasons.extend(lot_reasons)
    return StatementReview(False, tuple(dict.fromkeys(reasons)))


def _lot_review(
    text: str,
    sentences: list[tuple[int, int]],
    index: int,
    position: int,
    sentence: str,
    lot_context: LotContext | None,
) -> tuple[bool, tuple[str, ...]]:
    sold = lot_context.sold_lot if lot_context else None
    highest = (sold.lot_count if sold else None) or 9
    window_start = sentences[index - 1][0] if index > 0 else sentences[index][0]
    s_start, s_end = sentences[index]
    # Lot nommé le plus proche AVANT la valeur (phrase précédente comprise), puis ceux de la phrase.
    before = [(pos, {n for n in numbers if 1 <= n <= highest}) for pos, numbers in _lot_mentions(text, window_start, position)]
    before = [(pos, numbers) for pos, numbers in before if numbers]
    nearest = before[-1][1] if before else None
    in_sentence = set().union(*(numbers for _, numbers in _lot_mentions(text, s_start, s_end))) if s_end > s_start else set()
    in_sentence = {n for n in in_sentence if 1 <= n <= highest}
    named = nearest if nearest is not None else in_sentence
    page_lots = set().union(*(numbers for _, numbers in _lot_mentions(text, 0, len(text))))
    several_lots_in_text = len({n for n in page_lots if 1 <= n <= highest}) > 1

    if sold is not None:
        if nearest is not None:
            return (sold.number not in nearest, ())
        if names_another_lot(sentence, sold):
            return (True, ())
        return (False, ("lot_unidentified",) if not in_sentence else ())
    if lot_context is not None and lot_context.multi_lot:
        return (False, ("lot_unverified",) if named else ("lot_unidentified",))
    if named - {1}:
        return (False, ("lot_unverified",))
    if several_lots_in_text:
        return (False, ("lot_unidentified",))
    return (False, ())


# --- Surface et pièces : de quoi parle ce nombre ? ----------------------------------------------------
_LAND_CUE = r"terrain|parcelle|jardin|cadastr\w*|contenance|emprise|foncier"
_DWELLING_CUE = (
    r"habitables?|carrez|logement|appartement|maison|villa|pavillon|studio|duplex|b[âa]ti|plancher|utile|"
    r"int[ée]rieure?|surface\s+totale|privative"
)
_ANNEX_CUE = (
    r"caves?|loggias?|balcons?|terrasses?|garages?|cours?|greniers?|celliers?|parkings?|box|d[ée]pendances?|"
    r"annexes?|v[ée]randas?|combles?|sous-sol|abris?|remises?|hors"
)
_AREA_CUE_RE = re.compile(rf"\b(?:(?P<land>{_LAND_CUE})|(?P<dwelling>{_DWELLING_CUE})|(?P<annex>{_ANNEX_CUE}))\b", re.IGNORECASE)
_AREA_AFTER_DWELLING_RE = re.compile(
    r"^\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?)\s*(?:habitables?|carrez|de\s+surface\s+habitable)\b", re.IGNORECASE
)
_AREA_AFTER_LAND_RE = re.compile(
    r"^\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?)\s*(?:de\s+)?(?:terrain|jardin|parcelle)\b", re.IGNORECASE
)


def area_category(text: str, start: int, end: int) -> str | None:
    """« land », « dwelling », « annex » ou None : le repère le plus proche du nombre (après l'unité, puis
    le dernier repère avant le nombre dans la même proposition)."""
    after = text[end : end + 40]
    if _AREA_AFTER_DWELLING_RE.match(after):
        return "dwelling"
    if _AREA_AFTER_LAND_RE.match(after):
        return "land"
    window_start = max(0, start - 80)
    window = text[window_start:start]
    cut = max((m.end() for m in re.finditer(r"[.;!?\n]", window)), default=0)
    last: str | None = None
    for match in _AREA_CUE_RE.finditer(window, cut):
        last = match.lastgroup
    return last


ROOMS_FOLLOW_RE = re.compile(
    r"\s*(?:pi[èe]ces?\b|p\b)(?!\s+(?:jointes?|justificatives?|annexes?|demand[ée]es|compl[ée]mentaires|"
    r"d['’]identit[ée]|d['’]eau|du\s+dossier|de\s+(?:la\s+)?proc[ée]dure|[àa]\s+conviction|n[ée]cessaires|"
    r"requises|transmises|envoy[ée]es))",
    re.IGNORECASE,
)

__all__: list[str] = [
    "LotContext",
    "NUMERIC_FACT_KEYS",
    "REVIEW_REASON_LABELS",
    "ROOMS_FOLLOW_RE",
    "StatementReview",
    "area_category",
    "review_statement",
    "split_sentences",
]
