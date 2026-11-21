"""Ventes exclues de la lecture automatique des pièces (lot V3b-0) : règle, commande opérateur, banc."""

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
from src.document_reading_exclusions import (
    EXCLUDED_SALE_SQL,
    exclude_sale_from_document_reading,
    is_sale_excluded_from_document_reading,
)

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "supabase/migrations/20261208100000_document_reading_exclusions.sql"
URL = "https://example.test/vente-exclue"
REQUEST = UUID("91200000-0000-4000-8000-000000000001")


class FakeConnection:
    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self.row = row
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def execute(self, sql: str, parameters: tuple[Any, ...] = ()) -> Any:
        self.calls.append((sql, parameters))
        row = self.row

        class Cursor:
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

    connection = FakeConnection((URL,))
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://example.test/db")
    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda url, **options: connection)

    assert command.main(["--source-url", URL, "--reason", "opposition", "--request-id", str(REQUEST)]) == 0

    assert connection.calls[0][1] == (URL, "opposition", str(REQUEST))
    output = capsys.readouterr().out
    assert json.loads(output) == {"excluded": True, "already_excluded": False}
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
        finally:
            db.rollback()
