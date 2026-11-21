"""Ventes exclues de la lecture automatique des pièces (lot V3b-0) : règle, commande opérateur, banc, lecture Qwen."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from psycopg.types.json import Jsonb

from scripts import compare_document_vision as bench
from scripts import exclude_sale_from_document_reading as command
from src import document_reading
from src.document_reading_exclusions import (
    EXCLUDED_SALE_SQL,
    exclude_sale_from_document_reading,
    forget_readings_of_excluded_sales,
    is_sale_excluded_from_document_reading,
)

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "supabase/migrations/20261208100000_document_reading_exclusions.sql"
URL = "https://example.test/vente-exclue"
REQUEST = UUID("91200000-0000-4000-8000-000000000001")


class FakeConnection:
    def __init__(self, row: tuple[Any, ...] | None, rowcount: int = 0) -> None:
        self.row = row
        self.rowcount = rowcount
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def execute(self, sql: str, parameters: tuple[Any, ...] = ()) -> Any:
        self.calls.append((sql, parameters))
        row = self.row
        count = self.rowcount

        class Cursor:
            rowcount = count

            def fetchone(self) -> tuple[Any, ...] | None:
                return row

        return Cursor()

    def __enter__(self) -> FakeConnection:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def test_the_rule_reads_the_source_url_of_the_sale_and_the_urls_it_absorbed() -> None:
    assert is_sale_excluded_from_document_reading(FakeConnection((True,)), URL) is True
    connection = FakeConnection((False,))
    assert is_sale_excluded_from_document_reading(connection, URL) is False
    sql, parameters = connection.calls[0]
    assert EXCLUDED_SALE_SQL in sql and parameters == (URL, URL)
    assert "sale.source_urls" in EXCLUDED_SALE_SQL


def test_exclusion_keeps_a_closed_reason_and_an_optional_request() -> None:
    connection = FakeConnection((URL,))
    assert exclude_sale_from_document_reading(connection, URL, reason="opposition", request_id=REQUEST) is True
    assert connection.calls[0][1] == (URL, "opposition", str(REQUEST))
    # Déjà exclue : l'inscription existante reste.
    assert exclude_sale_from_document_reading(FakeConnection(None), URL, reason="correction") is False
    with pytest.raises(ValueError):
        exclude_sale_from_document_reading(FakeConnection(None), URL, reason="M. Dupont a appelé")


def test_the_bench_leaves_excluded_sales_out_before_any_download() -> None:
    # La condition est dans la requête des candidates : une vente exclue n'est jamais lue, donc jamais téléchargée.
    assert f"not {EXCLUDED_SALE_SQL}" in bench.CANDIDATES_SQL


def test_the_qwen_reading_leaves_excluded_sales_out_with_the_same_rule() -> None:
    assert f"not {EXCLUDED_SALE_SQL}" in document_reading.CANDIDATES_SQL


def test_the_served_reading_of_every_excluded_sale_is_deleted() -> None:
    connection = FakeConnection(None, rowcount=1)
    assert forget_readings_of_excluded_sales(connection) == 1
    sql, parameters = connection.calls[0]
    assert "delete from public.auction_document_readings" in sql and EXCLUDED_SALE_SQL in sql and parameters == ()


@pytest.mark.parametrize(
    "argv",
    [
        ["--source-url", URL, "--reason", "autre motif"],
        ["--source-url", "vente-exclue", "--reason", "opposition"],
        ["--source-url", URL, "--reason", "opposition", "--request-id", "pas-un-uuid"],
        ["--reason", "opposition"],
    ],
)
def test_command_refuses_an_unknown_reason_a_bad_url_or_request(argv: list[str]) -> None:
    with pytest.raises(SystemExit):
        command.parse_args(argv)


def test_command_needs_the_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    assert command.main(["--source-url", URL, "--reason", "opposition"]) == 2


def test_command_excludes_the_sale_and_prints_counts_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from src.storage import supabase_client

    connection = FakeConnection((URL,), rowcount=1)
    withdrawn: list[tuple[str, str | None]] = []
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://example.test/db")
    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda url, **options: connection)

    def withdraw(db_url: str, *, source_url: str | None = None) -> dict[str, int]:
        # Le retrait vient après l'inscription : la passe ne peut plus réécrire ce qu'il enlève.
        assert connection.calls, "exclusion first"
        withdrawn.append((db_url, source_url))
        return {"sales": 1, "cleared": 2, "preserved": 0, "not_recorded": 0}

    monkeypatch.setattr(command, "withdraw", withdraw)

    assert command.main(["--source-url", URL, "--reason", "opposition", "--request-id", str(REQUEST)]) == 0

    assert connection.calls[0][1] == (URL, "opposition", str(REQUEST))
    # Puis, dans la même transaction, la lecture servie aux abonnés est supprimée.
    assert "delete from public.auction_document_readings" in connection.calls[1][0]
    assert withdrawn == [("postgresql://example.test/db", URL)]
    output = capsys.readouterr().out
    assert json.loads(output) == {
        "excluded": True,
        "already_excluded": False,
        "readings_removed": 1,
        "withdrawn": {"sales": 1, "cleared": 2, "preserved": 0, "not_recorded": 0},
    }
    assert URL not in output


# --- Exécution réelle (PIPELINE_TEST_DB_URL, base jetable, sinon ignoré) ------------------------------------------


def _connect() -> Any:
    from src.storage.supabase_client import _postgres_connect

    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    return _postgres_connect(url)


def test_the_rule_runs_on_postgres_for_a_sale_and_for_the_url_it_absorbed() -> None:
    text = MIGRATION.read_text()
    start = text.index("create table if not exists public.document_reading_exclusions")
    table = text[start : text.index(");", start) + 2]
    with _connect() as db:
        try:
            db.execute("create table if not exists public.data_subject_requests (id uuid primary key)")
            db.execute(table)
            db.execute("create table public.auction_sales (source_url text primary key, source_urls jsonb)")
            db.execute(
                "insert into public.auction_sales values (%s, %s), (%s, %s), (%s, null)",
                (
                    "https://example.test/conservee", Jsonb(["https://example.test/absorbee"]),
                    "https://example.test/autre", Jsonb([]),
                    "https://example.test/sans-liste",
                ),
            )
            assert exclude_sale_from_document_reading(db, "https://example.test/absorbee", reason="opposition")
            assert not exclude_sale_from_document_reading(db, "https://example.test/absorbee", reason="autre")

            assert is_sale_excluded_from_document_reading(db, "https://example.test/conservee")
            assert is_sale_excluded_from_document_reading(db, "https://example.test/absorbee")
            assert not is_sale_excluded_from_document_reading(db, "https://example.test/autre")
            assert not is_sale_excluded_from_document_reading(db, "https://example.test/sans-liste")
            excluded = db.execute(
                f"select source_url from public.auction_sales sale where {EXCLUDED_SALE_SQL} order by 1"
            ).fetchall()
            assert excluded == [("https://example.test/conservee",)]

            # La lecture servie de la vente exclue (par l'URL qu'elle a absorbée) est supprimée, pas les autres.
            db.execute("alter table public.auction_sales add column id integer")
            db.execute("update public.auction_sales set id = length(source_url)")
            db.execute("create table public.auction_document_readings (sale_id integer primary key, points jsonb)")
            db.execute(
                "insert into public.auction_document_readings select id, '[]'::jsonb from public.auction_sales"
            )
            assert forget_readings_of_excluded_sales(db) == 1
            assert forget_readings_of_excluded_sales(db) == 0
            kept = db.execute(
                "select sale.source_url from public.auction_document_readings reading"
                " join public.auction_sales sale on sale.id = reading.sale_id order by 1"
            ).fetchall()
            assert kept == [("https://example.test/autre",), ("https://example.test/sans-liste",)]
        finally:
            db.rollback()
