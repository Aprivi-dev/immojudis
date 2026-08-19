from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from typing import Any, cast

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - parser-only installations.
    Jsonb = None

from src.outcome_statistics.models import (
    ClaimType,
    OutcomeVersion,
    PersistSummary,
    RoundKind,
    RoundObservation,
    SnapshotMember,
    StatisticsBundle,
    StatisticsSnapshot,
)
from src.storage.supabase_client import _postgres_connect


class OutcomeStatisticsRepositoryError(RuntimeError):
    pass


class RoundBoundExceeded(OutcomeStatisticsRepositoryError):
    pass


_SOURCE_SERIALIZATION_LOCK = "immojudis:tribunal-statistics-source-v1"


_LOAD_ROUNDS_SQL = """
with bounded_rounds as (
  select
    round_row.id as round_id,
    frozen_snapshot.id as feature_snapshot_id,
    round_row.lot_id,
    round_row.court_id,
    court_row.code as court_code,
    court_row.name as court_name,
    court_row.judicial_region,
    round_row.round_kind,
    round_row.scheduled_at,
    round_row.local_timezone,
    timezone_row.name is not null as timezone_is_valid,
    round_row.initial_starting_price_eur,
    round_row.effective_starting_price_eur
  from public.auction_rounds round_row
  join public.outcome_courts court_row on court_row.id = round_row.court_id
  left join pg_catalog.pg_timezone_names timezone_row
    on timezone_row.name = round_row.local_timezone
  left join lateral (
    select snapshot_row.id
    from public.auction_feature_snapshots snapshot_row
    where snapshot_row.round_id = round_row.id
      and snapshot_row.built_at <= %s
      and snapshot_row.created_at <= %s
      and snapshot_row.recorded_at <= %s
      and snapshot_row.feature_cutoff_at <= %s
      and not snapshot_row.retrospective
      and snapshot_row.leakage_check_status = 'passed'
    order by snapshot_row.created_at desc, snapshot_row.id desc
    limit 1
  ) frozen_snapshot on true
  where round_row.round_kind = %s
    and round_row.scheduled_at is not null
    and round_row.created_at <= %s
    and round_row.recorded_at <= %s
    and (
      (
        timezone_row.name is null
        and round_row.scheduled_at::date between %s::date - 1 and %s::date + 1
      )
      or (
        timezone_row.name is not null
        and (round_row.scheduled_at at time zone timezone_row.name)::date between %s and %s
      )
    )
  order by round_row.scheduled_at, round_row.id
  limit %s
)
select
  bounded_rounds.*,
  outcome_row.id as outcome_id,
  outcome_row.version as outcome_version,
  outcome_row.valid_from as outcome_valid_from,
  outcome_row.valid_to as outcome_valid_to,
  outcome_row.created_at as outcome_created_at,
  outcome_row.recorded_at as outcome_recorded_at,
  outcome_row.supersedes_outcome_id,
  outcome_row.outcome_status,
  outcome_row.initial_hammer_price_eur,
  outcome_row.final_hammer_price_eur,
  outcome_row.finality_status,
  outcome_row.surenchere_status,
  outcome_row.result_observed_at,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'outcome_status', %s
  ), false) as eligible_outcome_status,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'initial_starting_price_eur', %s
  ), false) as eligible_initial_starting_price,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'effective_starting_price_eur', %s
  ), false) as eligible_effective_starting_price,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'initial_hammer_price_eur', %s
  ), false) as eligible_initial_hammer_price,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'final_hammer_price_eur', %s
  ), false) as eligible_final_hammer_price,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'finality_status', %s
  ), false) as eligible_finality_status,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'surenchere_status', %s
  ), false) as eligible_surenchere_status,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id, 'result_observed_at', %s
  ), false) as eligible_result_observed_at,
  coalesce(app_private.outcome_claim_is_double_reviewed_at(
    outcome_row.id, 'outcome_status', %s
  ), false) as status_double_reviewed
from bounded_rounds
left join public.auction_outcomes outcome_row
 on outcome_row.round_id = bounded_rounds.round_id
 and outcome_row.valid_from <= %s
 and outcome_row.created_at <= %s
 and outcome_row.recorded_at <= %s
order by bounded_rounds.scheduled_at, bounded_rounds.round_id, outcome_row.version
"""


