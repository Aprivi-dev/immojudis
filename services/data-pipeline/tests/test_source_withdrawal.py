"""Source retirée du catalogue : le pipeline ne la collecte pas et ne s'alarme pas (src.source_withdrawal)."""

from __future__ import annotations

from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from src import autonomous_runner, main, source_withdrawal
from src.config import load_settings
from src.sources import licitor_history_refresh

# Les vraies fonctions : l'autouse de conftest remplace `withdrawn_sources` pendant chaque test.
REAL_WITHDRAWN_SOURCES = source_withdrawal.withdrawn_sources
LICITOR = frozenset({"licitor"})


def withdraw_licitor(monkeypatch) -> None:
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: LICITOR)


# --- lecture de l'interrupteur -------------------------------------------------------------------


def test_default_state_is_no_source_withdrawn_without_database_or_when_the_database_fails() -> None:
    assert source_withdrawal.DEFAULT_WITHDRAWN == frozenset()
    assert source_withdrawal.read_withdrawn_sources(None) == frozenset()
    assert source_withdrawal.read_withdrawn_sources("") == frozenset()

    def broken(_url):
        # Migration pas encore appliquée, base injoignable : Licitor reste collecté.
        raise RuntimeError('column "catalogue_withdrawn" does not exist')

    assert source_withdrawal.read_withdrawn_sources("postgresql://test", connect=broken) == frozenset()
    assert not source_withdrawal.is_source_withdrawn("licitor")


def test_switch_is_read_from_the_database_and_lifting_it_opens_the_source() -> None:
    class FakeDb:
        def __init__(self, rows):
            self.rows = rows
            self.statements: list[str] = []

        def execute(self, statement):
            self.statements.append(statement)
            return SimpleNamespace(fetchall=lambda: self.rows)

    withdrawn = FakeDb([("licitor",), ("Vench",)])
    assert source_withdrawal.read_withdrawn_sources(
        "postgresql://test", connect=lambda _url: nullcontext(withdrawn)
    ) == {"licitor", "vench"}
    assert withdrawn.statements == [source_withdrawal.QUERY]
    assert "catalogue_withdrawn" in source_withdrawal.QUERY

    lifted = FakeDb([])
    assert source_withdrawal.read_withdrawn_sources(
        "postgresql://test", connect=lambda _url: nullcontext(lifted)
    ) == frozenset()


def test_switch_is_cached_for_a_minute(monkeypatch) -> None:
    reads: list[str] = []
    monkeypatch.setattr(
        source_withdrawal, "read_withdrawn_sources", lambda db_url, **_: reads.append(db_url) or LICITOR
    )
    clock = [1000.0]
    monkeypatch.setattr(source_withdrawal.time, "monotonic", lambda: clock[0])
    source_withdrawal.reset_cache()

    assert REAL_WITHDRAWN_SOURCES("postgresql://a") == LICITOR
    assert REAL_WITHDRAWN_SOURCES("postgresql://a") == LICITOR
    assert reads == ["postgresql://a"]
    clock[0] += source_withdrawal.CACHE_SECONDS + 1
    REAL_WITHDRAWN_SOURCES("postgresql://a")
    assert reads == ["postgresql://a", "postgresql://a"]
    source_withdrawal.reset_cache()


def test_require_source_active_refuses_a_withdrawn_source_only(monkeypatch) -> None:
    withdraw_licitor(monkeypatch)
    with pytest.raises(source_withdrawal.SourceWithdrawn):
        source_withdrawal.require_source_active("licitor")
    source_withdrawal.require_source_active("vench")


