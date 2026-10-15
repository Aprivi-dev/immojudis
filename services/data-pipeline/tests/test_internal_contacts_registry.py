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


class _Response:
    def __init__(self, payload: Any = None, status_code: int = 200, headers: dict[str, str] | None = None) -> None:
        self._payload = payload if payload is not None else []
        self.headers = headers or {}
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
        if int(kwargs["params"].get("offset", "0")) > 0:  # une seule page de résultats, puis une page vide
            return _Response([])
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


def _ids(url: str, key: str, sales: list[AuctionSale]) -> dict[str, str]:
    return {URL: SALE_ID}


def test_a_registry_failure_never_fails_the_collection_nor_logs_the_address(
    caplog: pytest.LogCaptureFixture,
) -> None:
    connection = _Connection(fail_insert=True)

    with caplog.at_level(logging.DEBUG):
        written = registry.write_safely([_sale(EMAIL)], "https://example.test", "key", NOW, connection, _ids)

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
        registry,
        "write_internal_contacts_rest",
        lambda url, key, sales, ids, now, **kwargs: calls.append("rest") or 1,
    )

    assert registry.write_safely([_sale(EMAIL)], "https://example.test", "key", NOW, None, _ids) == 1
    assert registry.write_safely([_sale(EMAIL)], "https://example.test", "key", NOW, object(), _ids) == 1
    assert registry.write_safely([_sale()], "https://example.test", "key", NOW, object(), _ids) == 0

    assert calls == ["rest", "connection"]


def test_the_publication_write_calls_the_registry_after_the_sale_write() -> None:
    import inspect

    source = inspect.getsource(supabase_client._write_sale_revisions)

    assert "internal_contacts.write_safely(" in source
    assert source.index("_upsert_asset_tables_with_rest") < source.index("internal_contacts.write_safely(")


# --- Points de sauvegarde, pagination, source et fenêtre de conservation ------------------------------------


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

    rest = _Rest(
        existing=[
            {"id": "row-1", "scope_sale_id": SALE_ID, "normalized_email": EMAIL, "source_kind": "sale_listing",
             "opposition_status": "none"}
        ]
    )
    rest.run([_sale(EMAIL)])
    assert "created_at" not in _writes(rest)[0][2]["json"]


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
    rest = _Rest(
        existing=[
            {"id": "row-1", "scope_sale_id": SALE_ID, "normalized_email": EMAIL, "source_kind": "sale_listing",
             "opposition_status": "none"}
        ]
    )
    assert rest.run([sale]) == 0
    assert rest.calls == []


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


class _Server(_Rest):
    """Serveur PostgREST factice : ``max_rows`` plafonne une réponse, ``Content-Range`` annonce le total."""

    def __init__(self, opposed: list[str], *, max_rows: int, lie_about_total: int | None = None) -> None:
        super().__init__()
        self.all_opposed = opposed
        self.max_rows = max_rows
        self.lie_about_total = lie_about_total
        self.offsets: list[int] = []

    def get(self, url: str, **kwargs: Any) -> _Response:
        params = kwargs["params"]
        self.calls.append(("GET", url, kwargs))
        assert kwargs["headers"]["Prefer"] == "count=exact" and params["order"] == "id"
        if params.get("opposition_status") != "eq.opposed":
            return _Response([], headers={"Content-Range": "*/0"})
        offset, limit = int(params["offset"]), min(int(params["limit"]), self.max_rows)
        self.offsets.append(offset)
        page = [{"normalized_email": email} for email in self.all_opposed[offset : offset + limit]]
        total = self.lie_about_total if self.lie_about_total is not None else len(self.all_opposed)
        span = f"{offset}-{offset + len(page) - 1}" if page else "*"
        return _Response(page, headers={"Content-Range": f"{span}/{total}"})


def test_rest_opposition_list_is_read_page_by_page_and_an_address_on_a_later_page_is_honoured() -> None:
    opposed = [f"x{index}@exemple.test" for index in range(1000)] + [EMAIL]
    rest = _Server(opposed, max_rows=1000)

    assert rest.run([_sale(EMAIL)]) == 0
    assert rest.offsets == [0, 1000]
    assert _writes(rest) == []