class OutcomeStatisticsRepository:
    def __init__(
        self,
        db_url: str,
        *,
        connect: Callable[[str], Any] = _postgres_connect,
    ) -> None:
        if not db_url.strip():
            raise OutcomeStatisticsRepositoryError("SUPABASE_DB_URL is required")
        self._db_url = db_url
        self._connect = connect
        self._source_lock_held = False
        self._active_connection: Any | None = None

    @contextmanager
    def serialized_source_view(self) -> Iterator[None]:
        """Freeze all outcome-statistics source writers for one complete run.

        Database write triggers acquire the same transaction-scoped advisory
        lock. Keeping this transaction open across load, build and persistence
        closes the pre-commit visibility gap and remains safe with transaction
        poolers such as Supavisor.
        """

        if self._active_connection is not None:
            raise OutcomeStatisticsRepositoryError("serialized_source_view cannot be nested")
        try:
            connection_context = self._connect(self._db_url)
            with connection_context as connection:
                try:
                    with connection.cursor() as cursor:
                        # Acquire the writer-shared lock before the first source
                        # read. READ COMMITTED then observes every writer that
                        # committed before we obtained the lock; subsequent
                        # source writes are blocked until this transaction ends.
                        cursor.execute("set transaction isolation level read committed")
                        cursor.execute(
                            "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s, 0))",
                            (_SOURCE_SERIALIZATION_LOCK,),
                        )
                        cursor.fetchone()
                except Exception as exc:
                    connection.rollback()
                    raise OutcomeStatisticsRepositoryError(
                        "failed to acquire the outcome-statistics source lock"
                    ) from exc

                self._active_connection = connection
                self._source_lock_held = True
                try:
                    yield
                except BaseException:
                    connection.rollback()
                    raise
                else:
                    try:
                        connection.commit()
                    except BaseException:
                        connection.rollback()
                        raise
                finally:
                    self._source_lock_held = False
                    self._active_connection = None
        except OutcomeStatisticsRepositoryError:
            raise
        except Exception as exc:
            raise OutcomeStatisticsRepositoryError("outcome-statistics source transaction failed") from exc

    def load_rounds(
        self,
        *,
        period_start: date,
        period_end: date,
        knowledge_cutoff_at: datetime,
        round_kind: RoundKind,
        max_rounds: int,
    ) -> tuple[RoundObservation, ...]:
        if max_rounds < 1:
            raise ValueError("max_rounds must be positive")
        parameters: tuple[object, ...] = (
            knowledge_cutoff_at,
            knowledge_cutoff_at,
            knowledge_cutoff_at,
            knowledge_cutoff_at,
            round_kind,
            knowledge_cutoff_at,
            knowledge_cutoff_at,
            period_start,
            period_end,
            period_start,
            period_end,
            max_rounds + 1,
            *([knowledge_cutoff_at] * 9),
            knowledge_cutoff_at,
            knowledge_cutoff_at,
            knowledge_cutoff_at,
        )

        def load_from(connection: Any) -> tuple[dict[str, object], ...]:
            with connection.cursor() as cursor:
                cursor.execute(_LOAD_ROUNDS_SQL, parameters)
                return _mapping_rows(cursor)

        try:
            if self._active_connection is not None:
                rows = load_from(self._active_connection)
            else:
                with self._connect(self._db_url) as connection:
                    rows = load_from(connection)
        except Exception as exc:
            raise OutcomeStatisticsRepositoryError("failed to load the frozen mature-round universe") from exc
        observations = _round_observations(rows, knowledge_cutoff_at)
        if len(observations) > max_rounds:
            raise RoundBoundExceeded(f"mature round universe exceeds the explicit --max-rounds bound ({max_rounds})")
        return observations

    def persist_bundles(self, bundles: Sequence[StatisticsBundle]) -> PersistSummary:
        if Jsonb is None:
            raise OutcomeStatisticsRepositoryError("psycopg is required for snapshot persistence")
        if not self._source_lock_held or self._active_connection is None:
            raise OutcomeStatisticsRepositoryError("snapshot persistence requires serialized_source_view")
        inserted_snapshots = 0
        reused_snapshots = 0
        inserted_members = 0
        try:
            with self._active_connection.cursor() as cursor:
                for bundle in bundles:
                    national_id, inserted = _persist_snapshot(
                        cursor,
                        bundle.national,
                        parent_snapshot_id=None,
                    )
                    inserted_snapshots += inserted
                    reused_snapshots += not inserted
                    inserted_members += len(bundle.national.members) if inserted else 0
                    for tribunal in bundle.tribunals:
                        tribunal_id, inserted = _persist_snapshot(
                            cursor,
                            tribunal,
                            parent_snapshot_id=national_id,
                        )
                        del tribunal_id
                        inserted_snapshots += inserted
                        reused_snapshots += not inserted
                        inserted_members += len(tribunal.members) if inserted else 0
        except Exception as exc:
            raise OutcomeStatisticsRepositoryError(
                "statistics snapshot transaction failed and was rolled back"
            ) from exc
        return PersistSummary(
            inserted_snapshots=inserted_snapshots,
            reused_snapshots=reused_snapshots,
            inserted_members=inserted_members,
        )


