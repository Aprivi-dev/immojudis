"""Traces de rétention : une ligne refusée par le déclencheur SQL ne bloque plus le lot."""

import os
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from src import main
from src.models import AuctionSale
from src.retention_tombstones import (
    CHUNK,
    QUERY,
    RETENTION_TOMBSTONE_REASON,
    TRIGGER_MESSAGE,
    blocks,
    drop_retired,
    publish_batch,
)

MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "supabase/migrations/20261003130000_catalogue_expiry_retention_tombstones.sql"
)
FUTURE = datetime(2099, 1, 10, 9, 0, tzinfo=UTC)
LATER = datetime(2099, 6, 1, 9, 0, tzinfo=UTC)
RETIRED = datetime(2026, 9, 1, 9, 0, tzinfo=UTC)
URL = "https://example.test/{}"


def sale(name: str, sale_date: datetime | None = FUTURE) -> AuctionSale:
    return AuctionSale(
        source_name="cessions_etat",
        source_url=URL.format(name),
        city="Exempleville",
        address="3 rue des Lilas, 59000 Exempleville",
        starting_price_eur=Decimal("50000"),
        surface_m2=Decimal("40"),
        sale_date=sale_date,
    )


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _Connection:
    """Table des traces simulée ; compte les lectures."""

    def __init__(self, tombstones: dict[str, datetime | None]):
        self.tombstones, self.queries = tombstones, []

    def execute(self, query, params=()):
        self.queries.append((query, params))
        return _Result([(url, date) for url, date in self.tombstones.items() if url in params[0]])


def test_the_trigger_message_is_the_one_raised_by_the_migration():
    text = MIGRATION.read_text(encoding="utf-8")
    assert f"message = '{TRIGGER_MESSAGE}.'" in text
    assert "errcode = '23505'" in text


def test_predicate_is_the_trigger_predicate():
    url = URL.format("a")
    assert blocks(url, FUTURE, {url: None})  # tombstone without date
    assert blocks(url, None, {url: RETIRED})  # sale without date
    assert blocks(url, RETIRED, {url: RETIRED})  # equality included
    assert blocks(url, datetime(2026, 8, 1, tzinfo=UTC), {url: RETIRED})
    assert not blocks(url, FUTURE, {url: RETIRED})  # strictly later date
    assert not blocks(url, None, {})
    assert not blocks(url, None, {URL.format("other"): None})
    assert blocks(url, datetime(2026, 9, 1, 9, 0), {url: RETIRED})  # naive read as UTC


def test_nothing_is_read_outside_publish_batch():
    connection = _Connection({URL.format("a"): None})
    resolved = [sale("a")]
    assert drop_retired(connection, resolved, resolved) == resolved
    assert connection.queries == []


def _publisher(tombstones, written, resolve=None):
    """Imite ``upsert_sales_to_supabase`` : résolution d'identité, puis ``drop_retired``, puis écriture."""
    connection = _Connection(tombstones)

    def publish(group):
        resolved = resolve(group) if resolve else list(group)
        kept = drop_retired(connection, resolved, group)
        written.extend(item.source_url for item in kept)
        return len(kept)

    publish.connection = connection
    return publish


def _recorder(decisions):
    def record(run_id, group, *, decision, reason=None):
        decisions.append((run_id, [item.source_url for item in group], decision, reason))

    return record


def test_undated_sale_with_tombstone_is_set_aside_as_expired_and_the_five_others_are_published():
    retired = sale("ancien-logement-de-fonction", sale_date=None)
    others = [sale(f"vente-{index}") for index in range(5)]
    written, decisions, kept = [], [], [retired, *others]
    publish = _publisher({retired.source_url: RETIRED}, written)
    result = publish_batch([retired, *others], publish, "run-1", _recorder(decisions), {}, kept)
    assert written == [item.source_url for item in others]
    assert (result.count, result.sales) == (5, others)
    assert decisions == [("run-1", [retired.source_url], "expired", RETENTION_TOMBSTONE_REASON)]
    assert kept == others  # not republished by the final stage of the run
    assert len(publish.connection.queries) == 1 and publish.connection.queries[0][0] == QUERY


def test_dated_sale_without_tombstone_or_after_the_tombstone_date_is_published():
    plain, rescheduled = sale("plain"), sale("rescheduled", sale_date=LATER)
    written, decisions = [], []
    publish = _publisher({rescheduled.source_url: RETIRED}, written)
    result = publish_batch([plain, rescheduled], publish, "run-1", _recorder(decisions), {})
    assert written == [plain.source_url, rescheduled.source_url]
    assert result.sales == [plain, rescheduled] and decisions == []


