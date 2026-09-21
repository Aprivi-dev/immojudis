from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

from src.config import LLM_EXTRACTIONS_DIR, PDF_TEXTS_DIR, load_settings
from src.enrichment.display_evidence import verify_display_claims
from src.enrichment.display_quality import DISPLAY_MIN_CHARS, DISPLAY_QUALITY_VERSION, preserve_source_constraints
from src.enrichment.llm_client import ReplicateClient, create_llm_client, repair_json_payload
from src.enrichment.prompts import (
    DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_display_description_prompt,
    build_user_prompt,
)
from src.enrichment.surface_reasoning import (
    SURFACE_REASONING_VERSION,
    ExtractedAsset,
    apply_surface_reasoning_to_sale,
    extract_surface_facts_from_text,
    merge_extracted_assets,
)
from src.llm_cache import load_cached_result, save_cached_result
from src.llm_requests import llm_request_context
from src.models import AuctionSale
from src.normalize import clean_text, extract_bedrooms_count_from_text, extract_rooms_count_from_text
from src.pdf_enrichment import sale_storage_id
from src.pipeline_usage import PINNED_MODEL, PipelineBudgetExhausted

LOGGER = logging.getLogger(__name__)
LLM_CONTEXT_KEYWORDS = (
    "surface",
    "superficie",
    "contenance",
    "occupation",
    "occupé",
    "occupe",
    "libre",
    "bail",
    "locataire",
    "copropriété",
    "copropriete",
    "servitude",
    "diagnostics",
    "diagnostic",
    "amiante",
    "plomb",
    "termites",
    "dpe",
    "travaux",
    "désignation",
    "designation",
    "lots",
    "mise à prix",
    "mise a prix",
    "pièce",
    "pièces",
    "piece",
    "pieces",
    "composition",
    "comprenant",
    "comprend",
    "composé",
    "compose",
    "se compose",
    "distribution",
    "désignation",
    "designation",
    "rez-de-chaussée",
    "rez de chaussée",
    "etage",
    "étage",
    "séjour",
    "sejour",
    "salon",
    "salle à manger",
    "salle a manger",
    "pièce principale",
    "piece principale",
    "type deux",
    "type trois",
    "type quatre",
    "type cinq",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "chambre",
    "chambres",
    "studio",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
)
PRIORITY_DOCUMENT_TYPES = {
    "pv_descriptif",
    "pv_huissier",
    "pv_notaire",
    "proces_verbal",
    "diagnostics_techniques",
    "cahier_conditions",
    "cahier_conditions_vente",
    "conditions_vente",
    "annonce_vente",
}
PRIORITY_LABEL_PATTERNS = re.compile(
    r"pv|pvd|descriptif|cahier|conditions\s+de\s+vente|ccv",
    re.I,
)
PDF_TEXT_ENRICHMENT_MARKER = "--- PDF TEXT ENRICHMENT ---"
SOURCE_DESCRIPTION_KEYS = (
    "source_description",
    "description",
    "descriptif",
    "designation",
    "désignation",
    "renseignements_de_vente",
    "criteres_resume",
    "complement",
    "body",
)
SOURCE_DESCRIPTION_EXCLUDED_KEYS = {
    "documents",
    "page_text",
    "raw_text",
    "contact",
    "contact_avocat",
    "avocat",
    "lawyer",
    "source_images",
}
UNUSABLE_SOURCE_DESCRIPTION_RE = re.compile(
    r"abonn[ée]|connectez-vous|connexion|int[ée]gralit[ée]\s+des\s+informations|"
    r"pour\s+consulter\s+l['’]int[ée]gralit[ée]|vous\s+devez\s+[êe]tre\s+abonn[ée]",
    re.I,
)
DISPLAY_DESCRIPTION_MAX_WORDS = 125
DISPLAY_DESCRIPTION_MAX_CHARS = 850
DISPLAY_DESCRIPTION_MIN_CONFIDENCE = 0.55
FACT_FAILURE_STAGE = "facts_failure"
FACT_FAILURE_RETRY_HOURS = 24
_MISSING = object()
PROPERTY_TYPE_DISPLAY_LABELS = {
    "apartment": "Appartement",
    "house": "Maison",
    "building": "Immeuble",
    "land": "Terrain",
    "commercial": "Local commercial",
    "parking": "Stationnement",
    "mixed": "Bien mixte",
    "other": "Bien immobilier",
    "unknown": "Bien immobilier",
}
OCCUPANCY_DISPLAY_LABELS = {
    "vacant": "libre",
    "occupied": "occupé",
    "rented": "loué",
    "owner_occupied": "occupé par le propriétaire",
    "squatted": "squatté",
    "unknown": "à vérifier",
}

PropertyType = Literal[
    "apartment",
    "house",
    "building",
    "land",
    "commercial",
    "parking",
    "mixed",
    "other",
    "unknown",
]
OccupancyStatus = Literal["vacant", "occupied", "rented", "owner_occupied", "squatted", "unknown"]


class LLMExtraction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    property_type: PropertyType | None = None
    display_description: str | None = None
    surface_m2: float | None = None
    assets: list[ExtractedAsset] = Field(default_factory=list)
    rooms_count: int | None = None
    bedrooms_count: int | None = None
    occupancy_status: OccupancyStatus | None = None
    occupancy_details: str | None = None
    legal_risks: list[str] = Field(default_factory=list)
    physical_risks: list[str] = Field(default_factory=list)
    copropriete: bool | None = None
    servitudes: list[str] = Field(default_factory=list)
    works_needed: str | None = None
    summary: str | None = None
    investor_notes: str | None = None
    confidence: dict[str, float] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    investment_facts: list[dict[str, Any]] = Field(default_factory=list)
    contradictions: list[dict[str, Any]] = Field(default_factory=list)
    analysis_questions: list[dict[str, Any]] = Field(default_factory=list)
    scoring_guidance: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("property_type", mode="before")
    @classmethod
    def normalize_property_type(cls, value: Any) -> Any:
        if isinstance(value, str) and value.lower() in {"", "null", "none"}:
            return None
        if isinstance(value, str):
            aliases = {
                "appartement": "apartment",
                "maison": "house",
                "villa": "house",
                "immeuble": "building",
                "terrain": "land",
                "local": "commercial",
                "local commercial": "commercial",
                "parking": "parking",
                "stationnement": "parking",
                "mixte": "mixed",
                "bien mixte": "mixed",
                "autre": "other",
            }
            normalized = aliases.get(value.lower().strip(), value.lower().strip())
            return normalized if normalized in set(PropertyType.__args__) else None
        if value is not None and not isinstance(value, str):
            return None
        return value

    @field_validator("occupancy_status", mode="before")
    @classmethod
    def normalize_occupancy_status(cls, value: Any) -> Any:
        if isinstance(value, str):
            lowered = value.lower().strip()
            if lowered in {"", "null", "none"}:
                return None
            aliases = {
                "free": "vacant",
                "libre": "vacant",
                "vacant": "vacant",
                "inoccupé": "vacant",
                "inoccupe": "vacant",
                "occupied": "occupied",
                "loué": "rented",
                "loue": "rented",
                "leased": "rented",
                "tenant": "rented",
                "locataire": "rented",
                "rented": "rented",
                "occupé": "occupied",
                "occupe": "occupied",
                "owner occupied": "owner_occupied",
                "owner_occupied": "owner_occupied",
                "propriétaire occupant": "owner_occupied",
                "proprietaire occupant": "owner_occupied",
                "squatted": "squatted",
                "squatté": "squatted",
                "squatte": "squatted",
            }
            return aliases.get(lowered, lowered if lowered == "unknown" else None)
        if value is not None and not isinstance(value, str):
            return None
        return value

    @field_validator("surface_m2", mode="before")
    @classmethod
    def normalize_optional_surface(cls, value: Any) -> Any:
        return repair_json_payload({"surface_m2": value}).get("surface_m2")

    @field_validator("rooms_count", "bedrooms_count", mode="before")
    @classmethod
    def normalize_positive_count(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, bool):
            return None
        if isinstance(value, str):
            if value.lower() in {"", "null", "none", "unknown", "inconnu"}:
                return None
            match = re.search(r"[1-9][0-9]?", value)
            return int(match.group(0)) if match else None
        if isinstance(value, (int, float)):
            rooms = int(value)
            return rooms if rooms > 0 else None
        return None

    @field_validator("confidence", mode="before")
    @classmethod
    def normalize_confidence_payload(cls, value: Any) -> dict[str, float]:
        repaired = repair_json_payload({"confidence": value}).get("confidence")
        return repaired if isinstance(repaired, dict) else {}

    @field_validator("confidence")
    @classmethod
    def clamp_confidence(cls, value: dict[str, float] | None) -> dict[str, float]:
        if not value:
            return {}
        normalized: dict[str, float] = {}
        for key, score in value.items():
            try:
                normalized[key] = max(0.0, min(1.0, float(score)))
            except (TypeError, ValueError):
                continue
        return normalized

    @field_validator("evidence", mode="before")
    @classmethod
    def normalize_evidence(cls, value: Any) -> dict[str, Any]:
        repaired = repair_json_payload(value)
        return repaired if isinstance(repaired, dict) else {}

    @field_validator("investment_facts", "contradictions", "analysis_questions", "scoring_guidance", mode="before")
    @classmethod
    def normalize_due_diligence_lists(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]

    @field_validator("assets", mode="before")
    @classmethod
    def normalize_assets(cls, value: Any) -> list[dict[str, Any]]:
        return _repair_asset_payloads(value)

    @field_validator("legal_risks", "physical_risks", "servitudes", mode="before")
    @classmethod
    def default_empty_lists(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, list):
            return [_stringify_llm_value(item) for item in value if _stringify_llm_value(item)]
        return [_stringify_llm_value(value)]

    @field_validator("display_description", "works_needed", "occupancy_details", "summary", "investor_notes", mode="before")
    @classmethod
    def stringify_text_fields(cls, value: Any) -> Any:
        return _stringify_llm_value(value)

    @field_validator("copropriete", mode="before")
    @classmethod
    def normalize_copropriete(cls, value: Any) -> Any:
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, str):
            lowered = value.lower()
            if lowered in {"true", "oui", "yes"}:
                return True
            if lowered in {"false", "non", "no", "unknown", "inconnu", ""}:
                return False if lowered in {"false", "non", "no"} else None
        return None


def _repair_asset_payloads(value: Any) -> list[dict[str, Any]]:
    """Salvage valid assets and measurements without weakening their schema.

    One malformed measurement must not invalidate all the other measurements
    returned in the same model response.  Required measurement values and
    labels are the only reasons to discard an item; optional malformed numbers
    are converted to ``None`` by the shared JSON repair layer.
    """

    if not isinstance(value, list):
        return []
    assets: list[dict[str, Any]] = []
    for raw_asset in value:
        if not isinstance(raw_asset, dict):
            continue
        raw_spaces = raw_asset.get("spaces")
        asset = repair_json_payload(raw_asset)
        if not isinstance(asset, dict):
            continue
        if asset.get("asset_id") is None:
            asset["asset_id"] = "asset-main"
        completeness = str(asset.get("measurement_completeness") or "unknown").lower()
        if completeness not in {"complete", "likely_complete", "partial", "unknown"}:
            asset["measurement_completeness"] = "unknown"
        repaired_spaces = _repair_surface_items(
            asset.get("spaces"),
            candidate=False,
            asset_id=str(asset.get("asset_id") or "asset-main"),
        )
        asset["spaces"] = repaired_spaces
        if (
            isinstance(raw_spaces, list)
            and len(repaired_spaces) < len(raw_spaces)
            and completeness in {"complete", "likely_complete"}
        ):
            # The model claimed exhaustive coverage but at least one room
            # measurement was unusable. Keep the valid rooms, while ensuring
            # their sum can only be classified as partial downstream.
            asset["measurement_completeness"] = "partial"
        asset["explicit_surfaces"] = _repair_surface_items(
            asset.get("explicit_surfaces"),
            candidate=True,
            asset_id=str(asset.get("asset_id") or "asset-main"),
        )
        assets.append(asset)
    return assets


