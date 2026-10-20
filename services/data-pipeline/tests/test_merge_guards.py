"""Garde-fous des fonctions qui suppriment des lignes fusionnées (point 8 du 20/10/2026).

Le déclencheur de report des données des comptes et le plafond de 100 lignes par passage sont vérifiés DANS
``delete_secondary_sales_in_supabase`` et ``reconcile_duplicate_sales_in_supabase`` : le nettoyage de
``src.main`` les appelle sans passer par ``src.dedupe_apply``.
"""

from __future__ import annotations

import pytest

from src import merge_guards
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client

DB_SETTINGS = {
    "supabase_url": "https://supabase.test",
    "supabase_service_role_key": "secret",
    "supabase_db_url": "postgresql://example",
}


class _EmptyRegistry:
    def protected_source_urls(self):
        return frozenset()

    def protected_sale_ids(self):
        return frozenset()


def _sale_with_secondaries(count: int) -> AuctionSale:
    primary = "https://example.test/primary"
    return normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": primary,
            "source_urls": [primary, *(f"https://example.test/secondary-{index}" for index in range(count))],
        }
    )


@pytest.fixture
def settings(monkeypatch):
    def configure(**overrides):
        monkeypatch.setattr(supabase_client, "load_settings", lambda: {**DB_SETTINGS, **overrides})

    configure()
    monkeypatch.setattr(supabase_client, "_fetch_reviewed_alias_registry", lambda url, key: _EmptyRegistry())
    return configure


def test_secondary_cleanup_refuses_without_the_account_data_trigger(monkeypatch, settings) -> None:
    deletions: list[str] = []
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: False)
    monkeypatch.setattr(
        supabase_client, "_delete_secondary_sale_rows_with_postgres", lambda *a, **k: deletions.append("pg") or 1
    )
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows", lambda *a, **k: deletions.append("rest") or 1)

    with pytest.raises(merge_guards.MergeGuardRefused, match="auction_sales_carry_sale_user_data"):
        supabase_client.delete_secondary_sales_in_supabase([_sale_with_secondaries(2)])

    assert deletions == []


def test_secondary_cleanup_refuses_without_a_database_url(monkeypatch, settings) -> None:
    """Sans SUPABASE_DB_URL le déclencheur est invérifiable : refus, pas de repli REST."""
    settings(supabase_db_url=None)
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows", lambda *a, **k: pytest.fail("REST delete"))

    with pytest.raises(merge_guards.MergeGuardRefused):
        supabase_client.delete_secondary_sales_in_supabase([_sale_with_secondaries(1)])


def test_secondary_cleanup_without_secondary_rows_does_not_need_the_trigger(monkeypatch, settings) -> None:
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: pytest.fail("no check needed"))

    assert supabase_client.delete_secondary_sales_in_supabase([_sale_with_secondaries(0)]) == 0


@pytest.mark.parametrize("configured,expected", [(None, 100), (30, 30), (5000, 100), (0, 0)])
def test_secondary_cleanup_deletes_at_most_the_pass_cap(monkeypatch, settings, configured, expected) -> None:
    seen: list[int | None] = []
    settings(**({} if configured is None else {"dedupe_reconcile_max_merges": configured}))
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: True)
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows_with_postgres",
        lambda db_url, sales, limit=None: seen.append(limit) or 1,
    )

    supabase_client.delete_secondary_sales_in_supabase([_sale_with_secondaries(150)])

    assert seen == ([expected] if expected else [])


def test_secondary_cleanup_cap_applies_to_the_rest_fallback_too(monkeypatch, settings) -> None:
    deleted_urls: list[str] = []
    settings(supabase_db_url="postgresql://example")
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: True)
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows_with_postgres",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("postgres down")),
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete_by_source_urls",
        lambda url, key, table, urls: deleted_urls.extend(urls) or len(urls),
    )

    assert supabase_client.delete_secondary_sales_in_supabase([_sale_with_secondaries(150)]) == 100
    assert len(deleted_urls) == 100


def test_postgres_secondary_cleanup_stops_at_the_limit(monkeypatch) -> None:
    rows = [(f"00000000-0000-0000-0000-{index:012d}", f"https://example.test/secondary-{index}") for index in range(5)]
    executed: list[tuple[str, object]] = []

    class Cursor:
        def execute(self, sql, params=None):
            executed.append((sql, params))
            return self

        def fetchall(self):
            return rows

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class Connection:
        def cursor(self):
            return Cursor()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda url: Connection())
    monkeypatch.setattr(supabase_client, "load_reviewed_aliases", lambda cursor: _EmptyRegistry())

    deleted = supabase_client._delete_secondary_sale_rows_with_postgres(
        "postgresql://example", [_sale_with_secondaries(5)], limit=2
    )

    assert deleted == 2
    delete_calls = [params for sql, params in executed if sql.startswith("delete from public.auction_sales")]
    assert len(delete_calls[0][0]) == 2


def test_reconcile_refuses_without_the_account_data_trigger_before_planning(monkeypatch, settings) -> None:
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: False)
    monkeypatch.setattr(
        supabase_client, "plan_duplicate_reconciliation", lambda **kwargs: pytest.fail("planned without guard")
    )

    with pytest.raises(merge_guards.MergeGuardRefused):
        supabase_client.reconcile_duplicate_sales_in_supabase()


def test_reconcile_candidates_mode_stays_read_only_without_the_trigger(monkeypatch, settings) -> None:
    settings(dedupe_reconcile_mode="candidates")
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: pytest.fail("no check in read-only"))
    monkeypatch.setattr(supabase_client, "plan_duplicate_reconciliation", lambda **kwargs: None)

    assert supabase_client.reconcile_duplicate_sales_in_supabase() == 0


@pytest.mark.parametrize(
    "argument,configured,expected",
    [(None, None, 100), (None, 40, 40), (500, None, 100), (500, 5000, 100), (25, None, 25), (None, 5000, 100)],
)
def test_reconcile_never_plans_more_than_the_pass_cap(monkeypatch, settings, argument, configured, expected) -> None:
    planned: list[int | None] = []
    settings(**({} if configured is None else {"dedupe_reconcile_max_merges": configured}))
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: True)
    monkeypatch.setattr(
        supabase_client,
        "plan_duplicate_reconciliation",
        lambda **kwargs: planned.append(kwargs.get("max_merges")),
    )

    assert supabase_client.reconcile_duplicate_sales_in_supabase(max_merges=argument) == 0
    assert planned == [expected]


def test_reconcile_with_a_zero_cap_does_not_even_check_the_trigger(monkeypatch, settings) -> None:
    settings(dedupe_reconcile_max_merges=0)
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: pytest.fail("not needed"))

    assert supabase_client.reconcile_duplicate_sales_in_supabase() == 0


def test_merges_cap_is_bounded_by_the_hard_ceiling() -> None:
    assert merge_guards.merges_cap({}) == 100
    assert merge_guards.merges_cap({"dedupe_reconcile_max_merges": 7}) == 7
    assert merge_guards.merges_cap({"dedupe_reconcile_max_merges": 10_000}) == 100
    assert merge_guards.merges_cap({"dedupe_reconcile_max_merges": -3}) == 0
