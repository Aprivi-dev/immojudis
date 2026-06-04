from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv
import os


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
DOCUMENTS_DIR = DATA_DIR / "documents"
PDF_TEXTS_DIR = RAW_DIR / "pdf_texts"
PDF_DOCUMENT_TEXTS_DIR = PDF_TEXTS_DIR / "documents"
DOCLING_TEXTS_DIR = RAW_DIR / "docling_texts"
LLM_EXTRACTIONS_DIR = PROCESSED_DIR / "llm_extractions"

AQUITAINE_DEPARTMENTS = ("33", "64", "40", "24", "47")
AQUITAINE_TRIBUNALS = (
    "Bordeaux",
    "Libourne",
    "Bayonne",
    "Pau",
    "Dax",
    "Mont-de-Marsan",
    "Périgueux",
    "Bergerac",
    "Agen",
    "Marmande",
)


def load_settings() -> dict[str, str | float | None]:
    load_dotenv(ROOT_DIR / ".env")
    return {
        "supabase_url": os.getenv("SUPABASE_URL"),
        "supabase_service_role_key": os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
        "supabase_db_url": os.getenv("SUPABASE_DB_URL"),
        "user_agent": os.getenv("AUCTION_USER_AGENT", "immojudis-data-pipeline/1.0 (+https://example.com/contact)"),
        "request_delay_seconds": float(os.getenv("REQUEST_DELAY_SECONDS", "1.5")),
        "request_timeout_seconds": float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")),
        "geocode_enabled": os.getenv("GEOCODE_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "geocode_api_url": os.getenv("GEOCODE_API_URL", "https://api-adresse.data.gouv.fr/search/"),
        "geocode_min_score": float(os.getenv("GEOCODE_MIN_SCORE", "0.45")),
        "llm_enabled": os.getenv("LLM_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "llm_provider": os.getenv("LLM_PROVIDER", "replicate").lower(),
        "replicate_api_token": os.getenv("REPLICATE_API_TOKEN"),
        "replicate_model": os.getenv("REPLICATE_MODEL", "google/gemini-2.5-flash"),
        "replicate_temperature": float(os.getenv("REPLICATE_TEMPERATURE", "0")),
        "replicate_max_tokens": int(os.getenv("REPLICATE_MAX_TOKENS", "8192")),
        "replicate_timeout_seconds": float(os.getenv("REPLICATE_TIMEOUT_SECONDS", "180")),
        "replicate_wait_seconds": int(os.getenv("REPLICATE_WAIT_SECONDS", "60")),
        "replicate_cancel_after": os.getenv("REPLICATE_CANCEL_AFTER", "5m"),
        "replicate_max_retries": int(os.getenv("REPLICATE_MAX_RETRIES", "5")),
        "replicate_retry_backoff_seconds": float(os.getenv("REPLICATE_RETRY_BACKOFF_SECONDS", "20")),
        "replicate_retry_max_sleep_seconds": float(os.getenv("REPLICATE_RETRY_MAX_SLEEP_SECONDS", "180")),
        "replicate_min_interval_seconds": float(os.getenv("REPLICATE_MIN_INTERVAL_SECONDS", "10")),
        "replicate_thinking_budget": int(os.getenv("REPLICATE_THINKING_BUDGET", "0")),
        "replicate_dynamic_thinking": os.getenv("REPLICATE_DYNAMIC_THINKING", "false").lower()
        in {"1", "true", "yes", "on"},
        "llm_prompt_version": os.getenv("LLM_PROMPT_VERSION", "auction_llm_v2"),
        "llm_pdf_max_chars": int(os.getenv("LLM_PDF_MAX_CHARS", "18000")),
        "incremental_enrichment": os.getenv("INCREMENTAL_ENRICHMENT", "true").lower()
        in {"1", "true", "yes", "on"},
        "pdf_ocr_enabled": os.getenv("PDF_OCR_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "pdf_ocr_language": os.getenv("PDF_OCR_LANGUAGE", "fra+eng"),
        "pdf_ocr_tessdata": os.getenv("TESSDATA_PREFIX") or os.getenv("PDF_OCR_TESSDATA"),
        "pdf_extractor": os.getenv("PDF_EXTRACTOR", "auto").lower(),
        "pdf_docling_enabled": os.getenv("PDF_DOCLING_ENABLED", "true").lower() in {"1", "true", "yes", "on"},
        "pdf_docling_threshold_chars": int(os.getenv("PDF_DOCLING_THRESHOLD_CHARS", "1200")),
        "pdf_docling_timeout_seconds": float(os.getenv("PDF_DOCLING_TIMEOUT_SECONDS", "180")),
        "pdf_docling_fast_timeout_seconds": float(os.getenv("PDF_DOCLING_FAST_TIMEOUT_SECONDS", "60")),
        "pdf_docling_ocr_mode": os.getenv("PDF_DOCLING_OCR_MODE", "auto").lower(),
        "pdf_docling_ocr_max_pages": int(os.getenv("PDF_DOCLING_OCR_MAX_PAGES", "25")),
        "pdf_docling_ocr_max_size_mb": float(os.getenv("PDF_DOCLING_OCR_MAX_SIZE_MB", "15")),
        "pdf_docling_chunk_pages": int(os.getenv("PDF_DOCLING_CHUNK_PAGES", "10")),
        "pdf_docling_ocr_chunk_pages": int(os.getenv("PDF_DOCLING_OCR_CHUNK_PAGES", "2")),
        "pdf_max_documents_per_sale": int(os.getenv("PDF_MAX_DOCUMENTS_PER_SALE", "6")),
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
        "encheres_publiques_places": os.getenv(
            "ENCHERES_PUBLIQUES_PLACES",
            "bordeaux-33,libourne-33,bayonne-64,pau-64,dax-40,mont-de-marsan-40,perigueux-24,bergerac-24,agen-47,marmande-47",
        ),
    }