def _round_observations(
    rows: Iterable[Mapping[str, object]],
    knowledge_cutoff_at: datetime,
) -> tuple[RoundObservation, ...]:
    grouped: dict[str, tuple[Mapping[str, object], list[OutcomeVersion]]] = {}
    for row in rows:
        if row.get("timezone_is_valid") is not True:
            raise ValueError("invalid local timezone in statistics input")
        round_id = str(row["round_id"])
        base, outcomes = grouped.setdefault(round_id, (row, []))
        if row.get("outcome_id") is None:
            continue
        eligible_claims: set[ClaimType] = set()
        for column, claim in (
            ("eligible_outcome_status", "outcome_status"),
            ("eligible_initial_starting_price", "initial_starting_price_eur"),
            ("eligible_effective_starting_price", "effective_starting_price_eur"),
            ("eligible_initial_hammer_price", "initial_hammer_price_eur"),
            ("eligible_final_hammer_price", "final_hammer_price_eur"),
            ("eligible_finality_status", "finality_status"),
            ("eligible_surenchere_status", "surenchere_status"),
            ("eligible_result_observed_at", "result_observed_at"),
        ):
            if bool(row.get(column)):
                eligible_claims.add(cast("ClaimType", claim))
        outcomes.append(
            OutcomeVersion(
                outcome_id=str(row["outcome_id"]),
                version=int(cast("int", row["outcome_version"])),
                valid_from=cast("datetime", row["outcome_valid_from"]),
                valid_to=cast("datetime | None", row.get("outcome_valid_to")),
                created_at=cast("datetime", row["outcome_created_at"]),
                supersedes_outcome_id=(
                    str(row["supersedes_outcome_id"]) if row.get("supersedes_outcome_id") is not None else None
                ),
                outcome_status=cast("Any", row["outcome_status"]),
                initial_hammer_price_eur=cast("Decimal | None", row.get("initial_hammer_price_eur")),
                final_hammer_price_eur=cast("Decimal | None", row.get("final_hammer_price_eur")),
                finality_status=cast("Any", row.get("finality_status") or "unknown"),
                surenchere_status=cast("Any", row.get("surenchere_status") or "unknown"),
                result_observed_at=cast("datetime | None", row.get("result_observed_at")),
                eligible_claims=frozenset(eligible_claims),
                status_independently_double_reviewed=bool(row.get("status_double_reviewed")),
                eligibility_evaluated_at=knowledge_cutoff_at,
                recorded_at=cast("datetime", row["outcome_recorded_at"]),
            )
        )

    observations = []
    for round_id, (row, outcomes) in grouped.items():
        observations.append(
            RoundObservation(
                round_id=round_id,
                lot_id=str(row["lot_id"]),
                court_id=str(row["court_id"]),
                court_code=str(row["court_code"]),
                court_name=str(row["court_name"]),
                judicial_region=(str(row["judicial_region"]) if row.get("judicial_region") is not None else None),
                round_kind=cast("Any", row["round_kind"]),
                scheduled_at=cast("datetime", row["scheduled_at"]),
                local_timezone=str(row["local_timezone"]),
                feature_snapshot_id=(
                    str(row["feature_snapshot_id"]) if row.get("feature_snapshot_id") is not None else None
                ),
                initial_starting_price_eur=cast("Decimal | None", row.get("initial_starting_price_eur")),
                effective_starting_price_eur=cast("Decimal | None", row.get("effective_starting_price_eur")),
                outcomes=tuple(outcomes),
            )
        )
    return tuple(sorted(observations, key=lambda value: (value.scheduled_at, value.round_id)))


