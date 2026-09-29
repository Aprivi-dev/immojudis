"""Refresh an operational-only source revision without reusing old prose."""
from __future__ import annotations

import re
from typing import Any

from src.config import load_settings
from src.enrichment.display_quality import DISPLAY_MIN_CHARS, DISPLAY_QUALITY_VERSION, preserve_source_constraints
from src.enrichment.extract_structured import (
    DISPLAY_DESCRIPTION_MAX_CHARS,
    DISPLAY_DESCRIPTION_MAX_WORDS,
    PROPERTY_TYPE_DISPLAY_LABELS,
    LLMExtraction,
    _fallback_asset_details,
    _fallback_location,
    _fallback_occupation,
    extract_source_description,
    has_current_fact_analysis,
)
from src.models import AuctionSale

_OPERATIONAL_QUOTE_RE = re.compile(
    r"(?:"
    # Keep the original operational guards. These terms can carry a changed
    # schedule without exposing a numeric date (for example "visite lundi"
    # or "vente reportée").
    r"\bmise\s+[àa]\s+prix\b"
    r"|\badjudication\b"
    r"|\baudience\b"
    r"|\bvente\s+(?:le|du)\b"
    r"|\bvisite\b"
    # Keep this unbounded as in the legacy guard so both "reporté" and
    # "reportée" are rejected.
    r"|\breport[ée]"
    # Relative calendar dates without a year are still schedule facts.
    r"|\b(?:premier|1er|1|[2-9]|[12]\d|3[01])\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|"
    r"septembre|octobre|novembre|décembre|decembre)\b"
    # Dates in French prose or numeric form. A source quotation carrying a
    # date must be regenerated after an operational revision; preserving the
    # sentence would preserve the old schedule even when the surrounding
    # constraint itself is still current.
    r"|\b\d{1,2}\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|"
    r"septembre|octobre|novembre|décembre|decembre)\s+\d{4}\b"
    r"|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"
    r"|\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b"
    # Currency values are operational facts even when the sentence omits the
    # words “mise à prix” or “adjudication”.
    r"|\b\d[\d\s.,]*\s*(?:€|euros?|eur)(?=\b|[\s.,;:!?)]|$)"
    # Some source notices state a numeric price without a currency suffix.
    r"|\b(?:prix|montant|valeur)\b[^.!?\n]{0,80}\b\d[\d\s.,]{2,}\b"
    # Written amounts are operational facts too (e.g. "cent mille euros").
    r"|\b(?:zéro|zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|"
    r"quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|"
    r"soixante|quatre-vingt(?:s)?|cent(?:s)?|mille|million(?:s)?|milliard(?:s)?)(?:[\s-]+"
    r"(?:zéro|zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|"
    r"quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|"
    r"soixante|quatre-vingt(?:s)?|cent(?:s)?|mille|million(?:s)?|milliard(?:s)?)){0,8}\s+"
    r"(?:€|euros?|eur)\b"
    r")",
    re.IGNORECASE,
)


def _quote_contains_operational_reference(quote: str) -> bool:
    return bool(_OPERATIONAL_QUOTE_RE.search(quote))


def refresh_operational_display(
    sale: AuctionSale,
    *,
    settings: dict[str, Any] | None = None,
) -> bool:
    """Use current structured facts only; fall back to normal validation if unsafe."""
    payload = sale.raw_payload
    if not payload.get("source_operational_changed") or payload.get("operator_land_surface_conflict"):
        return False
    previous = payload.get("superseded_analysis")
    if not isinstance(previous, dict) or previous.get("reason") != "source_operational_changed":
        return False
    if previous.get("operational_refreshable") is not True:
        return False
    # ``source_content_changed`` is also used as the queue-visible flag for an
    # operational change.  A prior documentary invalidation must survive this
    # pass until an evidence-backed enrichment reconciles it.
    if payload.get("source_content_change_reason") != "source_operational_changed":
        return False
    if previous.get("source_content_changed_before") or previous.get("source_content_change_reason_before") not in {
        None,
        "source_operational_changed",
    }:
        return False
    settings = settings or load_settings()
    if any(
        previous.get(previous_key) != str(settings.get(current_key) or "")
        for previous_key, current_key in (
            ("prompt_version", "llm_prompt_version"),
            ("display_prompt_version", "llm_display_prompt_version"),
            ("model", "replicate_model"),
        )
    ):
        # A prompt or model change requires the ordinary enrichment path. The
        # deterministic builder must never certify a prior generation under a
        # different synthesis contract.
        return False
    facts = payload.get("llm_fact_extraction") or {}
    if not isinstance(facts, dict) or any(facts.get(key) for key in (
        "legal_risks", "physical_risks", "servitudes", "occupancy_details", "works_needed",
        "contradictions", "investment_facts",
    )):
        # These qualifiers may exist only in PDFs. A short structured fallback
        # cannot safely omit them or carry over an old financial narrative.
        return False
    if sale.documents and not has_current_fact_analysis(sale, settings=settings):
        # A document-backed sale needs a current, content-addressed fact pass
        # before a deterministic display can be rebuilt. Otherwise the old
        # PDF qualifiers may have disappeared from the retained payload.
        return False
    label = PROPERTY_TYPE_DISPLAY_LABELS.get(sale.property_type or "", "Bien immobilier")
    sentences = [" ".join(filter(None, (label, _fallback_location(sale)))) + "."]
    empty = LLMExtraction()
    details = _fallback_asset_details(sale, empty)
    if details:
        sentences.append("Les éléments disponibles mentionnent " + ", ".join(details) + ".")
    occupation = _fallback_occupation(sale, empty)
    if occupation:
        sentences.append(occupation + ".")
    sentences.append("Consultez les informations actualisées et les documents de vente pour les conditions détaillées.")
    text, quotes = preserve_source_constraints(
        " ".join(sentences), extract_source_description(sale) or payload.get("description"),
        max_chars=DISPLAY_DESCRIPTION_MAX_CHARS, max_words=DISPLAY_DESCRIPTION_MAX_WORDS,
        extra_quotes=payload.get("source_display_constraints"),
    )
    # Operational references inside a required legal quotation need a full
    # reconciliation. Never silently discard a quote or publish an old date.
    if not text or len(text) < DISPLAY_MIN_CHARS or any(
        _quote_contains_operational_reference(quote) for quote in quotes
    ):
        return False
    payload.update(
        llm_display_description=text,
        llm_display_description_word_count=len(text.split()),
        llm_display_status="fallback",
        llm_display_quality_version=DISPLAY_QUALITY_VERSION,
        llm_display_prompt_version=str(settings.get("llm_display_prompt_version") or ""),
        llm_prompt_version=str(settings.get("llm_prompt_version") or ""),
        llm_display_source_constraints=quotes,
        llm_display_origin="operational_refresh",
        llm_display_model=str(settings.get("replicate_model") or ""),
    )
    payload.pop("llm_display_evidence_check", None)
    if payload.get("source_content_change_reason") == "source_operational_changed":
        payload.pop("source_content_changed", None)
        payload.pop("source_content_change_reason", None)
    payload.pop("source_operational_changed", None)
    return True
