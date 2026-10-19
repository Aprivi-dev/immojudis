"""Vidage de la boîte d'envoi d'invalidation du cache public (point 4, 18/10/2026)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from src import cache_invalidation
from src.cache_invalidation import (
    BATCH_SIZE,
    DELETE_SQL,
    MAX_BATCHES,
    REVALIDATE_PATH,
    SELECT_SQL,
    flush,
    main,
    post_revalidation,
    site_origin,
)

SECRET = "cron-secret-value"
SITE = "https://immojudis.com"


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class FakeDb:
    """Boîte d'envoi transactionnelle : une suppression n'existe qu'après le commit."""

    def __init__(self, rows, *, fail_select: Exception | None = None):
        self.rows = list(rows)  # [(id, sale_id)]
        self.pending_delete: list[int] = []
        self.statements: list[str] = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False
        self.fail_select = fail_select

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True
        return False

    def execute(self, statement, parameters=()):
        self.statements.append(statement)
        if statement == SELECT_SQL:
            if self.fail_select:
                raise self.fail_select
            (limit,) = parameters
            return _Cursor(self.rows[:limit])
        if statement == DELETE_SQL:
            (ids,) = parameters
            self.pending_delete.extend(ids)
            return _Cursor([])
        raise AssertionError(statement)

    def commit(self):
        self.commits += 1
        self.rows = [row for row in self.rows if row[0] not in self.pending_delete]
        self.pending_delete = []

    def rollback(self):
        self.rollbacks += 1
        self.pending_delete = []


class Poster:
    def __init__(self, *statuses: int):
        self.statuses = list(statuses)
        self.calls: list[tuple[str, list[str], str]] = []

    def __call__(self, url, sale_ids, secret):
        self.calls.append((url, list(sale_ids), secret))
        return self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]


def _run(db, poster, **options):
    return flush(
        db_url="postgres://x",
        site_url=SITE,
        cron_secret=SECRET,
        connect=lambda _url: db,
        post=poster,
        **options,
    )


def test_empty_box_makes_no_request():
    db = FakeDb([])
    poster = Poster(200)

    summary = _run(db, poster)

    assert poster.calls == []
    assert summary.batches == 0 and summary.rows_read == 0 and summary.error is None
    assert db.closed


def test_success_posts_distinct_ids_and_deletes_the_rows_read():
    # La vente 1 a deux bascules : un seul identifiant dans l'appel, les deux lignes supprimées.
    db = FakeDb([(1, _uuid(1)), (2, _uuid(2)), (3, _uuid(1).upper())])
    poster = Poster(200)

    summary = _run(db, poster)

    assert poster.calls == [(f"{SITE}{REVALIDATE_PATH}", [_uuid(1), _uuid(2)], SECRET)]
    assert db.rows == []
    assert db.commits == 1 and db.rollbacks == 0
    assert (summary.batches, summary.rows_read, summary.sales_notified) == (1, 3, 2)
    assert (summary.requests_ok, summary.requests_failed, summary.rows_deleted) == (1, 0, 3)
    assert summary.last_status == 200


@pytest.mark.parametrize("status", [0, 301, 307, 400, 401, 403, 404, 429, 500, 503])
def test_rows_are_kept_and_the_pass_stops_on_a_non_2xx_answer(status):
    db = FakeDb([(number, _uuid(number)) for number in range(1, 251)])
    poster = Poster(status)

    summary = _run(db, poster)

    assert len(poster.calls) == 1  # inutile d'insister : le passage s'arrête au premier échec
    assert len(db.rows) == 250
    assert db.commits == 0 and db.rollbacks == 1
    assert (summary.requests_ok, summary.requests_failed, summary.rows_deleted) == (0, 1, 0)
    assert summary.last_status == status


def test_a_2xx_range_is_accepted():
    for status in (200, 202, 204):
        db = FakeDb([(1, _uuid(1))])
        _run(db, Poster(status))
        assert db.rows == [], status


