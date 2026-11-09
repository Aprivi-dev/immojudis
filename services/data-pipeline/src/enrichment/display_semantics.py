"""Wording checks for the public synthesis: absences, sale nature, occupancy, filler.

These are deterministic, pattern-based rejections. They do not certify that a
text is true; they catch the recurring failures measured in the 11/10/2026
audit (false « non précisé » sentences, « vente judiciaire » for a notarial or
State sale, « occupé par le propriétaire » invented from « occupé », and
generic procedure filler).
"""

from __future__ import annotations

import re
from typing import Any

from src.enrichment.display_facts import energy_classes, known_offer_amounts, sale_nature

# Verbatim source quotations (« … ») appended by ``preserve_source_constraints``
# are evidence, not prose written by the model.
QUOTED_SOURCE = re.compile(r"«[^»]*»")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?;])\s+")
# An absence and the field it denies must sit in the same clause: « visite à
# confirmer » next to « mise à prix » does not deny the price.
CLAUSE_SPLIT = re.compile(r"[,;:()]\s*|\s+[–—-]\s+")
_PARTICIPLES = (
    r"(?:précisée?s?|communiquée?s?|renseignée?s?|indiquée?s?|mentionnée?s?|fournie?s?|connue?s?|"
    r"disponibles?|spécifiée?s?|détaillée?s?|documentée?s?|établie?s?)"
)
ABSENCE = re.compile(
    r"\baucune?s?\s+(?:\w+\s+)?(?:information|indication|précision|donnée|mention|élément|détail)s?\b"
    r"|\bpas\s+d['’]\s*(?:information|indication|précision|donnée|élément)s?\b"
    rf"|\bnon\s+{_PARTICIPLES}"
    rf"|\b(?:n['’]|ne\s+)(?:est|sont|a|ont|figure|figurent|semble|semblent)?\s*(?:pas|jamais|guère)\s+(?:été\s+)?{_PARTICIPLES}"
    r"|\binconnue?s?\b"
    r"|\b(?:est|sont|reste|restent|demeure|demeurent|serait|seraient)\s+(?:encore\s+)?"
    r"(?:à\s+(?:confirmer|vérifier|préciser|clarifier|déterminer)|inconnue?s?|incertaine?s?)\b"
    r"|\bà\s+confirmer\b"
    r"|\bne\s+(?:précise|précisent|mentionne|mentionnent|indique|indiquent|fournit|fournissent|donne|donnent|"
    r"comporte|comportent)\s+(?:pas|aucune?)\b",
    re.I,
)
ABSENCE_TOPICS = {
    "surface": re.compile(r"surface|superficie|métrage|contenance|carrez|habitable|\bm²|\bm2\b", re.I),
    "date": re.compile(r"\bdates?\b(?!\s+de\s+visites?)|\baudience\b|\bcalendrier\b|\bjour de la vente\b", re.I),
    "price": re.compile(r"mises?\s+à\s+prix|\bprix\b|\bmontant\b|premi[èe]re\s+offre|1[èe]re\s+offre", re.I),
    "rooms": re.compile(r"\bpièces?\b", re.I),
    "bedrooms": re.compile(r"\bchambres?\b", re.I),
    "occupancy": re.compile(r"\boccupation\b|\boccupée?s?\b", re.I),
    "energy": re.compile(r"\bDPE\b|\bGES\b|performance\s+énergétique", re.I),
}
JUDICIAL_TERMS = re.compile(
    r"\bjudiciaires?\b|\btribuna(?:l|ux)\b|\bjuge\s+de\s+l['’]\s*ex[ée]cution\b|\bà\s+la\s+barre\b"
    r"|\bsaisie\s+immobili[èe]re\b",
    re.I,
)
STARTING_PRICE_TERM = re.compile(r"\bmises?\s+à\s+prix\b", re.I)
NEGATION_BEFORE = re.compile(
    r"(?:\bnon|\bpas|\bhors|\baucune?|\bsans|\bni|\blibres?\s+de)[\s-]+(?:[\w'’]+[\s-]+){0,3}$", re.I
)
TENANT_TERMS = re.compile(r"\blocataires?\b|\bbail\b|\bbaux\b|\blou[ée]e?s?\b|\bloyers?\b|\blocation\b", re.I)
OWNER_CLAIM = re.compile(r"\bpropri[ée]taires?\b", re.I)
OCCUPANCY_CONTEXT = re.compile(r"\boccup\w*|\bhabit[ée]\w*|\br[ée]sid\w*", re.I)
OWNER_EVIDENCE = re.compile(
    r"\bpropri[ée]taires?[\s-]+occupants?\b"
    r"|\b(?:occup|habit)\w*\s+par\s+(?:le|la|les|son|sa|ses|leurs?)\s+(?:\w+\s+)?propri[ée]taires?\b",
    re.I,
)
FILLER = {
    "procedure_lawyer": re.compile(
        r"\bminist[èe]re\s+d['’]\s*avocat\b|\bavocat\s+inscrit\b|\bpar\s+l['’]\s*interm[ée]diaire\s+d['’]\s*un\s+avocat\b"
        r"|\b(?:ench[èe]res?|ench[ée]rir|offres?)\b[^.]{0,50}\bavocat\b|\bavocat\s+(?:obligatoire|est\s+obligatoire)\b",
        re.I,
    ),
    "procedure_fees": re.compile(
        r"\bfrais\s+(?:pr[ée]alables|de\s+poursuites?|taxés|de\s+proc[ée]dure|d['’]\s*adjudication)\b|\bémoluments\b",
        re.I,
    ),
    "procedure_deposit": re.compile(r"\bconsignation\b|\bch[èe]que\s+de\s+banque\b|\bcaution\s+bancaire\b", re.I),
    "procedure_overbid": re.compile(r"\bsurench[èe]res?\b", re.I),
    "source_reliability": re.compile(
        r"\bannonce\s+non\s+officielle\b|\bnon\s+certifi[ée]e?s?\b|\bn['’]est\s+pas\s+certifi[ée]"
        r"|\bfiabilit[ée]\b|\bà\s+titre\s+indicatif\b|\bsans\s+garantie\b"
        r"|\babsence\s+de\s+(?:plans?|photos?|photographies|visite\s+virtuelle|documents?)\b",
        re.I,
    ),
    "advice": re.compile(
        r"\bse\s+rapprocher\b|\bil\s+(?:est|serait)\s+(?:recommand[ée]|conseill[ée]|prudent|utile|judicieux|n[ée]cessaire)\b"
        r"|\bil\s+convient\s+de\b|\bnous\s+(?:recommandons|conseillons)\b|\bprendre\s+contact\b"
        r"|\b(?:consulter|v[ée]rifier)\s+aupr[èe]s\b|\bs['’]\s*adresser\s+[àa]\b",
        re.I,
    ),
    "contact_name": re.compile(r"\b(?:Ma[îi]tre|Me)\s+[A-ZÀ-Ý][\w'’-]+", re.U),
}


