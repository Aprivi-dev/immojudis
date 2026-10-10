"""Suppression contrôlée des ventes aux informations insuffisantes (données fictives, aucune base de production)."""

import json
import os
import re
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src import recompute_scoring
from src.information_sufficiency import ContactBlocklist
from src.insufficient_sales import (
    Candidate,
    build_report,
    delete_batch,
    evaluate_rows,
)
from src.models import AuctionSale

GOOD_ADDRESS = "3 rue des Lilas, 59000 Exempleville"


def row(sale_id: str, **fields) -> dict:
    base = {
        "id": sale_id,
        "source_name": "licitor",
        "primary_source": "licitor",
        "source_url": f"https://example.test/vente/{sale_id}",
        "city": "Exempleville",
        "status": "upcoming",
        "updated_at": "2026-10-10T10:00:00+00:00",
    }
    base.update(fields)
    return base


def to_sale(stored: dict) -> AuctionSale:
    fields = {k: v for k, v in stored.items() if k in AuctionSale.model_fields}
    if "surface_m2" in fields:
        fields["surface_m2"] = Decimal(str(fields["surface_m2"]))
    return AuctionSale(**fields)


# ------------------------------------------------------------------ évaluation et rapport
def test_evaluate_rows_keeps_exempt_and_complete_sales_and_lists_the_rest():
    rows = [
        row("1", address=GOOD_ADDRESS, surface_m2=50),
        row("2", address=GOOD_ADDRESS),
        row("3", lawyer_contact="me.exemple@cabinet-exemple.test"),
        row("4", status="past"),
        row("5"),
    ]
    candidates, stats = evaluate_rows(rows, to_sale, ContactBlocklist())
    assert [(c.sale_id, c.reasons) for c in candidates] == [
        ("2", ("missing_surface",)),
        ("5", ("missing_address", "missing_surface")),
    ]
    assert stats["evaluated"] == 5 and stats["kept"] == 3 and stats["exempt"] == 1 and stats["insufficient"] == 2


def test_stored_status_wins_over_a_status_recomputed_by_normalisation():
    candidates, stats = evaluate_rows([row("9", status="adjudicated")], lambda r: to_sale({**r, "status": "upcoming"}),
                                      ContactBlocklist())
    assert candidates == [] and stats["exempt"] == 1


def test_an_unreadable_row_is_counted_and_never_proposed_for_deletion():
    def broken(_row):
        raise ValueError("payload illisible")

    candidates, stats = evaluate_rows([row("1")], broken, ContactBlocklist())
    assert candidates == [] and stats["unreadable"] == 1


def test_blocked_contact_makes_the_sale_a_candidate():
    contact = "me.exemple@cabinet-exemple.test"
    blocklist = ContactBlocklist(global_emails=frozenset({contact}))
    candidates, _ = evaluate_rows([row("3", lawyer_contact=contact)], to_sale, blocklist)
    assert [c.sale_id for c in candidates] == ["3"]


def test_report_protects_user_linked_sales_and_contains_only_ids_and_counts():
    contact = "me.exemple@cabinet-exemple.test"
    candidates, stats = evaluate_rows(
        [row("a", source_name="licitor", description=f"écrire à {contact}"), row("b"), row("c", primary_source="vench")],
        to_sale,
        ContactBlocklist(global_emails=frozenset({contact})),
    )
    links = {"protecting": {"user_favorites": {"b"}}, "informational": {"user_alert_matches": {"a", "b"}}}
    report = build_report(candidates, stats, links, include_user_linked=False)
    assert report["insufficient_total"] == 3
    assert report["protected_user_linked"] == ["b"]
    assert report["deletable_by_source"] == {"licitor": ["a"], "vench": ["c"]}
    assert report["links_among_candidates"] == {"protecting": {"user_favorites": 1}, "informational": {"user_alert_matches": 2}}
    assert contact not in json.dumps(report) and "Lilas" not in json.dumps(report)
    assert build_report(candidates, stats, links, include_user_linked=True)["deletable_total"] == 3


def test_links_are_read_per_table_in_chunks_of_one_hundred(monkeypatch):
    import httpx

    from src.insufficient_sales import fetch_links

    calls: list[tuple[str, str]] = []

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def fake_get(url, params, headers, timeout):
        table = url.rsplit("/", 1)[-1]
        column = params["select"]
        calls.append((table, params[column]))
        return Response([{column: "id-1"}] if table == "user_favorites" else [])

    monkeypatch.setattr(httpx, "get", fake_get)
    ids = [f"id-{i}" for i in range(150)]
    found = fetch_links({"supabase_url": "https://db.example.test", "supabase_service_role_key": "k"}, ids)
    assert found["protecting"]["user_favorites"] == {"id-1"}
    assert sum(1 for table, _ in calls if table == "user_favorites") == 2
    assert all(len(value.removeprefix("in.(").removesuffix(")").split(",")) <= 100 for _, value in calls)


