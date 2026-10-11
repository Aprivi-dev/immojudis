"""Choose the sale-level occupancy among the statements read in the PDF documents.

A conditions-of-sale document repeats standard clauses (« Si l'immeuble est
loué… », « la preuve de l'antériorité du bail… ») that say nothing about this
property, and diagnostic reports use « occupé » for the rooms they could reach.
Only a statement about the property itself may become its occupancy, and the
on-site report outranks the notice, which outranks the conditions of sale.
"""

from __future__ import annotations

import re

from src.normalize import strip_accents

_BOILERPLATE = re.compile(
    r"anteriorite\s+du\s+bail|entree\s+en\s+jouissance|"
    r"\bsi\s+(?:l[' ’]?)?(?:immeuble|bien|lot|vente)\b[^.]{0,60}\b(?:libre|loue|occupe|bail)|"
    r"\b(?:en\s+cas|s['’]il\s+existe)\b[^.]{0,40}\b(?:bail|location|occupation|occupant)|"
    r"surfaces?\s+occupees?\s+par|batiments?\s+occupes?\s+ou\s+frequentes?|"
    r"vendeur\s+ou\s+(?:le\s+)?bailleur|bail\s+a\s+construction|preemption|"
    r"fera\s+son\s+affaire|(?:locataires?|occupants?)\s+(?:eventuels?|a\s+quelque\s+titre)|"
    r"\bloi\s+du\s+\d|\barticle\s+\d",
)
# Lower rank wins: what was seen on site, then the notice, then the sale terms.
_DOCUMENT_RANK = {
    "pv_huissier": 0,
    "proces_verbal": 0,
    "pv_notaire": 0,
    "annonce_vente": 1,
    "bail": 1,
    "cahier_conditions_vente": 2,
    "conditions_vente": 2,
}
_EXCLUDED_DOCUMENT_TYPES = {"diagnostics_techniques", "cadastre"}


def occupancy_statement_is_relevant(candidate: dict[str, object]) -> bool:
    if str(candidate.get("document_type") or "") in _EXCLUDED_DOCUMENT_TYPES:
        return False
    evidence = strip_accents(str(candidate.get("evidence") or "")).lower()
    return not _BOILERPLATE.search(evidence)


def occupancy_statements_agree(candidates: list[dict[str, object]]) -> bool:
    return len({str(item.get("value")) for item in candidates}) == 1


def best_occupancy_statement(candidates: list[dict[str, object]]) -> dict[str, object] | None:
    """The best-ranked statement, or None when the best-ranked documents disagree."""
    if not candidates:
        return None
    rank = min(_DOCUMENT_RANK.get(str(item.get("document_type") or ""), 3) for item in candidates)
    top = [item for item in candidates if _DOCUMENT_RANK.get(str(item.get("document_type") or ""), 3) == rank]
    return top[0] if occupancy_statements_agree(top) else None
