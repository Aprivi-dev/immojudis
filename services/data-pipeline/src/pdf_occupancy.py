"""Choose the sale-level occupancy among the statements read in the PDF documents.

A conditions-of-sale document repeats standard clauses (« Si l'immeuble est
loué… », « la preuve de l'antériorité du bail… ») that say nothing about this
property, and diagnostic reports use « occupé » for the rooms they could reach.
Only a statement about the property itself may become its occupancy
(:mod:`src.occupancy_statements` reads each sentence).

Since 03/11/2026 the documents no longer pick a winner when they disagree: a
free unit and a rented one, a « partiellement occupé », a PV that only says the
house « semble inoccupée », or a page « libre » whose PV says « occupé » give
``unknown`` (« À confirmer ») with the evidence, never a certain status. The
on-site report still decides when it is the only one to hedge.
"""

from __future__ import annotations

from typing import Any

from src.occupancy_statements import (
    CERTAIN_STATUSES,
    MIXED,
    OCCUPIED,
    UNKNOWN,
    VACANT,
    _merge_family,
    is_template_clause,
    read_occupancy_statement,
)
from src.pdf_fact_scope import _pdf_record_fact_projection
from src.text_folding import strip_accents

# Lower rank: what was seen on site, then the notice, then the sale terms.
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


def pdf_occupancy_status(text: str) -> str | None:
    """Status of one PDF sentence: certain, ``mixed`` (two statuses) or ``unknown`` (hedged)."""
    reading = read_occupancy_statement(text)
    if reading is None:
        return None
    if reading.status == MIXED:
        return MIXED
    return reading.status if reading.certain else UNKNOWN


def occupancy_statement_is_relevant(candidate: dict[str, object]) -> bool:
    if str(candidate.get("document_type") or "") in _EXCLUDED_DOCUMENT_TYPES:
        return False
    return not is_template_clause(strip_accents(str(candidate.get("evidence") or "")))


def occupancy_statements_agree(candidates: list[dict[str, object]]) -> bool:
    """Same status, or compatible ones (« occupée » and « occupés par le débiteur »)."""
    values = {str(item.get("value")) for item in candidates}
    return len(values) == 1 or (values <= CERTAIN_STATUSES and _merge_family(values) is not None)


def _rank(candidate: dict[str, object]) -> int:
    return _DOCUMENT_RANK.get(str(candidate.get("document_type") or ""), 3)


def best_occupancy_statement(candidates: list[dict[str, object]]) -> dict[str, object] | None:
    """The sale-level statement: agreeing certain statements, else ``unknown`` carrying the evidence."""
    if not candidates:
        return None
    # « Au jour de l'adjudication … le terrain sera libre de toute occupation » : what the buyer gets wins over
    # the convention that still occupies it when the conditions were written (not over a lease).
    if any(_delivered_free(item) for item in candidates):
        candidates = [item for item in candidates if item.get("value") != OCCUPIED]
    certain = [item for item in candidates if item.get("value") in CERTAIN_STATUSES]
    top_rank = min(_rank(item) for item in candidates)
    top = [item for item in candidates if _rank(item) == top_rank]
    merged = _merge_family({str(item["value"]) for item in certain}) if certain else None
    mixed = [item for item in candidates if item.get("value") == MIXED]
    if merged and not mixed and any(item.get("value") in CERTAIN_STATUSES for item in top):
        best = sorted(certain, key=lambda item: (item.get("value") != merged, _rank(item)))[0]
        return {**best, "value": merged}
    # Contradiction, a mixed sentence, or only hedged wording in the best-ranked document.
    evidence = " | ".join(str(item.get("evidence") or "")[:200] for item in (mixed or top or candidates)[:3])
    return {**sorted(mixed or top, key=_rank)[0], "value": UNKNOWN, "evidence": evidence}


def _delivered_free(candidate: dict[str, object]) -> bool:
    reading = read_occupancy_statement(str(candidate.get("evidence") or ""))
    return candidate.get("value") == VACANT and reading is not None and reading.at_sale


def apply_pdf_occupancy(sale: Any, candidates: list[dict[str, object]], *, ambiguous: bool) -> None:
    """Project the documents' occupancy, or neutralise a page status they contradict."""
    statement = None if ambiguous else best_occupancy_statement(candidates)
    if statement is None:
        return
    current = getattr(sale, "occupancy_status", None)
    value = str(statement["value"])
    if current in (None, "", UNKNOWN):
        projected = value
    elif current not in CERTAIN_STATUSES:
        return
    elif value == UNKNOWN:
        projected = UNKNOWN  # the page says it plainly, the documents hedge or disagree
    else:
        projected = _merge_family({current, value}) or UNKNOWN
    if projected == current:
        return
    evidence = str(statement.get("evidence") or "")
    if current in CERTAIN_STATUSES:
        evidence = f"Page source : {current} ; pièces : {evidence}"
    sale.occupancy_status = projected
    _pdf_record_fact_projection(
        sale,
        ["occupancy_status"],
        evidence=evidence,
        document_url=str(statement.get("document_url") or ""),
        page_number=statement.get("page_number"),
        **({"baseline": current} if current else {}),
    )
