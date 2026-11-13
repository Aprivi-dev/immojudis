"""Écriture des adresses internes Licitor dans le registre de l'agent (fixtures fictives, exemple.test)."""

from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from src.models import AuctionSale
from src.storage import internal_contacts as registry
from src.storage import supabase_client

URL = "https://www.licitor.com/annonce/10/99/99/vente-aux-encheres/un-appartement/paris-16eme/paris/109999.html"
SALE_ID = "11111111-1111-4111-8111-111111111111"
EMAIL = "maitre@exemple.test"
NOW = "2026-10-14T10:00:00+00:00"


def _sale(*emails: str) -> AuctionSale:
    return AuctionSale(
        source_name="licitor",
        source_url=URL,
        sale_date=datetime.now(UTC) + timedelta(days=30),
        internal_contacts=[
            {"email": email, "name": "Maître Exemple, Avocat", "role": "lawyer", "source_url": URL} for email in emails
        ],
    )


class _Result:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class _Connection:
    def __init__(self, *, fail_insert: bool = False) -> None:
        self.statements: list[tuple[str, Any]] = []
        self.savepoints = 0
        self.fail_insert = fail_insert

    @contextmanager
    def transaction(self):
        self.savepoints += 1
        yield

    def execute(self, statement: Any, params: Any = None) -> _Result:
        text = str(statement)
        self.statements.append((text, params))
        if "from public.auction_sales" in text:
            return _Result([(SALE_ID, URL)])
        if "insert into public.information_agent_contacts" in text and self.fail_insert:
            raise RuntimeError(f"boom {params['email']}")
        return _Result([])


def test_connection_path_inserts_a_sale_listing_row_with_the_listing_as_origin() -> None:
    connection = _Connection()

    assert registry.write_internal_contacts_connection(connection, [_sale(EMAIL)], NOW) == 1

    insert, params = next(item for item in connection.statements if "insert into" in item[0])
    assert connection.savepoints == 2  # relecture des ids, puis la ligne
    assert "'sale_listing'" in insert and "'agent'" in insert and "'source_observed'" in insert
    assert params["sale_id"] == SALE_ID and params["email"] == EMAIL and params["now"] == NOW
    assert params["source_url"] == URL and params["source_name"] == "licitor"
    assert params["name"] == "Maître Exemple, Avocat"
    # Une adresse opposée n'est jamais écrite ; une ligne d'un autre type n'est jamais réécrite ;
    # une ligne sale_listing est rafraîchie (observed_at) à chaque recollecte.
    assert "opposition_status = 'opposed'" in insert
    assert "source_kind = 'sale_listing'" in insert and "observed_at = excluded.observed_at" in insert
    assert "on conflict (scope_sale_id, normalized_email)" in insert
    assert "ignore" not in insert.lower()


def test_connection_path_without_internal_contacts_does_nothing() -> None:
    connection = _Connection()

    assert registry.write_internal_contacts_connection(connection, [_sale()], NOW) == 0
    assert connection.statements == []


def test_a_registry_failure_never_fails_the_collection_nor_logs_the_address(
    caplog: pytest.LogCaptureFixture,
) -> None:
    connection = _Connection(fail_insert=True)

    with caplog.at_level(logging.DEBUG):
        written = registry.write_safely([_sale(EMAIL)], NOW, connection)

    assert written == 0
    assert "RuntimeError" in caplog.text
    assert EMAIL not in caplog.text


def test_write_goes_through_the_publication_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        registry, "write_internal_contacts_connection", lambda connection, sales, now: calls.append("connection") or 1
    )

    assert registry.write_safely([_sale(EMAIL)], NOW, object()) == 1
    assert registry.write_safely([_sale()], NOW, object()) == 0

    assert calls == ["connection"]


def test_the_publication_write_calls_the_registry_after_the_sale_write() -> None:
    import inspect

    source = inspect.getsource(supabase_client._write_sale_revisions)

    assert "internal_contacts.write_safely(" in source
    assert source.index("_upsert_asset_tables") < source.index("internal_contacts.write_safely(")