def test_urls_and_sales_of_a_withdrawn_source_are_recognised(monkeypatch) -> None:
    withdraw_licitor(monkeypatch)
    assert source_withdrawal.source_of_url("https://www.licitor.com/photos/1.jpg") == "licitor"
    assert source_withdrawal.source_of_url("https://cdn.licitor.com/x.pdf") == "licitor"
    assert source_withdrawal.source_of_url("https://notlicitor.com/x.pdf") is None
    assert source_withdrawal.source_of_url("https://avoventes.fr/x") is None
    assert source_withdrawal.source_of_url("https://document.vench.fr/x.pdf") == "vench"
    assert source_withdrawal.source_of_url(None) is None
    assert source_withdrawal.is_withdrawn_source_url("https://www.licitor.com/doc.pdf")
    assert not source_withdrawal.is_withdrawn_source_url("https://avoventes.fr/doc.pdf")

    only = SimpleNamespace(source_name="licitor", observations=[{"source_name": "licitor"}])
    no_observation = SimpleNamespace(source_name="Licitor", observations=[])
    merged = SimpleNamespace(
        source_name="licitor", observations=[{"source_name": "licitor"}, {"source_name": "info_encheres"}]
    )
    other_primary = SimpleNamespace(source_name="vench", observations=[{"source_name": "licitor"}])
    assert source_withdrawal.sale_is_fully_withdrawn(only)
    assert source_withdrawal.sale_is_fully_withdrawn(no_observation)
    assert not source_withdrawal.sale_is_fully_withdrawn(merged)
    assert not source_withdrawal.sale_is_fully_withdrawn(other_primary)


def test_nothing_is_withdrawn_once_the_switch_is_lifted(monkeypatch) -> None:
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset())
    assert not source_withdrawal.is_withdrawn_source_url("https://www.licitor.com/doc.pdf")
    assert not source_withdrawal.sale_is_fully_withdrawn(
        SimpleNamespace(source_name="licitor", observations=[{"source_name": "licitor"}])
    )


# --- collecte d'annonces -------------------------------------------------------------------------


def test_withdrawn_source_is_not_collected_even_when_asked_for(monkeypatch) -> None:
    settings = {**load_settings(), "enable_licitor_benchmark": True, "enable_vench_benchmark": True}
    settings["supabase_db_url"] = "postgresql://test"
    monkeypatch.setattr(main, "require_encheres_publiques_access", lambda _settings: None)

    # État ouvert (conftest) : la source explicitement demandée est collectée.
    assert "licitor" in main._enabled_scrapers("licitor", settings, {}, {})

    withdraw_licitor(monkeypatch)
    assert main._enabled_scrapers("licitor", settings, {}, {}) == {}
    assert "licitor" not in main._enabled_scrapers("all", settings, {}, {})
    assert "vench" in main._enabled_scrapers("all", settings, {}, {})


def test_manual_run_of_a_withdrawn_source_exits_cleanly_without_opening_a_run(monkeypatch, capsys) -> None:
    withdraw_licitor(monkeypatch)
    monkeypatch.setattr(
        main, "_open_run", lambda _options: pytest.fail("no run (and therefore no .missed alert) may be created")
    )
    assert main.run_pipeline(main.PipelineOptions(source="licitor")) == 0
    assert "retirée du catalogue" in capsys.readouterr().out


def test_scheduled_run_of_a_withdrawn_source_is_closed_without_executing_anything(monkeypatch) -> None:
    withdraw_licitor(monkeypatch)
    statements: list[tuple[str, object]] = []

    class FakeDb:
        def execute(self, statement, params=None):
            statements.append((statement, params))
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("licitor",))
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: pytest.fail("run must not be registered"))
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda *_: pytest.fail("no source health, no backoff"))
    monkeypatch.setattr(
        autonomous_runner.subprocess, "run", lambda *_a, **_k: pytest.fail("no collector may be spawned")
    )

    assert autonomous_runner.execute("00000000-0000-0000-0000-000000000001") == 0
    closing = [params for statement, params in statements if "set status='succeeded'" in statement]
    assert len(closing) == 1
    assert closing[0][0].obj == {"completion_status": "skipped", "skipped_reason": "source_withdrawn"}