def _model_prose(text: str) -> str:
    return QUOTED_SOURCE.sub(" ", text or "")


def _sentences(text: str) -> list[str]:
    return [sentence for sentence in SENTENCE_SPLIT.split(text) if sentence.strip()]


def _affirmative(pattern: re.Pattern[str], text: str) -> list[re.Match[str]]:
    """Matches that are not negated (« non judiciaire », « sans bail »)."""
    return [
        match
        for match in pattern.finditer(text)
        if not NEGATION_BEFORE.search(text[max(0, match.start() - 30) : match.start()])
    ]


def _known_topics(fields: dict[str, Any]) -> set[str]:
    known: set[str] = set()
    if any(
        fields.get(key) is not None
        for key in (
            "surface_m2",
            "app_surface_m2",
            "habitable_surface_m2",
            "carrez_surface_m2",
            "land_surface_m2",
        )
    ):
        known.add("surface")
    if fields.get("sale_date"):
        known.add("date")
    if known_offer_amounts(fields):
        known.add("price")
    if fields.get("rooms_count"):
        known.add("rooms")
    if fields.get("bedrooms_count"):
        known.add("bedrooms")
    if fields.get("occupancy_status") not in (None, "", "unknown"):
        known.add("occupancy")
    if any(energy_classes(fields)):
        known.add("energy")
    return known


def absence_issues(prose: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    known = _known_topics(fields)
    issues = []
    for sentence in _sentences(prose):
        denied = sorted(
            {
                topic
                for clause in CLAUSE_SPLIT.split(sentence)
                if ABSENCE.search(clause)
                for topic, pattern in ABSENCE_TOPICS.items()
                if topic in known and pattern.search(clause)
            }
        )
        if denied:
            issues.append({"code": "absence_claim_contradicted", "claim": sentence.strip(), "fields": ",".join(denied)})
    return issues


def procedure_issues(prose: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    nature = sale_nature(fields)
    issues = []
    if not nature.judicial_terms_allowed:
        issues.extend(
            {"code": "procedure_mismatch", "claim": match.group(), "sale_nature": nature.code}
            for match in _affirmative(JUDICIAL_TERMS, prose)
        )
    if not nature.starting_price_term_allowed:
        issues.extend(
            {"code": "procedure_mismatch", "claim": match.group(), "sale_nature": nature.code}
            for match in STARTING_PRICE_TERM.finditer(prose)
        )
    return issues


def occupancy_qualifier_issues(prose: str, evidence: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    status = fields.get("occupancy_status")
    issues = []
    if status != "rented" and not _affirmative(TENANT_TERMS, evidence):
        issues.extend(
            {"code": "occupancy_qualifier_unsupported", "claim": match.group()}
            for match in _affirmative(TENANT_TERMS, prose)
        )
    if status != "owner_occupied" and not OWNER_EVIDENCE.search(evidence):
        for sentence in _sentences(prose):
            if OCCUPANCY_CONTEXT.search(sentence):
                issues.extend(
                    {"code": "occupancy_qualifier_unsupported", "claim": match.group()}
                    for match in _affirmative(OWNER_CLAIM, sentence)
                )
    return issues


def filler_issues(prose: str) -> list[dict[str, str]]:
    return [
        {"code": "filler_claim", "claim": match.group(), "category": category}
        for category, pattern in FILLER.items()
        for match in pattern.finditer(prose)
    ]


def semantic_display_issues(text: str, evidence: str, fields: dict[str, Any]) -> list[dict[str, str]]:
    prose = _model_prose(text)
    return [
        *absence_issues(prose, fields),
        *procedure_issues(prose, fields),
        *occupancy_qualifier_issues(prose, evidence or "", fields),
        *filler_issues(prose),
    ]
