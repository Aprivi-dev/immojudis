from __future__ import annotations

from src import config
from src.config import PROCESS_ISOLATED_SOURCES, SOURCE_NAMES, load_settings


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
        "REPLICATE_WAIT_SECONDS",
        "REPLICATE_MODEL",
        "REPLICATE_THINKING_LEVEL",
        "REPLICATE_MAX_RETRIES",
        "REPLICATE_RETRY_BACKOFF_SECONDS",
        "REPLICATE_RETRY_MAX_SLEEP_SECONDS",
        "REPLICATE_MIN_INTERVAL_SECONDS",
        "PIPELINE_ENRICH_WORKERS",
        "PIPELINE_PDF_MAX_TARGETS",
        "PIPELINE_LLM_MAX_TARGETS",
        "PIPELINE_LLM_WORKERS",
        "PIPELINE_ENRICHMENT_QUEUE_ENABLED",
        "PIPELINE_ENRICHMENT_QUEUE_BATCH_SIZE",
        "LLM_PROMPT_VERSION",
        "LLM_FACT_PROMPT_VERSION",
        "LLM_FACT_CHUNK_CHARS",
        "LLM_FACT_MAX_CHUNKS",
        "PDF_OCR_ENABLED",
        "PDF_OCR_DOCUMENT_BUDGET_SECONDS",
        "PDF_DOCLING_ENABLED",
        "PDF_MAX_DOCUMENTS_PER_SALE",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings["replicate_max_tokens"] == 512
    assert settings["replicate_wait_seconds"] == 60
    assert settings["replicate_model"] == "qwen/qwen3-7-plus"
    assert settings["replicate_thinking_level"] == "low"
    assert settings["replicate_max_retries"] == 4
    assert settings["replicate_retry_backoff_seconds"] == 30
    assert settings["replicate_retry_max_sleep_seconds"] == 60
    assert settings["replicate_min_interval_seconds"] == 11
    assert settings["pipeline_enrich_workers"] == 2
    assert settings["pipeline_llm_workers"] == 1
    assert settings["pipeline_pdf_max_targets"] == 10
    assert settings["pipeline_llm_max_targets"] == 20
    assert settings["pipeline_enrichment_queue_enabled"] is True
    assert settings["pipeline_enrichment_queue_batch_size"] == 10
    assert settings["llm_prompt_version"] == "auction_llm_v10_structured_display"
    assert settings["llm_fact_prompt_version"] == "auction_facts_v1"
    assert settings["llm_fact_chunk_chars"] == 12000
    assert settings["llm_fact_max_chunks"] == 0
    assert settings["pdf_ocr_enabled"] is False
    assert settings["pdf_ocr_document_budget_seconds"] == 120
    assert settings["pdf_docling_enabled"] is False
    assert settings["pdf_max_documents_per_sale"] == 6


def test_source_isolation_defaults_cover_petites_affiches_inside_existing_budgets(monkeypatch) -> None:
    monkeypatch.delenv("SOURCE_PROCESS_ISOLATION", raising=False)
    monkeypatch.delenv("SOURCE_PROCESS_ISOLATION_SOURCES", raising=False)
    monkeypatch.delenv("SOURCE_SCRAPE_TIMEOUT_SECONDS", raising=False)

    settings = load_settings()

    assert settings["source_process_isolation"] is True
    assert settings["source_process_isolation_sources"] == (
        "vench",
        "avoventes",
        "petites_affiches",
    )
    assert settings["source_process_isolation_sources"] == PROCESS_ISOLATED_SOURCES
    assert set(PROCESS_ISOLATED_SOURCES) <= set(SOURCE_NAMES)
    assert settings["source_scrape_timeout_seconds"] == 1800.0


