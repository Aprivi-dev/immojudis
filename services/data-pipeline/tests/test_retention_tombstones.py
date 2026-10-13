"""Traces de rétention : les ventes que le déclencheur SQL refuserait sont écartées avant l'écriture."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src import admission, main
from src.admission import admit_sales
from src.models import AuctionSale
from src.retention_tombstones import (
    RETENTION_TOMBSTONE_REASON,
    TRIGGER_MESSAGE,
    blocks,
    load_retention_tombstones,
    publish_batch,
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


def test_predicate_is_the_trigger_predicate():
    url = URL.format("a")
    # tombstone.sale_date is null -> any date is refused
    assert blocks(url, FUTURE, {url: None})
    # new.sale_date is null -> refused whatever the tombstone date
    assert blocks(url, None, {url: RETIRED})
    # new.sale_date <= tombstone.sale_date -> refused (equality included)
    assert blocks(url, RETIRED, {url: RETIRED})
    assert blocks(url, datetime(2026, 8, 1, tzinfo=UTC), {url: RETIRED})
    # strictly later date -> admissible again
    assert not blocks(url, FUTURE, {url: RETIRED})
    # no tombstone for this URL (or another URL) -> admissible
    assert not blocks(url, None, {})
    assert not blocks(url, None, {URL.format("other"): None})
    # naive datetimes are read as UTC, like elsewhere in the pipeline
    assert blocks(url, datetime(2026, 9, 1, 9, 0), {url: RETIRED})


def test_undated_sale_with_tombstone_is_set_aside_as_expired_and_the_others_are_kept():
    retired = sale("ancien-logement-de-fonction", sale_date=None)
    others = [sale(f"vente-{index}") for index in range(5)]
    recorded: list[tuple[list[str], str, str | None]] = []

    def record(group, decision, reason=None):
        recorded.append(([item.source_url for item in group], decision, reason))

    tombstones = {retired.source_url: RETIRED}
    admitted = admit_sales([retired, *others], record, tombstones=tombstones)

    assert admitted == others
    assert recorded == [([retired.source_url], "expired", RETENTION_TOMBSTONE_REASON)]
    assert RETENTION_TOMBSTONE_REASON == "retention_tombstone"


def test_future_sale_without_tombstone_is_published_and_a_later_date_than_the_tombstone_too():
    plain = sale("plain")
    rescheduled = sale("rescheduled", sale_date=LATER)
    recorded: list[tuple] = []
    admitted = admit_sales(
        [plain, rescheduled],
        lambda group, **kw: recorded.append((group, kw)),
        tombstones={rescheduled.source_url: RETIRED},
    )
    assert admitted == [plain, rescheduled]
    assert recorded == []


def test_without_tombstones_admission_is_unchanged():
    undated = sale("undated", sale_date=None)
    assert admit_sales([undated], lambda *a, **k: None) == [undated]
    assert admit_sales([undated], lambda *a, **k: None, tombstones={}) == [undated]


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _Connection:
    def __init__(self, rows, queries):
        self.rows, self.queries = rows, queries

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=()):
        self.queries.append((query, params))
        return _Result(self.rows)


def test_tombstones_are_read_with_one_query_for_the_whole_batch():
    queries: list[tuple] = []
    sales = [sale("a"), sale("b", sale_date=None), sale("a")]
    rows = [(URL.format("b"), RETIRED)]
    result = load_retention_tombstones(
        sales, db_url="postgresql://unused", connect=lambda url: _Connection(rows, queries)
    )
    assert result == {URL.format("b"): RETIRED}
    assert len(queries) == 1
    query, params = queries[0]
    assert "public.auction_sale_retention_tombstones" in query
    assert params == ([URL.format("a"), URL.format("b")],)


def test_unreadable_tombstones_set_nothing_aside():
    def broken(url):
        raise OSError("down")

    assert load_retention_tombstones([sale("a")], db_url="postgresql://unused", connect=broken) == {}
    assert load_retention_tombstones([sale("a")], db_url="") == {}
    assert load_retention_tombstones([], db_url="postgresql://unused") == {}


def _refusing(bad: set[str], published: list[str], other_error: set[str] = frozenset()):
    def publish(group):
        urls = [item.source_url for item in group]
        if any(url in bad for url in urls):
            raise RuntimeError(f"{TRIGGER_MESSAGE}.")
        if any(url in other_error for url in urls):
            raise RuntimeError("boom")
        published.extend(urls)
        return len(group)

    return publish


def _recorder(decisions: list):
    def record(run_id, group, *, decision, reason=None):
        decisions.append((run_id, [item.source_url for item in group], decision, reason))

    return record


def test_one_refused_row_no_longer_blocks_the_batch():
    sales = [sale("a"), sale("b"), sale("c")]
    published: list[str] = []
    decisions: list = []
    errors: dict[str, list[str]] = {}
    kept = list(sales)
    result = publish_batch(
        sales, _refusing({URL.format("b")}, published), "run-1", _recorder(decisions), errors, kept
    )
    assert published == [URL.format("a"), URL.format("c")]
    assert result.count == 2
    assert result.sales == [sales[0], sales[2]]
    assert decisions == [("run-1", [URL.format("b")], "expired", "retention_tombstone")]
    assert errors == {}
    assert kept == [sales[0], sales[2]]  # no longer republished at the end of the run


def test_another_error_in_the_fallback_only_fails_its_own_row():
    sales = [sale("a"), sale("b"), sale("c")]
    published: list[str] = []
    decisions: list = []
    errors: dict[str, list[str]] = {}
    result = publish_batch(
        sales,
        _refusing({URL.format("a")}, published, other_error={URL.format("c")}),
        "run-1",
        _recorder(decisions),
        errors,
    )
    assert published == [URL.format("b")]
    assert result.sales == [sales[1]]
    assert decisions == [
        ("run-1", [URL.format("a")], "expired", "retention_tombstone"),
        ("run-1", [URL.format("c")], "publication_failed", "boom"),
    ]
    assert errors == {"supabase": ["boom"]}


def test_an_unrelated_batch_error_is_raised_as_before():
    with pytest.raises(RuntimeError, match="boom"):
        publish_batch(
            [sale("a"), sale("b")],
            _refusing(set(), [], other_error={URL.format("a")}),
            "run-1",
            _recorder([]),
            {},
        )


def test_a_clean_batch_is_published_once():
    sales = [sale("a"), sale("b")]
    published: list[str] = []
    result = publish_batch(sales, _refusing(set(), published), "run-1", _recorder([]), {})
    assert published == [URL.format("a"), URL.format("b")]
    assert (result.count, result.sales) == (2, sales)


@pytest.fixture
def factual_batch(monkeypatch):
    """``publish_factual_batch`` with its collaborators replaced; returns what was written."""
    state = {"decisions": [], "upserts": [], "tombstones": {}, "refused": set()}
    by_url: dict[str, AuctionSale] = {}

    def upsert(group):
        state["upserts"].append([item.source_url for item in group])
        if any(item.source_url in state["refused"] for item in group):
            raise RuntimeError(f"{TRIGGER_MESSAGE}.")
        return len(group)

    monkeypatch.setattr(main, "record_items", lambda *a, **k: None)
    monkeypatch.setattr(main, "_hydrate_known_unchanged_sales", lambda *a, **k: None)
    monkeypatch.setattr(main, "_preserve_known_enrichment_payloads", lambda *a, **k: None)
    monkeypatch.setattr(main, "record_source_checks", lambda *a, **k: None)
    monkeypatch.setattr(main, "normalize_sale", lambda raw: by_url[raw["source_url"]])
    monkeypatch.setattr(main, "_finalize_sale_for_app", lambda *a, **k: None)
    monkeypatch.setattr(main, "merge_duplicate_sales", lambda sales: sales)
    monkeypatch.setattr(main, "mark_past_sales", lambda sales: None)
    monkeypatch.setattr(main, "upsert_sales_to_supabase", upsert)
    monkeypatch.setattr(
        main,
        "record_sale_decisions",
        lambda run_id, group, *, decision, reason=None, **k: state["decisions"].append(
            ([item.source_url for item in group], decision, reason)
        ),
    )
    monkeypatch.setattr(admission, "load_retention_tombstones", lambda sales: state["tombstones"])

    def run(sales: list[AuctionSale]) -> dict:
        by_url.update({item.source_url: item for item in sales})
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
    state["refused"] = {retired.source_url}

    run([retired, *others])

    assert state["upserts"] == [[item.source_url for item in others]]
    assert (
        [retired.source_url],
        "expired",
        "retention_tombstone",
    ) in state["decisions"]
    assert not [d for d in state["decisions"] if d[1] == "publication_failed"]
    assert state["errors"] == {}


def test_publish_factual_batch_falls_back_row_by_row_when_the_lookup_missed_the_tombstone(factual_batch):
    run, state = factual_batch
    retired = sale("ancien-logement-de-fonction", sale_date=None)
    others = [sale(f"vente-{index}") for index in range(2)]
    state["refused"] = {retired.source_url}  # database refuses, lookup saw nothing

    run([retired, *others])

    assert state["upserts"][0] == [item.source_url for item in (retired, *others)]
    assert state["upserts"][1:] == [[item.source_url] for item in (retired, *others)]
    assert ([retired.source_url], "expired", "retention_tombstone") in state["decisions"]
    assert not [d for d in state["decisions"] if d[1] == "publication_failed"]
    assert state["errors"] == {}


def test_publish_factual_batch_publishes_a_dated_sale_without_tombstone(factual_batch):
    run, state = factual_batch
    dated = sale("datee")
    run([dated])
    assert state["upserts"] == [[dated.source_url]]
    assert state["decisions"] == []


def test_admit_unretired_forgets_the_retired_sale_in_place(monkeypatch):
    retired = sale("ancien-logement-de-fonction", sale_date=None)
    others = [sale("a"), sale("b")]
    monkeypatch.setattr(admission, "load_retention_tombstones", lambda sales: {retired.source_url: RETIRED})
    kept = [retired, *others]
    recorded: list = []
    admitted = admission.admit_unretired(
        [retired, *others], lambda group, **kw: recorded.append((group, kw)), forget=kept
    )
    assert admitted == others
    assert kept == others
    assert recorded == [([retired], {"decision": "expired", "reason": "retention_tombstone"})]