def test_batches_of_100_then_stops_when_a_later_batch_fails():
    db = FakeDb([(number, _uuid(number)) for number in range(1, 251)])
    poster = Poster(200, 200, 503)

    summary = _run(db, poster)

    assert [len(call[1]) for call in poster.calls] == [100, 100, 50]
    # Les deux premiers lots sont supprimés, le troisième reste.
    assert [row[0] for row in db.rows] == list(range(201, 251))
    assert (summary.batches, summary.requests_ok, summary.requests_failed) == (3, 2, 1)
    assert summary.rows_deleted == 200


def test_the_pass_is_bounded_by_the_maximum_number_of_batches():
    db = FakeDb([(number, _uuid(number)) for number in range(1, BATCH_SIZE * (MAX_BATCHES + 3) + 1)])
    poster = Poster(200)

    summary = _run(db, poster)

    assert len(poster.calls) == MAX_BATCHES
    assert summary.capped is True
    assert len(db.rows) == BATCH_SIZE * 3


def test_a_small_maximum_can_be_given():
    db = FakeDb([(number, _uuid(number)) for number in range(1, 8)])
    poster = Poster(200)

    summary = _run(db, poster, batch_size=3, max_batches=2)

    assert [len(call[1]) for call in poster.calls] == [3, 3]
    assert [row[0] for row in db.rows] == [7]
    assert summary.capped is True


def test_the_select_locks_with_skip_locked_and_reads_the_oldest_first():
    normalized = " ".join(SELECT_SQL.split())
    assert "for update skip locked" in normalized
    assert "order by at, id" in normalized
    assert "limit %s" in normalized
    assert BATCH_SIZE == 100  # le maximum de la route revalidate-sale


def test_flush_never_raises_on_a_database_error():
    db = FakeDb([], fail_select=RuntimeError("relation does not exist"))

    summary = _run(db, Poster(200))

    assert summary.error == "RuntimeError"
    assert db.closed


def test_flush_never_raises_when_the_connection_fails():
    def broken(_url):
        raise OSError("connection refused")

    summary = flush(db_url="postgres://x", site_url=SITE, cron_secret=SECRET, connect=broken, post=Poster(200))

    assert summary.error == "OSError"


def test_flush_never_raises_when_the_post_raises():
    db = FakeDb([(1, _uuid(1))])

    def boom(*_args):
        raise RuntimeError("boom")

    summary = _run(db, boom)

    assert summary.error == "RuntimeError"
    assert len(db.rows) == 1  # rien n'est supprimé


def test_an_invalid_site_url_skips_before_connecting():
    def never(_url):
        raise AssertionError("no connection expected")

    summary = flush(db_url="postgres://x", site_url="ftp://example.test", cron_secret=SECRET, connect=never)

    assert summary.skipped == "invalid_site_url"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://immojudis.com", "https://immojudis.com"),
        ("https://immojudis.com/", "https://immojudis.com"),
        ("  https://www.immojudis.com  ", "https://www.immojudis.com"),
        ("https://immojudis.com:8443", "https://immojudis.com:8443"),
        ("http://localhost:3102", "http://localhost:3102"),
        ("http://127.0.0.1:3102/", "http://127.0.0.1:3102"),
        ("http://immojudis.com", None),
        ("https://user:pw@immojudis.com", None),
        ("https://immojudis.com/app", None),
        ("https://immojudis.com/?a=1", None),
        ("https://immojudis.com/#x", None),
        ("javascript:alert(1)", None),
        ("immojudis.com", None),
        ("https://immojudis.com:abc", None),
        ("", None),
        (None, None),
    ],
)
def test_site_origin(value, expected):
    assert site_origin(value) == expected


def test_post_sends_the_bearer_secret_and_does_not_follow_redirects(monkeypatch):
    seen = {}

    def fake_post(url, **kwargs):
        seen["url"] = url
        seen.update(kwargs)
        return httpx.Response(204)

    monkeypatch.setattr(cache_invalidation.httpx, "post", fake_post)

    assert post_revalidation(f"{SITE}{REVALIDATE_PATH}", [_uuid(1)], SECRET) == 204
    assert seen["url"] == "https://immojudis.com/api/pipeline/revalidate-sale"
    assert seen["json"] == {"saleIds": [_uuid(1)]}
    assert seen["headers"]["authorization"] == f"Bearer {SECRET}"
    assert seen["timeout"] == 10.0
    assert seen["follow_redirects"] is False


