from __future__ import annotations

import importlib.util
import sys
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "backfill_fact_claims.py"
SPEC = importlib.util.spec_from_file_location("backfill_fact_claims", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
backfill = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backfill
SPEC.loader.exec_module(backfill)


SALE_ID = "10000000-0000-4000-8000-000000000001"
SALE_ID_2 = "10000000-0000-4000-8000-000000000002"
SALE_URL = "https://source.example/sale-1"


def sale_row(
    *,
    sale_id: str = SALE_ID,
    source_url: str = SALE_URL,
    raw_payload: object | None = None,
    observations: object | None = None,
    updated_at: datetime | None = None,
) -> tuple[object, ...]:
    return (
        sale_id,
        "source-a",
        source_url,
        "external-1",
        raw_payload if raw_payload is not None else {},
        observations if observations is not None else [],
        updated_at or datetime(2026, 9, 28, 10, tzinfo=UTC),
    )


def test_build_ignores_flattened_values_when_persisted_payload_has_no_proof() -> None:
    # The tuple intentionally has no normalized catalogue columns.  A real
    # auction_sales row may have starting_price_eur/surface_m2 populated, but
    # this operator must not copy those fields into raw_payload.
    result = backfill.build_batch_candidates(
        [sale_row(raw_payload={}, observations=[])],
        {},
    )

    assert result.rows == ()
    assert result.skipped_by_reason == {"no_persisted_proof": 1}


def test_persisted_source_observations_are_hydrated_and_deduplicated() -> None:
    embedded = [
        {
            "source_name": "source-a",
            "source_url": SALE_URL,
            "raw_payload": {"source_blocks": {"mise_a_prix": "100 000 euros"}},
            "observed_at": "2026-09-28T09:00:00+00:00",
        }
    ]
    persisted = [
        {
            "source_url": SALE_URL,
            "source_name": "source-a",
            "external_id": "external-1",
            "canonical_source_url": SALE_URL,
            "raw_payload": {"source_blocks": {"mise_a_prix": "105 000 euros"}},
            "observed_at": datetime(2026, 9, 28, 11, tzinfo=UTC),
            "updated_at": datetime(2026, 9, 28, 11, tzinfo=UTC),
        },
        {
            "source_url": "https://secondary.example/sale-1",
            "source_name": "source-b",
            "canonical_source_url": SALE_URL,
            "raw_payload": {"source_blocks": {"mise_a_prix": "110 000 euros"}},
            "observed_at": datetime(2026, 9, 28, 11, tzinfo=UTC),
            "updated_at": datetime(2026, 9, 28, 11, tzinfo=UTC),
        },
    ]

    hydrated = backfill.hydrate_observations(embedded, persisted)

    assert {row["source_url"] for row in hydrated} == {
        SALE_URL,
        "https://secondary.example/sale-1",
    }
    # The newer persisted row wins over the embedded snapshot.
    primary = next(row for row in hydrated if row["source_url"] == SALE_URL)
    assert primary["raw_payload"]["source_blocks"]["mise_a_prix"] == "105 000 euros"


def test_state_round_trip_and_scope_and_mode_are_guarded(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    original = backfill.BackfillState(
        source_name="source-a",
        mode="dry-run",
        cursor=backfill.ResumeKey(
            datetime(2026, 9, 28, 10, tzinfo=UTC),
            UUID(SALE_ID),
        ),
        processed_sales=4,
        candidate_rows=3,
        inserted_rows=0,
        skipped_by_reason={"no_persisted_proof": 1},
    )
    backfill.save_state(path, original)

    loaded = backfill.load_state(path, source_name="source-a", mode="dry-run", restart=False)

    assert loaded == original
    with pytest.raises(ValueError, match="scope"):
        backfill.load_state(path, source_name="source-b", mode="dry-run", restart=False)
    with pytest.raises(ValueError, match="mode"):
        backfill.load_state(path, source_name="source-a", mode="apply", restart=False)


def test_insert_is_idempotent_and_candidate_only() -> None:
    inserted_id = "20000000-0000-4000-8000-000000000001"
    candidate = {
        "id": inserted_id,
        "auction_sale_id": SALE_ID,
        "field_key": "sale.starting_price_eur",
        "value_jsonb": 100000.0,
        "claim_status": "candidate",
        "evidence_kind": "source_listing",
        "source_url": SALE_URL,
        "evidence_locator": {"kind": "source_block", "quote": "100 000 euros"},
        "confidence_score": 0.9,
        "extractor_name": "test",
        "extractor_version": "1",
    }

    class Connection:
        def __init__(self) -> None:
            self.statement = ""
            self.params: tuple[object, ...] = ()

        def execute(self, statement, params=None):
            self.statement = str(statement)
            self.params = params or ()
            return SimpleNamespace(fetchall=lambda: [(inserted_id,)])

    connection = Connection()
    assert backfill.insert_candidate_rows(connection, [candidate]) == 1
    assert "on conflict (id) do nothing" in connection.statement.lower()
    assert "returning id" in connection.statement.lower()
    # The materialized row's status is carried through unchanged and the
    # script never sends a resolved status to the database.
    assert "candidate" in {str(value) for value in connection.params}


def test_insert_chunks_large_claim_batches() -> None:
    candidate = {
        "id": "20000000-0000-4000-8000-000000000001",
        "auction_sale_id": SALE_ID,
        "field_key": "sale.starting_price_eur",
        "value_jsonb": 100000.0,
        "claim_status": "candidate",
        "evidence_kind": "source_listing",
        "source_url": SALE_URL,
        "evidence_locator": {"kind": "source_block", "quote": "100 000 euros"},
        "confidence_score": 0.9,
        "extractor_name": "test",
        "extractor_version": "1",
    }
    rows = [
        {**candidate, "id": f"20000000-0000-4000-8000-{index:012d}"}
        for index in range(201)
    ]

    class Connection:
        def __init__(self) -> None:
            self.calls: list[tuple[str, tuple[object, ...]]] = []

        def execute(self, statement, params=None):
            values = tuple(params or ())
            self.calls.append((str(statement), values))
            claim_count = len(values) // len(backfill.CLAIM_COLUMNS)
            return SimpleNamespace(fetchall=lambda: [(str(index),) for index in range(claim_count)])

    connection = Connection()

    assert backfill.insert_candidate_rows(connection, rows) == 201
    assert len(connection.calls) == 2
    assert [len(params) // len(backfill.CLAIM_COLUMNS) for _, params in connection.calls] == [200, 1]


def test_dry_run_never_executes_insert_and_advances_keyset_checkpoint(tmp_path: Path, monkeypatch) -> None:
    updated_at = datetime(2026, 9, 28, 10, tzinfo=UTC)
    calls: list[str] = []

    class Transaction:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

    class Connection:
        def transaction(self):
            return Transaction()

        def execute(self, statement, params=None):
            sql = str(statement)
            calls.append(sql)
            if "from public.auction_sales" in sql and "order by" in sql:
                # The first keyset page has a source block; the second query
                # is the empty page that closes the scan.
                if params and params[3] == UUID(int=0):
                    return SimpleNamespace(
                        fetchall=lambda: [
                            sale_row(
                                raw_payload={
                                    "source_blocks": {
                                        "mise_a_prix": "100 000 euros",
                                    }
                                },
                                updated_at=updated_at,
                            )
                        ]
                    )
                return SimpleNamespace(fetchall=lambda: [])
            if "from public.auction_observations" in sql:
                return SimpleNamespace(fetchall=lambda: [])
            if "select id" in sql and "from public.auction_sales" in sql:
                return SimpleNamespace(fetchall=lambda: [(SALE_ID,)])
            if "auction_fact_claims" in sql:
                raise AssertionError("dry-run must never execute a claim INSERT")
            raise AssertionError(f"unexpected SQL: {sql}")

    monkeypatch.setattr(backfill, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(backfill, "_postgres_connect", lambda _: nullcontext(Connection()))

    state_path = tmp_path / "backfill.json"
    args = backfill.build_parser().parse_args(
        ["--limit", "1", "--batch-size", "1", "--state-file", str(state_path)]
    )
    summary = backfill.run(args)

    assert summary["mode"] == "dry-run"
    assert summary["candidate_rows"] == 1
    assert summary["inserted_rows"] == 0
    assert summary["complete"] is False
    assert state_path.exists()
    assert any("auction_sales" in sql for sql in calls)
    assert all("insert into public.auction_fact_claims" not in sql.lower() for sql in calls)


def test_exhaustion_checkpoint_is_saved_after_transaction_commit(tmp_path: Path, monkeypatch) -> None:
    updated_at = datetime(2026, 9, 28, 10, tzinfo=UTC)
    save_calls: list[backfill.BackfillState] = []

    class Connection:
        transaction_depth = 0

        class Transaction:
            def __init__(self, connection):
                self.connection = connection

            def __enter__(self):
                self.connection.transaction_depth += 1
                return self

            def __exit__(self, exc_type, exc, traceback):
                self.connection.transaction_depth -= 1
                return False

        def transaction(self):
            return self.Transaction(self)

        def execute(self, statement, params=None):
            sql = str(statement)
            if "from public.auction_sales" in sql and "order by" in sql:
                if params and params[3] == UUID(int=0):
                    return SimpleNamespace(
                        fetchall=lambda: [
                            sale_row(
                                raw_payload={"source_blocks": {"mise_a_prix": "100 000 euros"}},
                                updated_at=updated_at,
                            )
                        ]
                    )
                return SimpleNamespace(fetchall=lambda: [])
            if "from public.auction_observations" in sql:
                return SimpleNamespace(fetchall=lambda: [])
            if "select id" in sql and "from public.auction_sales" in sql:
                return SimpleNamespace(fetchall=lambda: [(SALE_ID,)])
            raise AssertionError(f"unexpected SQL: {sql}")

    connection = Connection()
    monkeypatch.setattr(backfill, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(backfill, "_postgres_connect", lambda _: nullcontext(connection))

    def record_state(path, state):
        assert connection.transaction_depth == 0
        save_calls.append(state)

    monkeypatch.setattr(backfill, "save_state", record_state)
    args = backfill.build_parser().parse_args(
        ["--limit", "2", "--batch-size", "1", "--state-file", str(tmp_path / "state.json")]
    )

    summary = backfill.run(args)

    assert summary["complete"] is True
    assert [state.complete for state in save_calls] == [False, True]


def test_canonical_id_verification_drops_deleted_targets() -> None:
    class Connection:
        def execute(self, statement, params=None):
            return SimpleNamespace(fetchall=lambda: [(SALE_ID_2,)])

    verified = backfill.verify_canonical_sale_ids(Connection(), [SALE_ID, SALE_ID_2])

    assert verified == {SALE_ID_2}