def _repair_surface_items(
    value: Any,
    *,
    candidate: bool,
    asset_id: str,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    repaired_items: list[dict[str, Any]] = []
    for raw_item in value:
        if not isinstance(raw_item, dict):
            continue
        item = repair_json_payload(raw_item)
        if not isinstance(item, dict):
            continue
        value_m2 = item.get("value_m2")
        maximum_m2 = 1_000_000 if candidate else 10_000
        if (
            not isinstance(value_m2, (int, float))
            or isinstance(value_m2, bool)
            or not 0 < float(value_m2) <= maximum_m2
        ):
            # A measurement without a numeric value cannot be used for a
            # surface calculation. Values outside the strict downstream
            # schema are equally unusable; discard only this item, not its
            # asset or its other valid measurements.
            continue
        item.setdefault("asset_id", asset_id)
        if item.get("asset_id") is None:
            item["asset_id"] = asset_id
        if not candidate:
            if not clean_text(item.get("space_label")):
                continue
            item["space_label"] = clean_text(item.get("space_label"))
            item.setdefault("extraction_method", "llm")
            if item.get("extraction_method") is None:
                item["extraction_method"] = "llm"
            category = str(item.get("category") or "unknown").lower()
            if category not in {"habitable", "circulation", "sanitary", "service", "annex", "exterior", "land", "unknown"}:
                item["category"] = "unknown"
        else:
            if item.get("unit_as_written") is None:
                item["unit_as_written"] = "m2"
            kind = str(item.get("kind") or "unknown").lower()
            if kind not in {
                "explicit_carrez",
                "explicit_habitable",
                "explicit_total",
                "explicit_built",
                "calculated_room_sum",
                "calculated_sale_sum",
                "land",
                "annex",
                "unknown",
            }:
                item["kind"] = "unknown"
            scope = str(item.get("scope") or "unknown").lower()
            if scope not in {"sale", "asset", "lot", "level", "partial", "unknown"}:
                item["scope"] = "unknown"
        evidence = item.get("evidence")
        item["evidence"] = evidence if isinstance(evidence, dict) else {}
        repaired_items.append(item)
    return repaired_items


@dataclass
class LLMEnrichmentStats:
    analyzed: int = 0
    valid_json: int = 0
    errors: int = 0
    surface_extracted: int = 0
    surface_detected: int = 0
    rooms_extracted: int = 0
    rooms_detected: int = 0
    bedrooms_extracted: int = 0
    bedrooms_detected: int = 0
    occupancy_extracted: int = 0
    occupancy_detected: int = 0
    risks_detected: int = 0
    fact_chunks_analyzed: int = 0
    structured_surface_verified: int = 0
    calculated_surface_verified: int = 0
    unavailable: bool = False
    deferred: bool = False
    progress_made: bool = False
    error_messages: list[str] = field(default_factory=list)


class LLMEnrichmentDeferred(PipelineBudgetExhausted):
    """A bounded enrichment pass made progress and should be retried soon.

    This is deliberately a ``PipelineBudgetExhausted`` subclass so queue
    workers can release the lease without consuming a retry attempt.  A
    progressive pass is not a failed extraction: its checkpoints are valid,
    but the public result must wait for the remaining chunks.
    """

    def __init__(
        self,
        message: str,
        *,
        stats: LLMEnrichmentStats | None = None,
        retry_after: datetime | None = None,
    ) -> None:
        super().__init__(message)
        self.next_attempt_at = retry_after or (datetime.now(UTC) + timedelta(minutes=5))
        self.progress_made = True
        self.stats = stats


def enrich_sale_with_llm(
    sale: AuctionSale,
    client: ReplicateClient | None = None,
    output_dir: Path = LLM_EXTRACTIONS_DIR,
    extraction_mode: str | None = None,
) -> LLMEnrichmentStats:
    stats = LLMEnrichmentStats()
    settings = load_settings()
    if not settings["llm_enabled"]:
        return stats

    source_description = extract_source_description(sale)
    if source_description:
        sale.raw_payload["source_description"] = source_description
    else:
        sale.raw_payload.pop("source_description", None)

    extraction_mode = extraction_mode or str(settings.get("llm_extraction_mode") or "display_description")
    if extraction_mode == "display_description":
        contexts = [load_llm_context_for_sale(sale, max_chars=int(settings["llm_pdf_max_chars"]))]
    else:
        if sale.documents and not _has_pdf_fact_cache(sale):
            stats.errors += 1
            stats.error_messages.append("Fact extraction deferred: PDF text cache is missing or incomplete")
            return stats
        # Always inspect the complete input set.  ``llm_fact_max_chunks`` is a
        # paid-call budget for this invocation, not a coverage limit.  The
        # planner below skips cached chunks and spends the budget on the next
        # uncached chunks, so later passes can make forward progress.
        contexts = load_llm_fact_context_chunks_for_sale(
            sale,
            chunk_chars=int(settings.get("llm_fact_chunk_chars") or 12000),
            max_chunks=0,
        )
    fact_contexts = [context for context in contexts if context]
    if not fact_contexts:
        return stats

    client = client or create_llm_client()
    model_name = str(getattr(client, "model", "") or settings.get("replicate_model") or "")
    prompt_version = str(settings["llm_prompt_version"])
    incremental = bool(settings.get("incremental_enrichment"))

    # Display synthesis is a separate stage.  Its key contains only the exact
    # display context, model and display prompt/quality versions, so a facts
    # cache hit never masquerades as a display cache hit (and vice versa).
    if extraction_mode == "display_description":
        display_context = "\n\n".join(fact_contexts)
        retained_facts = _validated_extraction_payload(sale.raw_payload.get("llm_fact_extraction"))
        if retained_facts is not None and has_current_fact_analysis(sale):
            # A fresh runner may have lost the local PDF text while validated
            # facts remain current in the database. Keep documentary risks and
            # occupation qualifiers in the synthesis without paying for facts
            # again. This builder omits prior narrative/financial summaries and
            # supplies the current sale price/date explicitly.
            display_context = _build_validated_display_context(
                sale, retained_facts, fallback_context=display_context,
            )
        display_prompt_version = str(settings.get("llm_display_prompt_version") or prompt_version)
        display_key = _display_cache_key(display_context, model_name, display_prompt_version)
        display_extraction = (
            _load_display_cache(display_key, output_dir, model_name, incremental)
            if incremental
            else None
        )
        if display_extraction is not None:
            stats.analyzed = 1
            stats.valid_json = 1
            _apply_extraction_to_sale(
                sale,
                display_extraction,
                stats,
                display_context,
                prompt_version=prompt_version,
            )
            sale.raw_payload["llm_extraction"] = display_extraction.model_dump(mode="json")
            sale.raw_payload["llm_cache_hit"] = True
            return stats
        if not client.is_available():
            stats.unavailable = True
            return stats
        stats.analyzed = 1
        try:
            with _llm_request_context(sale, stage="display", reason="cache_miss"):
                raw = client.generate_json(
                    DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
                    build_display_description_prompt(display_context),
                )
            extraction = _validated_llm_extraction(raw)
            sale.raw_payload["llm_display_prompt_version"] = display_prompt_version
            if not _normalize_display_description(extraction.display_description):
                stats.errors += 1
                stats.error_messages.append("Model returned an empty display description; derived fallback only")
            elif incremental:
                _save_display_cache(display_key, extraction, output_dir, model_name)
        except PipelineBudgetExhausted:
            raise
        except Exception as exc:
            LOGGER.warning("LLM display synthesis failed for %s: %s", sale.source_url, exc)
            stats.errors += 1
            stats.error_messages.append(_llm_error_message(sale, exc))
            return stats

        stats.valid_json += 1
        _apply_extraction_to_sale(sale, extraction, stats, display_context, prompt_version=prompt_version)
        if not stats.errors:
            _save_extraction(
                sale,
                extraction,
                output_dir,
                cache_key=display_key,
                model=model_name,
                prompt_version=display_prompt_version,
            )
        sale.raw_payload["llm_extraction"] = extraction.model_dump(mode="json")
        sale.raw_payload["llm_cache_hit"] = False
        if stats.errors:
            sale.raw_payload.pop("llm_prompt_version", None)
        return stats

    context_coverage = sale.raw_payload.get("llm_fact_context_coverage") or {}
    context_complete = context_coverage.get("complete") is not False
    if not context_complete:
        stats.errors += 1
        stats.error_messages.append("Fact context truncated by the configured chunk budget")
    full_evidence_context = "\n\n".join(fact_contexts)
    fact_prompt_version = str(settings.get("llm_fact_prompt_version") or prompt_version)
    fact_input_key = _fact_input_cache_key(full_evidence_context, model_name, fact_prompt_version)
    legacy_entry = (
        _load_legacy_extraction(
            sale,
            output_dir,
            full_evidence_context,
            model_name,
            extraction_mode,
            prompt_version,
            fact_prompt_version,
        )
        if incremental and context_complete
        else None
    )
    chunk_extractions_by_index: dict[int, LLMExtraction] = {}
    pending_chunks: list[tuple[int, str, str, Path]] = []
    cache_hits = len(fact_contexts) if legacy_entry is not None else 0

    # Read every checkpoint before applying this pass's paid-call budget.  A
    # cached first page therefore cannot consume the budget intended for the
    # next uncached page.
    if legacy_entry is None:
        for index, context in enumerate(fact_contexts, start=1):
            chunk_key = _fact_chunk_cache_key(context, model_name, fact_prompt_version)
            chunk_path = output_dir / "chunks" / f"{chunk_key}.json"
            chunk = (
                _load_fact_chunk(chunk_key, chunk_path, output_dir, model_name, incremental)
                if incremental
                else None
            )
            if chunk is None:
                pending_chunks.append((index, context, chunk_key, chunk_path))
            else:
                cache_hits += 1
                chunk_extractions_by_index[index] = chunk
                stats.fact_chunks_analyzed += 1
    else:
        stats.fact_chunks_analyzed = len(fact_contexts)

    # A progressive budget is meaningful only when checkpoints are enabled;
    # with incremental enrichment disabled, process the complete input in one
    # pass instead of repeatedly paying for the same first window.
    max_new_chunks = max(0, int(settings.get("llm_fact_max_chunks") or 0)) if incremental else 0
    selected_pending = pending_chunks if max_new_chunks == 0 else pending_chunks[:max_new_chunks]
    remaining_pending = pending_chunks[len(selected_pending):]
    stats.analyzed = 1 if (selected_pending or chunk_extractions_by_index or legacy_entry) else 0

    failed_chunks = 0
    newly_cached_chunks = 0
    blocked_failure_retry_after: datetime | None = None
    non_deterministic_failure = False
    for index, context, chunk_key, chunk_path in selected_pending:
        retry_after = _load_fact_failure_retry_after(chunk_key)
        if retry_after is not None:
            failed_chunks += 1
            blocked_failure_retry_after = max(
                blocked_failure_retry_after or retry_after,
                retry_after,
            )
            stats.error_messages.append(
                f"Fact chunk {index}/{len(fact_contexts)} deferred after a deterministic output failure"
            )
            continue
        if not client.is_available():
            stats.unavailable = True
            return stats
        try:
            with _llm_request_context(sale, stage="facts", reason="chunk_cache_miss"):
                raw = client.generate_json(SYSTEM_PROMPT, build_user_prompt(context))
            # An empty but schema-valid object is still a successful analysis.
            # Persisting it prevents the same absence from being paid for on
            # every retry.
            chunk = _validated_llm_extraction(raw)
            _save_fact_chunk(chunk_key, chunk, chunk_path, output_dir, model_name, incremental)
            chunk_extractions_by_index[index] = chunk
            stats.fact_chunks_analyzed += 1
            newly_cached_chunks += 1
            stats.progress_made = True
        except PipelineBudgetExhausted:
            raise
        except Exception as exc:
            failed_chunks += 1
            stats.errors += 1
            stats.error_messages.append(
                f"{_llm_error_message(sale, exc)} [fact chunk {index}/{len(fact_contexts)}]"
            )
            if _is_deterministic_fact_failure(exc):
                _save_fact_failure_marker(chunk_key, model=model_name, error=exc)
            else:
                non_deterministic_failure = True

    chunk_extractions = [legacy_entry[0]] if legacy_entry is not None else [
        chunk_extractions_by_index[index]
        for index in range(1, len(fact_contexts) + 1)
        if index in chunk_extractions_by_index
    ]
    complete = context_complete and failed_chunks == 0 and not remaining_pending
    coverage = {
        "total_chunks": len(fact_contexts),
        "successful_chunks": len(fact_contexts) if legacy_entry is not None else len(chunk_extractions),
        "failed_chunks": failed_chunks,
        "remaining_chunks": len(remaining_pending),
        "complete": complete,
    }
    if blocked_failure_retry_after is not None and not non_deterministic_failure:
        stats.deferred = True
        raise LLMEnrichmentDeferred(
            f"Fact extraction deferred for {failed_chunks} deterministic chunk failure(s)",
            stats=stats,
            retry_after=blocked_failure_retry_after,
        )
    if not complete:
        # Do not apply partial facts or synthesize a fallback display.  A
        # bounded pass is deferred without consuming a queue retry whenever it
        # checkpointed at least one new chunk; failed chunks remain uncached
        # and are retried on the next pass.
        if (
            remaining_pending
            and newly_cached_chunks > 0
            and max_new_chunks > 0
        ):
            stats.deferred = True
            stats.progress_made = True
            raise LLMEnrichmentDeferred(
                f"Fact extraction checkpointed {newly_cached_chunks} new chunks; "
                f"{len(remaining_pending) + failed_chunks} remain",
                stats=stats,
            )
        sale.raw_payload["llm_fact_coverage"] = coverage
        sale.raw_payload["llm_fact_prompt_version"] = fact_prompt_version
        if not chunk_extractions:
            return stats
        stats.valid_json += 1
        return stats

    extraction = legacy_entry[0] if legacy_entry is not None else _merge_llm_extractions(chunk_extractions)
    sale.raw_payload["llm_fact_coverage"] = coverage
    sale.raw_payload["llm_fact_prompt_version"] = fact_prompt_version
    sale.raw_payload["llm_fact_input_key"] = fact_input_key
    sale.raw_payload["llm_fact_context_manifest"] = _fact_context_manifest(
        sale,
        model=model_name,
        fact_prompt_version=fact_prompt_version,
    )

    display_cache_hit = False
    if extraction_mode in {"structured_then_display", "full"}:
        display_context = _build_validated_display_context(
            sale,
            extraction,
            fallback_context=load_llm_context_for_sale(
                sale,
                max_chars=int(settings.get("llm_display_context_chars") or 12000),
            ),
        )
        display_prompt_version = str(settings.get("llm_display_prompt_version") or prompt_version)
        display_key = _display_cache_key(display_context, model_name, display_prompt_version)
        display_extraction = None
        if (
            legacy_entry is not None
            and legacy_entry[1].endswith(f":{display_prompt_version}")
            and _normalize_display_description(legacy_entry[0].display_description)
        ):
            # The legacy aggregate is accepted only when its own metadata
            # proves the display prompt is still current.  Promote that exact
            # result into the stage-specific cache for future workers.
            display_extraction = legacy_entry[0]
            if incremental:
                _save_display_cache(display_key, display_extraction, output_dir, model_name)
        elif incremental:
            display_extraction = _load_display_cache(display_key, output_dir, model_name, incremental)
        if display_extraction is not None:
            display_cache_hit = True
            extraction.display_description = display_extraction.display_description
            if "display_description" in display_extraction.confidence:
                extraction.confidence["display_description"] = display_extraction.confidence[
                    "display_description"
                ]
            sale.raw_payload["llm_display_prompt_version"] = display_prompt_version
        else:
            if not client.is_available():
                stats.unavailable = True
                return stats
            try:
                with _llm_request_context(sale, stage="display", reason="cache_miss"):
                    display_raw = client.generate_json(
                        DISPLAY_DESCRIPTION_SYSTEM_PROMPT,
                        build_display_description_prompt(display_context),
                    )
                display_extraction = _validated_llm_extraction(display_raw)
                if not _normalize_display_description(display_extraction.display_description):
                    raise ValueError("Model returned an empty display description")
                extraction.display_description = display_extraction.display_description
                if "display_description" in display_extraction.confidence:
                    extraction.confidence["display_description"] = display_extraction.confidence[
                        "display_description"
                    ]
                sale.raw_payload["llm_display_prompt_version"] = display_prompt_version
                if incremental:
                    _save_display_cache(display_key, display_extraction, output_dir, model_name)
            except PipelineBudgetExhausted:
                raise
            except Exception as exc:
                LOGGER.warning("LLM display synthesis failed for %s: %s", sale.source_url, exc)
                stats.errors += 1
                stats.error_messages.append(_llm_error_message(sale, exc))

    stats.valid_json += 1
    _apply_extraction_to_sale(sale, extraction, stats, full_evidence_context, prompt_version=prompt_version)
    sale.raw_payload["llm_extraction"] = extraction.model_dump(mode="json")
    sale.raw_payload["llm_fact_extraction"] = extraction.model_dump(mode="json")
    sale.raw_payload["llm_cache_hit"] = bool(cache_hits == len(fact_contexts) and display_cache_hit)
    if not stats.errors:
        # Keep the legacy sale-scoped artifact for existing consumers.  The
        # stage-specific files above are authoritative for cost avoidance.
        legacy_prompt_version = (
            f"{prompt_version}:{extraction_mode}:{SURFACE_REASONING_VERSION}:complete_v2:"
            f"{fact_prompt_version}:{settings.get('llm_display_prompt_version')}"
        )
        legacy_cache_key = _llm_cache_key(
            full_evidence_context,
            model_name,
            prompt_version=legacy_prompt_version,
        )
        _save_extraction(
            sale,
            extraction,
            output_dir,
            cache_key=legacy_cache_key,
            model=model_name,
            prompt_version=legacy_prompt_version,
        )
    if stats.errors:
        sale.raw_payload.pop("llm_prompt_version", None)
    return stats


def apply_cached_llm_extraction_to_sale(sale: AuctionSale, *, prompt_version: str | None = None) -> bool:
    """Re-apply an LLM payload already stored in raw_payload.

    This is intentionally network-free. It lets a pipeline version that adds a
    new public display field populate it from a previously validated extraction
    without re-downloading PDFs or calling Replicate again.
    """
    if sale.raw_payload.get("source_content_changed") or (sale.raw_payload.get("llm_fact_coverage") or {}).get("complete") is False:
        return False
    payload = sale.raw_payload.get("llm_extraction") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(payload, dict):
        return False
    try:
        extraction = _validated_llm_extraction(payload)
    except Exception:
        return False

    before = clean_text(sale.raw_payload.get("llm_display_description"))
    stats = LLMEnrichmentStats()
    _apply_extraction_to_sale(sale, extraction, stats, context=load_llm_context_for_sale(sale) or "", prompt_version=prompt_version)
    after = clean_text(sale.raw_payload.get("llm_display_description"))
    return bool(after and after != before)


def load_pdf_text_for_sale(sale: AuctionSale, max_chars: int = 12000) -> str | None:
    path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        return None
    return build_reduced_pdf_context(payload, max_chars=max_chars)


def load_llm_context_for_sale(sale: AuctionSale, max_chars: int = 12000) -> str | None:
    source_context = build_source_page_context(sale, max_chars=min(6000, max(1500, max_chars // 3)))
    pdf_budget = max(2000, max_chars - len(source_context or "") - 2)
    pdf_context = load_pdf_text_for_sale(sale, max_chars=pdf_budget)
    if source_context or pdf_context:
        return _join_unique_sections(
            [section for section in (source_context, pdf_context) if section],
            max_chars=max_chars,
        )

    raw_text = clean_text(sale.raw_text)
    if not raw_text:
        return None
    return f"[ANNONCE SOURCE]\n{raw_text[:max_chars]}"


def load_llm_fact_context_chunks_for_sale(
    sale: AuctionSale,
    *,
    chunk_chars: int = 12000,
    max_chunks: int = 0,
) -> list[str]:
    """Return page-aware chunks covering all text already collected by the tool.

    Unlike the display context, this fact-extraction context does not keep only
    the first pages or keyword windows. Every source block and every extracted
    PDF page is represented. ``max_chunks=0`` means no artificial coverage cap.
    """

    chunk_chars = max(3000, chunk_chars)
    sections = _all_source_fact_sections(sale)
    pdf_path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    try:
        pdf_payload = json.loads(pdf_path.read_text(encoding="utf-8")) if pdf_path.exists() else []
    except (OSError, json.JSONDecodeError):
        pdf_payload = []
    if isinstance(pdf_payload, list):
        sections.extend(_all_pdf_fact_sections(pdf_payload))
    chunks = _pack_fact_sections(sections, chunk_chars=chunk_chars)
    total_chunks = len(chunks)
    if max_chunks > 0:
        chunks = chunks[:max_chunks]
    sale.raw_payload["llm_fact_context_coverage"] = {
        "total_chunks": total_chunks,
        "selected_chunks": len(chunks),
        "complete": len(chunks) == total_chunks,
        "chunk_chars": chunk_chars,
    }
    return chunks


def has_current_fact_analysis(sale: AuctionSale) -> bool:
    """Return whether the sale has complete facts for its current evidence.

    The comparison is content-addressed and excludes the display stage.  When
    a worker has no local PDF text cache, a persisted document/source manifest
    is accepted only when it still matches the current document identities and
    source evidence fingerprint.  A source-only fallback therefore cannot
    accidentally certify a previously document-backed analysis.
    """
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    coverage = raw_payload.get("llm_fact_coverage") or {}
    input_key = clean_text(raw_payload.get("llm_fact_input_key"))
    if not input_key or coverage.get("complete") is not True:
        return False
    manifest = raw_payload.get("llm_fact_context_manifest")
    if not isinstance(manifest, dict):
        manifest = None
    if manifest is not None and not _manifest_matches_current(sale, manifest):
        return False
    document_path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    if sale.documents and not document_path.exists():
        return bool(manifest and manifest.get("documents") and _manifest_matches_current(sale, manifest))

    previous_context_coverage = raw_payload.get("llm_fact_context_coverage", _MISSING)
    try:
        contexts = load_llm_fact_context_chunks_for_sale(
            sale,
            chunk_chars=int(load_settings().get("llm_fact_chunk_chars") or 12000),
            max_chunks=0,
        )
    finally:
        # This helper is used by selection code and must stay read-only.  The
        # loader records diagnostics for normal enrichment, but a freshness
        # check should not create a partial public state.
        if previous_context_coverage is _MISSING:
            raw_payload.pop("llm_fact_context_coverage", None)
        else:
            raw_payload["llm_fact_context_coverage"] = previous_context_coverage
    if not contexts or (sale.documents and not (raw_payload.get("document_analysis") or {}).get("documents_extracted")):
        return False
    settings = load_settings()
    model = str(settings.get("replicate_model") or "")
    prompt_version = str(settings.get("llm_fact_prompt_version") or settings.get("llm_prompt_version") or "")
    expected = _fact_input_cache_key("\n\n".join(contexts), model, prompt_version)
    if expected == input_key and not raw_payload.get("source_content_changed"):
        return True
    if manifest is not None and _manifest_matches_current(sale, manifest):
        return True
    return False


def needs_fact_extraction(sale: AuctionSale) -> bool:
    """Return whether current documentary evidence requires a fact pass.

    This is the single selection predicate shared by publication, queue and
    inline scan paths. Keeping it content-aware prevents a lightweight display
    call immediately before the queue performs the authoritative fact pass and
    final display synthesis.
    """

    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return False
    try:
        documents_extracted = int(analysis.get("documents_extracted") or 0)
    except (TypeError, ValueError):
        return False
    if documents_extracted <= 0 or has_current_fact_analysis(sale):
        return False
    surface_analysis = raw_payload.get("surface_analysis")
    contradictions = (
        surface_analysis.get("contradictions")
        if isinstance(surface_analysis, dict)
        else None
    )
    return bool(
        not sale.app_surface_m2
        or sale.occupancy_status in {None, "unknown"}
        or raw_payload.get("source_conflicts")
        or contradictions
    )


def _all_source_fact_sections(sale: AuctionSale) -> list[str]:
    sections: list[str] = []
    payloads = _source_payloads_for_sale(sale)
    primary_raw_text = _source_raw_text_without_pdf(
        payloads[0].get("raw_text") if payloads else None
    ) or _source_raw_text_without_pdf(sale.raw_text)
    if primary_raw_text:
        sections.append(f"[ANNONCE SOURCE - URL {sale.source_url}]\n{primary_raw_text}")
    metadata = _source_metadata_section(sale)
    if metadata:
        sections.append(metadata)
    # Do not include fields produced by a previous enrichment pass here: doing
    # so would change the cache key after applying the extraction itself.
    for index, payload in enumerate(payloads):
        sections.extend(
            _source_payload_sections(
                payload,
                sale,
                include_raw_text=not (index == 0 and primary_raw_text),
            )
        )
    return _unique_fact_sections(sections)


def _all_pdf_fact_sections(pdf_payload: list[dict[str, Any]]) -> list[str]:
    sections: list[str] = []
    for item in pdf_payload:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or "document"
        document_type = clean_text(item.get("document_type")) or "pdf"
        document_url = clean_text(item.get("url")) or "URL inconnue"
        pages = item.get("pages")
        if isinstance(pages, list) and pages:
            for page in pages:
                if not isinstance(page, dict):
                    continue
                text = clean_text(page.get("text"))
                if not text:
                    continue
                page_number = page.get("page")
                method = clean_text(page.get("method")) or "extraction"
                sections.append(
                    f"[DOCUMENT: {label} | TYPE: {document_type} | URL: {document_url} | "
                    f"PAGE: {page_number} | METHODE: {method}]\n{text}"
                )
            continue
        text = clean_text(item.get("text"))
        if text:
            sections.append(
                f"[DOCUMENT: {label} | TYPE: {document_type} | URL: {document_url}]\n{text}"
            )
    return _unique_fact_sections(sections)


def _pack_fact_sections(sections: list[str], *, chunk_chars: int) -> list[str]:
    fragments: list[str] = []
    for section in sections:
        if len(section) <= chunk_chars:
            fragments.append(section)
            continue
        header, separator, body = section.partition("\n")
        prefix = f"{header}\n" if separator else ""
        available = max(1000, chunk_chars - len(prefix) - 40)
        # Keep a small overlap so a room label and its value cannot be split on
        # opposite sides of a model call boundary.
        step = max(500, available - 250)
        for index, start in enumerate(range(0, len(body), step), start=1):
            fragments.append(f"{prefix}[FRAGMENT {index}]\n{body[start:start + available]}")
            if start + available >= len(body):
                break

    chunks: list[str] = []
    current: list[str] = []
    current_size = 0
    for fragment in fragments:
        extra = len(fragment) + (2 if current else 0)
        if current and current_size + extra > chunk_chars:
            chunks.append("\n\n".join(current))
            current = []
            current_size = 0
        current.append(fragment)
        current_size += len(fragment) + (2 if current_size else 0)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def _unique_fact_sections(sections: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for section in sections:
        normalized = clean_text(section)
        if not normalized:
            continue
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        unique.append(normalized)
    return unique


def build_source_page_context(sale: AuctionSale, max_chars: int = 5000) -> str | None:
    sections: list[str] = []
    payloads = _source_payloads_for_sale(sale)
    primary_raw_text = _source_raw_text_without_pdf(
        payloads[0].get("raw_text") if payloads else None
    ) or _source_raw_text_without_pdf(sale.raw_text)
    if primary_raw_text:
        sections.append(f"[ANNONCE SOURCE]\n{primary_raw_text}")

    metadata = _source_metadata_section(sale)
    if metadata:
        sections.append(metadata)

    structured_metadata = _structured_sale_context(sale)
    if structured_metadata:
        sections.append(structured_metadata)

    for index, payload in enumerate(payloads):
        sections.extend(_source_payload_sections(payload, sale, include_raw_text=not (index == 0 and primary_raw_text)))

    raw_text = _source_raw_text_without_pdf(sale.raw_text)
    if raw_text and not primary_raw_text:
        sections.append(f"[ANNONCE SOURCE - TEXTE COLLECTE]\n{raw_text}")

    return _join_unique_sections(sections, max_chars=max_chars)


def extract_source_description(sale: AuctionSale) -> str | None:
    source_block_candidates: list[str] = []
    for payload in _source_payloads_for_sale(sale):
        source_url = payload.get("source_url") or (sale.source_url if payload is sale.raw_payload else None)
        source_block_candidates.extend(
            text for text in _source_description_candidates_from_payload(payload)
            if _description_reference_matches(text, source_url)
        )
    best_source_block = _best_source_description(source_block_candidates)
    if best_source_block:
        return best_source_block
    return _best_source_description([
        value for value in (sale.description, sale.raw_text)
        if value and _description_reference_matches(value, sale.source_url)
    ])


def _description_reference_matches(text: str, source_url: Any) -> bool:
    """Reject explicit cross-listing references; other publishers use their own IDs."""
    if not isinstance(source_url, str):
        return True
    url = urlparse(source_url)
    if url.hostname != "encheresimmobilieres.fr":
        return True
    expected = re.match(r"/ventes/(\d+)(?:-|$)", url.path)
    actual = re.search(r"R[ée]f\.\s*annonce\s*:\s*(\d+)\b", text, re.I)
    return not expected or not actual or expected[1] == actual[1]


def _source_description_candidates_from_payload(payload: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for key in SOURCE_DESCRIPTION_KEYS:
        text = clean_text(payload.get(key))
        if text:
            candidates.append(text)

    blocks = payload.get("source_blocks")
    if isinstance(blocks, dict):
        for key in SOURCE_DESCRIPTION_KEYS:
            text = clean_text(blocks.get(key))
            if text:
                candidates.append(text)
        for key, value in blocks.items():
            normalized_key = str(key).lower()
            if normalized_key in SOURCE_DESCRIPTION_EXCLUDED_KEYS:
                continue
            if "description" in normalized_key or "descriptif" in normalized_key:
                text = clean_text(value)
                if text:
                    candidates.append(text)
    return candidates


def _best_source_description(candidates: list[str]) -> str | None:
    seen: set[str] = set()
    usable: list[str] = []
    for candidate in candidates:
        text = _usable_source_description(candidate)
        if not text:
            continue
        fingerprint = text.lower()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        usable.append(text)
    if not usable:
        return None
    return max(usable, key=len)


def _usable_source_description(value: str | None) -> str | None:
    text = clean_text(value)
    if not text or len(text) < 20:
        return None
    if UNUSABLE_SOURCE_DESCRIPTION_RE.search(text):
        return None
    return text[:2500]


def build_reduced_pdf_context(
    pdf_texts: list[dict[str, Any]],
    max_chars: int = 12000,
    first_page_chars: int = 2500,
    window_chars: int = 900,
) -> str | None:
    max_chars = max(2000, max_chars)
    sections: list[str] = []

    for item in _priority_documents(pdf_texts):
        sections.extend(_document_page_sections(item, first_page_chars=first_page_chars, priority=True))

    for item in pdf_texts:
        pages = item.get("pages") if isinstance(item, dict) else None
        if isinstance(pages, list) and pages:
            label = clean_text(item.get("label")) or "document"
            document_type = clean_text(item.get("document_type")) or "pdf"
            for page in pages:
                if not isinstance(page, dict):
                    continue
                text = clean_text(page.get("text"))
                if not text:
                    continue
                page_number = page.get("page")
                for window in _keyword_windows(text, window_chars=window_chars):
                    sections.append(f"[EXTRAIT - {label} - {document_type} - page {page_number}]\n{window}")
        else:
            text = clean_text(item.get("text"))
            if not text:
                continue
            label = clean_text(item.get("label")) or "document"
            document_type = clean_text(item.get("document_type")) or "pdf"
            for window in _keyword_windows(text, window_chars=window_chars):
                sections.append(f"[EXTRAIT - {label} - {document_type}]\n{window}")

    reduced = _join_unique_sections(sections, max_chars=max_chars)
    if reduced:
        return reduced

    fallback_sections = []
    for item in pdf_texts:
        text = clean_text(item.get("text"))
        if text:
            label = clean_text(item.get("label")) or "document"
            fallback_sections.append(f"[{label}]\n{text[:first_page_chars]}")
    return _join_unique_sections(fallback_sections, max_chars=max_chars)


def _source_metadata_section(sale: AuctionSale) -> str | None:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    parts = [
        f"Source primaire: {sale.primary_source or sale.source_name}",
        f"URL: {sale.source_url}",
        _metadata_line("Titre", raw_payload.get("title") or sale.title),
        _metadata_line("Description source", raw_payload.get("source_description") or raw_payload.get("description")),
        _metadata_line("Adresse", raw_payload.get("address") or sale.address),
        _metadata_line("Ville", raw_payload.get("city") or sale.city),
        _metadata_line("Code postal", raw_payload.get("postal_code") or sale.postal_code),
        _metadata_line("Type", raw_payload.get("property_type")),
        _metadata_line("Mise a prix", raw_payload.get("starting_price_eur")),
        _metadata_line("Date de vente", raw_payload.get("sale_date")),
        _metadata_line("Visites", " | ".join(raw_payload.get("visit_dates") or []) if isinstance(raw_payload.get("visit_dates"), list) else None),
        _metadata_line("Occupation source", raw_payload.get("occupancy_status")),
    ]
    text = "\n".join(part for part in parts if part)
    return f"[ANNONCE SOURCE]\n{text}" if text else None


def _structured_sale_context(sale: AuctionSale) -> str | None:
    llm_payload = sale.raw_payload.get("llm_extraction") if isinstance(sale.raw_payload, dict) else None
    previous_llm = llm_payload if isinstance(llm_payload, dict) else {}
    surface_m2 = None if sale.surface_source == "llm" else sale.surface_m2
    rooms_count = None if _same_int(previous_llm.get("rooms_count"), sale.rooms_count) else sale.rooms_count
    bedrooms_count = None if _same_int(previous_llm.get("bedrooms_count"), sale.bedrooms_count) else sale.bedrooms_count
    occupancy_status = (
        None
        if clean_text(previous_llm.get("occupancy_status")) == clean_text(sale.occupancy_status)
        else sale.occupancy_status
    )
    parts = [
        _metadata_line("Type normalisé", sale.property_type),
        _metadata_line("Surface principale", _decimal_text(surface_m2, "m2")),
        _metadata_line("Surface habitable", _decimal_text(sale.habitable_surface_m2, "m2")),
        _metadata_line("Surface Carrez", _decimal_text(sale.carrez_surface_m2, "m2")),
        _metadata_line("Surface terrain", _decimal_text(sale.land_surface_m2, "m2")),
        _metadata_line("Surface applicative", _decimal_text(sale.app_surface_m2, "m2")),
        _metadata_line("Pièces", rooms_count),
        _metadata_line("Chambres", bedrooms_count),
        _metadata_line("Salles de bain", sale.bathrooms_count),
        _metadata_line("Stationnements", sale.parking_count),
        _metadata_line("Jardin", _bool_text(sale.has_garden)),
        _metadata_line("Terrasse", _bool_text(sale.has_terrace)),
        _metadata_line("Garage", _bool_text(sale.has_garage)),
        _metadata_line("Piscine", _bool_text(sale.has_pool)),
        _metadata_line("Occupation extraite", occupancy_status),
    ]
    text = "\n".join(part for part in parts if part)
    return f"[DONNEES STRUCTUREES EXTRAITES]\n{text}" if text else None


def _metadata_line(label: str, value: Any) -> str | None:
    text = clean_text(value)
    return f"{label}: {text}" if text else None


def _decimal_text(value: Decimal | None, suffix: str) -> str | None:
    if value is None:
        return None
    return f"{value} {suffix}"


def _bool_text(value: bool | None) -> str | None:
    if value is None:
        return None
    return "oui" if value else "non"


def _same_int(left: Any, right: int | None) -> bool:
    if right is None:
        return False
    try:
        return int(left) == right
    except (TypeError, ValueError):
        return False


def _source_payloads_for_sale(sale: AuctionSale) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_payload(payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        marker = str(payload.get("source_url") or payload.get("external_id") or id(payload))
        if marker in seen:
            return
        seen.add(marker)
        payloads.append(payload)

    add_payload(sale.raw_payload)
    if isinstance(sale.raw_payload, dict):
        for item in sale.raw_payload.get("merged_sources") or []:
            if isinstance(item, dict):
                add_payload(item.get("raw_payload"))
    for observation in sale.observations:
        if isinstance(observation, dict):
            add_payload(observation.get("raw_payload"))
    return payloads


def _source_payload_sections(payload: dict[str, Any], sale: AuctionSale, *, include_raw_text: bool = True) -> list[str]:
    label = _source_payload_label(payload, sale)
    sections: list[str] = []
    blocks = payload.get("source_blocks")
    page_text: str | None = None
    if isinstance(blocks, dict):
        for key, value in blocks.items():
            text = clean_text(value)
            if not text:
                continue
            if key == "page_text":
                page_text = text
                continue
            sections.append(f"[ANNONCE SOURCE - {label} - {key}]\n{text}")

    raw_text = clean_text(payload.get("raw_text")) if include_raw_text else None
    if raw_text:
        sections.append(f"[ANNONCE SOURCE - {label} - raw_text]\n{_source_raw_text_without_pdf(raw_text)}")
    if page_text:
        sections.append(f"[ANNONCE SOURCE - {label} - page_text]\n{page_text}")
    return sections


def _source_payload_label(payload: dict[str, Any], sale: AuctionSale) -> str:
    parts = [
        clean_text(payload.get("source_name")) or sale.source_name,
        clean_text(payload.get("source_url")),
    ]
    return " - ".join(part for part in parts if part) or "source"


def _source_raw_text_without_pdf(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    if PDF_TEXT_ENRICHMENT_MARKER in text:
        text = text.split(PDF_TEXT_ENRICHMENT_MARKER, 1)[0]
    return clean_text(text)


def _save_extraction(
    sale: AuctionSale,
    extraction: LLMExtraction,
    output_dir: Path,
    cache_key: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{sale_storage_id(sale)}.json"
    payload = extraction.model_dump(mode="json")
    if cache_key or model or prompt_version:
        payload["_cache"] = {"key": cache_key, "model": model, "prompt_version": prompt_version}
    _atomic_json(path, payload)
    return path


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _read_fact_chunk(path: Path) -> LLMExtraction | None:
    try:
        return _validated_llm_extraction(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def _load_cached_extraction(sale: AuctionSale, cache_key: str, output_dir: Path) -> LLMExtraction | None:
    path = output_dir / f"{sale_storage_id(sale)}.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    cache = payload.get("_cache")
    if not isinstance(cache, dict) or cache.get("key") != cache_key:
        return None
    payload = {key: value for key, value in payload.items() if key != "_cache"}
    try:
        return _validated_llm_extraction(payload)
    except Exception:
        return None


def _load_legacy_extraction(
    sale: AuctionSale,
    output_dir: Path,
    context: str,
    model: str,
    extraction_mode: str,
    prompt_version: str,
    fact_prompt_version: str,
) -> tuple[LLMExtraction, str] | None:
    """Read a pre-stage-split aggregate only when its exact key still matches."""
    path = output_dir / f"{sale_storage_id(sale)}.json"
    payload = _read_json_mapping(path) if path.exists() else None
    if not payload:
        return None
    cache = payload.get("_cache")
    if not isinstance(cache, dict):
        return None
    if str(cache.get("model") or "") != model:
        return None
    cached_prompt_version = clean_text(cache.get("prompt_version"))
    expected_prefix = (
        f"{prompt_version}:{extraction_mode}:{SURFACE_REASONING_VERSION}:complete_v2:"
        f"{fact_prompt_version}:"
    )
    if cached_prompt_version.startswith(expected_prefix):
        key_prompt_version = cached_prompt_version
    else:
        # The pre-stage-split writer stored only the base prompt version in
        # metadata while hashing the complete versioned string.  Reconstruct
        # that exact key to promote compatible old artifacts without trusting
        # their generated display text after a prompt-version change.
        key_prompt_version = (
            f"{prompt_version}:{extraction_mode}:{SURFACE_REASONING_VERSION}:complete_v2:"
            f"{fact_prompt_version}:{load_settings().get('llm_display_prompt_version')}"
        )
        if cached_prompt_version != prompt_version:
            return None
    if cache.get("key") != _llm_cache_key(context, model, key_prompt_version):
        return None
    extraction = _validated_extraction_payload(payload)
    if extraction is None:
        return None
    return extraction, key_prompt_version


def _llm_cache_key(context: str, model: str, prompt_version: str = "auction_llm_v1") -> str:
    digest = hashlib.sha256()
    digest.update(model.encode("utf-8"))
    digest.update(b"\0")
    digest.update(prompt_version.encode("utf-8"))
    digest.update(b"\0")
    digest.update(context.encode("utf-8"))
    return digest.hexdigest()


def _fact_chunk_cache_key(context: str, model: str, prompt_version: str) -> str:
    return _llm_cache_key(
        context,
        model,
        f"facts_complete_v2:{prompt_version}:{SURFACE_REASONING_VERSION}",
    )


def _fact_input_cache_key(context: str, model: str, prompt_version: str) -> str:
    """Identify the exact complete fact input, independent of display output."""
    return _llm_cache_key(
        context,
        model,
        f"facts_input_v1:{prompt_version}:{SURFACE_REASONING_VERSION}",
    )


def _display_cache_key(context: str, model: str, prompt_version: str) -> str:
    return _llm_cache_key(
        context,
        model,
        f"display_v1:{prompt_version}:{DISPLAY_QUALITY_VERSION}",
    )


def _load_durable_cache(cache_key: str, *, stage: str) -> dict[str, Any] | None:
    # PipelineBudgetExhausted is intentionally allowed to propagate.  The
    # queue then defers the job instead of paying for a request whose cache
    # state could not be checked.
    payload = load_cached_result(cache_key, stage=stage)
    return payload if isinstance(payload, dict) else None


def _save_durable_cache(
    cache_key: str,
    payload: dict[str, Any],
    *,
    stage: str,
    model: str,
) -> None:
    # As above, a durable-cache write failure is a queue deferral signal.  The
    # local checkpoint is written first by the caller and can be promoted on
    # the next attempt.
    save_cached_result(cache_key, payload, stage=stage, model=model)


def _load_fact_failure_retry_after(cache_key: str) -> datetime | None:
    """Return the active deterministic-failure cooldown for one exact chunk."""

    payload = _load_durable_cache(cache_key, stage=FACT_FAILURE_STAGE)
    if not isinstance(payload, dict) or payload.get("kind") != "deterministic_failure":
        return None
    retry_after = payload.get("retry_after")
    if not isinstance(retry_after, str) or not retry_after.strip():
        return None
    try:
        parsed = datetime.fromisoformat(retry_after.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    parsed = parsed.astimezone(UTC)
    return parsed if parsed > datetime.now(UTC) else None


def _save_fact_failure_marker(cache_key: str, *, model: str, error: Exception) -> datetime:
    """Persist only deterministic model-output failures, never provider errors."""

    retry_after = datetime.now(UTC) + timedelta(hours=FACT_FAILURE_RETRY_HOURS)
    payload = {
        "kind": "deterministic_failure",
        "retry_after": retry_after.isoformat(),
        "error_type": error.__class__.__name__,
        # Persist only a non-reversible fingerprint. Validation messages can
        # contain a model-output excerpt and the durable cache must not retain
        # source/prompt content for a failed response.
        "error_fingerprint": hashlib.sha256(str(error).encode("utf-8")).hexdigest(),
    }
    _save_durable_cache(cache_key, payload, stage=FACT_FAILURE_STAGE, model=model)
    return retry_after


def _is_deterministic_fact_failure(error: Exception) -> bool:
    """Classify failures safe to suppress for the exact prompt/evidence key."""

    # Pydantic/JSON validation errors inherit ValueError.  Provider failures,
    # transport ambiguity and all budget/cache failures inherit
    # PipelineBudgetExhausted or surface as RuntimeError/HTTP errors and must
    # remain retryable instead of being memoized.
    return isinstance(error, ValueError) and not isinstance(error, PipelineBudgetExhausted)


def _read_json_mapping(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _payload_without_cache_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key != "_cache"}


def _validated_llm_extraction(payload: Any) -> LLMExtraction:
    """Repair safe model-output glitches before applying the strict schema."""

    repaired = repair_json_payload(payload)
    if not isinstance(repaired, dict):
        raise ValueError("LLM extraction must be a JSON object")
    return LLMExtraction.model_validate(repaired)


def _validated_extraction_payload(payload: Any) -> LLMExtraction | None:
    if not isinstance(payload, dict):
        return None
    try:
        return _validated_llm_extraction(_payload_without_cache_metadata(payload))
    except Exception:
        return None


def _load_fact_chunk(
    cache_key: str,
    local_path: Path,
    output_dir: Path,
    model: str,
    incremental: bool,
) -> LLMExtraction | None:
    if not incremental:
        return None
    local_payload = _read_json_mapping(local_path) if local_path.exists() else None
    local_extraction = _validated_extraction_payload(local_payload)
    if local_extraction is not None:
        # Promote old local checkpoints so workers can recover after the local
        # filesystem is replaced by a fresh runner.
        _save_durable_cache(
            cache_key,
            local_extraction.model_dump(mode="json"),
            stage="facts",
            model=model,
        )
        return local_extraction

    durable_payload = _load_durable_cache(cache_key, stage="facts")
    durable_extraction = _validated_extraction_payload(durable_payload)
    if durable_extraction is None:
        return None
    _atomic_json(local_path, durable_extraction.model_dump(mode="json"))
    return durable_extraction


def _save_fact_chunk(
    cache_key: str,
    extraction: LLMExtraction,
    local_path: Path,
    output_dir: Path,
    model: str,
    incremental: bool,
) -> None:
    if not incremental:
        return
    payload = extraction.model_dump(mode="json")
    _atomic_json(local_path, payload)
    _save_durable_cache(cache_key, payload, stage="facts", model=model)


def _load_display_cache(
    cache_key: str,
    output_dir: Path,
    model: str,
    incremental: bool,
) -> LLMExtraction | None:
    if not incremental:
        return None
    local_path = output_dir / "display" / f"{cache_key}.json"
    local_payload = _read_json_mapping(local_path) if local_path.exists() else None
    local_extraction = _validated_extraction_payload(local_payload)
    if local_extraction is not None and _normalize_display_description(local_extraction.display_description):
        _save_durable_cache(
            cache_key,
            local_extraction.model_dump(mode="json"),
            stage="display",
            model=model,
        )
        return local_extraction

    durable_payload = _load_durable_cache(cache_key, stage="display")
    durable_extraction = _validated_extraction_payload(durable_payload)
    if durable_extraction is None or not _normalize_display_description(durable_extraction.display_description):
        return None
    _atomic_json(local_path, durable_extraction.model_dump(mode="json"))
    return durable_extraction


def _save_display_cache(
    cache_key: str,
    extraction: LLMExtraction,
    output_dir: Path,
    model: str,
) -> None:
    payload = extraction.model_dump(mode="json")
    _atomic_json(output_dir / "display" / f"{cache_key}.json", payload)
    _save_durable_cache(cache_key, payload, stage="display", model=model)


def _llm_request_context(sale: AuctionSale, *, stage: str, reason: str):
    """Attach bounded sale/job metadata to the external request."""
    fields: dict[str, Any] = {
        "source_url": sale.source_url,
        "auction_id": sale.id or sale.external_id,
        "stage": stage,
        "reason": reason,
    }
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    job_id = raw_payload.get("llm_job_id") or raw_payload.get("enrichment_job_id")
    if job_id:
        fields["job_id"] = job_id
    return llm_request_context(**fields)


def _document_identity_key(documents: list[dict[str, Any]]) -> str:
    identities = sorted(
        (str(item.get("url") or ""), str(item.get("label") or ""))
        for item in documents
        if isinstance(item, dict)
    )
    return hashlib.sha256(json.dumps(identities, ensure_ascii=False).encode("utf-8")).hexdigest()


def _load_pdf_fact_cache_items(sale: AuctionSale) -> list[dict[str, Any]]:
    path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(payload, dict):
        payload = [payload]
    return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []


def _pdf_item_text_sha256(item: dict[str, Any]) -> str | None:
    parts: list[str] = []
    text = item.get("text")
    if isinstance(text, str) and text:
        parts.append(f"text\n{text}")
    pages = item.get("pages")
    if isinstance(pages, list):
        for index, page in enumerate(pages):
            if not isinstance(page, dict) or not isinstance(page.get("text"), str):
                continue
            parts.append(f"page:{index}:{page.get('page')}\n{page['text']}")
    if not parts:
        return None
    return hashlib.sha256("\n\n".join(parts).encode("utf-8")).hexdigest()


def _pdf_fact_manifest_documents(pdf_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for item in pdf_items:
        text = clean_text(item.get("text"))
        pages = item.get("pages")
        page_texts = [
            page
            for page in pages or []
            if isinstance(page, dict) and clean_text(page.get("text"))
        ] if isinstance(pages, list) else []
        if not text and not page_texts:
            continue
        documents.append(
            {
                "url": clean_text(item.get("url")),
                "label": clean_text(item.get("label")),
                "document_type": clean_text(item.get("document_type")),
                "sha256": clean_text(item.get("sha256")),
                "text_sha256": _pdf_item_text_sha256(item),
                "page_count": len(pages) if isinstance(pages, list) else None,
            }
        )
    return sorted(
        documents,
        key=lambda item: (str(item.get("url") or ""), str(item.get("label") or "")),
    )


def _fact_context_manifest(
    sale: AuctionSale,
    *,
    model: str | None = None,
    fact_prompt_version: str | None = None,
) -> dict[str, Any]:
    source_fingerprint = _source_evidence_fingerprint(sale)
    manifest: dict[str, Any] = {
        "source_fingerprint": source_fingerprint,
        "document_identity": _document_identity_key(sale.documents),
        "model": model or str(load_settings().get("replicate_model") or ""),
        "fact_prompt_version": fact_prompt_version or str(
            load_settings().get("llm_fact_prompt_version")
            or load_settings().get("llm_prompt_version")
            or ""
        ),
        "surface_reasoning_version": SURFACE_REASONING_VERSION,
        "documents": [],
    }
    manifest["documents"] = _pdf_fact_manifest_documents(_load_pdf_fact_cache_items(sale))
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if isinstance(analysis, dict):
        manifest["document_input_fingerprint"] = analysis.get("input_fingerprint")
        profiles = []
        for profile in analysis.get("profiles") or []:
            if not isinstance(profile, dict):
                continue
            profiles.append(
                {
                    "url": clean_text(profile.get("url")),
                    "sha256": clean_text(profile.get("sha256")),
                    "extraction_status": clean_text(profile.get("extraction_status")),
                    "complete": profile.get("complete") is not False,
                }
            )
        manifest["document_profiles"] = sorted(
            profiles,
            key=lambda item: (str(item.get("url") or ""), str(item.get("sha256") or "")),
        )
    source_checks = sale.raw_payload.get("source_checks") if isinstance(sale.raw_payload, dict) else None
    if isinstance(source_checks, dict):
        manifest["source_checks"] = sorted(
            [
                {
                    "url": str(url),
                    "evidence_fingerprint": clean_text(check.get("evidence_fingerprint"))
                    or clean_text(check.get("fingerprint")),
                }
                for url, check in source_checks.items()
                if isinstance(check, dict)
            ],
            key=lambda item: str(item.get("url") or ""),
        )
    return manifest


def _source_evidence_fingerprint(sale: AuctionSale) -> str:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_checks = raw_payload.get("source_checks")
    if isinstance(source_checks, dict):
        check = source_checks.get(sale.source_url)
        if isinstance(check, dict):
            evidence_fingerprint = clean_text(check.get("evidence_fingerprint"))
            if evidence_fingerprint:
                return evidence_fingerprint
            legacy_fingerprint = clean_text(check.get("fingerprint"))
            if legacy_fingerprint:
                return legacy_fingerprint
    return hashlib.sha256(
        "\n\n".join(_all_source_fact_sections(sale)).encode("utf-8")
    ).hexdigest()


def _has_pdf_fact_cache(sale: AuctionSale) -> bool:
    """Require extracted PDF text before a document-backed fact pass."""
    if not sale.documents:
        return True
    path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(payload, list) or not payload:
        return False
    return any(
        isinstance(item, dict)
        and (
            bool(clean_text(item.get("text")))
            or any(bool(clean_text(page.get("text"))) for page in item.get("pages") or [] if isinstance(page, dict))
        )
        for item in payload
    )


def _current_source_checks(sale: AuctionSale) -> list[dict[str, str]]:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_checks = raw_payload.get("source_checks")
    if not isinstance(source_checks, dict):
        return []
    return sorted(
        [
            {
                "url": str(url),
                "evidence_fingerprint": clean_text(check.get("evidence_fingerprint"))
                or clean_text(check.get("fingerprint")),
            }
            for url, check in source_checks.items()
            if isinstance(check, dict)
        ],
        key=lambda item: str(item.get("url") or ""),
    )


def _manifest_matches_current(sale: AuctionSale, manifest: dict[str, Any]) -> bool:
    settings = load_settings()
    current_model = str(settings.get("replicate_model") or "")
    manifest_model = manifest.get("model")
    if manifest_model != current_model and not (
        current_model == "qwen/qwen3-7-plus" and manifest_model == PINNED_MODEL
    ):
        return False
    current_fact_prompt_version = str(
        settings.get("llm_fact_prompt_version") or settings.get("llm_prompt_version") or ""
    )
    if manifest.get("fact_prompt_version") != current_fact_prompt_version:
        return False
    if manifest.get("surface_reasoning_version") != SURFACE_REASONING_VERSION:
        return False
    if manifest.get("document_identity") != _document_identity_key(sale.documents):
        return False
    current_checks = _current_source_checks(sale)
    manifest_checks = manifest.get("source_checks")
    if current_checks or manifest_checks:
        if not isinstance(manifest_checks, list) or current_checks != manifest_checks:
            return False
    elif _source_evidence_fingerprint(sale) != manifest.get("source_fingerprint"):
        return False

    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if sale.documents:
        if not isinstance(analysis, dict) or int(analysis.get("documents_extracted") or 0) <= 0:
            return False
        if int(analysis.get("failed_documents") or 0) > 0:
            return False
        manifest_input_fingerprint = manifest.get("document_input_fingerprint")
        current_input_fingerprint = analysis.get("input_fingerprint")
        if (
            manifest_input_fingerprint
            or current_input_fingerprint
        ) and manifest_input_fingerprint != current_input_fingerprint:
            return False
        current_profiles = []
        for profile in analysis.get("profiles") or []:
            if not isinstance(profile, dict):
                continue
            sha256 = clean_text(profile.get("sha256"))
            if not sha256:
                return False
            current_profiles.append(
                {
                    "url": clean_text(profile.get("url")),
                    "sha256": sha256,
                    "extraction_status": clean_text(profile.get("extraction_status")),
                    "complete": profile.get("complete") is not False,
                }
            )
        current_profiles.sort(key=lambda item: (str(item.get("url") or ""), str(item.get("sha256") or "")))
        manifest_profiles = manifest.get("document_profiles")
        document_urls = {clean_text(document.get("url")) for document in sale.documents if isinstance(document, dict)}
        if (
            not current_profiles
            or not isinstance(manifest_profiles, list)
            or not manifest_profiles
            or len(current_profiles) != len(manifest_profiles)
            or any(not item.get("sha256") for item in current_profiles)
            or not document_urls.issubset({clean_text(item.get("url")) for item in current_profiles})
            or current_profiles != manifest_profiles
        ):
            return False
        # A document byte profile alone cannot detect an OCR/parser refresh
        # that keeps the source PDF unchanged.  When the local extracted text
        # is available, require the persisted content hash as well.  Workers
        # without local files rely on the byte/profile hashes above.
        pdf_path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
        if pdf_path.exists():
            current_documents = _pdf_fact_manifest_documents(_load_pdf_fact_cache_items(sale))
            manifest_documents = manifest.get("documents")
            if not isinstance(manifest_documents, list) or current_documents != manifest_documents:
                return False
    return True


def _llm_error_message(sale: AuctionSale, exc: Exception) -> str:
    source = sale.source_name or sale.primary_source or "unknown"
    title = clean_text(sale.title) or "annonce sans titre"
    detail = clean_text(str(exc)) or exc.__class__.__name__
    return f"LLM extraction failed [{source}] {sale.source_url} — {title}: {detail[:500]}"


def _merge_llm_extractions(extractions: list[LLMExtraction]) -> LLMExtraction:
    if not extractions:
        return LLMExtraction()
    merged = extractions[0].model_copy(deep=True)
    merged.assets = merge_extracted_assets([asset for item in extractions for asset in item.assets])
    scalar_fields = (
        "property_type",
        "surface_m2",
        "rooms_count",
        "bedrooms_count",
        "occupancy_status",
        "occupancy_details",
        "copropriete",
        "works_needed",
        "summary",
        "investor_notes",
    )
    list_fields = (
        "legal_risks",
        "physical_risks",
        "servitudes",
        "investment_facts",
        "contradictions",
        "analysis_questions",
        "scoring_guidance",
    )
    for extraction in extractions[1:]:
        for field_name in scalar_fields:
            current = getattr(merged, field_name)
            incoming = getattr(extraction, field_name)
            if current is None or current == "unknown":
                setattr(merged, field_name, incoming)
            elif incoming not in (None, "unknown") and incoming != current:
                merged.contradictions.append(
                    {
                        "field": field_name,
                        "statement": "Valeurs différentes relevées dans plusieurs fragments.",
                        "sources": [str(current), str(incoming)],
                        "confidence": 0.9,
                    }
                )
                if field_name in {"surface_m2", "rooms_count", "bedrooms_count", "occupancy_status"}:
                    setattr(merged, field_name, None if field_name != "occupancy_status" else "unknown")
        for field_name in list_fields:
            values = [*getattr(merged, field_name), *getattr(extraction, field_name)]
            setattr(merged, field_name, _dedupe_json_values(values))
        for field_name, score in extraction.confidence.items():
            merged.confidence[field_name] = max(merged.confidence.get(field_name, 0.0), score)
        for field_name, evidence in extraction.evidence.items():
            if field_name not in merged.evidence:
                merged.evidence[field_name] = evidence
    return merged


def _downgrade_extraction_completeness(extraction: LLMExtraction) -> LLMExtraction:
    assets = []
    for asset in extraction.assets:
        completeness = asset.measurement_completeness
        if completeness in {"complete", "likely_complete"}:
            completeness = "partial"
        assets.append(asset.model_copy(update={"measurement_completeness": completeness}))
    return extraction.model_copy(update={"assets": assets})


def _dedupe_json_values(values: list[Any]) -> list[Any]:
    unique: list[Any] = []
    seen: set[str] = set()
    for value in values:
        marker = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(value)
    return unique


def _build_validated_display_context(
    sale: AuctionSale,
    extraction: LLMExtraction,
    *,
    fallback_context: str | None,
) -> str:
    facts = {
        "property_type": extraction.property_type or sale.property_type,
        "rooms_count": extraction.rooms_count or sale.rooms_count,
        "bedrooms_count": extraction.bedrooms_count or sale.bedrooms_count,
        "starting_price_eur": (
            str(sale.starting_price_eur) if sale.starting_price_eur is not None else None
        ),
        "sale_date": sale.sale_date.isoformat() if sale.sale_date is not None else None,
        "adjudication_price_eur": (
            str(sale.adjudication_price_eur) if sale.adjudication_price_eur is not None else None
        ),
        "occupancy_status": extraction.occupancy_status or sale.occupancy_status,
        "occupancy_details": extraction.occupancy_details,
        "assets": [asset.model_dump(mode="json") for asset in extraction.assets],
        "legal_risks": extraction.legal_risks,
        "physical_risks": extraction.physical_risks,
        "servitudes": extraction.servitudes,
        "works_needed": extraction.works_needed,
        "contradictions": extraction.contradictions,
    }
    sections = ["[FAITS STRUCTURES A VALIDER POUR AFFICHAGE]\n" + json.dumps(facts, ensure_ascii=False)]
    if fallback_context:
        sections.append(fallback_context)
    return "\n\n".join(sections)


def _apply_extraction_to_sale(
    sale: AuctionSale,
    extraction: LLMExtraction,
    stats: LLMEnrichmentStats,
    context: str = "",
    prompt_version: str | None = None,
) -> None:
    reference_sale = sale.model_copy()
    confidence = extraction.confidence
    if prompt_version:
        sale.raw_payload["llm_prompt_version"] = prompt_version
    if extraction.surface_m2 is not None or extraction.assets:
        stats.surface_detected += 1
    if extraction.rooms_count is not None:
        stats.rooms_detected += 1
    if extraction.bedrooms_count is not None:
        stats.bedrooms_detected += 1
    if extraction.occupancy_status not in (None, "unknown"):
        stats.occupancy_detected += 1

    structured_assets = list(extraction.assets)
    if not structured_assets:
        deterministic_asset = extract_surface_facts_from_text(context)
        if deterministic_asset is not None:
            structured_assets = [deterministic_asset]
    selected_structured_surface = None
    if structured_assets:
        previous_surface = sale.surface_m2
        surface_result = apply_surface_reasoning_to_sale(
            sale,
            structured_assets,
            context=context,
            source="llm_structured_verified" if extraction.assets else "deterministic_surface_reasoning",
        )
        selected_structured_surface = surface_result.selected
        if selected_structured_surface is not None:
            stats.structured_surface_verified += 1
            if selected_structured_surface.kind.startswith("calculated_"):
                stats.calculated_surface_verified += 1
            if sale.surface_m2 is not None and sale.surface_m2 != previous_surface:
                stats.surface_extracted += 1

    if (
        selected_structured_surface is None
        and sale.surface_m2 is None
        and extraction.surface_m2 is not None
        and confidence.get("surface_m2", 0) >= 0.7
        and _scalar_surface_is_supported(context, extraction.surface_m2, extraction.evidence)
    ):
        try:
            sale.surface_m2 = Decimal(str(extraction.surface_m2))
            sale.surface_source = sale.surface_source or "llm_explicit_verified"
            sale.surface_confidence = sale.surface_confidence or Decimal(str(confidence.get("surface_m2", 0)))
            evidence_quote = _evidence_quote(extraction.evidence, "surface_m2")
            if evidence_quote and not sale.surface_evidence:
                sale.surface_evidence = evidence_quote
            stats.surface_extracted += 1
        except InvalidOperation:
            pass

    if sale.rooms_count is None and extraction.rooms_count is not None:
        if confidence.get("rooms_count", 0) >= 0.7 or _rooms_count_is_corroborated(
            context, extraction.rooms_count
        ):
            sale.rooms_count = extraction.rooms_count
            stats.rooms_extracted += 1

    if sale.bedrooms_count is None and extraction.bedrooms_count is not None:
        if confidence.get("bedrooms_count", 0) >= 0.7 or _bedrooms_count_is_corroborated(
            context, extraction.bedrooms_count
        ):
            sale.bedrooms_count = extraction.bedrooms_count
            stats.bedrooms_extracted += 1

    if sale.rooms_count is not None and sale.bedrooms_count is not None and sale.bedrooms_count > sale.rooms_count:
        sale.bedrooms_count = None

    if not sale.occupancy_status and extraction.occupancy_status not in (None, "unknown"):
        if confidence.get("occupancy_status", 0) >= 0.7:
            sale.occupancy_status = extraction.occupancy_status
            stats.occupancy_extracted += 1

    if sale.property_type in (None, "unknown", "other") and extraction.property_type not in (None, "unknown"):
        if confidence.get("property_type", 0) >= 0.7:
            sale.property_type = extraction.property_type

    display_description = _normalize_display_description(extraction.display_description)
    display_check = verify_display_claims(
        display_description or "", "\n".join(filter(None, (extract_source_description(sale), context))),
        reference_sale.model_dump(),
    )
    sale.raw_payload["llm_display_evidence_check"] = display_check
    if (display_description and confidence.get("display_description", 1.0) >= DISPLAY_DESCRIPTION_MIN_CONFIDENCE
            and not sale.raw_payload.get("operator_land_surface_conflict")
            and not display_check["issues"]):
        sale.raw_payload["llm_display_status"] = "accepted"
        sale.raw_payload["llm_display_prompt_version"] = str(
            load_settings().get("llm_display_prompt_version") or prompt_version or ""
        )
        sale.raw_payload["llm_display_description"] = display_description
        sale.raw_payload["llm_display_description_word_count"] = len(display_description.split())
    else:
        sale.raw_payload["llm_display_status"] = "rejected"
        fallback_display_description = _fallback_display_description(reference_sale if display_check["issues"] else sale, LLMExtraction() if display_check["issues"] else extraction)
        if fallback_display_description:
            sale.raw_payload["llm_display_status"] = "fallback"
            sale.raw_payload["llm_display_prompt_version"] = str(
                load_settings().get("llm_display_prompt_version") or prompt_version or ""
            )
            sale.raw_payload["llm_display_description"] = (fallback_display_description + " Surface du terrain à clarifier entre les champs de la source."
                                                               if sale.raw_payload.get("operator_land_surface_conflict") else fallback_display_description)
            sale.raw_payload["llm_display_description_word_count"] = len(fallback_display_description.split())

    # Revalidate cached generations too; do not certify stale text on rejection.
    if sale.raw_payload["llm_display_status"] == "rejected":
        sale.raw_payload.pop("llm_display_description", None)
    checked_display, source_quotes = preserve_source_constraints(
        sale.raw_payload.get("llm_display_description"), extract_source_description(sale),
        max_chars=DISPLAY_DESCRIPTION_MAX_CHARS, max_words=DISPLAY_DESCRIPTION_MAX_WORDS,
        extra_quotes=sale.raw_payload.get("source_display_constraints"),
    )
    sale.raw_payload["llm_display_source_constraints"] = source_quotes
    sale.raw_payload.pop("llm_display_quality_version", None)
    if checked_display:
        sale.raw_payload["llm_display_description"] = checked_display
        sale.raw_payload["llm_display_description_word_count"] = len(checked_display.split())
        if len(checked_display.strip()) >= DISPLAY_MIN_CHARS:
            sale.raw_payload["llm_display_quality_version"] = DISPLAY_QUALITY_VERSION
    else:
        sale.raw_payload["llm_display_status"] = "rejected"
        sale.raw_payload.pop("llm_display_description", None)
        sale.raw_payload.pop("llm_display_description_word_count", None)
        stats.errors += 1
        stats.error_messages.append("Display quality rejected: no summary preserving source constraints within budget")

    risk_notes = _format_risk_notes(extraction)
    if risk_notes:
        sale.risk_notes = clean_text(" | ".join(filter(None, [sale.risk_notes, risk_notes])))
        stats.risks_detected += 1

    if extraction.summary and _is_better_summary(sale.description, extraction.summary):
        sale.description = extraction.summary

    due_diligence = _due_diligence_payload(extraction)
    if due_diligence:
        sale.raw_payload["llm_due_diligence"] = due_diligence


def _scalar_surface_is_supported(context: str, value: float, evidence: dict[str, Any]) -> bool:
    quote = _evidence_quote(evidence, "surface_m2")
    variants = {
        str(value),
        str(value).replace(".", ","),
        str(Decimal(str(value)).normalize()),
        str(Decimal(str(value)).normalize()).replace(".", ","),
    }
    searchable = quote or context
    if not searchable or not any(variant in searchable for variant in variants):
        return False
    return bool(
        re.search(
            r"\b(?:surface|superficie|carrez|habitable|appartement|maison|immeuble|b[âa]timent|local)\b",
            searchable,
            re.I,
        )
    )


def _format_risk_notes(extraction: LLMExtraction) -> str | None:
    parts = []
    if extraction.legal_risks:
        parts.append("Risques juridiques: " + "; ".join(extraction.legal_risks))
    if extraction.physical_risks:
        parts.append("Risques physiques: " + "; ".join(extraction.physical_risks))
    if extraction.servitudes:
        parts.append("Servitudes: " + "; ".join(extraction.servitudes))
    if extraction.works_needed:
        parts.append("Travaux: " + extraction.works_needed)
    if extraction.investor_notes:
        parts.append("Notes investisseur: " + extraction.investor_notes)
    return " | ".join(parts) if parts else None


def _normalize_display_description(value: str | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = re.sub(r"^(?:description|synthèse|synthese)\s*:\s*", "", text, flags=re.I).strip()
    words = text.split()
    if len(words) > DISPLAY_DESCRIPTION_MAX_WORDS:
        text = " ".join(words[:DISPLAY_DESCRIPTION_MAX_WORDS]).rstrip(" ,;:")
        if not re.search(r"[.!?]$", text):
            text += "."
    if len(text) > DISPLAY_DESCRIPTION_MAX_CHARS:
        truncated = text[:DISPLAY_DESCRIPTION_MAX_CHARS].rsplit(" ", 1)[0].rstrip(" ,;:")
        text = truncated if truncated else text[:DISPLAY_DESCRIPTION_MAX_CHARS].rstrip(" ,;:")
        if not re.search(r"[.!?]$", text):
            text += "."
    return clean_text(text)


def _fallback_display_description(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    sentences: list[str] = []
    opening = _fallback_opening(sale, extraction)
    if opening:
        sentences.append(_ensure_sentence(opening))

    details = _fallback_asset_details(sale, extraction)
    if details:
        sentences.append(_ensure_sentence("Les éléments disponibles mentionnent " + ", ".join(details)))

    occupation = _fallback_occupation(sale, extraction)
    if occupation:
        sentences.append(_ensure_sentence(occupation))

    attention_points = _fallback_attention_points(extraction)
    if attention_points:
        sentences.append(_ensure_sentence("Points à vérifier : " + "; ".join(attention_points)))

    if len(" ".join(sentences).split()) < 18:
        source_description = extract_source_description(sale)
        if source_description:
            sentences.append(_ensure_sentence(source_description))

    return _normalize_display_description(" ".join(sentences))


def _fallback_opening(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    property_type = extraction.property_type or sale.property_type or "unknown"
    label = PROPERTY_TYPE_DISPLAY_LABELS.get(property_type, "Bien immobilier")
    location = _fallback_location(sale)
    if location:
        return f"{label} {location}"
    title = clean_text(sale.title)
    if title:
        return title
    return label


def _fallback_location(sale: AuctionSale) -> str | None:
    city = clean_text(sale.city)
    department = clean_text(sale.department)
    if city and department:
        return f"à {city} ({department})"
    if city:
        return f"à {city}"
    if department:
        return f"dans le département {department}"
    return None


def _fallback_asset_details(sale: AuctionSale, extraction: LLMExtraction) -> list[str]:
    details: list[str] = []
    surface = _fallback_surface(sale, extraction)
    if surface:
        details.append(f"une surface de {surface} m²")
    if extraction.rooms_count or sale.rooms_count:
        rooms = extraction.rooms_count or sale.rooms_count
        details.append(f"{rooms} pièce{'s' if rooms and rooms > 1 else ''}")
    if extraction.bedrooms_count or sale.bedrooms_count:
        bedrooms = extraction.bedrooms_count or sale.bedrooms_count
        details.append(f"{bedrooms} chambre{'s' if bedrooms and bedrooms > 1 else ''}")
    amenities = _fallback_amenities(sale)
    if amenities:
        details.append("des annexes ou équipements : " + ", ".join(amenities))
    return details


def _fallback_surface(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    value = extraction.surface_m2 or sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.surface_m2
    if value is None and (extraction.property_type or sale.property_type) == "land":
        value = sale.land_surface_m2
    return _format_surface_value(value)


def _format_surface_value(value: Any) -> str | None:
    if value is None:
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    normalized = number.quantize(Decimal("0.01")).normalize()
    return format(normalized, "f").replace(".", ",")


def _fallback_amenities(sale: AuctionSale) -> list[str]:
    amenities = []
    if sale.has_garden:
        amenities.append("jardin")
    if sale.has_terrace:
        amenities.append("terrasse")
    if sale.has_garage:
        amenities.append("garage")
    if sale.has_pool:
        amenities.append("piscine")
    if sale.parking_count:
        amenities.append(f"{sale.parking_count} stationnement{'s' if sale.parking_count > 1 else ''}")
    return amenities


def _fallback_occupation(sale: AuctionSale, extraction: LLMExtraction) -> str | None:
    status = extraction.occupancy_status or sale.occupancy_status
    label = OCCUPANCY_DISPLAY_LABELS.get(status or "")
    details = clean_text(extraction.occupancy_details)
    if label and details:
        return f"L'occupation est indiquée comme {label}, avec la précision suivante : {details}"
    if label and status != "unknown":
        return f"L'occupation est indiquée comme {label}"
    return None


def _fallback_attention_points(extraction: LLMExtraction) -> list[str]:
    points: list[str] = []
    if extraction.works_needed:
        points.append(f"travaux ou état signalé ({extraction.works_needed})")
    if extraction.legal_risks:
        points.append("risques juridiques mentionnés")
    if extraction.physical_risks:
        points.append("risques techniques mentionnés")
    if extraction.servitudes:
        points.append("servitudes mentionnées")
    return points


def _ensure_sentence(value: str) -> str:
    text = clean_text(value) or ""
    if not text:
        return text
    return text if re.search(r"[.!?]$", text) else f"{text}."


def _due_diligence_payload(extraction: LLMExtraction) -> dict[str, Any]:
    payload = {
        "investment_facts": extraction.investment_facts,
        "contradictions": extraction.contradictions,
        "analysis_questions": extraction.analysis_questions,
        "scoring_guidance": extraction.scoring_guidance,
    }
    return {key: value for key, value in payload.items() if value}


def _is_better_summary(current: str | None, candidate: str) -> bool:
    candidate_text = clean_text(candidate)
    if not candidate_text:
        return False
    current_text = clean_text(current)
    if not current_text:
        return True
    return len(candidate_text) > len(current_text) and len(candidate_text) <= 1200


def _rooms_count_is_corroborated(context: str, rooms_count: int) -> bool:
    if rooms_count <= 0:
        return False
    return extract_rooms_count_from_text(context) == rooms_count


def _bedrooms_count_is_corroborated(context: str, bedrooms_count: int) -> bool:
    if bedrooms_count < 0:
        return False
    return extract_bedrooms_count_from_text(context) == bedrooms_count


def _stringify_llm_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            text = _stringify_llm_value(item)
            if text:
                parts.append(f"{key}: {text}")
        return clean_text("; ".join(parts))
    if isinstance(value, list):
        return clean_text("; ".join(filter(None, (_stringify_llm_value(item) for item in value))))
    return clean_text(str(value))


def _priority_documents(pdf_texts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    priority = []
    for item in pdf_texts:
        document_type = str(item.get("document_type") or "")
        label = str(item.get("label") or "")
        if document_type in PRIORITY_DOCUMENT_TYPES or PRIORITY_LABEL_PATTERNS.search(label):
            priority.append(item)
    return priority


def _document_page_sections(item: dict[str, Any], *, first_page_chars: int, priority: bool) -> list[str]:
    label = clean_text(item.get("label")) or "document"
    document_type = clean_text(item.get("document_type")) or "pdf"
    prefix = "PRIORITE" if priority else "DOCUMENT"
    pages = item.get("pages")
    sections: list[str] = []
    if isinstance(pages, list) and pages:
        for page in pages[:3]:
            if not isinstance(page, dict):
                continue
            text = clean_text(page.get("text"))
            if not text:
                continue
            page_number = page.get("page")
            method = clean_text(page.get("method")) or "extraction"
            sections.append(f"[{prefix} - {label} - {document_type} - page {page_number} - {method}]\n{text[:first_page_chars]}")
        return sections
    text = clean_text(item.get("text"))
    return [f"[{prefix} - {label} - {document_type}]\n{text[:first_page_chars]}"] if text else []


def _keyword_windows(text: str, window_chars: int) -> list[str]:
    lowered = text.lower()
    half = window_chars // 2

    # Collect a [left, right] span around each keyword hit.
    spans: list[tuple[int, int]] = []
    for keyword in LLM_CONTEXT_KEYWORDS:
        start = 0
        while True:
            index = lowered.find(keyword, start)
            if index == -1:
                break
            spans.append((max(0, index - half), min(len(text), index + half)))
            start = index + len(keyword)

    if not spans:
        return []

    # Merge overlapping/adjacent spans so the same characters are not emitted
    # several times (dense legal PDFs produce heavily overlapping windows). This
    # keeps exactly the union of the previous windows — no information dropped,
    # only duplicated overlap removed.
    spans.sort()
    merged: list[list[int]] = [list(spans[0])]
    for left, right in spans[1:]:
        if left <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], right)
        else:
            merged.append([left, right])

    return [text[left:right].strip() for left, right in merged]


def _join_unique_sections(sections: list[str], max_chars: int) -> str | None:
    unique: list[str] = []
    seen: set[str] = set()
    total = 0
    for section in sections:
        normalized = re.sub(r"\s+", " ", section).strip()
        fingerprint = normalized[:300]
        if not normalized or fingerprint in seen:
            continue
        if total + len(normalized) + 2 > max_chars:
            remaining = max_chars - total - 2
            if remaining > 120:
                unique.append(normalized[:remaining])
            break
        seen.add(fingerprint)
        unique.append(normalized)
        total += len(normalized) + 2
    return "\n\n".join(unique) if unique else None


def _evidence_quote(evidence: dict[str, Any], field: str) -> str | None:
    item = evidence.get(field)
    if not isinstance(item, dict):
        return None
    quote = clean_text(item.get("quote"))
    if not quote:
        return None
    label = clean_text(item.get("document_label"))
    page = item.get("page_number")
    prefix_parts = []
    if label:
        prefix_parts.append(label)
    if isinstance(page, int):
        prefix_parts.append(f"page {page}")
    prefix = " - ".join(prefix_parts)
    return f"{prefix}: {quote}" if prefix else quote