def test_a_sale_attached_to_a_live_row_is_published_even_if_its_own_url_has_a_tombstone():
    # B (undated, tombstone on its URL) resolves to the live row A (no tombstone): the database
    # would accept it as an update of A, so it must not be classified expired.
    incoming = sale("b", sale_date=None)
    live = sale("a")

    def resolve(group):
        for item in group:  # what resolve_publication_identities does to the caller's object
            item.source_url, item.sale_date = live.source_url, live.sale_date
        return [live]

    written, decisions = [], []
    publish = _publisher({URL.format("b"): RETIRED}, written, resolve)
    result = publish_batch([incoming], publish, "run-1", _recorder(decisions), {})
    assert written == [live.source_url]
    assert result.count == 1 and decisions == []


def test_a_sale_attached_to_a_retired_row_is_set_aside_with_the_caller_object():
    incoming = sale("b")
    retired_row = sale("a", sale_date=None)

    def resolve(group):
        for item in group:
            item.source_url = retired_row.source_url
        return [retired_row]

    written, decisions, kept = [], [], [incoming]
    publish = _publisher({URL.format("a"): RETIRED}, written, resolve)
    publish_batch([incoming], publish, "run-1", _recorder(decisions), {}, kept)
    assert written == [] and kept == []
    assert decisions == [("run-1", [URL.format("a")], "expired", RETENTION_TOMBSTONE_REASON)]


def _refusing(bad: set[str], published: list[str], other_error: set[str] = frozenset()):
    def publish(group):
        urls = [item.source_url for item in group]
        published.append(urls)
        if any(url in bad for url in urls):
            raise RuntimeError(f"{TRIGGER_MESSAGE}.")
        if any(url in other_error for url in urls):
            raise RuntimeError("boom")
        return len(group)

    return publish


def test_only_the_faulty_group_is_republished_one_by_one():
    sales = [sale(f"s{index}") for index in range(CHUNK + 5)]
    bad = URL.format(f"s{CHUNK + 2}")  # second group
    calls: list[list[str]] = []
    decisions: list = []
    errors: dict[str, list[str]] = {}
    kept = list(sales)
    result = publish_batch(sales, _refusing({bad}, calls), "run-1", _recorder(decisions), errors, kept)
    first_group = [item.source_url for item in sales[:CHUNK]]
    assert calls[0] == first_group and calls.count(first_group) == 1  # committed group never replayed
    assert calls[1] == [item.source_url for item in sales[CHUNK:]]
    assert calls[2:] == [[item.source_url] for item in sales[CHUNK:]]
    assert result.count == CHUNK + 4
    assert decisions == [("run-1", [bad], "expired", RETENTION_TOMBSTONE_REASON)]
    assert errors == {} and bad not in [item.source_url for item in kept]


def test_another_error_in_the_fallback_only_fails_its_own_row():
    sales = [sale("a"), sale("b"), sale("c")]
    decisions: list = []
    errors: dict[str, list[str]] = {}
    result = publish_batch(
        sales,
        _refusing({URL.format("a")}, [], other_error={URL.format("c")}),
        "run-1",
        _recorder(decisions),
        errors,
    )
    assert result.sales == [sales[1]]
    assert decisions == [
        ("run-1", [URL.format("a")], "expired", RETENTION_TOMBSTONE_REASON),
        ("run-1", [URL.format("c")], "publication_failed", "boom"),
    ]
    assert errors == {"supabase": ["boom"]}


def test_an_unrelated_group_error_is_raised_as_before():
    with pytest.raises(RuntimeError, match="boom"):
        publish_batch(
            [sale("a"), sale("b")], _refusing(set(), [], other_error={URL.format("a")}), "run-1", _recorder([]), {}
        )


def test_a_failing_decision_journal_does_not_stop_the_fallback():
    sales = [sale("a"), sale("b")]

    def broken(run_id, group, **kw):
        raise OSError("journal down")

    result = publish_batch(sales, _refusing({URL.format("a")}, []), "run-1", broken, {})
    assert result.sales == [sales[1]]


