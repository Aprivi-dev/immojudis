from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
DOCUMENTS_DIR = DATA_DIR / "documents"
PDF_TEXTS_DIR = RAW_DIR / "pdf_texts"
PDF_DOCUMENT_TEXTS_DIR = PDF_TEXTS_DIR / "documents"
DOCLING_TEXTS_DIR = RAW_DIR / "docling_texts"
LLM_EXTRACTIONS_DIR = PROCESSED_DIR / "llm_extractions"

FRANCE_DEPARTMENTS = (
    *(f"{department:02d}" for department in range(1, 96)),
    "2A",
    "2B",
    "971",
    "972",
    "973",
    "974",
    "975",
    "976",
    "977",
    "978",
    "986",
    "987",
    "988",
)
def _target_departments_from_env() -> tuple[str, ...]:
    load_dotenv(ROOT_DIR / ".env")
    raw = (os.getenv("TARGET_DEPARTMENTS") or "").strip()
    if not raw:
        return FRANCE_DEPARTMENTS
    if raw.lower() in {"all", "france", "france_entire"}:
        return FRANCE_DEPARTMENTS
    requested = tuple(part.strip().upper() for part in raw.split(",") if part.strip())
    valid = set(FRANCE_DEPARTMENTS)
    unknown = [department for department in requested if department not in valid]
    if unknown:
        raise ValueError(f"Unsupported TARGET_DEPARTMENTS: {', '.join(unknown)}")
    return requested


TARGET_DEPARTMENTS = _target_departments_from_env()
# Backward-compatible import for old scraper function names.
FRENCH_POSTAL_CODE_PATTERN = r"(?:(?:0[1-9]|[1-8]\d|9[0-5])\d{3}|97[1-8]\d{2}|98[6-8]\d{2})"