# --- Points de sauvegarde, source et fenêtre de conservation ------------------------------------------------


def test_a_failing_id_lookup_is_isolated_in_its_savepoint_and_leaves_the_publication_intact() -> None:
    class _LookupFails(_Connection):
        def execute(self, statement: Any, params: Any = None) -> _Result:
            self.statements.append((str(statement), params))
            if "from public.auction_sales" in str(statement):
                raise RuntimeError("lookup failed")
            return _Result([])

    connection = _LookupFails()

    assert registry.write_internal_contacts_connection(connection, [_sale(EMAIL)], NOW) == 0
    assert connection.savepoints == 1
    assert all("insert into public.information_agent_contacts" not in text for text, _ in connection.statements)


def test_each_row_has_its_own_savepoint_and_one_failure_does_not_stop_the_others(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _FirstInsertFails(_Connection):
        inserts = 0

        def execute(self, statement: Any, params: Any = None) -> _Result:
            if "insert into public.information_agent_contacts" in str(statement):
                type(self).inserts += 1
                if type(self).inserts == 1:
                    raise RuntimeError(f"boom {params['email']}")
            return super().execute(statement, params)

    connection = _FirstInsertFails()
    with caplog.at_level(logging.WARNING):
        written = registry.write_internal_contacts_connection(connection, [_sale(EMAIL, "autre@exemple.test")], NOW)

    assert written == 1
    assert connection.savepoints == 3  # ids + deux lignes
    assert "RuntimeError" in caplog.text and "failed=1" in caplog.text
    assert EMAIL not in caplog.text and "autre@exemple.test" not in caplog.text


def test_the_address_keeps_licitor_as_its_source_after_a_merge_under_another_source() -> None:
    sale = AuctionSale(
        source_name="vench",
        source_url=URL,
        internal_contacts=[
            {"email": EMAIL, "name": "Maître Exemple", "role": "lawyer", "source_name": "licitor", "source_url": "https://www.licitor.com/annonce/1.html"}
        ],
    )

    [row] = registry.contact_rows([sale], {URL: SALE_ID}, NOW)

    assert row["source_name"] == "licitor"
    assert row["provenance"][0]["source_name"] == "licitor"
    assert row["source_url"] == "https://www.licitor.com/annonce/1.html"


def test_the_first_observation_date_is_never_rewritten() -> None:
    insert = registry._INSERT_SQL
    update = insert[insert.index("do update") :]

    assert "created_at" not in insert
    assert set(re.findall(r"(\w+) = excluded", update)) == {"observed_at", "source_url", "last_seen_at"}


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "cancelled"},
        {"status": "withdrawn"},
        {"status": "past"},
        {"status": "adjudicated"},
        {"status": "postponed", "sale_date": None},  # reportée sans nouvelle date
        {"status": "upcoming", "sale_date": None},  # sans date d'audience : strict minimum
        {"sale_date": datetime(2020, 1, 1, 10, 0, tzinfo=UTC)},  # audience passée
    ],
)
def test_no_write_nor_refresh_after_the_sale_is_over_or_withdrawn(overrides: dict[str, Any]) -> None:
    sale = _sale(EMAIL)
    for key, value in overrides.items():
        setattr(sale, key, value)

    connection = _Connection()
    assert registry.write_internal_contacts_connection(connection, [sale], NOW) == 0
    assert connection.statements == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "upcoming", "sale_date": datetime.now(UTC) + timedelta(days=3)},
        {"status": "active", "sale_date": datetime.now(UTC) + timedelta(days=20)},
        {"status": "postponed", "sale_date": datetime.now(UTC) + timedelta(days=40)},  # nouvelle date connue
        {"status": "unknown", "sale_date": datetime.now(UTC) + timedelta(days=3)},
    ],
)
def test_an_upcoming_sale_keeps_its_address_refreshed(overrides: dict[str, Any]) -> None:
    sale = _sale(EMAIL)
    for key, value in overrides.items():
        setattr(sale, key, value)

    assert registry.registers_internal_contacts(sale) is True