def test_replicate_wait_seconds_stays_within_provider_header_limit(monkeypatch) -> None:
    monkeypatch.setenv("REPLICATE_WAIT_SECONDS", "120")
    assert load_settings()["replicate_wait_seconds"] == 60

    monkeypatch.setenv("REPLICATE_WAIT_SECONDS", "0")
    assert load_settings()["replicate_wait_seconds"] == 1


def test_evidence_vision_is_off_unless_explicitly_enabled(monkeypatch) -> None:
    monkeypatch.delenv("INFORMATION_AGENT_EVIDENCE_VISION_ENABLED", raising=False)
    assert load_settings()["information_agent_evidence_vision_enabled"] is False

    for value in ("1", "true", "yes", "on", " TRUE "):
        monkeypatch.setenv("INFORMATION_AGENT_EVIDENCE_VISION_ENABLED", value)
        assert load_settings()["information_agent_evidence_vision_enabled"] is True

    for value in ("", "0", "false", "off", "enabled"):
        monkeypatch.setenv("INFORMATION_AGENT_EVIDENCE_VISION_ENABLED", value)
        assert load_settings()["information_agent_evidence_vision_enabled"] is False


def test_evidence_ocr_is_on_and_semantic_pass_off_unless_configured(monkeypatch) -> None:
    monkeypatch.delenv("INFORMATION_AGENT_EVIDENCE_OCR_ENABLED", raising=False)
    monkeypatch.delenv("INFORMATION_AGENT_EVIDENCE_SEMANTIC_ENABLED", raising=False)
    settings = load_settings()
    assert settings["information_agent_evidence_ocr_enabled"] is True
    assert settings["information_agent_evidence_semantic_enabled"] is False

    monkeypatch.setenv("INFORMATION_AGENT_EVIDENCE_OCR_ENABLED", "off")
    monkeypatch.setenv("INFORMATION_AGENT_EVIDENCE_SEMANTIC_ENABLED", "yes")
    settings = load_settings()
    assert settings["information_agent_evidence_ocr_enabled"] is False
    assert settings["information_agent_evidence_semantic_enabled"] is True


def test_env_flag_keeps_the_default_only_when_the_variable_is_absent(monkeypatch) -> None:
    monkeypatch.delenv("IMMOJUDIS_TEST_FLAG", raising=False)
    assert config.env_flag("IMMOJUDIS_TEST_FLAG", True) is True
    assert config.env_flag("IMMOJUDIS_TEST_FLAG", False) is False

    for value in ("1", "true", "yes", "on", " TRUE "):
        monkeypatch.setenv("IMMOJUDIS_TEST_FLAG", value)
        assert config.env_flag("IMMOJUDIS_TEST_FLAG", False) is True

    # Une valeur vide ou inconnue éteint, même un interrupteur allumé par défaut (comportement d'origine).
    for value in ("", "0", "false", "off", "enabled"):
        monkeypatch.setenv("IMMOJUDIS_TEST_FLAG", value)
        assert config.env_flag("IMMOJUDIS_TEST_FLAG", True) is False


def test_env_override_returns_none_unless_a_known_word_forces_it(monkeypatch) -> None:
    monkeypatch.delenv("IMMOJUDIS_TEST_FLAG", raising=False)
    assert config.env_override("IMMOJUDIS_TEST_FLAG") is None
    for value, expected in (("on", True), (" YES ", True), ("0", False), ("off", False), ("", None), ("auto", None)):
        monkeypatch.setenv("IMMOJUDIS_TEST_FLAG", value)
        assert config.env_override("IMMOJUDIS_TEST_FLAG") is expected


def test_env_flag_on_unless_false_only_turns_off_for_a_false_word(monkeypatch) -> None:
    monkeypatch.delenv("IMMOJUDIS_TEST_FLAG", raising=False)
    assert config.env_flag_on_unless_false("IMMOJUDIS_TEST_FLAG") is True
    # À l'inverse d'env_flag : une valeur vide ou inconnue laisse l'étape allumée.
    for value in ("", "true", "on", "enabled", "non"):
        monkeypatch.setenv("IMMOJUDIS_TEST_FLAG", value)
        assert config.env_flag_on_unless_false("IMMOJUDIS_TEST_FLAG") is True
    for value in ("0", "false", "no", "off", " OFF ", "False"):
        monkeypatch.setenv("IMMOJUDIS_TEST_FLAG", value)
        assert config.env_flag_on_unless_false("IMMOJUDIS_TEST_FLAG") is False