# ------------------------------------------------------------------ ordre des suppressions (connexion simulée)
class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConnection:
    def __init__(self, sales, *, bridge_complete=True):
        self.sales = sales  # id -> (source_url, updated_at)
        self.bridge_complete = bridge_complete
        self.statements: list[str] = []

    def execute(self, sql, params=None):
        compact = " ".join(sql.split())
        self.statements.append(compact)
        if "pg_advisory_xact_lock" in compact:
            return FakeResult([])
        if compact.startswith("select id::text"):
            return FakeResult([(sid, url, updated) for sid, (url, updated) in self.sales.items()])
        if compact.startswith("select id from public.auction_sales where id <"):
            return FakeResult([])
        if "bridge_auction_sales_to_outcome_graph_batch" in compact:
            return FakeResult([(self.bridge_complete, next(iter(self.sales)))])
        return FakeResult([])


def candidate(sale_id, updated="2026-10-10T10:00:00+00:00"):
    return Candidate(sale_id, f"https://example.test/vente/{sale_id}", "licitor", updated, ("missing_surface",))


def test_deletion_follows_the_retention_order_without_any_tombstone():
    sid = str(uuid.uuid4())
    connection = FakeConnection({sid: (f"https://example.test/vente/{sid}", datetime(2026, 10, 10, 10, tzinfo=UTC))})
    assert delete_batch(connection, [candidate(sid)]) == (1, 0)
    statements = connection.statements
    order = [
        "pg_advisory_xact_lock",
        "bridge_auction_sales_to_outcome_graph_batch",
        "insert into public.sale_retention_storage_queue",
        "delete from public.valuation_estimates",
        "delete from public.information_agent_missions",
        "delete from public.lawyer_placement_events",
        "delete from public.lawyer_referral_requests",
        "delete from public.auction_observations",
        "delete from public.auction_sales",
    ]
    positions = [next(i for i, sql in enumerate(statements) if marker in sql) for marker in order]
    assert positions == sorted(positions)
    assert not any("tombstone" in sql for sql in statements)


def test_a_sale_updated_since_the_evaluation_is_skipped():
    sid = str(uuid.uuid4())
    connection = FakeConnection({sid: (f"https://example.test/vente/{sid}", datetime(2026, 10, 10, 11, tzinfo=UTC))})
    assert delete_batch(connection, [candidate(sid)]) == (0, 1)
    assert not any(sql.startswith("delete from public.auction_sales") for sql in connection.statements)


def test_an_incomplete_outcome_bridge_aborts_before_any_delete():
    sid = str(uuid.uuid4())
    connection = FakeConnection(
        {sid: (f"https://example.test/vente/{sid}", datetime(2026, 10, 10, 10, tzinfo=UTC))}, bridge_complete=False
    )
    with pytest.raises(RuntimeError, match="Outcome Graph"):
        delete_batch(connection, [candidate(sid)])
    assert not any(sql.startswith("delete from") for sql in connection.statements)


# ------------------------------------------------------------------ ligne de commande
def test_execute_drop_requires_drop_insufficient(monkeypatch):
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--execute-drop"])
    with pytest.raises(SystemExit):
        recompute_scoring.parse_args()


def test_drop_is_a_dry_run_by_default_and_never_takes_the_catalogue_lock(monkeypatch):
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--drop-insufficient"])
    args = recompute_scoring.parse_args()
    assert args.drop_insufficient and not args.execute_drop and args.max_deletions == 100
    assert recompute_scoring._writes_catalogue(args) is False
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--drop-insufficient", "--execute-drop"])
    assert recompute_scoring._writes_catalogue(recompute_scoring.parse_args()) is True