def _persist_snapshot(
    cursor: Any,
    snapshot: StatisticsSnapshot,
    *,
    parent_snapshot_id: str | None,
) -> tuple[str, bool]:
    lock_key = ":".join(
        (
            "tribunal-statistics",
            snapshot.scope_type,
            snapshot.court_id or "national",
            snapshot.round_kind,
            str(snapshot.period.window_months),
            snapshot.period.knowledge_cutoff_at.isoformat(),
            snapshot.builder_version,
        )
    )
    cursor.execute("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(%s))", (lock_key,))
    member_hashes = _database_member_hashes(cursor, snapshot)
    source_manifest_hash = _database_source_manifest_hash(cursor, snapshot, member_hashes)
    existing = _find_existing_snapshot(
        cursor,
        snapshot,
        parent_snapshot_id=parent_snapshot_id,
        source_manifest_hash=source_manifest_hash,
    )
    if existing is not None:
        return existing, False

    cursor.execute(
        """
        insert into public.tribunal_statistics_snapshots (
          scope_type, court_id, court_code, court_name, judicial_region,
          parent_snapshot_id, round_kind, window_months, period_start, period_end,
          knowledge_cutoff_at, maturity_days, builder_version,
          eligibility_rule_version, smoothing_rule_version, reliability_status,
          quality_gate_passed, eligible_round_count, unfrozen_round_count, freeze_coverage,
          status_sample_size,
          initial_price_sample_size, effective_price_sample_size, market_price_sample_size,
          surenchere_sample_size, result_delay_sample_size, postponement_delay_sample_size,
          double_reviewed_count,
          outcome_coverage, statistics, source_manifest_hash, statistics_hash,
          computed_at
        ) values (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s
        )
        returning id
        """,
        (
            snapshot.scope_type,
            snapshot.court_id,
            snapshot.court_code,
            snapshot.court_name,
            snapshot.judicial_region,
            parent_snapshot_id,
            snapshot.round_kind,
            snapshot.period.window_months,
            snapshot.period.start,
            snapshot.period.end,
            snapshot.period.knowledge_cutoff_at,
            snapshot.period.maturity_days,
            snapshot.builder_version,
            snapshot.eligibility_rule_version,
            snapshot.smoothing_rule_version,
            snapshot.reliability_status,
            snapshot.quality_gate_passed,
            snapshot.eligible_round_count,
            snapshot.unfrozen_round_count,
            Decimal(str(snapshot.freeze_coverage)),
            snapshot.status_sample_size,
            snapshot.initial_price_sample_size,
            snapshot.effective_price_sample_size,
            snapshot.market_price_sample_size,
            snapshot.surenchere_sample_size,
            snapshot.result_delay_sample_size,
            snapshot.postponement_delay_sample_size,
            snapshot.double_reviewed_count,
            Decimal(str(snapshot.outcome_coverage)),
            Jsonb(snapshot.statistics),
            source_manifest_hash,
            "0" * 64,  # Recomputed by the immutable database trigger.
            snapshot.computed_at,
        ),
    )
    snapshot_id = str(cursor.fetchone()[0])
    _insert_members(cursor, snapshot_id, snapshot.members, member_hashes)
    return snapshot_id, True


