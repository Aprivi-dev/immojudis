"""Bounded, resumable backfill of source-backed fact claim candidates.

This operator command reads only evidence that is already persisted in
``auction_sales.raw_payload``, ``auction_sales.observations`` and the
source-scoped ``auction_observations`` table.  It deliberately does not read
the flattened catalogue columns: those values have no field-level provenance
and must not be turned into claims after the fact.

The command is read-only by default.  ``--apply`` is required before it can
append candidate rows to ``auction_fact_claims``.  Rows are materialized with
the existing deterministic UUID helper and inserted with ``ON CONFLICT (id)
DO NOTHING``, so an interrupted or repeated run cannot create a duplicate
observation or upgrade a claim.  A local JSON state file stores the keyset
cursor ``(updated_at, auction_sales.id)`` after each committed batch.
Because the cursor is owned by ``auction_sales.updated_at``, adding a late
row to ``auction_observations`` requires ``--restart`` (or a new state file)
to revisit the affected sales.

Examples::

    # Inspect the first 100 sales without writing to Supabase.
    python services/data-pipeline/scripts/backfill_fact_claims.py --limit 100

    # Resume the same dry-run (the state file is local and ignored by git).
    python services/data-pipeline/scripts/backfill_fact_claims.py --limit 100

    # Start an explicit candidate-only write from the beginning.
    python services/data-pipeline/scripts/backfill_fact_claims.py \
        --limit 100 --apply --restart

Production writes are intentionally impossible unless both ``--apply`` and a
working direct Postgres connection are supplied.  The script never updates
``auction_sales`` and never changes an existing claim.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import PROCESSED_DIR, load_settings  # noqa: E402
from src.fact_claims import materialize_fact_claim_rows  # noqa: E402
from src.models import AuctionSale  # noqa: E402
from src.storage.supabase_client import _postgres_connect  # noqa: E402

try:  # pragma: no cover - the production dependency is installed in CI.
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - exercised by the guard below.
    Jsonb = None


LOGGER = logging.getLogger("backfill_fact_claims")
STATE_SCHEMA_VERSION = "auction_fact_claim_backfill_v1"
DEFAULT_STATE_FILE = PROCESSED_DIR / "auction-fact-claims-backfill-state.json"
DEFAULT_BATCH_SIZE = 25
MAX_BATCH_SIZE = 100
MAX_CLAIMS_PER_INSERT = 200
DEFAULT_LIMIT = 100
MAX_LIMIT = 1_000
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
NIL_UUID = UUID(int=0)

SALE_COLUMNS = (
    "id",
    "source_name",
    "source_url",
    "external_id",
    "raw_payload",
    "observations",
    "cursor_updated_at",
)
OBSERVATION_COLUMNS = (
    "source_url",
    "source_name",
    "external_id",
    "canonical_source_url",
    "raw_payload",
    "observed_at",
    "updated_at",
)
CLAIM_COLUMNS = (
    "id",
    "auction_sale_id",
    "field_key",
    "value_jsonb",
    "claim_status",
    "evidence_kind",
    "source_url",
    "evidence_locator",
    "confidence_score",
    "extractor_name",
    "extractor_version",
)
JSON_CLAIM_COLUMNS = {"value_jsonb", "evidence_locator"}

SALE_PAGE_SQL = """
select
  id,
  source_name,
  source_url,
  external_id,
  raw_payload,
  observations,
  coalesce(updated_at, timestamptz 'epoch') as cursor_updated_at
from public.auction_sales
where (%s::text is null or source_name = %s)
  and (coalesce(updated_at, timestamptz 'epoch'), id)
      > (%s::timestamptz, %s::uuid)
order by coalesce(updated_at, timestamptz 'epoch'), id
limit %s
"""

OBSERVATION_PAGE_SQL = """
select
  source_url,
  source_name,
  external_id,
  canonical_source_url,
  raw_payload,
  observed_at,
  updated_at
from public.auction_observations
where source_url = any(%s::text[])
   or canonical_source_url = any(%s::text[])
