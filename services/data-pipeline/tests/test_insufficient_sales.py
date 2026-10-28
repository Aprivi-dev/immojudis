"""Suppression contrôlée des ventes aux informations insuffisantes (données fictives, aucune base de production)."""

import inspect
import json
from decimal import Decimal

import pytest

from src import insufficient_sales, recompute_scoring
from src.information_sufficiency import ContactBlocklist
from src.insufficient_sales import (
    CLEANUP_FUNCTION_MAX,
    build_report,
    drop_insufficient_sales,
    evaluate_rows,
    execute_empty_listing_cleanup,
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
def test_evaluate_rows_keeps_listings_with_the_minimum_and_lists_the_rest():
    rows = [
        row("1", address=GOOD_ADDRESS, surface_m2=50),
        row("2", address=GOOD_ADDRESS),
        row("3", lawyer_contact="me.exemple@cabinet-exemple.test"),
        row("4", status="past"),
        row("5", lawyer_name="Maître Exemple", lawyer_contact="04 00 00 00 00"),
    ]
    candidates, stats = evaluate_rows(rows, to_sale, ContactBlocklist())
    # Un nom d'avocat ou un téléphone seul ne suffit pas, ni une vente passée sans le minimum.
    assert [(c.sale_id, c.reasons) for c in candidates] == [
        ("4", ("insufficient_listing",)),
        ("5", ("insufficient_listing",)),
    ]
    assert stats["evaluated"] == 5 and stats["kept"] == 3 and stats["insufficient"] == 2


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


def test_report_marks_user_linked_sales_and_contains_only_ids_and_counts():
    contact = "me.exemple@cabinet-exemple.test"
    candidates, stats = evaluate_rows(
        [row("a", source_name="licitor", description=f"écrire à {contact}"), row("b"), row("c", primary_source="vench")],
        to_sale,
        ContactBlocklist(global_emails=frozenset({contact})),
    )
    links = {"protecting": {"user_favorites": {"b"}}, "informational": {"user_alert_matches": {"a", "b"}}}
    report = build_report(candidates, stats, links)
    assert report["insufficient_total"] == 3
    assert report["protected_user_linked"] == ["b"]
    assert report["deletable_by_source"] == {"licitor": ["a"], "vench": ["c"]}
    assert report["links_among_candidates"] == {"protecting": {"user_favorites": 1}, "informational": {"user_alert_matches": 2}}
    assert contact not in json.dumps(report) and "Lilas" not in json.dumps(report)


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


# ------------------------------------------------------------------ suppression par la fonction SQL (connexion simulée)
class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConnection:
    """Base simulée : ``app_private.delete_empty_listings`` rend un compte rendu par mode."""

    def __init__(self, deletable):
        self.deletable = deletable
        self.statements: list[tuple[str, tuple]] = []

    def execute(self, sql, params=()):
        compact = " ".join(sql.split())
        self.statements.append((compact, tuple(params)))
        if "delete_empty_listings" in compact:
            applied = compact.endswith("true)")
            report = {"deletable": self.deletable, "deleted": self.deletable if applied else 0, "skipped": 0,
                      "kept_for_user_trace": 1, "kept_for_known_outcome": 0, "set_aside_by_blocking_link": 0,
                      "kept_after_recheck": 0, "applied": applied}
            return FakeResult([(report,)])
        return FakeResult([])


def test_execute_drop_goes_through_the_sql_function_after_a_count():
    connection = FakeConnection(deletable=3)
    result = execute_empty_listing_cleanup(connection, 100)
    calls = [(sql, params) for sql, params in connection.statements if "delete_empty_listings" in sql]
    assert calls == [
        ("select app_private.delete_empty_listings(%s, false)", (CLEANUP_FUNCTION_MAX,)),
        ("select app_private.delete_empty_listings(%s, true)", (100,)),
    ]
    assert result["deleted"] == 3
    # Aucune suppression directe : ni liste de protection figée, ni delete SQL dans le module.
    assert not any(sql.startswith("delete from") for sql, _ in connection.statements)
    assert connection.statements[0][0].startswith("set local lock_timeout")


def test_execute_drop_refuses_above_the_ceiling_and_deletes_nothing():
    connection = FakeConnection(deletable=101)
    assert execute_empty_listing_cleanup(connection, 100) is None
    assert not any(sql.endswith("true)") for sql, _ in connection.statements)


@pytest.mark.parametrize("ceiling", [0, -1, CLEANUP_FUNCTION_MAX + 1])
def test_execute_drop_needs_a_ceiling_the_function_accepts(ceiling):
    with pytest.raises(ValueError):
        execute_empty_listing_cleanup(FakeConnection(deletable=0), ceiling)


def test_the_module_no_longer_deletes_rows_itself():
    source = inspect.getsource(insufficient_sales)
    assert "delete from" not in source
    assert "delete_batch" not in source and not hasattr(insufficient_sales, "delete_batch")


@pytest.mark.parametrize("scope", [{"source": "licitor", "limit": None}, {"source": None, "limit": 10}])
def test_execute_drop_refuses_a_scope_because_the_sql_function_covers_the_whole_catalogue(scope):
    assert (
        drop_insufficient_sales(execute=True, max_deletions=100, report_path=None, **scope) == 1
    )


# ------------------------------------------------------------------ ligne de commande
def test_execute_drop_requires_drop_insufficient(monkeypatch):
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--execute-drop"])
    with pytest.raises(SystemExit):
        recompute_scoring.parse_args()


def test_include_user_linked_no_longer_exists(monkeypatch):
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--drop-insufficient", "--include-user-linked"])
    with pytest.raises(SystemExit):
        recompute_scoring.parse_args()


def test_drop_is_a_dry_run_by_default_and_never_takes_the_catalogue_lock(monkeypatch):
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--drop-insufficient"])
    args = recompute_scoring.parse_args()
    assert args.drop_insufficient and not args.execute_drop and args.max_deletions == 100
    assert recompute_scoring._writes_catalogue(args) is False
    monkeypatch.setattr("sys.argv", ["recompute_scoring", "--drop-insufficient", "--execute-drop"])
    assert recompute_scoring._writes_catalogue(recompute_scoring.parse_args()) is True
