from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from src.outcome_ingestion.repository import (
    OutcomeIngestionError,
    OutcomeIngestionRepository,
)


class QueryCursor:
    def __init__(
        self,
        *,
        rows: list[tuple[object, ...]] | None = None,
        row_batches: list[list[tuple[object, ...]]] | None = None,
        one: tuple[object, ...] | None = None,
    ) -> None:
        self.rows = rows or []
        self.row_batches = list(row_batches or [])
        self.one = one
        self.calls: list[tuple[str, object]] = []

    def __enter__(self) -> QueryCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: object = None) -> None:
        self.calls.append((" ".join(statement.split()), parameters))

    def fetchall(self) -> list[tuple[object, ...]]:
        if self.row_batches:
            return self.row_batches.pop(0)
        return self.rows

    def fetchone(self) -> tuple[object, ...] | None:
        return self.one


class QueryConnection:
    def __init__(self, cursor: QueryCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> QueryConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> QueryCursor:
        return self._cursor


def _repository(cursor: QueryCursor) -> OutcomeIngestionRepository:
    connection = QueryConnection(cursor)
    return OutcomeIngestionRepository("postgresql://example", connect=lambda _url: connection)


def test_load_active_dvf_records_is_latest_non_purged_and_bounded() -> None:
    cursor = QueryCursor(
        rows=[
            (
                "record-1",
                "dvf-adjudication:one",
                {
                    "schema_version": "dvf_adjudication_candidate_v1",
                    "training_eligible": False,
                },
            )
        ]
    )

    records = _repository(cursor).load_active_dvf_adjudication_records(limit=5)

    assert records[0].source_record_id == "record-1"
    assert records[0].external_record_id == "dvf-adjudication:one"
    statement, parameters = cursor.calls[0]
    assert "source.name = 'dvf_dgfip'" in statement
    assert "newer.record_version > record.record_version" in statement
    assert "public.source_purge_events" in statement
    assert "not record.training_eligible" in statement
    assert statement.endswith("limit %s")
    assert parameters == (5,)


def test_load_all_active_dvf_records_requires_explicit_none_but_uses_no_fake_limit() -> None:
    cursor = QueryCursor(rows=[])

    records = _repository(cursor).load_active_dvf_adjudication_records(limit=None)

    assert records == []
    statement, parameters = cursor.calls[0]
    assert not statement.endswith("limit %s")
    assert parameters == ()


def test_load_active_dvf_records_resolves_composite_cursor_before_page() -> None:
    cursor_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    cursor_created_at = datetime(2025, 5, 14, 9, 0, tzinfo=UTC)
    cursor = QueryCursor(one=(cursor_created_at, cursor_id), rows=[])

    records = _repository(cursor).load_active_dvf_adjudication_records(
        limit=5,
        after_source_record_id=cursor_id,
    )

    assert records == []
    assert len(cursor.calls) == 2
    cursor_statement, cursor_parameters = cursor.calls[0]
    page_statement, page_parameters = cursor.calls[1]
    assert "record.id = %s::uuid" in cursor_statement
    assert "source.name = 'dvf_dgfip'" in cursor_statement
    assert cursor_parameters == (cursor_id,)
    assert (
        "(record.created_at, record.id) > (%s::timestamptz, %s::uuid)"
        in page_statement
    )
    assert "order by record.created_at, record.id" in page_statement
    assert page_parameters == (cursor_created_at, cursor_id, 5)


def test_load_active_dvf_records_rejects_unknown_cursor() -> None:
    cursor_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    cursor = QueryCursor(one=None)

    with pytest.raises(OutcomeIngestionError, match="cursor does not exist"):
        _repository(cursor).load_active_dvf_adjudication_records(
            limit=5,
            after_source_record_id=cursor_id,
        )

    assert len(cursor.calls) == 1


def test_context_read_joins_outcome_and_catalogue_tables_and_remains_bounded() -> None:
    scheduled_at = datetime(2025, 5, 14, 9, 0, tzinfo=UTC)
    cursor = QueryCursor(
        rows=[
            (
                "case-1",
                "lot-1",
                "round-1",
                scheduled_at,
                "auction_round",
                ["33063000AB0042"],
                "12 rue du Test",
                "Bordeaux",
                "33000",
                "33063",
            )
        ]
    )

    contexts = _repository(cursor).load_dvf_auction_match_contexts(
        sale_date=date(2025, 5, 14),
        parcel_ids=("33 063 000 AB 0042",),
        address="12 RUE de l'Été",
        insee_code="33063",
        postal_code="33000",
        city="Bordeaux",
        limit=25,
    )

    assert contexts[0].case_id == "case-1"
    assert contexts[0].lot_id == "lot-1"
    assert contexts[0].round_id == "round-1"
    assert contexts[0].parcel_ids == ("33063000AB0042",)
    statement, parameters = cursor.calls[0]
    assert "public.auction_lots" in statement
    assert "public.auction_rounds" in statement
    assert "public.auction_sales" in statement
    assert "public.auction_cadastre_parcels" in statement
    assert "extensions.unaccent" in statement
    assert "[^a-z0-9]+" in statement
    assert "limit %s" in statement
    assert parameters[-1] == 25
    assert parameters[1] == ["33063000AB0042"]
    assert parameters[5:7] == ("12 RUE de l'Été", "12 RUE de l'Été")
    assert parameters[16:18] == ("12 RUE de l'Été", "12 RUE de l'Été")


def test_repository_reports_active_lot_presence_and_current_match() -> None:
    lot_cursor = QueryCursor(one=(False,))
    match_cursor = QueryCursor(one=("match-1",))
    connections = iter((QueryConnection(lot_cursor), QueryConnection(match_cursor)))
    repository = OutcomeIngestionRepository(
        "postgresql://example",
        connect=lambda _url: next(connections),
    )

    assert repository.has_active_outcome_lots() is False
    assert (
        repository.find_current_source_record_match(
            source_record_id="record-1",
            lot_id="lot-1",
            round_id=None,
        )
        == "match-1"
    )
    assert "select exists" in lot_cursor.calls[0][0]
    assert "where active limit 1" in lot_cursor.calls[0][0]
    assert "supersedes_match_id = match_row.id" in match_cursor.calls[0][0]
    assert match_cursor.calls[0][1] == ("record-1", "lot-1", None)


def test_generic_source_record_exists_is_bounded_and_source_scoped() -> None:
    cursor = QueryCursor(one=(True,))

    exists = _repository(cursor).source_record_exists(
        source_name="judilibre",
        external_record_id="decision-123",
    )

    assert exists is True
    statement, parameters = cursor.calls[0]
    assert "select exists" in statement
    assert "source.name = %s" in statement
    assert "record.external_record_id = %s" in statement
    assert "limit 1" in statement
    assert parameters == ("judilibre", "decision-123")


def test_batch_source_record_lookup_is_unique_source_scoped_and_chunked() -> None:
    cursor = QueryCursor(
        row_batches=[
            [("decision-1",)],
            [("decision-3",)],
        ]
    )

    existing = _repository(cursor).source_record_ids_exist(
        "judilibre",
        ["decision-1", "decision-1", "decision-2", "decision-3", " "],
        chunk_size=2,
    )

    assert existing == {"decision-1", "decision-3"}
    assert len(cursor.calls) == 2
    assert cursor.calls[0][1] == ("judilibre", ["decision-1", "decision-2"])
    assert cursor.calls[1][1] == ("judilibre", ["decision-3"])
    assert all("record.external_record_id = any(%s::text[])" in call[0] for call in cursor.calls)
    assert all("public.source_purge_events" in call[0] for call in cursor.calls)


def test_matching_schema_preflight_reports_missing_versioned_tables() -> None:
    cursor = QueryCursor(
        one=(
            "judicial_source_records",
            "source_record_matches",
            "auction_lots",
            "auction_rounds",
            "auction_sales",
            "auction_cadastre_parcels",
        )
    )

    _repository(cursor).require_dvf_matching_schema()

    assert "to_regclass('public.judicial_source_records')" in cursor.calls[0][0]