def test_rest_pagination_survives_a_server_cap_below_the_page_size() -> None:
    # max_rows = 400 : le décalage suit les lignes reçues, aucune ligne n'est sautée.
    opposed = [f"x{index}@exemple.test" for index in range(1100)] + [EMAIL]
    rest = _Server(opposed, max_rows=400)

    assert rest.run([_sale(EMAIL)]) == 0
    assert rest.offsets == [0, 400, 800]
    assert _writes(rest) == []


def test_rest_reading_fails_closed_when_the_rows_read_differ_from_the_announced_total() -> None:
    rest = _Server([f"x{index}@exemple.test" for index in range(10)], max_rows=1000, lie_about_total=42)

    with pytest.raises(RuntimeError, match="lecture incomplète"):
        rest.run([_sale(EMAIL)])
    assert _writes(rest) == []


def test_rest_reading_without_a_total_stops_on_an_empty_page() -> None:
    class _NoTotal(_Server):
        def get(self, url: str, **kwargs: Any) -> _Response:
            response = super().get(url, **kwargs)
            response.headers = {}
            return response

    rest = _NoTotal([f"x{index}@exemple.test" for index in range(1500)] + [EMAIL], max_rows=1000)

    assert rest.run([_sale(EMAIL)]) == 0
    assert rest.offsets == [0, 1000, 1501]


def test_rest_reading_fails_closed_after_the_page_cap_and_writes_nothing() -> None:
    class _Endless(_Rest):
        def get(self, url: str, **kwargs: Any) -> _Response:
            self.calls.append(("GET", url, kwargs))
            return _Response([{"normalized_email": f"x{index}@exemple.test"} for index in range(1000)])

    rest = _Endless()
    with pytest.raises(RuntimeError, match="trop de pages"):
        rest.run([_sale(EMAIL)])
    assert _writes(rest) == []
    assert len([call for call in rest.calls if call[0] == "GET"]) == registry.MAX_PAGES


def test_rest_existing_rows_are_read_by_chunks_of_sale_ids() -> None:
    sales = []
    ids: dict[str, str] = {}
    for index in range(120):
        url = f"{URL}?n={index}"
        sale = AuctionSale(
            source_name="licitor",
            source_url=url,
            sale_date=datetime.now(UTC) + timedelta(days=30),
            internal_contacts=[{"email": f"a{index}@exemple.test", "name": "", "role": "lawyer", "source_url": url}],
        )
        sales.append(sale)
        ids[url] = f"00000000-0000-4000-8000-{index:012d}"
    rest = _Rest()

    written = registry.write_internal_contacts_rest(
        "https://example.test", "key", sales, ids, NOW, get=rest.get, post=rest.post, patch=rest.patch
    )

    existing_reads = [c for c in rest.calls if c[0] == "GET" and "scope_sale_id" in c[2]["params"]]
    assert written == 120 and len(existing_reads) == 3  # 50 + 50 + 20
    assert all(c[2]["params"]["scope_sale_id"].count(",") < registry.SALE_ID_CHUNK for c in existing_reads)


def _opposition_reads(rest: _Rest) -> list[tuple[str, str, dict[str, Any]]]:
    return [c for c in rest.calls if c[0] == "GET" and c[2]["params"].get("opposition_status") == "eq.opposed"]


def _run_with_cache(rest: _Rest, cache: registry.OpposedAddressCache, sales: list[AuctionSale]) -> int:
    return registry.write_internal_contacts_rest(
        "https://example.test",
        "key",
        sales,
        {URL: SALE_ID},
        NOW,
        get=rest.get,
        post=rest.post,
        patch=rest.patch,
        opposed_cache=cache,
    )


def _sale_in_run(run_id: str | None, *emails: str) -> AuctionSale:
    sale = _sale(*emails)
    sale.last_run_id = run_id
    return sale


def test_the_opposition_list_is_read_once_per_run_and_not_for_every_batch() -> None:
    rest = _Rest(opposed=["opposee@exemple.test"])
    cache = registry.OpposedAddressCache()

    for _batch in range(3):
        assert _run_with_cache(rest, cache, [_sale_in_run("run-1", EMAIL)]) == 1
    assert len(_opposition_reads(rest)) == 2  # une page de résultats puis la page vide, une seule fois

    # Une adresse opposée reste refusée à partir du cache.
    assert _run_with_cache(rest, cache, [_sale_in_run("run-1", "opposee@exemple.test")]) == 0
    assert len(_opposition_reads(rest)) == 2


