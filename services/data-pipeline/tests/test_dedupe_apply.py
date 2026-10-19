"""`python -m src.dedupe_apply` : le balayage exécutable hors de la collecte, avec ses garde-fous."""

from types import SimpleNamespace

import pytest

from src import dedupe_apply
from src.outcome_ingestion import catalogue_bridge
from src.storage import supabase_client

SETTINGS = {
    "supabase_url": "https://supabase.test",
    "supabase_service_role_key": "secret",
    "dedupe_reconcile_enabled": True,
    "dedupe_reconcile_mode": "apply",
    "dedupe_reconcile_max_merges": 100,
}


class _Calls(list):
    """Appels notés dans l'ordre, et réglage des paramètres du balayage."""

    def __init__(self, monkeypatch):
        super().__init__()
        self._monkeypatch = monkeypatch

    def configure(self, **overrides):
        self._monkeypatch.setattr(dedupe_apply, "load_settings", lambda: {**SETTINGS, **overrides})


@pytest.fixture
def calls(monkeypatch):
    recorded = _Calls(monkeypatch)

    def bridge(settings, **kwargs):
        recorded.append(("bridge", None))
        return SimpleNamespace(scanned_count=3, created_count=1, reused_count=2)

    def reconcile(**kwargs):
        recorded.append(("reconcile", kwargs.get("max_merges")))
        return 7

    def report(*, output=None):
        recorded.append(("report", output))
        return SimpleNamespace(groups=[])

    monkeypatch.setattr(catalogue_bridge, "bridge_auction_sales_before_cleanup", bridge)
    monkeypatch.setattr(supabase_client, "reconcile_duplicate_sales_in_supabase", reconcile)
    monkeypatch.setattr(dedupe_apply, "report_duplicate_candidates", report)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    recorded.configure()
    return recorded


def test_the_sweep_bridges_the_catalogue_then_deletes_with_the_pass_cap(calls) -> None:
    assert dedupe_apply.apply_duplicate_sweep() == 0

    assert calls == [("bridge", None), ("reconcile", 100)]


def test_the_pass_cap_can_be_lowered_but_never_raised(calls) -> None:
    calls.configure(dedupe_reconcile_max_merges=30)
    assert dedupe_apply.apply_duplicate_sweep() == 0
    calls.configure(dedupe_reconcile_max_merges=5000)
    assert dedupe_apply.apply_duplicate_sweep() == 0

    assert [value for name, value in calls if name == "reconcile"] == [30, 100]


def test_nothing_is_written_while_the_sweep_is_not_enabled(calls, capsys, tmp_path, monkeypatch) -> None:
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    calls.configure(dedupe_reconcile_enabled=False)

    assert dedupe_apply.apply_duplicate_sweep() == 0

    assert calls == []
    assert "::warning" in capsys.readouterr().out
    assert "DEDUPE_RECONCILE_ENABLED" in summary.read_text(encoding="utf-8")


def test_candidates_mode_is_read_only_even_when_enabled(calls, tmp_path) -> None:
    calls.configure(dedupe_reconcile_mode="candidates")
    assert dedupe_apply.apply_duplicate_sweep(output=tmp_path / "rapport.json") == 0
    calls.configure()
    assert dedupe_apply.apply_duplicate_sweep(candidates_only=True) == 0

    assert [name for name, _ in calls] == ["report", "report"]


def test_a_failed_bridge_stops_before_any_deletion(calls, monkeypatch) -> None:
    def failing_bridge(settings, **kwargs):
        raise catalogue_bridge.OutcomeCatalogueBridgeError("pont incomplet")

    monkeypatch.setattr(catalogue_bridge, "bridge_auction_sales_before_cleanup", failing_bridge)

    assert dedupe_apply.apply_duplicate_sweep() == 1
    assert calls == []


def test_missing_credentials_fail_without_touching_anything(calls) -> None:
    calls.configure(supabase_service_role_key=None)

    assert dedupe_apply.apply_duplicate_sweep() == 1
    assert calls == []


def test_a_zero_cap_does_nothing(calls) -> None:
    calls.configure(dedupe_reconcile_max_merges=0)

    assert dedupe_apply.apply_duplicate_sweep() == 0
    assert calls == []


def test_main_reads_the_command_line(calls) -> None:
    assert dedupe_apply.main(["--candidates"]) == 0
    assert calls == [("report", None)]