def test_scheduler_query_never_selects_a_disabled_source() -> None:
    """Le planificateur ne lance que `state.enabled`, et une source retirée est toujours désactivée."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[3] / "supabase/migrations"
    scheduler = (root / "20260929153000_enrichment_drain_mode.sql").read_text()
    assert "where enabled and (suspended_until is null or suspended_until<=now_at)" in scheduler
    migration = (root / "20261021110000_licitor_source_withdrawal.sql").read_text()
    assert "check (not (catalogue_withdrawn and enabled))" in migration
    # L'observateur n'ouvre l'alerte « source manquée » que pour une source activée.
    observer = (root / "20260929234000_optimize_pipeline_health_observe.sql").read_text()
    assert "alert_active := source_row.enabled" in observer


# --- historique des adjudications ----------------------------------------------------------------


def test_history_refresh_is_skipped_while_the_source_is_withdrawn(monkeypatch) -> None:
    withdraw_licitor(monkeypatch)

    def no_connection(_url):
        pytest.fail("the collector must not even be reached")

    report = licitor_history_refresh.refresh("postgresql://test", connect=no_connection)
    assert report == {"status": "skipped", "reason": "source_withdrawn"}


def test_history_refresh_main_succeeds_quietly_when_withdrawn(monkeypatch, capsys) -> None:
    withdraw_licitor(monkeypatch)
    monkeypatch.setattr("src.config.load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    assert licitor_history_refresh.main() == 0
    assert "source_withdrawn" in capsys.readouterr().out


def test_autonomous_runner_skips_the_history_tick_and_says_so(monkeypatch) -> None:
    withdraw_licitor(monkeypatch)
    summaries: list[object] = []

    class FakeDb:
        def execute(self, statement, params=None):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("enrichment-queue",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            if "select status,count(*)" in statement:
                return SimpleNamespace(fetchall=lambda: [("completed", 1)])
            if "attempt_count>=max_attempts" in statement:
                return SimpleNamespace(fetchone=lambda: (0,))
            if "update public.auction_runs set status=%s" in statement:
                summaries.append(params[2].obj)
            return SimpleNamespace(fetchone=lambda: None)

    commands: list[list[str]] = []
    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda *_: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **_kwargs: commands.append(command) or SimpleNamespace(returncode=0),
    )

    assert autonomous_runner.execute("00000000-0000-0000-0000-000000000003") == 0
    assert not any("licitor_history_refresh" in " ".join(command) for command in commands)
    assert any("src.queued_runner" in " ".join(command) for command in commands)
    assert summaries[0]["licitor_history_skipped"] == "source_withdrawn"
    assert "licitor_history_exit_code" not in summaries[0]


# --- pièces et file d'enrichissement -------------------------------------------------------------


def test_documents_hosted_by_a_withdrawn_source_are_not_downloaded(monkeypatch, tmp_path) -> None:
    from src import pdf_enrichment
    from src.models import AuctionSale
    from src.pdf_enrichment import PdfEnrichmentStats

    withdraw_licitor(monkeypatch)
    requested: list[str] = []
    monkeypatch.setattr(pdf_enrichment, "_ensure_pdf_deadline", lambda **_k: None)
    monkeypatch.setattr(pdf_enrichment, "require_ep_documents", lambda *_a: None)
    monkeypatch.setattr(
        pdf_enrichment,
        "_select_documents_for_extraction",
        lambda documents, **_k: documents,
    )
    monkeypatch.setattr(pdf_enrichment.httpx, "Client", lambda *a, **k: pytest.fail("no HTTP client expected"))

    sale = AuctionSale(
        source_name="vench",
        source_url="https://www.vench.fr/vente-1",
        documents=[
            {"url": "https://www.licitor.com/documents/cahier.pdf", "label": "Cahier des conditions de vente", "type": "cahier_des_charges"},
        ],
    )
    stats = PdfEnrichmentStats()
    assert pdf_enrichment.download_documents(sale, tmp_path, stats) == []
    assert requested == []
    assert stats.blocked_document_urls == []


def test_queue_defers_the_enrichment_of_a_fully_withdrawn_sale(monkeypatch) -> None:
    withdraw_licitor(monkeypatch)
    with pytest.raises(source_withdrawal.SaleSourceWithdrawn) as refused:
        source_withdrawal.require_sale_not_withdrawn(
            SimpleNamespace(source_name="licitor", observations=[{"source_name": "licitor"}]), "postgresql://test"
        )
    # Reporté un jour, sans consommer d'essai.
    deferral = source_withdrawal.deferral_for(refused.value)
    assert deferral.next_attempt_at - datetime.now(UTC) > timedelta(hours=23)
    # Une vente fusionnée avec une autre source reste enrichie.
    source_withdrawal.require_sale_not_withdrawn(
        SimpleNamespace(source_name="licitor", observations=[{"source_name": "vench"}]), "postgresql://test"
    )
    # Le report d'un accès non autorisé garde son délai et son message d'origine.
    other = source_withdrawal.deferral_for(RuntimeError("EP"))
    assert "Encheres Publiques" in str(other) and other.next_attempt_at - datetime.now(UTC) < timedelta(hours=1)