# ------------------------------------------------------------------ PostgreSQL jetable
SCHEMA = """
create table public.auction_sales (
  id uuid primary key, source_url text unique not null, source_name text, updated_at timestamptz not null default now());
create table public.sale_retention_storage_queue (bucket text, object_path text, primary key (bucket, object_path));
create table public.information_agent_evidence_assets (
  sale_id uuid, storage_bucket text, storage_path text, metadata jsonb not null default '{}');
create table public.auction_documents (source_url text, file_path text, document_url text);
create table public.valuation_estimates (id serial primary key,
  auction_sale_id uuid references public.auction_sales(id) on delete set null);
create table public.information_agent_missions (id serial primary key,
  sale_id uuid references public.auction_sales(id) on delete set null);
create table public.lawyer_placement_events (id serial primary key,
  sale_id uuid references public.auction_sales(id) on delete set null);
create table public.lawyer_referral_requests (id serial primary key,
  sale_id uuid references public.auction_sales(id) on delete set null);
create table public.auction_observations (id serial primary key, source_url text,
  canonical_source_url text references public.auction_sales(source_url) on delete set null);
create table public.user_favorites (user_id uuid, sale_id uuid references public.auction_sales(id) on delete cascade);
create table public.auction_sale_retention_tombstones (source_url text primary key, sale_date timestamptz);
create table public.auction_sale_outcome_bridges (auction_sale_id uuid);
create function public.bridge_auction_sales_to_outcome_graph_batch(p_after_id uuid default null, p_limit integer default 25)
returns table(scanned_count bigint, created_count bigint, reused_count bigint, linked_count bigint,
              complete boolean, next_cursor uuid, has_more boolean)
language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from public.auction_sales where p_after_id is null or id > p_after_id order by id limit 1;
  insert into public.auction_sale_outcome_bridges(auction_sale_id) values (v_id);
  return query select 1::bigint, 1::bigint, 0::bigint, 0::bigint, true, v_id, false;
end $$;
create function public.require_bridge_before_delete() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.auction_sale_outcome_bridges where auction_sale_id = old.id) then
    raise exception 'auction_sales rows must have a complete Outcome Graph bridge before deletion.';
  end if;
  return old;
end $$;
create trigger require_bridge_before_delete before delete on public.auction_sales
  for each row execute function public.require_bridge_before_delete();
"""


@pytest.fixture
def scratch_database():
    base = os.getenv("PIPELINE_TEST_DB_URL")
    if not base:
        pytest.skip("Requires disposable PostgreSQL")
    import psycopg

    name = f"insufficient_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f'create database "{name}"')
    url = re.sub(r"/[^/?]+(\?|$)", rf"/{name}\1", base, count=1)
    try:
        with psycopg.connect(url) as setup:
            setup.execute(SCHEMA)
        yield url
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')


def test_real_postgres_deletion_keeps_other_sales_and_writes_no_tombstone(scratch_database):
    import psycopg

    keep, drop_a, drop_b = (str(uuid.uuid4()) for _ in range(3))
    with psycopg.connect(scratch_database) as db:
        for sid in (keep, drop_a, drop_b):
            db.execute(
                "insert into public.auction_sales(id, source_url, source_name, updated_at) values (%s, %s, 'licitor', %s)",
                (sid, f"https://example.test/vente/{sid}", "2026-10-10T10:00:00+00:00"),
            )
        db.execute("insert into public.valuation_estimates(auction_sale_id) values (%s)", (drop_a,))
        db.execute("insert into public.auction_observations(source_url, canonical_source_url) values (%s, %s)",
                   (f"https://example.test/vente/{drop_a}", f"https://example.test/vente/{drop_a}"))
        db.execute("insert into public.user_favorites(user_id, sale_id) values (%s, %s)", (str(uuid.uuid4()), keep))
        db.execute("insert into public.auction_documents values (%s, %s, %s)",
                   (f"https://example.test/vente/{drop_b}", f"{drop_b}/pv.pdf",
                    "https://x.test/storage/v1/object/public/information-agent-approved/pv.pdf"))
    with psycopg.connect(scratch_database) as db:
        deleted, skipped = delete_batch(db, [candidate(drop_a), candidate(drop_b)])
    assert (deleted, skipped) == (2, 0)
    with psycopg.connect(scratch_database) as db:
        remaining = {str(r[0]) for r in db.execute("select id from public.auction_sales").fetchall()}
        assert remaining == {keep}
        assert db.execute("select count(*) from public.auction_sale_retention_tombstones").fetchone()[0] == 0
        assert db.execute("select count(*) from public.valuation_estimates").fetchone()[0] == 0
        assert db.execute("select count(*) from public.auction_observations").fetchone()[0] == 0
        assert db.execute("select count(*) from public.user_favorites").fetchone()[0] == 1
        queued = db.execute("select bucket, object_path from public.sale_retention_storage_queue").fetchall()
        assert queued == [("information-agent-approved", f"{drop_b}/pv.pdf")]


def test_real_postgres_skips_a_sale_updated_after_the_evaluation(scratch_database):
    import psycopg

    sid = str(uuid.uuid4())
    with psycopg.connect(scratch_database) as db:
        db.execute(
            "insert into public.auction_sales(id, source_url, source_name, updated_at) values (%s, %s, 'licitor', %s)",
            (sid, f"https://example.test/vente/{sid}", "2026-10-10T12:00:00+00:00"),
        )
    with psycopg.connect(scratch_database) as db:
        assert delete_batch(db, [candidate(sid, updated="2026-10-10T10:00:00+00:00")]) == (0, 1)
    with psycopg.connect(scratch_database) as db:
        assert db.execute("select count(*) from public.auction_sales").fetchone()[0] == 1