def test_the_opposition_list_is_read_again_for_a_new_run_or_after_the_delay() -> None:
    clock = [1000.0]
    rest = _Rest()
    cache = registry.OpposedAddressCache(ttl=60.0, clock=lambda: clock[0])

    _run_with_cache(rest, cache, [_sale_in_run("run-1", EMAIL)])
    _run_with_cache(rest, cache, [_sale_in_run("run-2", EMAIL)])
    assert len(_opposition_reads(rest)) == 2  # une lecture complète par run (liste vide : une seule page)

    clock[0] += 59.0
    _run_with_cache(rest, cache, [_sale_in_run("run-2", EMAIL)])
    assert len(_opposition_reads(rest)) == 2
    clock[0] += 2.0
    _run_with_cache(rest, cache, [_sale_in_run("run-2", EMAIL)])
    assert len(_opposition_reads(rest)) == 3


def test_a_new_opposition_is_honoured_as_soon_as_the_list_is_read_again() -> None:
    clock = [0.0]
    rest = _Rest()
    cache = registry.OpposedAddressCache(ttl=60.0, clock=lambda: clock[0])
    assert _run_with_cache(rest, cache, [_sale_in_run("run-1", EMAIL)]) == 1

    rest.opposed = [EMAIL]
    clock[0] = 61.0
    assert _run_with_cache(rest, cache, [_sale_in_run("run-1", EMAIL)]) == 0


def test_a_failed_opposition_read_leaves_nothing_in_the_cache_and_writes_nothing() -> None:
    class _Flaky(_Rest):
        fail = True

        def get(self, url: str, **kwargs: Any) -> _Response:
            if self.fail:
                return _Response(status_code=500)
            return super().get(url, **kwargs)

    rest = _Flaky()
    cache = registry.OpposedAddressCache()
    with pytest.raises(RuntimeError):
        _run_with_cache(rest, cache, [_sale_in_run("run-1", EMAIL)])
    assert cache.get("https://example.test/rest/v1/information_agent_contacts", frozenset({"run-1"})) is None
    assert _writes(rest) == []

    rest.fail = False
    assert _run_with_cache(rest, cache, [_sale_in_run("run-1", EMAIL)]) == 1


@pytest.fixture
def process_cache_with(monkeypatch: pytest.MonkeyPatch):
    """Branche un faux PostgREST sous write_safely (cache du processus vidé avant et après)."""

    def install(rest: _Rest) -> None:
        original = registry.write_internal_contacts_rest
        monkeypatch.setattr(
            registry,
            "write_internal_contacts_rest",
            lambda *args, **kwargs: original(*args, get=rest.get, post=rest.post, patch=rest.patch, **kwargs),
        )

    registry._OPPOSED_CACHE.clear()
    yield install
    registry._OPPOSED_CACHE.clear()


def test_write_safely_shares_one_opposition_read_between_batches(process_cache_with) -> None:
    rest = _Rest(opposed=["opposee@exemple.test"])
    process_cache_with(rest)

    for _batch in range(3):
        assert registry.write_safely(
            [_sale_in_run("run-1", EMAIL)], "https://example.test", "key", NOW, None, _ids
        ) == 1
    assert len(_opposition_reads(rest)) == 2


def test_stopping_at_the_page_limit_is_visible_in_the_log_without_any_address(
    caplog: pytest.LogCaptureFixture, process_cache_with
) -> None:
    class _Endless(_Rest):
        def get(self, url: str, **kwargs: Any) -> _Response:
            self.calls.append(("GET", url, kwargs))
            return _Response([{"normalized_email": f"x{index}@exemple.test"} for index in range(1000)])

    rest = _Endless()
    process_cache_with(rest)

    with caplog.at_level(logging.DEBUG):
        written = registry.write_safely([_sale(EMAIL)], "https://example.test", "key", NOW, None, _ids)

    assert written == 0 and _writes(rest) == []
    limit_logs = [record for record in caplog.records if "page limit" in record.getMessage()]
    assert limit_logs and limit_logs[0].levelno == logging.ERROR
    assert f"pages={registry.MAX_PAGES}" in limit_logs[0].getMessage()
    assert any("RegistryReadError" in record.getMessage() for record in caplog.records)
    assert "@" not in caplog.text