def test_autonomous_run_id_is_none_outside_an_autonomous_run(monkeypatch) -> None:
    monkeypatch.delenv("PIPELINE_AUTONOMOUS_RUN_ID", raising=False)
    assert config.autonomous_run_id() is None
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "")
    assert config.autonomous_run_id() is None
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "run-1")
    assert config.autonomous_run_id() == "run-1"


def test_document_reading_limits_fall_back_to_defaults_and_stay_bounded(monkeypatch, caplog) -> None:
    monkeypatch.delenv("DOCUMENT_READING_MAX_SALES", raising=False)
    monkeypatch.delenv("DOCUMENT_READING_BUDGET_MINUTES", raising=False)
    assert config.document_reading_limits() == (40, 20 * 60.0)

    monkeypatch.setenv("DOCUMENT_READING_MAX_SALES", "12")
    monkeypatch.setenv("DOCUMENT_READING_BUDGET_MINUTES", "2.5")
    assert config.document_reading_limits() == (12, 150.0)

    # Une variable illisible ne bloque pas la commande : valeur par défaut et avertissement.
    monkeypatch.setenv("DOCUMENT_READING_MAX_SALES", "douze")
    monkeypatch.setenv("DOCUMENT_READING_BUDGET_MINUTES", "nan")
    with caplog.at_level("WARNING", logger="src.config"):
        assert config.document_reading_limits() == (40, 20 * 60.0)
    assert "DOCUMENT_READING_MAX_SALES" in caplog.text and "DOCUMENT_READING_BUDGET_MINUTES" in caplog.text

    # Bornes : 1 à 500 ventes, 1 à 120 minutes, pour la variable comme pour l'argument de la commande.
    monkeypatch.setenv("DOCUMENT_READING_MAX_SALES", "9000")
    monkeypatch.setenv("DOCUMENT_READING_BUDGET_MINUTES", "600")
    assert config.document_reading_limits() == (500, 120 * 60.0)
    assert config.document_reading_limits(0, 0.2) == (1, 60.0)
    assert config.document_reading_limits(15, 4) == (15, 240.0)


def test_write_step_summary_appends_only_inside_github_actions(monkeypatch, tmp_path) -> None:
    summary = tmp_path / "summary.md"
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    config.write_step_summary("ignoré\n")
    assert not summary.exists()

    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    config.write_step_summary("### Première\n")
    config.write_step_summary("### Seconde\n")
    assert summary.read_text(encoding="utf-8") == "### Première\n### Seconde\n"


def test_unwritable_step_summary_leaves_a_warning_instead_of_failing(monkeypatch, tmp_path, caplog) -> None:
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "missing-directory" / "summary.md"))

    config.write_step_summary("### Rapport\n")

    assert "Could not write the GitHub step summary" in caplog.text


def test_licitor_collector_credentials_are_read_at_call_time(monkeypatch) -> None:
    monkeypatch.delenv("LICITOR_DATABASE_URL", raising=False)
    monkeypatch.delenv("CRON_SECRET", raising=False)
    assert config.licitor_collector_database_url() == ""
    assert config.cron_secret() is None

    monkeypatch.setenv("LICITOR_DATABASE_URL", "postgresql://licitor_collector@db.example.supabase.co/postgres")
    monkeypatch.setenv("CRON_SECRET", "secret")
    assert config.licitor_collector_database_url() == "postgresql://licitor_collector@db.example.supabase.co/postgres"
    assert config.cron_secret() == "secret"
