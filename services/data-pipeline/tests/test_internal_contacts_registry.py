"""Écriture des adresses internes Licitor dans le registre de l'agent (fixtures fictives, exemple.test)."""

from __future__ import annotations

import logging
from contextlib import contextmanager
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
    assert connection.savepoints == 1
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


class _Response:
    def __init__(self, payload: Any = None, status_code: int = 200) -> None:
        self._payload = payload if payload is not None else []
        self.status_code = status_code
        self.is_error = status_code >= 400
        self.text = f"detail with {EMAIL}"

    def json(self) -> Any:
        return self._payload


class _Rest:
    def __init__(self, *, opposed: list[str] | None = None, existing: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.opposed = opposed or []
        self.existing = existing or []

    def get(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append(("GET", url, kwargs))
        if kwargs["params"].get("opposition_status") == "eq.opposed":
            return _Response([{"normalized_email": email} for email in self.opposed])
        return _Response(self.existing)

    def post(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append(("POST", url, kwargs))
        return _Response()

    def patch(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append(("PATCH", url, kwargs))
        return _Response()

    def run(self, sales: list[AuctionSale]) -> int:
        return registry.write_internal_contacts_rest(
            "https://example.test",
            "key",
            sales,
            {URL: SALE_ID},
            NOW,
            get=self.get,
            post=self.post,
            patch=self.patch,
        )


def _writes(rest: _Rest) -> list[tuple[str, str, dict[str, Any]]]:
    return [call for call in rest.calls if call[0] != "GET"]


def test_rest_path_inserts_a_new_row_without_overwriting_an_existing_one() -> None:
    rest = _Rest()

    assert rest.run([_sale(EMAIL)]) == 1

    method, url, kwargs = _writes(rest)[0]
    assert method == "POST" and url.endswith("/rest/v1/information_agent_contacts")
    assert "ignore-duplicates" in kwargs["headers"]["Prefer"]
    row = kwargs["json"][0]
    assert row["source_kind"] == "sale_listing" and row["observed_by"] == "agent" and row["observed_at"] == NOW
    assert row["scope_sale_id"] == SALE_ID == row["sale_id"] and row["source_url"] == URL
    assert row["email"] == EMAIL and row["verification_status"] == "source_observed"
    # L'adresse n'est jamais dans une URL (le client HTTP journalise les URL complètes).
    assert all(EMAIL not in str(call[2].get("params")) and EMAIL not in call[1] for call in rest.calls)


def test_rest_path_refreshes_a_sale_listing_row_but_leaves_other_kinds_alone() -> None:
    existing = [
        {"id": "row-1", "scope_sale_id": SALE_ID, "normalized_email": EMAIL, "source_kind": "sale_listing",
         "opposition_status": "none"},
        {"id": "row-2", "scope_sale_id": SALE_ID, "normalized_email": "saisie@exemple.test", "source_kind": "admin_entry",
         "opposition_status": "none"},
    ]
    rest = _Rest(existing=existing)

    assert rest.run([_sale(EMAIL, "saisie@exemple.test")]) == 1

    writes = _writes(rest)
    assert [call[0] for call in writes] == ["PATCH"]
    assert writes[0][2]["params"] == {"id": "eq.row-1"}
    assert writes[0][2]["json"] == {"observed_at": NOW, "source_url": URL, "last_seen_at": NOW}


def test_rest_path_never_writes_an_opposed_address() -> None:
    rest = _Rest(opposed=[EMAIL])

    assert rest.run([_sale(EMAIL)]) == 0
    assert _writes(rest) == []


def test_rest_path_fails_closed_without_leaking_the_address_when_the_registry_errors() -> None:
    class _Failing(_Rest):
        def get(self, url: str, **kwargs: Any) -> _Response:
            return _Response(status_code=500)

    with pytest.raises(RuntimeError) as error:
        _Failing().run([_sale(EMAIL)])
    assert EMAIL not in str(error.value)


def test_a_registry_failure_never_fails_the_collection_nor_logs_the_address(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    connection = _Connection(fail_insert=True)
    token = supabase_client._PUBLICATION_CONNECTION.set(connection)
    try:
        with caplog.at_level(logging.DEBUG):
            written = supabase_client._write_internal_contacts([_sale(EMAIL)], "https://example.test", "key", NOW)
    finally:
        supabase_client._PUBLICATION_CONNECTION.reset(token)

    assert written == 0
    assert "RuntimeError" in caplog.text
    assert EMAIL not in caplog.text


def test_write_goes_through_the_transaction_when_there_is_one_and_through_rest_otherwise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        registry, "write_internal_contacts_connection", lambda connection, sales, now: calls.append("connection") or 1
    )
    monkeypatch.setattr(
        registry, "write_internal_contacts_rest", lambda url, key, sales, ids, now: calls.append("rest") or 1
    )
    monkeypatch.setattr(supabase_client, "_sale_ids_for_rest", lambda url, key, sales: {URL: SALE_ID})

    assert supabase_client._write_internal_contacts([_sale(EMAIL)], "https://example.test", "key", NOW) == 1
    token = supabase_client._PUBLICATION_CONNECTION.set(object())
    try:
        assert supabase_client._write_internal_contacts([_sale(EMAIL)], "https://example.test", "key", NOW) == 1
        assert supabase_client._write_internal_contacts([_sale()], "https://example.test", "key", NOW) == 0
    finally:
        supabase_client._PUBLICATION_CONNECTION.reset(token)

    assert calls == ["rest", "connection"]
