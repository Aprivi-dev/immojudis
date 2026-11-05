"""Tribunal d'une vente judiciaire lu dans ses pièces jointes, quand la page n'en nomme aucun.

Une fiche Avoventes ne donne souvent ni champ « tribunal » ni phrase « Tribunal judiciaire de X », alors que
l'affiche et le cahier des conditions de vente écrivent « Tribunal Judiciaire de BOBIGNY », « TRIBUNAL
JUDICIAIRE DE DRAGUIGNAN (VAR) », « Tribunal Judiciaire d'ALBERTVILLE ». Seul un nom rattaché au référentiel
national des tribunaux (``resolve_court_by_label``) est retenu, jamais le texte brut : une coquille d'OCR
(« Tribunal Judiciaire de DION ») ne se rattache à rien et ne compte pas.

Garde-fous :

* une source dont la page donne déjà un tribunal n'est jamais modifiée ;
* les pièces doivent désigner un seul tribunal ; si elles en citent plusieurs (jugement d'un autre tribunal),
  seules les mentions du lieu de la vente (audience, juge de l'exécution, adjudication, greffe…) départagent,
  sinon rien n'est retenu ;
* le libellé est gardé dans ``raw_payload.pdf_tribunal_extraction`` : ``fill_tribunal`` le relit à chaque
  passage comme un libellé de source, derrière la compétence INSEE vérifiée qui reste prioritaire.
"""

from __future__ import annotations

import re
from typing import Any

from src.court_competence import OfficialCourt, resolve_court_by_label
from src.normalize import clean_text
from src.pdf_fact_scope import _pdf_record_fact_projection
from src.tribunal_labels import _fold

PDF_TRIBUNAL_EXTRACTION_FIELD = "pdf_tribunal_extraction"
# Sources de ventes judiciaires : une vente notariale ou domaniale peut citer un tribunal (ordonnance,
# jugement d'autorisation) qui n'est pas le lieu de la vente.
JUDICIAL_PDF_TRIBUNAL_SOURCES = frozenset(
    {"avoventes", "licitor", "vench", "info_encheres", "encheres_immobilieres", "petites_affiches"}
)
_MENTION = re.compile(
    r"\bTribunal\s+(?:Judiciaire|de\s+grande\s+instance)\s+(?:de\s+(?:la\s+|l['’]\s*)?|du\s+|des\s+|d['’]\s*)"
    r"(?P<name>[A-Za-zÀ-ÿ'’ -]{2,60})",
    re.I,
)
_SALE_VENUE_CONTEXT = re.compile(
    r"audience|adjudication|ench[eè]res?|juge\s+de\s+l['’]?\s*ex[ée]cution|barre|salle|cri[ée]es|greffe|"
    r"cahier\s+des\s+conditions",
    re.I,
)
_MAX_NAME_WORDS = 6


def extract_pdf_tribunal_candidates(pdf_texts: list[dict[str, object]] | list[str]) -> list[dict[str, Any]]:
    """Chaque mention « Tribunal judiciaire de X » des pièces rattachée à un tribunal du référentiel."""
    candidates: list[dict[str, Any]] = []
    for item in pdf_texts:
        text = str(item.get("text") or "") if isinstance(item, dict) else str(item or "")
        url = str(item.get("url") or "") if isinstance(item, dict) else ""
        for match in _MENTION.finditer(text):
            court, label = _resolve_mention(match.group("name"))
            if court is None or label is None:
                continue
            before = text[max(0, match.start() - 160) : match.start()]
            candidates.append({
                "court": court,
                "label": label,
                "sale_venue": bool(_SALE_VENUE_CONTEXT.search(before)),
                "evidence": clean_text(text[max(0, match.start() - 80) : match.end()]) or "",
                "document_url": url,
            })
    return candidates


def _resolve_mention(name: str) -> tuple[OfficialCourt | None, str | None]:
    # « DRAGUIGNAN (VAR) », « FORT DE FRANCE Salle ordinaire », « ALBERTVILLE en un LOT » : le plus long début
    # du texte qui nomme un tribunal du référentiel (« Saint-Denis de la Réunion » avant « Saint-Denis »).
    words = _fold(name.split("(", 1)[0]).split()[:_MAX_NAME_WORDS]
    for size in range(len(words), 0, -1):
        label = f"TJ {' '.join(words[:size])}"
        court = resolve_court_by_label(label)
        if court is not None:
            return court, label
    return None, None


def select_pdf_tribunal(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Le seul tribunal désigné par les pièces (ou par leurs mentions du lieu de vente), sinon ``None``."""
    for pool in (candidates, [item for item in candidates if item["sale_venue"]]):
        codes = {item["court"].court_code for item in pool}
        if len(codes) == 1:
            return next(item for item in pool if item["sale_venue"]) if any(
                item["sale_venue"] for item in pool
            ) else pool[0]
    return None


def apply_pdf_tribunal(sale: Any, pdf_texts: list[dict[str, object]] | list[str]) -> None:
    """Tribunal d'une vente judiciaire sans tribunal sur sa page, tiré d'un nom unique de ses pièces."""
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else None
    if payload is None or sale.source_name not in JUDICIAL_PDF_TRIBUNAL_SOURCES:
        return
    previous = payload.pop(PDF_TRIBUNAL_EXTRACTION_FIELD, None)
    previous_court = previous.get("court_name") if isinstance(previous, dict) else None
    if clean_text(sale.tribunal) and sale.tribunal != previous_court:
        return
    candidates = extract_pdf_tribunal_candidates(pdf_texts)
    chosen = select_pdf_tribunal(candidates)
    if chosen is None:
        return
    court: OfficialCourt = chosen["court"]
    payload[PDF_TRIBUNAL_EXTRACTION_FIELD] = {
        "court_name": court.court_name,
        "court_code": court.court_code,
        "source_label": chosen["label"],
        "evidence": chosen["evidence"],
        "document_url": chosen["document_url"],
        "mentions": len(candidates),
    }
    sale.tribunal = court.court_name
    sale.tribunal_code = court.court_code
    payload["tribunal_label_assignment"] = court.label_evidence(chosen["label"])
    if "tribunal_competence_unverified" not in sale.quality_flags:
        sale.quality_flags.append("tribunal_competence_unverified")
    _pdf_record_fact_projection(
        sale,
        ["tribunal", "tribunal_code"],
        evidence=chosen["evidence"],
        document_url=chosen["document_url"],
        payload_keys=(PDF_TRIBUNAL_EXTRACTION_FIELD,),
    )


def pdf_tribunal_label(raw_payload: object) -> str | None:
    """Libellé de tribunal lu dans les pièces lors d'un passage précédent (relu par ``fill_tribunal``)."""
    extraction = raw_payload.get(PDF_TRIBUNAL_EXTRACTION_FIELD) if isinstance(raw_payload, dict) else None
    return clean_text(extraction.get("court_name")) if isinstance(extraction, dict) else None