def load_settings() -> dict[str, str | float | None]:
    load_dotenv(ROOT_DIR / ".env")
    return {
        "supabase_url": os.getenv("SUPABASE_URL"),
        "supabase_service_role_key": os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
        "supabase_db_url": os.getenv("SUPABASE_DB_URL"),
        "dvf_import_batch_size": int(os.getenv("DVF_IMPORT_BATCH_SIZE", "1000")),
        "user_agent": os.getenv("AUCTION_USER_AGENT", "immojudis-data-pipeline/1.0 (+https://example.com/contact)"),
        "request_delay_seconds": float(os.getenv("REQUEST_DELAY_SECONDS", "1.5")),
        "request_timeout_seconds": float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")),
        "geocode_enabled": os.getenv("GEOCODE_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "geocode_api_url": os.getenv("GEOCODE_API_URL", "https://data.geopf.fr/geocodage/search/"),
        "geocode_min_score": float(os.getenv("GEOCODE_MIN_SCORE", "0.45")),
        "cadastre_enrich_enabled": os.getenv("CADASTRE_ENRICH_ENABLED", "true").lower()
        in {"1", "true", "yes", "on"},
        "cadastre_api_url": os.getenv("CADASTRE_API_URL", "https://apicarto.ign.fr/api/cadastre/parcelle"),
        "cadastre_source_ign": os.getenv("CADASTRE_SOURCE_IGN", "PCI"),
        "cadastre_max_parcels": max(1, int(os.getenv("CADASTRE_MAX_PARCELS", "4"))),
        "cadastre_timeout_seconds": float(os.getenv("CADASTRE_TIMEOUT_SECONDS", "10")),
        "dpe_enrich_enabled": os.getenv("DPE_ENRICH_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "dpe_api_url": os.getenv(
            "DPE_API_URL",
            "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines",
        ),
        "dpe_geo_radius_m": max(10, int(os.getenv("DPE_GEO_RADIUS_M", "120"))),
        "dpe_max_results": max(1, int(os.getenv("DPE_MAX_RESULTS", "5"))),
        "dpe_timeout_seconds": float(os.getenv("DPE_TIMEOUT_SECONDS", "12")),
        "llm_enabled": os.getenv("LLM_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "llm_provider": os.getenv("LLM_PROVIDER", "replicate").lower(),
        "replicate_api_token": os.getenv("REPLICATE_API_TOKEN"),
        "replicate_model": os.getenv("REPLICATE_MODEL", "google/gemini-2.5-flash"),
        "replicate_temperature": float(os.getenv("REPLICATE_TEMPERATURE", "0")),
        "replicate_max_tokens": int(os.getenv("REPLICATE_MAX_TOKENS", "1024")),
        "replicate_timeout_seconds": float(os.getenv("REPLICATE_TIMEOUT_SECONDS", "180")),
        "replicate_wait_seconds": int(os.getenv("REPLICATE_WAIT_SECONDS", "60")),
        "replicate_cancel_after": os.getenv("REPLICATE_CANCEL_AFTER", "5m"),
        "replicate_max_retries": int(os.getenv("REPLICATE_MAX_RETRIES", "4")),
        "replicate_retry_backoff_seconds": float(os.getenv("REPLICATE_RETRY_BACKOFF_SECONDS", "30")),
        "replicate_retry_max_sleep_seconds": float(os.getenv("REPLICATE_RETRY_MAX_SLEEP_SECONDS", "60")),
        # Les appels LLM restent parallélisés, mais espacés globalement pour
        # éviter les rafales Replicate qui transforment les runs en longues
        # boucles de retry 429.
        "replicate_min_interval_seconds": float(os.getenv("REPLICATE_MIN_INTERVAL_SECONDS", "5")),
        "pipeline_enrich_workers": max(1, int(os.getenv("PIPELINE_ENRICH_WORKERS", "2"))),
        # Extractions PDF/OCR en parallèle (CPU + RAM : on reste prudent pour ne
        # pas saturer la mémoire du runner avec plusieurs Docling/OCR simultanés).
        "pipeline_pdf_workers": max(1, int(os.getenv("PIPELINE_PDF_WORKERS", "2"))),
        # Replicate rate-limit les prédictions concurrentes sur notre usage.
        # On sépare donc le LLM des workers PDF pour éviter les boucles de 429.
        "pipeline_llm_workers": max(1, int(os.getenv("PIPELINE_LLM_WORKERS", "1"))),
        "pipeline_pdf_max_targets": max(0, int(os.getenv("PIPELINE_PDF_MAX_TARGETS", "10"))),
        "pipeline_llm_max_targets": max(0, int(os.getenv("PIPELINE_LLM_MAX_TARGETS", "10"))),
        "pipeline_llm_backfill_max_targets": max(
            1,
            int(os.getenv("PIPELINE_LLM_BACKFILL_MAX_TARGETS", os.getenv("PIPELINE_LLM_MAX_TARGETS", "20"))),
        ),
        "pipeline_idle_llm_backfill_enabled": os.getenv("PIPELINE_IDLE_LLM_BACKFILL_ENABLED", "false").lower()
        in {"1", "true", "yes", "on"},
        "replicate_thinking_budget": int(os.getenv("REPLICATE_THINKING_BUDGET", "0")),
        "replicate_dynamic_thinking": os.getenv("REPLICATE_DYNAMIC_THINKING", "false").lower()
        in {"1", "true", "yes", "on"},
        "llm_prompt_version": os.getenv("LLM_PROMPT_VERSION", "auction_llm_v6_display"),
        "llm_extraction_mode": os.getenv("LLM_EXTRACTION_MODE", "display_description").lower(),
        "llm_pdf_max_chars": int(os.getenv("LLM_PDF_MAX_CHARS", "6000")),
        "incremental_enrichment": os.getenv("INCREMENTAL_ENRICHMENT", "true").lower()
        in {"1", "true", "yes", "on"},
        "pdf_ocr_enabled": os.getenv("PDF_OCR_ENABLED", "false").lower() in {"1", "true", "yes", "on"},
        "pdf_ocr_language": os.getenv("PDF_OCR_LANGUAGE", "fra+eng"),
        "pdf_ocr_tessdata": os.getenv("TESSDATA_PREFIX") or os.getenv("PDF_OCR_TESSDATA"),
        "pdf_extractor": os.getenv("PDF_EXTRACTOR", "auto").lower(),
        "pdf_docling_enabled": os.getenv("PDF_DOCLING_ENABLED", "false").lower() in {"1", "true", "yes", "on"},
        "pdf_docling_threshold_chars": int(os.getenv("PDF_DOCLING_THRESHOLD_CHARS", "1200")),
        "pdf_docling_timeout_seconds": float(os.getenv("PDF_DOCLING_TIMEOUT_SECONDS", "180")),
        "pdf_docling_fast_timeout_seconds": float(os.getenv("PDF_DOCLING_FAST_TIMEOUT_SECONDS", "60")),
        "pdf_docling_ocr_mode": os.getenv("PDF_DOCLING_OCR_MODE", "auto").lower(),
        "pdf_docling_ocr_max_pages": int(os.getenv("PDF_DOCLING_OCR_MAX_PAGES", "25")),
        "pdf_docling_ocr_max_size_mb": float(os.getenv("PDF_DOCLING_OCR_MAX_SIZE_MB", "15")),
        "pdf_docling_chunk_pages": int(os.getenv("PDF_DOCLING_CHUNK_PAGES", "10")),
        "pdf_docling_ocr_chunk_pages": int(os.getenv("PDF_DOCLING_OCR_CHUNK_PAGES", "2")),
        "pdf_max_documents_per_sale": int(os.getenv("PDF_MAX_DOCUMENTS_PER_SALE", "2")),
        "enable_licitor_benchmark": os.getenv("ENABLE_LICITOR_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "licitor_max_pages": int(os.getenv("LICITOR_MAX_PAGES", "5")),
        "enable_vench_benchmark": os.getenv("ENABLE_VENCH_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "vench_max_pages": int(os.getenv("VENCH_MAX_PAGES", "1")),
        "enable_info_encheres_benchmark": os.getenv("ENABLE_INFO_ENCHERES_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "info_encheres_max_pages": int(os.getenv("INFO_ENCHERES_MAX_PAGES", "4")),
        "enable_encheres_publiques_benchmark": os.getenv("ENABLE_ENCHERES_PUBLIQUES_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "encheres_publiques_max_pages": int(os.getenv("ENCHERES_PUBLIQUES_MAX_PAGES", "10")),
        "encheres_publiques_places": os.getenv("ENCHERES_PUBLIQUES_PLACES"),
        "enable_petites_affiches_benchmark": os.getenv("ENABLE_PETITES_AFFICHES_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "enable_cessions_etat_benchmark": os.getenv("ENABLE_CESSIONS_ETAT_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "cessions_etat_max_pages": int(os.getenv("CESSIONS_ETAT_MAX_PAGES", "3")),
        "enable_agrasc_benchmark": os.getenv("ENABLE_AGRASC_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "enable_encheres_immobilieres_benchmark": os.getenv(
            "ENABLE_ENCHERES_IMMOBILIERES_BENCHMARK", "true"
        ).lower()
        in {"1", "true", "yes", "on"},
        "encheres_immobilieres_max_pages": int(os.getenv("ENCHERES_IMMOBILIERES_MAX_PAGES", "1")),
        "enable_notaires_benchmark": os.getenv("ENABLE_NOTAIRES_BENCHMARK", "true").lower()
        in {"1", "true", "yes", "on"},
        "notaires_max_pages": int(os.getenv("NOTAIRES_MAX_PAGES", "2")),
    }
