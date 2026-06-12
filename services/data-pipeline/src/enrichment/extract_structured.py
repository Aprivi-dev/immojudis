from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
import json
import logging
from pathlib import Path
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from src.config import LLM_EXTRACTIONS_DIR, PDF_TEXTS_DIR, load_settings
from src.enrichment.llm_client import ReplicateClient, create_llm_client
from src.enrichment.prompts import SYSTEM_PROMPT, build_user_prompt
from src.models import AuctionSale
from src.normalize import clean_text, extract_bedrooms_count_from_text, extract_rooms_count_from_text
from src.pdf_enrichment import sale_storage_id


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
    surface_m2: float | None = None
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
                "loué": "rented",
                "loue": "rented",
                "leased": "rented",
                "tenant": "rented",
                "locataire": "rented",
                "occupé": "occupied",
                "occupe": "occupied",
                "owner occupied": "owner_occupied",
                "propriétaire occupant": "owner_occupied",
                "proprietaire occupant": "owner_occupied",
            }
            return aliases.get(lowered, value)
        return value

    @field_validator("rooms_count", "bedrooms_count", mode="before")
    @classmethod
    def normalize_positive_count(cls, value: Any) -> Any:
        if value is None:
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

    @field_validator("confidence")
    @classmethod
    def clamp_confidence(cls, value: dict[str, float] | None) -> dict[str, float]:
        if not value:
            return {}
        return {key: max(0.0, min(1.0, float(score))) for key, score in value.items()}

    @field_validator("evidence", mode="before")
    @classmethod
    def normalize_evidence(cls, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    @field_validator("investment_facts", "contradictions", "analysis_questions", "scoring_guidance", mode="before")
    @classmethod
    def normalize_due_diligence_lists(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]

    @field_validator("legal_risks", "physical_risks", "servitudes", mode="before")
    @classmethod
    def default_empty_lists(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, list):
            return [_stringify_llm_value(item) for item in value if _stringify_llm_value(item)]
        return [_stringify_llm_value(value)]

    @field_validator("works_needed", "occupancy_details", "summary", "investor_notes", mode="before")
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
    unavailable: bool = False
    error_messages: list[str] = field(default_factory=list)


def enrich_sale_with_llm(
    sale: AuctionSale,
    client: ReplicateClient | None = None,
    output_dir: Path = LLM_EXTRACTIONS_DIR,
) -> LLMEnrichmentStats:
    stats = LLMEnrichmentStats()
    settings = load_settings()
    if not settings["llm_enabled"]:
        return stats

    llm_context = load_llm_context_for_sale(sale, max_chars=int(settings["llm_pdf_max_chars"]))
    if not llm_context:
        return stats

    client = client or create_llm_client()
    if not client.is_available():
        stats.unavailable = True
        return stats

    stats.analyzed += 1
    model_name = str(getattr(client, "model", "") or "")
    prompt_version = str(settings["llm_prompt_version"])
    cache_key = _llm_cache_key(llm_context, model_name, prompt_version=prompt_version)
    cached = _load_cached_extraction(sale, cache_key, output_dir) if settings["incremental_enrichment"] else None
    if cached is None and settings["incremental_enrichment"]:
        cached = _load_cached_extraction(sale, _legacy_llm_cache_key(llm_context, model_name), output_dir)
    if cached is not None:
        extraction = cached
        stats.valid_json += 1
        _apply_extraction_to_sale(sale, extraction, stats, llm_context)
        sale.raw_payload["llm_extraction"] = extraction.model_dump()
        sale.raw_payload["llm_cache_hit"] = True
        return stats

    try:
        raw = client.generate_json(SYSTEM_PROMPT, build_user_prompt(llm_context))
        extraction = LLMExtraction.model_validate(raw)
    except Exception as exc:
        LOGGER.warning("LLM extraction failed for %s: %s", sale.source_url, exc)
        stats.errors += 1
        stats.error_messages.append(_llm_error_message(sale, exc))
        return stats

    stats.valid_json += 1
    _save_extraction(sale, extraction, output_dir, cache_key=cache_key, model=model_name, prompt_version=prompt_version)
    _apply_extraction_to_sale(sale, extraction, stats, llm_context)
    sale.raw_payload["llm_extraction"] = extraction.model_dump()
    sale.raw_payload["llm_cache_hit"] = False
    return stats


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

    for index, payload in enumerate(payloads):
        sections.extend(_source_payload_sections(payload, sale, include_raw_text=not (index == 0 and primary_raw_text)))

    raw_text = _source_raw_text_without_pdf(sale.raw_text)
    if raw_text and not primary_raw_text:
        sections.append(f"[ANNONCE SOURCE - TEXTE COLLECTE]\n{raw_text}")

    return _join_unique_sections(sections, max_chars=max_chars)


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
        _metadata_line("Description", raw_payload.get("description")),
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


def _metadata_line(label: str, value: Any) -> str | None:
    text = clean_text(value)
    return f"{label}: {text}" if text else None


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
    payload = extraction.model_dump()
    if cache_key or model or prompt_version:
        payload["_cache"] = {"key": cache_key, "model": model, "prompt_version": prompt_version}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


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
        return LLMExtraction.model_validate(payload)
    except Exception:
        return None


def _llm_cache_key(context: str, model: str, prompt_version: str = "auction_llm_v1") -> str:
    digest = hashlib.sha256()
    digest.update(model.encode("utf-8"))
    digest.update(b"\0")
    digest.update(prompt_version.encode("utf-8"))
    digest.update(b"\0")
    digest.update(context.encode("utf-8"))
    return digest.hexdigest()


def _llm_error_message(sale: AuctionSale, exc: Exception) -> str:
    source = sale.source_name or sale.primary_source or "unknown"
    title = clean_text(sale.title) or "annonce sans titre"
    detail = clean_text(str(exc)) or exc.__class__.__name__
    return f"LLM extraction failed [{source}] {sale.source_url} — {title}: {detail[:500]}"


def _legacy_llm_cache_key(context: str, model: str) -> str:
    digest = hashlib.sha256()
    digest.update(model.encode("utf-8"))
    digest.update(b"\0")
    digest.update(context.encode("utf-8"))
    return digest.hexdigest()


def _apply_extraction_to_sale(
    sale: AuctionSale,
    extraction: LLMExtraction,
    stats: LLMEnrichmentStats,
    context: str = "",
) -> None:
    confidence = extraction.confidence
    if extraction.surface_m2 is not None:
        stats.surface_detected += 1
    if extraction.rooms_count is not None:
        stats.rooms_detected += 1
    if extraction.bedrooms_count is not None:
        stats.bedrooms_detected += 1
    if extraction.occupancy_status not in (None, "unknown"):
        stats.occupancy_detected += 1

    if sale.surface_m2 is None and extraction.surface_m2 is not None and confidence.get("surface_m2", 0) >= 0.7:
        try:
            sale.surface_m2 = Decimal(str(extraction.surface_m2))
            sale.surface_source = sale.surface_source or "llm"
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

    risk_notes = _format_risk_notes(extraction)
    if risk_notes:
        sale.risk_notes = clean_text(" | ".join(filter(None, [sale.risk_notes, risk_notes])))
        stats.risks_detected += 1

    if extraction.summary and _is_better_summary(sale.description, extraction.summary):
        sale.description = extraction.summary

    due_diligence = _due_diligence_payload(extraction)
    if due_diligence:
        sale.raw_payload["llm_due_diligence"] = due_diligence


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
    windows: list[str] = []
    for keyword in LLM_CONTEXT_KEYWORDS:
        start = 0
        while True:
            index = lowered.find(keyword, start)
            if index == -1:
                break
            left = max(0, index - window_chars // 2)
            right = min(len(text), index + window_chars // 2)
            windows.append(text[left:right].strip())
            start = index + len(keyword)
    return windows


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