def _database_member_hashes(
    cursor: Any,
    snapshot: StatisticsSnapshot,
) -> dict[str, str]:
    members = tuple(sorted(snapshot.members, key=lambda value: value.round_id))
    if not members:
        return {}
    cursor.execute(
        """
        with member_input as (
          select *
          from pg_catalog.jsonb_to_recordset(%s::jsonb) as input_row (
            round_id uuid,
            feature_snapshot_id uuid,
            outcome_id uuid,
            court_id uuid,
            status_claim_eligible boolean,
            initial_starting_price_claim_eligible boolean,
            effective_starting_price_claim_eligible boolean,
            initial_hammer_price_claim_eligible boolean,
            final_hammer_price_claim_eligible boolean,
            finality_status_claim_eligible boolean,
            market_price_claim_eligible boolean,
            surenchere_claim_eligible boolean,
            result_observed_at_claim_eligible boolean,
            postponement_delay_eligible boolean,
            double_reviewed boolean,
            exclusion_reasons jsonb
          )
        ), hashed as (
          select
            member_input.round_id::text as round_id,
            app_private.tribunal_statistics_member_hash(
              member_input.round_id,
              member_input.feature_snapshot_id,
              member_input.outcome_id,
              member_input.court_id,
              member_input.status_claim_eligible,
              member_input.initial_starting_price_claim_eligible,
              member_input.effective_starting_price_claim_eligible,
              member_input.initial_hammer_price_claim_eligible,
              member_input.final_hammer_price_claim_eligible,
              member_input.finality_status_claim_eligible,
              member_input.market_price_claim_eligible,
              member_input.surenchere_claim_eligible,
              member_input.result_observed_at_claim_eligible,
              member_input.postponement_delay_eligible,
              member_input.double_reviewed,
              coalesce(
                array(
                  select pg_catalog.jsonb_array_elements_text(
                    coalesce(member_input.exclusion_reasons, '[]'::jsonb)
                  )
                ),
                '{}'::text[]
              ),
              %s,
              %s
            ) as member_hash
          from member_input
        )
        select coalesce(
          pg_catalog.jsonb_object_agg(
            hashed.round_id,
            hashed.member_hash order by hashed.round_id
          ),
          '{}'::jsonb
        )
        from hashed
        """,
        (
            Jsonb([_member_record(member) for member in members]),
            snapshot.period.knowledge_cutoff_at,
            snapshot.eligibility_rule_version,
        ),
    )
    row = cursor.fetchone()
    raw_hashes = row[0] if row else None
    if not isinstance(raw_hashes, Mapping):
        raise OutcomeStatisticsRepositoryError("database returned an invalid member hash batch")
    hashes = {str(round_id): str(member_hash) for round_id, member_hash in raw_hashes.items()}
    expected_round_ids = {member.round_id for member in members}
    if (
        len(expected_round_ids) != len(members)
        or set(hashes) != expected_round_ids
        or any(not _is_sha256(value) for value in hashes.values())
    ):
        raise OutcomeStatisticsRepositoryError("database returned an invalid member hash batch")
    return hashes