"""

CANONICAL_IDS_SQL = """
select id
from public.auction_sales
where id = any(%s::uuid[])
for key share
"""


@dataclass(frozen=True)
class ResumeKey:
    """The strict keyset position used for an interrupted scan."""

    updated_at: datetime
    sale_id: UUID

    def as_state(self) -> dict[str, str]:
        return {
            "updated_at": _as_utc(self.updated_at).isoformat(),
            "id": str(self.sale_id),
        }


@dataclass(frozen=True)
class BackfillState:
    """Validated state persisted between operator invocations."""

    source_name: str | None
    mode: str
    cursor: ResumeKey
    processed_sales: int
    candidate_rows: int
    inserted_rows: int
    skipped_by_reason: dict[str, int]
    complete: bool = False

    def as_json(self) -> dict[str, object]:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "source_name": self.source_name,
            "mode": self.mode,
            "cursor": self.cursor.as_state(),
            "processed_sales": self.processed_sales,
            "candidate_rows": self.candidate_rows,
            "inserted_rows": self.inserted_rows,
            "skipped_by_reason": dict(sorted(self.skipped_by_reason.items())),
            "complete": self.complete,
        }


@dataclass(frozen=True)
class BuildResult:
    rows: tuple[dict[str, object], ...]
    sale_ids: tuple[str, ...]
    skipped_by_reason: dict[str, int]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill candidate auction_fact_claims only from persisted source "
            "evidence. Dry-run is the default; --apply is required to write."
        )
    )
    parser.add_argument(
        "--limit",
        type=_bounded_limit,
        default=DEFAULT_LIMIT,
        help=f"Maximum auction_sales rows examined in this invocation (1-{MAX_LIMIT}).",
    )
    parser.add_argument(
        "--batch-size",
        type=_bounded_batch_size,
        default=DEFAULT_BATCH_SIZE,
        help=f"Rows fetched per keyset page (1-{MAX_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--source-name",
        default=None,
        help="Restrict the scan to one exact auction_sales.source_name.",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=DEFAULT_STATE_FILE,
        help="Local JSON checkpoint path; no production data is stored here.",
    )
    parser.add_argument(
        "--restart",
        action="store_true",
        help="Ignore the existing local cursor and start this scope from the beginning.",
    )
    parser.add_argument(
        "--apply",
        "--persist",
        dest="apply",
        action="store_true",
        help="Append candidate rows. Existing claim IDs are left unchanged.",
    )
    return parser


def _bounded_limit(value: str) -> int:
    return _bounded_positive(value, MAX_LIMIT, "limit")


def _bounded_batch_size(value: str) -> int:
    return _bounded_positive(value, MAX_BATCH_SIZE, "batch-size")


def _bounded_positive(value: str, maximum: int, label: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"{label} must be an integer") from exc
    if not 1 <= parsed <= maximum:
        raise argparse.ArgumentTypeError(f"{label} must be between 1 and {maximum}")
    return parsed


def _as_utc(value: object, *, default: datetime = EPOCH) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif value:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return default
    else:
        return default
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _canonical_uuid(value: object) -> str | None:
    try:
        return str(UUID(str(value)))
    except (AttributeError, TypeError, ValueError):
        return None


def _clean_https_url(value: object) -> str | None:
    if value is None:
        return None
    url = str(value).strip()
    return url if url.startswith("https://") else None


def _tuple_row(row: object, columns: Sequence[str]) -> dict[str, object]:
    """Convert the default psycopg tuple row into a named mapping.

    The small mapping fallback makes the pure transformation functions easy
    to exercise with a dict-row cursor without changing the production
    connection factory.
    """
    if isinstance(row, Mapping):
        return {column: row.get(column) for column in columns}
    if isinstance(row, (tuple, list)):
        return {
            column: row[index] if index < len(row) else None
            for index, column in enumerate(columns)
        }
    raise TypeError(f"Unexpected database row type: {type(row).__name__}")


def _observation_rank(observation: Mapping[str, object]) -> datetime:
    return max(
        _as_utc(observation.get("observed_at")),
        _as_utc(observation.get("updated_at")),
    )


def _merge_observation(
    current: dict[str, object],
    incoming: dict[str, object],
) -> dict[str, object]:
    """Keep the newest persisted snapshot and retain non-empty proof fields."""
    current_rank = _observation_rank(current)
    incoming_rank = _observation_rank(incoming)
    winner, fallback = (
        (incoming, current) if incoming_rank > current_rank else (current, incoming)
    )
    merged = dict(winner)
    for key in ("source_name", "external_id", "raw_payload", "observed_at", "updated_at"):
        if not merged.get(key) and fallback.get(key):
            merged[key] = fallback[key]
    return merged


def hydrate_observations(
    embedded_observations: object,
    persisted_rows: Iterable[object],
) -> list[dict[str, object]]:
    """Merge persisted source snapshots without synthesizing any fields.

    ``auction_sales.observations`` is retained as-is when valid.  Rows from
    ``auction_observations`` are added or replace the same source URL only
    when their persisted timestamp is newer.  Values are never copied from a
    flattened ``auction_sales`` column.
    """
    by_url: dict[str, dict[str, object]] = {}

    if isinstance(embedded_observations, list):
        for raw in embedded_observations:
            if not isinstance(raw, dict):
                continue
            source_url = _clean_https_url(raw.get("source_url"))
            if source_url is None:
                continue
            observation = dict(raw)
            observation["source_url"] = source_url
            previous = by_url.get(source_url)
            by_url[source_url] = (
                _merge_observation(previous, observation)
                if previous is not None
                else observation
            )

    for raw in persisted_rows:
        row = _tuple_row(raw, OBSERVATION_COLUMNS)
        source_url = _clean_https_url(row.get("source_url"))
        if source_url is None:
            continue
        payload = row.get("raw_payload")
        observation: dict[str, object] = {
            "source_url": source_url,
            "source_name": row.get("source_name"),
            "external_id": row.get("external_id"),
            "raw_payload": dict(payload) if isinstance(payload, dict) else {},
            "observed_at": row.get("observed_at"),
            "updated_at": row.get("updated_at"),
        }
        previous = by_url.get(source_url)
        by_url[source_url] = (
            _merge_observation(previous, observation)
            if previous is not None
            else observation
        )

    return [by_url[url] for url in sorted(by_url)]


def _sale_from_row(row: object, observations: list[dict[str, object]]) -> tuple[AuctionSale | None, str | None, str | None]:
    """Create the minimal model used by fact materialization.

    The third return value is a skip reason.  In particular, a row with only
    normalized/flattened fields is accepted as a sale model but produces no
    claims because those fields are intentionally not copied into
    ``raw_payload``.
    """
    values = _tuple_row(row, SALE_COLUMNS)
    sale_id = _canonical_uuid(values.get("id"))
    if sale_id is None:
        return None, None, "invalid_sale_id"
    source_url = _clean_https_url(values.get("source_url"))
    if source_url is None:
        return None, sale_id, "invalid_source_url"
    source_name = str(values.get("source_name") or "").strip()
    if not source_name:
        return None, sale_id, "missing_source_name"
    raw_payload = values.get("raw_payload")
    raw_payload = dict(raw_payload) if isinstance(raw_payload, dict) else {}
    try:
        sale = AuctionSale(
            id=sale_id,
            source_name=source_name,
            source_url=source_url,
            external_id=(
                str(values["external_id"]).strip()
                if values.get("external_id") is not None
                else None
            ),
            raw_payload=raw_payload,
            observations=observations,
        )
    except (TypeError, ValueError) as exc:
        LOGGER.warning("Skipping malformed persisted sale id=%s: %s", sale_id, exc)
        return None, sale_id, "malformed_sale_row"
    return sale, sale_id, None


def build_batch_candidates(
    sale_rows: Iterable[object],
    observation_rows_by_sale_url: Mapping[str, Iterable[object]],
) -> BuildResult:
    """Build candidate rows from persisted payloads and source snapshots."""
    candidates: list[dict[str, object]] = []
    sale_ids: list[str] = []
    skipped: Counter[str] = Counter()

    for raw_row in sale_rows:
        values = _tuple_row(raw_row, SALE_COLUMNS)
        source_url = _clean_https_url(values.get("source_url"))
        embedded = values.get("observations")
        persisted = observation_rows_by_sale_url.get(source_url or "", ())
        observations = hydrate_observations(embedded, persisted)
        sale, sale_id, reason = _sale_from_row(raw_row, observations)
        if reason is not None:
            skipped[reason] += 1
            continue
        assert sale is not None and sale_id is not None
        rows = materialize_fact_claim_rows(sale, sale_id)
        candidate_rows = [
            row
            for row in rows
            if row.get("claim_status") == "candidate"
            and row.get("auction_sale_id") == sale_id
            and _clean_https_url(row.get("source_url")) is not None
        ]
        if not candidate_rows:
            skipped["no_persisted_proof"] += 1
            continue
        sale_ids.append(sale_id)
        candidates.extend(candidate_rows)

    return BuildResult(
        rows=tuple(candidates),
        sale_ids=tuple(dict.fromkeys(sale_ids)),
        skipped_by_reason=dict(skipped),
    )


def _fetch_sales(
    connection: Any,
    cursor: ResumeKey,
    *,
    source_name: str | None,
    limit: int,
) -> list[dict[str, object]]:
    result = connection.execute(
        SALE_PAGE_SQL,
        (
            source_name,
            source_name,
            _as_utc(cursor.updated_at),
            cursor.sale_id,
            limit,
        ),
    )
    return [_tuple_row(row, SALE_COLUMNS) for row in result.fetchall()]


def _fetch_observations(
    connection: Any,
    canonical_urls: Sequence[str],
) -> list[dict[str, object]]:
    if not canonical_urls:
        return []
    result = connection.execute(
        OBSERVATION_PAGE_SQL,
        (list(canonical_urls), list(canonical_urls)),
    )
    return [_tuple_row(row, OBSERVATION_COLUMNS) for row in result.fetchall()]


def _group_observations(
    rows: Iterable[Mapping[str, object]],
) -> dict[str, tuple[dict[str, object], ...]]:
    grouped: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        source_url = _clean_https_url(row.get("source_url"))
        canonical_url = _clean_https_url(row.get("canonical_source_url"))
        if source_url is None:
            continue
        # The query is intentionally broad enough to catch both the canonical
        # row and secondary source rows.  Mapping is done by the persisted
        # canonical URL; a source row without that pointer is only usable for
        # the sale whose own URL it carries.
        if canonical_url:
            grouped[canonical_url].append(dict(row))
        else:
            grouped[source_url].append(dict(row))
    return {url: tuple(values) for url, values in grouped.items()}


def verify_canonical_sale_ids(
    connection: Any,
    sale_ids: Sequence[str],
) -> set[str]:
    """Confirm every target still exists in the canonical parent table."""
    canonical_ids = [UUID(value) for value in dict.fromkeys(sale_ids)]
    if not canonical_ids:
        return set()
    result = connection.execute(CANONICAL_IDS_SQL, (canonical_ids,))
    verified: set[str] = set()
    for raw in result.fetchall():
        value = raw.get("id") if isinstance(raw, Mapping) else (raw[0] if raw else None)
        normalized = _canonical_uuid(value)
        if normalized is not None:
            verified.add(normalized)
    return verified


def _claim_value(column: str, value: object) -> object:
    if column in JSON_CLAIM_COLUMNS and Jsonb is not None:
        return Jsonb(value)
    return value


def insert_candidate_rows(connection: Any, rows: Sequence[Mapping[str, object]]) -> int:
    """Append candidates in bounded chunks and return rows inserted.

    A sale page is bounded by sales, but one sale can carry several persisted
    source observations.  Chunking by claim count keeps the SQL statement and
    parameter list bounded independently of that source fan-out.
    """
    if not rows:
        return 0
    return sum(
        _insert_candidate_chunk(connection, rows[offset : offset + MAX_CLAIMS_PER_INSERT])
        for offset in range(0, len(rows), MAX_CLAIMS_PER_INSERT)
    )


def _insert_candidate_chunk(
    connection: Any,
    rows: Sequence[Mapping[str, object]],
) -> int:
    # The table and column names are constants.  Only the bounded placeholder
    # count is assembled dynamically; all values remain query parameters.
    columns = ", ".join(CLAIM_COLUMNS)
    row_placeholders = "(" + ", ".join(["%s"] * len(CLAIM_COLUMNS)) + ")"
    values_sql = ", ".join([row_placeholders] * len(rows))
    statement = (
        f"insert into public.auction_fact_claims ({columns}) values {values_sql} "
        "on conflict (id) do nothing returning id"
    )
    params: list[object] = []
    for row in rows:
        params.extend(_claim_value(column, row.get(column)) for column in CLAIM_COLUMNS)
    result = connection.execute(statement, tuple(params))
    returned = result.fetchall()
    return len(returned)


def _initial_state(source_name: str | None, mode: str) -> BackfillState:
    return BackfillState(
        source_name=source_name,
        mode=mode,
        cursor=ResumeKey(EPOCH, NIL_UUID),
        processed_sales=0,
        candidate_rows=0,
        inserted_rows=0,
        skipped_by_reason={},
        complete=False,
    )


def load_state(path: Path, *, source_name: str | None, mode: str, restart: bool) -> BackfillState:
    if restart or not path.exists():
        return _initial_state(source_name, mode)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Cannot read backfill state {path}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != STATE_SCHEMA_VERSION:
        raise ValueError(f"Unsupported backfill state schema in {path}")
    if payload.get("source_name") != source_name:
        raise ValueError(
            "Backfill state scope differs from --source-name; choose another --state-file or use --restart"
        )
    if payload.get("mode") != mode:
        raise ValueError(
            "Backfill state mode differs from the requested mode; use another --state-file or use --restart"
        )
    cursor = payload.get("cursor")
    if not isinstance(cursor, dict):
        raise ValueError(f"Backfill state cursor is missing in {path}")
    cursor_id = _canonical_uuid(cursor.get("id"))
    if cursor_id is None:
        raise ValueError(f"Backfill state cursor id is invalid in {path}")
    skipped = payload.get("skipped_by_reason")
    if not isinstance(skipped, dict):
        skipped = {}
    return BackfillState(
        source_name=source_name,
        mode=mode,
        cursor=ResumeKey(_as_utc(cursor.get("updated_at")), UUID(cursor_id)),
        processed_sales=_nonnegative_int(payload.get("processed_sales")),
        candidate_rows=_nonnegative_int(payload.get("candidate_rows")),
        inserted_rows=_nonnegative_int(payload.get("inserted_rows")),
        skipped_by_reason={
            str(key): _nonnegative_int(value)
            for key, value in skipped.items()
        },
        complete=bool(payload.get("complete", False)),
    )


def _nonnegative_int(value: object) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def save_state(path: Path, state: BackfillState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(state.as_json(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _next_cursor(rows: Sequence[Mapping[str, object]], fallback: ResumeKey) -> ResumeKey:
    if not rows:
        return fallback
    last = rows[-1]
    sale_id = _canonical_uuid(last.get("id"))
    if sale_id is None:
        return fallback
    return ResumeKey(_as_utc(last.get("cursor_updated_at")), UUID(sale_id))


def _merge_skip_counts(current: Mapping[str, int], additions: Mapping[str, int]) -> dict[str, int]:
    merged = Counter(current)
    merged.update(additions)
    return dict(merged)


def run(args: argparse.Namespace) -> dict[str, object]:
    settings = load_settings()
    db_url = settings.get("supabase_db_url")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required for this direct Postgres backfill")
    mode = "apply" if args.apply else "dry-run"
    state = load_state(
        args.state_file,
        source_name=args.source_name,
        mode=mode,
        restart=args.restart,
    )
    if state.complete:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "mode": mode,
            "complete": True,
            "resumed": not args.restart,
            "processed_sales": state.processed_sales,
            "candidate_rows": state.candidate_rows,
            "inserted_rows": state.inserted_rows,
            "skipped_by_reason": state.skipped_by_reason,
            "cursor": state.cursor.as_state(),
            "state_file": str(args.state_file),
            "candidate_only": True,
        }

    remaining = args.limit
    resumed = state.cursor != ResumeKey(EPOCH, NIL_UUID)
    with _postgres_connect(str(db_url)) as connection:
        while remaining > 0:
            page_size = min(args.batch_size, remaining)
            exhausted = False
            with connection.transaction():
                page = _fetch_sales(
                    connection,
                    state.cursor,
                    source_name=args.source_name,
                    limit=page_size,
                )
                if not page:
                    state = BackfillState(
                        source_name=state.source_name,
                        mode=state.mode,
                        cursor=state.cursor,
                        processed_sales=state.processed_sales,
                        candidate_rows=state.candidate_rows,
                        inserted_rows=state.inserted_rows,
                        skipped_by_reason=state.skipped_by_reason,
                        complete=True,
                    )
                    exhausted = True
                if not exhausted:
                    urls = [
                        source_url
                        for row in page
                        if (source_url := _clean_https_url(row.get("source_url"))) is not None
                    ]
                    persisted_observations = _fetch_observations(connection, urls)
                    grouped = _group_observations(persisted_observations)
                    build = build_batch_candidates(page, grouped)
                    verified_ids = verify_canonical_sale_ids(connection, build.sale_ids)
                    rows = tuple(
                        row
                        for row in build.rows
                        if row.get("auction_sale_id") in verified_ids
                    )
                    missing_ids = set(build.sale_ids) - verified_ids
                    skipped = dict(build.skipped_by_reason)
                    if missing_ids:
                        skipped["canonical_sale_missing"] = len(missing_ids)
                    inserted = insert_candidate_rows(connection, rows) if args.apply else 0

                    state = BackfillState(
                        source_name=state.source_name,
                        mode=state.mode,
                        cursor=_next_cursor(page, state.cursor),
                        processed_sales=state.processed_sales + len(page),
                        candidate_rows=state.candidate_rows + len(rows),
                        inserted_rows=state.inserted_rows + inserted,
                        skipped_by_reason=_merge_skip_counts(state.skipped_by_reason, skipped),
                        complete=False,
                    )
            if exhausted:
                # Persisting the local checkpoint is deliberately kept
                # outside the database transaction.  A state-file error
                # must never be hidden by an open/aborted DB transaction.
                save_state(args.state_file, state)
                break
            # The database transaction has committed before the local cursor
            # advances.  A process kill can therefore replay a page safely.
            save_state(args.state_file, state)
            remaining -= len(page)
            if len(page) < page_size:
                state = BackfillState(
                    source_name=state.source_name,
                    mode=state.mode,
                    cursor=state.cursor,
                    processed_sales=state.processed_sales,
                    candidate_rows=state.candidate_rows,
                    inserted_rows=state.inserted_rows,
                    skipped_by_reason=state.skipped_by_reason,
                    complete=True,
                )
                save_state(args.state_file, state)
                break

    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "mode": mode,
        "complete": state.complete,
        "resumed": resumed,
        "processed_sales": state.processed_sales,
        "candidate_rows": state.candidate_rows,
        "inserted_rows": state.inserted_rows,
        "skipped_by_reason": state.skipped_by_reason,
        "cursor": state.cursor.as_state(),
        "state_file": str(args.state_file),
        "candidate_only": True,
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = run(args)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        print(f"Fact claims backfill failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
