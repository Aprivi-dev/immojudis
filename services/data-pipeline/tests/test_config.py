from __future__ import annotations

from src import config
from src.config import load_settings


def test_target_departments_default_matches_production_scope(monkeypatch) -> None:
    monkeypatch.delenv("TARGET_DEPARTMENTS", raising=False)

    assert config._target_departments_from_env() == config.FRANCE_DEPARTMENTS


def test_target_departments_all_selects_whole_france(monkeypatch) -> None:
    monkeypatch.setenv("TARGET_DEPARTMENTS", "all")

    assert config._target_departments_from_env() == config.FRANCE_DEPARTMENTS


def test_target_departments_can_be_overridden(monkeypatch) -> None:
    monkeypatch.setenv("TARGET_DEPARTMENTS", "33,64")

    assert config._target_departments_from_env() == ("33", "64")


def test_load_settings_uses_bounded_runtime_defaults(monkeypatch) -> None:
    for key in (
        "REPLICATE_MAX_TOKENS",
        "REPLICATE_MAX_RETRIES",
        "REPLICATE_RETRY_BACKOFF_SECONDS",
        "REPLICATE_RETRY_MAX_SLEEP_SECONDS",
        "REPLICATE_MIN_INTERVAL_SECONDS",
        "PIPELINE_ENRICH_WORKERS",
        "PIPELINE_PDF_MAX_TARGETS",
        "PIPELINE_LLM_MAX_TARGETS",
        "PIPELINE_LLM_BACKFILL_MAX_TARGETS",
        "PIPELINE_LLM_WORKERS",
        "PIPELINE_LLM_FAILURE_COOLDOWN_HOURS",
        "PIPELINE_IDLE_LLM_BACKFILL_ENABLED",
        "LLM_PROMPT_VERSION",
        "LLM_EXTRACTION_MODE",
        "LLM_PDF_MAX_CHARS",
        "PDF_OCR_ENABLED",
        "PDF_DOCLING_ENABLED",
        "PDF_MAX_DOCUMENTS_PER_SALE",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings["replicate_max_tokens"] == 1024
    assert settings["replicate_max_retries"] == 4
    assert settings["replicate_retry_backoff_seconds"] == 30
    assert settings["replicate_retry_max_sleep_seconds"] == 60
    assert settings["replicate_min_interval_seconds"] == 15
    assert settings["pipeline_enrich_workers"] == 2
    assert settings["pipeline_llm_workers"] == 1
    assert settings["pipeline_pdf_max_targets"] == 10
    assert settings["pipeline_llm_max_targets"] == 10
    assert settings["pipeline_llm_backfill_max_targets"] == 20
    assert settings["pipeline_llm_failure_cooldown_hours"] == 24
    assert settings["pipeline_idle_llm_backfill_enabled"] is False
    assert settings["llm_prompt_version"] == "auction_llm_v6_display"
    assert settings["llm_extraction_mode"] == "display_description"
    assert settings["llm_pdf_max_chars"] == 6000
    assert settings["pdf_ocr_enabled"] is False
    assert settings["pdf_docling_enabled"] is False
    assert settings["pdf_max_documents_per_sale"] == 2