def _database_source_manifest_hash(
    cursor: Any,
    snapshot: StatisticsSnapshot,
    member_hashes: Mapping[str, str],
) -> str:
    unfrozen_round_ids = [
        entry.round_id for entry in sorted(snapshot.unfrozen_rounds, key=lambda value: value.round_id)
    ]
    if len(unfrozen_round_ids) != snapshot.unfrozen_round_count:
        raise OutcomeStatisticsRepositoryError("unfrozen round count does not match its private manifest")
    if len(unfrozen_round_ids) != len(set(unfrozen_round_ids)):
        raise OutcomeStatisticsRepositoryError("unfrozen round manifest contains duplicate IDs")
    if snapshot.scope_type == "tribunal" and any(
        entry.court_id != snapshot.court_id for entry in snapshot.unfrozen_rounds
    ):
        raise OutcomeStatisticsRepositoryError("tribunal unfrozen round manifest contains another court")
    members = [
        {"roundId": member.round_id, "memberHash": member_hashes[member.round_id]}
        for member in sorted(snapshot.members, key=lambda value: value.round_id)
    ]
    cursor.execute(
        """
        select app_private.tribunal_statistics_source_manifest_hash(
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          (
            select coalesce(
              pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'roundId', round_row.id,
                  'lotId', round_row.lot_id,
                  'courtId', round_row.court_id,
                  'courtCode', court_row.code,
                  'courtName', court_row.name,
                  'judicialRegion', court_row.judicial_region,
                  'scheduledAtEpoch', extract(epoch from round_row.scheduled_at),
                  'localTimezone', round_row.local_timezone
                ) order by round_row.id
              ),
              '[]'::jsonb
            )
            from public.auction_rounds round_row
            join public.outcome_courts court_row on court_row.id = round_row.court_id
            where round_row.id = any(%s::uuid[])
          ),
          %s::jsonb
        )
        """,
        (
            snapshot.scope_type,
            snapshot.court_id,
            snapshot.round_kind,
            snapshot.period.window_months,
            snapshot.period.start,
            snapshot.period.end,
            snapshot.period.knowledge_cutoff_at,
            snapshot.period.maturity_days,
            snapshot.builder_version,
            snapshot.eligibility_rule_version,
            snapshot.unfrozen_round_count,
            unfrozen_round_ids,
            Jsonb(members),
        ),
    )
    return str(cursor.fetchone()[0])


def _find_existing_snapshot(
    cursor: Any,
    snapshot: StatisticsSnapshot,
    *,
    parent_snapshot_id: str | None,
    source_manifest_hash: str,
) -> str | None:
    cursor.execute(
        """
        select id
        from public.tribunal_statistics_snapshots
        where scope_type = %s
          and court_id is not distinct from %s
          and court_code is not distinct from %s
          and court_name is not distinct from %s
          and judicial_region is not distinct from %s
          and parent_snapshot_id is not distinct from %s
          and round_kind = %s
          and window_months = %s
          and period_start = %s
          and period_end = %s
          and knowledge_cutoff_at = %s
          and maturity_days = %s
          and builder_version = %s
          and eligibility_rule_version = %s
          and smoothing_rule_version = %s
          and reliability_status = %s
          and quality_gate_passed = %s
          and eligible_round_count = %s
          and unfrozen_round_count = %s
          and freeze_coverage = %s
          and status_sample_size = %s
          and initial_price_sample_size = %s
          and effective_price_sample_size = %s
          and market_price_sample_size = %s
          and surenchere_sample_size = %s
          and result_delay_sample_size = %s
          and postponement_delay_sample_size = %s
          and double_reviewed_count = %s
          and outcome_coverage = %s
          and statistics = %s::jsonb
          and source_manifest_hash = %s
        limit 1
        """,
        (
            snapshot.scope_type,
            snapshot.court_id,
            snapshot.court_code,
            snapshot.court_name,
            snapshot.judicial_region,
            parent_snapshot_id,
            snapshot.round_kind,
            snapshot.period.window_months,
            snapshot.period.start,
            snapshot.period.end,
            snapshot.period.knowledge_cutoff_at,
            snapshot.period.maturity_days,
            snapshot.builder_version,
            snapshot.eligibility_rule_version,
            snapshot.smoothing_rule_version,
            snapshot.reliability_status,
            snapshot.quality_gate_passed,
            snapshot.eligible_round_count,
            snapshot.unfrozen_round_count,
            Decimal(str(snapshot.freeze_coverage)),
            snapshot.status_sample_size,
            snapshot.initial_price_sample_size,
            snapshot.effective_price_sample_size,
            snapshot.market_price_sample_size,
            snapshot.surenchere_sample_size,
            snapshot.result_delay_sample_size,
            snapshot.postponement_delay_sample_size,
            snapshot.double_reviewed_count,
            Decimal(str(snapshot.outcome_coverage)),
            Jsonb(snapshot.statistics),
            source_manifest_hash,
        ),
    )
    row = cursor.fetchone()
    return str(row[0]) if row else None