def test_post_returns_zero_on_a_network_error(monkeypatch):
    def fake_post(*_args, **_kwargs):
        raise httpx.ConnectTimeout("timeout")

    monkeypatch.setattr(cache_invalidation.httpx, "post", fake_post)

    assert post_revalidation(f"{SITE}{REVALIDATE_PATH}", [_uuid(1)], SECRET) == 0


def test_main_reports_counters_without_the_secret(monkeypatch, capsys):
    db = FakeDb([(1, _uuid(1))])
    monkeypatch.setattr(cache_invalidation, "postgres_connect", lambda _url: db)
    monkeypatch.setattr(
        cache_invalidation,
        "flush",
        lambda **kwargs: flush(**kwargs, connect=lambda _url: db, post=Poster(200)),
    )

    code = main(
        ["--flush"],
        env={"SUPABASE_DB_URL": "postgres://user:dbpass@host/db", "SITE_URL": SITE, "CRON_SECRET": SECRET},
    )

    out = capsys.readouterr().out
    payload = json.loads(out.strip().splitlines()[-1])
    assert code == 0
    assert payload["event"] == "cache_invalidation"
    assert payload["rows_deleted"] == 1 and payload["requests_ok"] == 1
    assert SECRET not in out and "dbpass" not in out
    assert "::warning" not in out


def test_main_exits_zero_and_warns_when_the_site_answers_badly(monkeypatch, capsys):
    db = FakeDb([(1, _uuid(1))])
    monkeypatch.setattr(
        cache_invalidation,
        "flush",
        lambda **kwargs: flush(**kwargs, connect=lambda _url: db, post=Poster(503)),
    )

    code = main(["--flush"], env={"SUPABASE_DB_URL": "postgres://x", "SITE_URL": SITE, "CRON_SECRET": SECRET})

    out = capsys.readouterr().out
    assert code == 0
    assert "::warning title=Invalidate public cache::" in out
    assert len(db.rows) == 1
    assert SECRET not in out


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"SITE_URL": SITE, "CRON_SECRET": SECRET}, "missing_supabase_db_url"),
        ({"SUPABASE_DB_URL": "postgres://x", "CRON_SECRET": SECRET}, "missing_site_url"),
        ({"SUPABASE_DB_URL": "postgres://x", "SITE_URL": SITE}, "missing_cron_secret"),
        ({"SUPABASE_DB_URL": "postgres://x", "SITE_URL": SITE, "CRON_SECRET": "  "}, "missing_cron_secret"),
    ],
)
def test_main_skips_without_the_required_variables(monkeypatch, capsys, env, expected):
    def never(**_kwargs):
        raise AssertionError("no flush expected")

    monkeypatch.setattr(cache_invalidation, "flush", never)

    assert main(["--flush"], env=env) == 0
    out = capsys.readouterr().out
    assert json.loads(out.splitlines()[0])["skipped"] == expected
    assert "::warning" in out


def test_main_requires_the_flush_flag():
    with pytest.raises(SystemExit):
        main([], env={})


def test_the_migration_defines_what_the_flush_reads_and_deletes():
    migration = (
        Path(__file__).resolve().parents[3]
        / "supabase"
        / "migrations"
        / "20261028100000_catalogue_invalidations.sql"
    ).read_text(encoding="utf-8")

    assert "create table if not exists app_private.catalogue_invalidations" in migration
    assert "id bigint generated always as identity primary key" in migration
    assert "sale_id uuid not null" in migration
    assert "grant select, delete on table app_private.catalogue_invalidations to service_role" in migration
    assert "from app_private.catalogue_invalidations" in " ".join(SELECT_SQL.split())