@pytest.fixture
def factual_batch(monkeypatch):
    """``publish_factual_batch`` avec ses collaborateurs remplacés ; renvoie ce qui est écrit."""
    state = {"decisions": [], "written": [], "tombstones": {}}
    by_url: dict[str, AuctionSale] = {}
    monkeypatch.setattr(main, "record_items", lambda *a, **k: None)
    monkeypatch.setattr(main, "_hydrate_known_unchanged_sales", lambda *a, **k: None)
    monkeypatch.setattr(main, "_preserve_known_enrichment_payloads", lambda *a, **k: None)
    monkeypatch.setattr(main, "record_source_checks", lambda *a, **k: None)
    monkeypatch.setattr(main, "normalize_sale", lambda raw: by_url[raw["source_url"]])
    monkeypatch.setattr(main, "_finalize_sale_for_app", lambda *a, **k: None)
    monkeypatch.setattr(main, "merge_duplicate_sales", lambda sales: sales)
    monkeypatch.setattr(main, "mark_past_sales", lambda sales: None)
    monkeypatch.setattr(
        main,
        "record_sale_decisions",
        lambda run_id, group, *, decision, reason=None, **k: state["decisions"].append(
            ([item.source_url for item in group], decision, reason)
        ),
    )

    def run(sales: list[AuctionSale]) -> dict:
        by_url.update({item.source_url: item for item in sales})
        monkeypatch.setattr(main, "upsert_sales_to_supabase", _publisher(state["tombstones"], state["written"]))
        errors: dict[str, list[str]] = {}
        main.publish_factual_batch("run-1", [{"source_url": item.source_url} for item in sales], {}, errors)
        state["errors"] = errors
        return state

    return run, state


def test_publish_factual_batch_publishes_the_other_five_when_one_has_a_tombstone(factual_batch):
    run, state = factual_batch
    retired = sale("ancien-logement-de-fonction", sale_date=None)
    others = [sale(f"vente-{index}") for index in range(5)]
    state["tombstones"] = {retired.source_url: RETIRED}
    run([retired, *others])
    assert state["written"] == [item.source_url for item in others]
    assert ([retired.source_url], "expired", "retention_tombstone") in state["decisions"]
    assert not [d for d in state["decisions"] if d[1] == "publication_failed"]
    assert state["errors"] == {}


def test_publish_factual_batch_publishes_a_dated_sale_without_tombstone(factual_batch):
    run, state = factual_batch
    dated = sale("datee")
    run([dated])
    assert state["written"] == [dated.source_url] and state["decisions"] == []


def test_the_trigger_and_the_predicate_agree_on_a_real_database():
    """Équivalence contre le vrai déclencheur (base jetable) pour toutes les combinaisons de dates."""
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    from src.storage.supabase_client import _postgres_connect

    text = MIGRATION.read_text(encoding="utf-8")
    table = text[text.index("create table if not exists public.auction_sale_retention_tombstones"):]
    table = table[: table.index(");") + 2]
    function = text[text.index("create or replace function app_private.prevent_retention_tombstone_reimport()"):]
    function = function[: function.index("$$;") + 3]
    dates = [None, RETIRED, datetime(2026, 8, 1, tzinfo=UTC), datetime(2026, 10, 1, tzinfo=UTC)]
    with _postgres_connect(url) as db:
        try:
            db.execute("create schema if not exists app_private")
            db.execute("create schema if not exists public")
            db.execute(table)
            db.execute(function)
            db.execute("create table public.auction_sales(source_url text, sale_date timestamptz)")
            db.execute(
                "create trigger guard before insert on public.auction_sales for each row "
                "execute function app_private.prevent_retention_tombstone_reimport()"
            )
            checked = 0
            for tombstone_date in dates:
                for sale_date in dates:
                    for with_tombstone in (True, False):
                        name = f"t{checked}"
                        if with_tombstone:
                            db.execute(
                                "insert into public.auction_sale_retention_tombstones(source_url, sale_date) values (%s, %s)",
                                (URL.format(name), tombstone_date),
                            )
                        db.execute("savepoint attempt")
                        try:
                            db.execute(
                                "insert into public.auction_sales(source_url, sale_date) values (%s, %s)",
                                (URL.format(name), sale_date),
                            )
                            refused = False
                        except Exception as exc:
                            assert TRIGGER_MESSAGE in str(exc)
                            refused = True
                            db.execute("rollback to savepoint attempt")
                        expected = blocks(
                            URL.format(name), sale_date, {URL.format(name): tombstone_date} if with_tombstone else {}
                        )
                        assert refused == expected, (tombstone_date, sale_date, with_tombstone)
                        checked += 1
            rows = db.execute(QUERY, ([URL.format("t0"), URL.format("t1")],)).fetchall()
            assert {row[0] for row in rows} <= {URL.format("t0"), URL.format("t1")}
        finally:
            db.rollback()