def _insert_members(
    cursor: Any,
    snapshot_id: str,
    members: Sequence[SnapshotMember],
    member_hashes: Mapping[str, str],
) -> None:
    ordered_members = tuple(sorted(members, key=lambda value: value.round_id))
    if not ordered_members:
        return
    if set(member_hashes) != {member.round_id for member in ordered_members} or any(
        not _is_sha256(value) for value in member_hashes.values()
    ):
        raise OutcomeStatisticsRepositoryError("member hash batch does not match snapshot members")
    records = []
    for member in ordered_members:
        record = _member_record(member)
        record["member_hash"] = member_hashes[member.round_id]
        records.append(record)
    cursor.execute(
        """
        insert into public.tribunal_statistics_members (
          snapshot_id, round_id, feature_snapshot_id, outcome_id, court_id,
          status_claim_eligible, initial_starting_price_claim_eligible,
          effective_starting_price_claim_eligible,
          initial_hammer_price_claim_eligible, final_hammer_price_claim_eligible,
          finality_status_claim_eligible, market_price_claim_eligible,
          surenchere_claim_eligible, result_observed_at_claim_eligible,
          postponement_delay_eligible, double_reviewed,
          exclusion_reasons, member_hash
        )
        select
          %s::uuid,
          member_input.round_id,
          member_input.feature_snapshot_id,
          member_input.outcome_id,
          member_input.court_id,
          member_input.status_claim_eligible,
          member_input.initial_starting_price_claim_eligible,
          member_input.effective_starting_price_claim_eligible,
          member_input.initial_hammer_price_claim_eligible,
          member_input.final_hammer_price_claim_eligible,
          member_input.finality_status_claim_eligible,
          member_input.market_price_claim_eligible,
          member_input.surenchere_claim_eligible,
          member_input.result_observed_at_claim_eligible,
          member_input.postponement_delay_eligible,
          member_input.double_reviewed,
          coalesce(
            array(
              select pg_catalog.jsonb_array_elements_text(
                coalesce(member_input.exclusion_reasons, '[]'::jsonb)
              )
            ),
            '{}'::text[]
          ),
          member_input.member_hash
        from pg_catalog.jsonb_to_recordset(%s::jsonb) as member_input (
          round_id uuid,
          feature_snapshot_id uuid,
          outcome_id uuid,
          court_id uuid,
          status_claim_eligible boolean,
          initial_starting_price_claim_eligible boolean,
          effective_starting_price_claim_eligible boolean,
          initial_hammer_price_claim_eligible boolean,
          final_hammer_price_claim_eligible boolean,
          finality_status_claim_eligible boolean,
          market_price_claim_eligible boolean,
          surenchere_claim_eligible boolean,
          result_observed_at_claim_eligible boolean,
          postponement_delay_eligible boolean,
          double_reviewed boolean,
          exclusion_reasons jsonb,
          member_hash text
        )
        order by member_input.round_id
        """,
        (
            snapshot_id,
            Jsonb(records),
        ),
    )


def _member_record(member: SnapshotMember) -> dict[str, object]:
    return {
        "round_id": member.round_id,
        "feature_snapshot_id": member.feature_snapshot_id,
        "outcome_id": member.outcome_id,
        "court_id": member.court_id,
        "status_claim_eligible": member.status_claim_eligible,
        "initial_starting_price_claim_eligible": member.initial_starting_price_claim_eligible,
        "effective_starting_price_claim_eligible": member.effective_starting_price_claim_eligible,
        "initial_hammer_price_claim_eligible": member.initial_hammer_price_claim_eligible,
        "final_hammer_price_claim_eligible": member.final_hammer_price_claim_eligible,
        "finality_status_claim_eligible": member.finality_status_claim_eligible,
        "market_price_claim_eligible": member.market_price_claim_eligible,
        "surenchere_claim_eligible": member.surenchere_claim_eligible,
        "result_observed_at_claim_eligible": member.result_observed_at_claim_eligible,
        "postponement_delay_eligible": member.postponement_delay_eligible,
        "double_reviewed": member.double_reviewed,
        "exclusion_reasons": list(member.exclusion_reasons),
    }


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _mapping_rows(cursor: Any) -> tuple[dict[str, object], ...]:
    columns = tuple(description.name for description in cursor.description)
    return tuple(dict(zip(columns, row, strict=True)) for row in cursor.fetchall())
