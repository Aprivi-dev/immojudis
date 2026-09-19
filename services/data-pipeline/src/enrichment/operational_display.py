"""Refresh an operational-only source revision without reusing old prose."""
from __future__ import annotations

import re

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
)
from src.models import AuctionSale


def refresh_operational_display(sale: AuctionSale) -> bool:
    """Use current structured facts only; fall back to normal validation if unsafe."""
    payload = sale.raw_payload
    if not payload.get("source_operational_changed") or payload.get("operator_land_surface_conflict"):
        return False
    facts = payload.get("llm_fact_extraction") or {}
    if not isinstance(facts, dict) or any(facts.get(key) for key in (
        "legal_risks", "physical_risks", "servitudes", "occupancy_details", "works_needed",
        "contradictions", "investment_facts",
    )):
        # These qualifiers may exist only in PDFs. A short structured fallback
        # cannot safely omit them or carry over an old financial narrative.
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
        re.search(r"mise\s+[àa]\s+prix|adjudication|audience|vente\s+(?:le|du)|visite|report[ée]", quote, re.I)
        for quote in quotes
    ):
        return False
    settings = load_settings()
    payload.update(
        llm_display_description=text,
        llm_display_description_word_count=len(text.split()),
        llm_display_status="fallback",
        llm_display_quality_version=DISPLAY_QUALITY_VERSION,
        llm_display_prompt_version=settings["llm_display_prompt_version"],
        llm_prompt_version=settings["llm_prompt_version"],
        llm_display_source_constraints=quotes,
        llm_display_origin="operational_refresh",
    )
    payload.pop("llm_display_evidence_check", None)
    payload.pop("source_content_changed", None)
    payload.pop("source_operational_changed", None)
    return True
