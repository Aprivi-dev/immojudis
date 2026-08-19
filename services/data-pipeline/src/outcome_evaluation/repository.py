from __future__ import annotations

import json
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from hashlib import sha256
from typing import Any

from src.outcome_evaluation.engine import evaluate, validate_public_report
from src.outcome_evaluation.models import EvaluationConfig, EvaluationInputError, EvaluationRecord, PriceQuantiles
from src.outcome_evaluation.reporting import build_promotion_summary
from src.storage.supabase_client import _postgres_connect


class OutcomeEvaluationRepositoryError(RuntimeError):
    pass


class EvaluationBoundExceeded(OutcomeEvaluationRepositoryError):
    pass


@dataclass(frozen=True, slots=True)
class EvaluationUniverse:
    model_version_id: str
    model_status: str
    records: tuple[EvaluationRecord, ...]
    feature_cutoff_at: datetime | None
    source_manifest_hash: str
    prediction_manifest_hash: str
    outcome_manifest_hash: str


@dataclass(frozen=True, slots=True)
class EvaluationPersistSummary:
    inserted_evaluations: int


_LOAD_MODEL_SQL = """
select model_row.id::text, model_row.status
from public.model_versions model_row
where model_row.model_key = %s
  and model_row.version = %s
limit 1
"""


_LOAD_RECORDS_SQL = """
with selected_model as (
  select model_row.id
  from public.model_versions model_row
  where model_row.model_key = %s
    and model_row.version = %s
  limit 1
), bounded_rounds as (
  select
    round_row.id,
    round_row.lot_id,
    round_row.scheduled_at,
    coalesce(round_row.effective_starting_price_eur,
             round_row.initial_starting_price_eur,
             lot_row.initial_starting_price_eur) as starting_price_eur,
    lot_row.property_type,
    lot_row.occupation_status,
    case_row.procedure_type,
    court_row.code as tribunal,
    court_row.judicial_region,
    evaluation_context.knowledge_cutoff_at
  from public.auction_rounds round_row
  join public.auction_lots lot_row on lot_row.id = round_row.lot_id
  join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
  join public.outcome_courts court_row on court_row.id = round_row.court_id
  cross join lateral (
    select %s::timestamptz as knowledge_cutoff_at
  ) evaluation_context
  where round_row.scheduled_at >= %s
    and round_row.scheduled_at < %s
    and round_row.created_at <= evaluation_context.knowledge_cutoff_at
    and round_row.recorded_at <= evaluation_context.knowledge_cutoff_at
  order by round_row.scheduled_at, round_row.lot_id, round_row.id
  limit %s
)
select
  bounded_rounds.id::text as round_key,
  bounded_rounds.lot_id::text as lot_key,
  bounded_rounds.scheduled_at,
  bounded_rounds.starting_price_eur,
  bounded_rounds.property_type,
  bounded_rounds.occupation_status,
  bounded_rounds.procedure_type,
  bounded_rounds.tribunal,
  bounded_rounds.judicial_region,
  outcome_row.outcome_status,
  outcome_row.id::text as outcome_key,
  outcome_row.version as outcome_version,
  outcome_row.final_hammer_price_eur as outcome_final_hammer_price_eur,
  outcome_row.finality_status as outcome_finality_status,
  outcome_row.result_observed_at as outcome_result_observed_at,
  outcome_row.created_at as outcome_created_at,
  outcome_row.recorded_at as outcome_recorded_at,
  claim_availability.status_available_at as label_available_at,
  greatest(
    claim_availability.final_price_available_at,
    claim_availability.finality_available_at
  ) as price_label_available_at,
  coalesce(app_private.outcome_claim_is_eligible_at(
    outcome_row.id,
    'outcome_status',
    bounded_rounds.knowledge_cutoff_at
  ), false)
    as label_eligible,
  case
    when outcome_row.finality_status = 'procedurally_definitive'
      and coalesce(app_private.outcome_claim_is_eligible_at(
        outcome_row.id,
        'final_hammer_price_eur',
        bounded_rounds.knowledge_cutoff_at
      ), false)
      and coalesce(app_private.outcome_claim_is_eligible_at(
        outcome_row.id,
        'finality_status',
        bounded_rounds.knowledge_cutoff_at
      ), false)
      then outcome_row.final_hammer_price_eur
    else null
  end as actual_price_eur,
  coalesce(prediction_snapshot.feature_cutoff_at, available_snapshot.feature_cutoff_at) as snapshot_cutoff_at,
  coalesce(prediction_snapshot.built_at, available_snapshot.built_at) as snapshot_built_at,
  coalesce(prediction_snapshot.created_at, available_snapshot.created_at) as snapshot_created_at,
  coalesce(prediction_snapshot.recorded_at, available_snapshot.recorded_at) as snapshot_recorded_at,
  coalesce(prediction_snapshot.source_manifest_hash, available_snapshot.source_manifest_hash)
    as source_manifest_hash,
  coalesce(prediction_snapshot.snapshot_hash, available_snapshot.snapshot_hash) as snapshot_hash,
  coalesce(prediction_snapshot.leakage_check_status, available_snapshot.leakage_check_status) = 'passed'
    and not coalesce(prediction_snapshot.retrospective, available_snapshot.retrospective, true)
    and coalesce(prediction_snapshot.feature_cutoff_at, available_snapshot.feature_cutoff_at)
      < bounded_rounds.scheduled_at
    and coalesce(prediction_snapshot.built_at, available_snapshot.built_at) < bounded_rounds.scheduled_at
    and coalesce(prediction_snapshot.created_at, available_snapshot.created_at) < bounded_rounds.scheduled_at
    and coalesce(prediction_snapshot.recorded_at, available_snapshot.recorded_at) < bounded_rounds.scheduled_at
    as leakage_check_passed,
  prediction_row.prediction_status,
  prediction_row.id::text as prediction_key,
  prediction_row.prediction_hash,
  prediction_row.generated_at as prediction_generated_at,
  prediction_row.created_at as prediction_recorded_at,
  prediction_row.probabilities,
  prediction_row.quantiles,
  %s::text as horizon
from bounded_rounds
left join lateral (
  select candidate.*
  from public.auction_outcomes candidate
  where candidate.round_id = bounded_rounds.id
    and candidate.valid_from <= bounded_rounds.knowledge_cutoff_at
    and candidate.created_at <= bounded_rounds.knowledge_cutoff_at
    and candidate.recorded_at <= bounded_rounds.knowledge_cutoff_at
  order by candidate.version desc, candidate.id desc
  limit 1
) outcome_row on true
left join lateral (
  select
    greatest(
      outcome_row.result_observed_at,
      outcome_row.created_at,
      outcome_row.recorded_at,
      max(decision_row.decided_at) filter (
        where decision_row.claim_type = 'outcome_status'
      ),
      max(decision_row.created_at) filter (
        where decision_row.claim_type = 'outcome_status'
      ),
      max(link.created_at) filter (
        where decision_row.claim_type = 'outcome_status'
      ),
      max(evidence.created_at) filter (
        where decision_row.claim_type = 'outcome_status'
      ),
      max(review_row.reviewed_at) filter (
        where decision_row.claim_type = 'outcome_status'
      ),
      max(review_row.recorded_at) filter (
        where decision_row.claim_type = 'outcome_status'
      )
    ) as status_available_at,
    greatest(
      outcome_row.result_observed_at,
      outcome_row.created_at,
      outcome_row.recorded_at,
      max(decision_row.decided_at) filter (
        where decision_row.claim_type = 'final_hammer_price_eur'
      ),
      max(decision_row.created_at) filter (
        where decision_row.claim_type = 'final_hammer_price_eur'
      ),
      max(link.created_at) filter (
        where decision_row.claim_type = 'final_hammer_price_eur'
      ),
      max(evidence.created_at) filter (
        where decision_row.claim_type = 'final_hammer_price_eur'
      ),
      max(review_row.reviewed_at) filter (
        where decision_row.claim_type = 'final_hammer_price_eur'
      ),
      max(review_row.recorded_at) filter (
        where decision_row.claim_type = 'final_hammer_price_eur'
      )
    ) as final_price_available_at,
    greatest(
      outcome_row.result_observed_at,
      outcome_row.created_at,
      outcome_row.recorded_at,
      max(decision_row.decided_at) filter (
        where decision_row.claim_type = 'finality_status'
      ),
      max(decision_row.created_at) filter (
        where decision_row.claim_type = 'finality_status'
      ),
      max(link.created_at) filter (
        where decision_row.claim_type = 'finality_status'
      ),
      max(evidence.created_at) filter (
        where decision_row.claim_type = 'finality_status'
      ),
      max(review_row.reviewed_at) filter (
        where decision_row.claim_type = 'finality_status'
      ),
      max(review_row.recorded_at) filter (
        where decision_row.claim_type = 'finality_status'
      )
    ) as finality_available_at
  from public.outcome_claim_eligibility_decisions decision_row
  left join public.outcome_claim_eligibility_evidence link
    on link.eligibility_decision_id = decision_row.id
   and link.created_at <= bounded_rounds.knowledge_cutoff_at
  left join public.auction_outcome_evidence evidence
    on evidence.id = link.evidence_id
   and evidence.outcome_id = decision_row.outcome_id
   and evidence.created_at <= bounded_rounds.knowledge_cutoff_at
  left join public.evidence_reviews review_row
    on review_row.evidence_id = evidence.id
   and review_row.reviewed_at <= bounded_rounds.knowledge_cutoff_at
   and review_row.recorded_at <= bounded_rounds.knowledge_cutoff_at
  where decision_row.outcome_id = outcome_row.id
    and decision_row.claim_type in (
      'outcome_status',
      'final_hammer_price_eur',
      'finality_status'
    )
    and decision_row.decided_at <= bounded_rounds.knowledge_cutoff_at
    and decision_row.created_at <= bounded_rounds.knowledge_cutoff_at
) claim_availability on true
left join lateral (
  select candidate.*
  from public.auction_predictions candidate
  join selected_model on selected_model.id = candidate.model_version_id
  where candidate.round_id = bounded_rounds.id
    and candidate.prediction_kind = %s
    and candidate.horizon = %s
    and candidate.generated_at <= bounded_rounds.knowledge_cutoff_at
    and candidate.created_at <= bounded_rounds.knowledge_cutoff_at
  order by candidate.generated_at desc, candidate.created_at desc
  limit 1
) prediction_row on true
left join public.auction_feature_snapshots prediction_snapshot
  on prediction_snapshot.id = prediction_row.snapshot_id
left join lateral (
  select
    candidate.feature_cutoff_at,
    candidate.built_at,
    candidate.created_at,
    candidate.recorded_at,
    candidate.source_manifest_hash,
    candidate.snapshot_hash,
    candidate.leakage_check_status,
    candidate.retrospective
  from public.auction_feature_snapshots candidate
  where candidate.round_id = bounded_rounds.id
    and candidate.prediction_horizon = %s
    and candidate.feature_cutoff_at < bounded_rounds.scheduled_at
    and candidate.built_at < bounded_rounds.scheduled_at
    and candidate.created_at < bounded_rounds.scheduled_at
    and candidate.recorded_at < bounded_rounds.scheduled_at
  order by candidate.feature_cutoff_at desc, candidate.created_at desc
  limit 1
) available_snapshot on true
order by bounded_rounds.scheduled_at, bounded_rounds.lot_id, bounded_rounds.id
"""


_INSERT_EVALUATION_SQL = """
insert into public.outcome_model_evaluations (
  model_version_id,
  evaluation_mode,
  evaluation_status,
  evaluation_rule_version,
  evaluation_period_start,
  evaluation_period_end,
  feature_cutoff_at,
  outcome_cutoff_at,
  knowledge_cutoff_at,
  required_observation_count,
  observation_count,
  eligible_observation_count,
  scored_observation_count,
  known_outcome_count,
  excluded_observation_count,
  invalid_observation_count,
  source_manifest_hash,
  prediction_manifest_hash,
  outcome_manifest_hash,
  report
) values (
  %s, %s, %s, 'outcome_evaluation_gate_v1',
  %s, %s, %s, %s, %s,
  %s, %s, %s, %s, %s, %s, %s,
  %s, %s, %s, %s::jsonb
)
on conflict do nothing
returning evaluation_hash
"""

_FIND_EXISTING_EVALUATION_SQL = """
select evaluation_hash
from public.outcome_model_evaluations
where model_version_id = %s
  and evaluation_mode = %s
  and evaluation_status = %s
  and evaluation_rule_version = 'outcome_evaluation_gate_v1'
  and evaluation_period_start = %s
  and evaluation_period_end = %s
  and feature_cutoff_at = %s
  and outcome_cutoff_at = %s
  and knowledge_cutoff_at = %s
  and required_observation_count = %s
  and observation_count = %s
  and eligible_observation_count = %s
  and scored_observation_count = %s
  and known_outcome_count = %s
  and excluded_observation_count = %s
  and invalid_observation_count = %s
  and source_manifest_hash = %s
  and prediction_manifest_hash = %s
  and outcome_manifest_hash = %s
  and report = %s::jsonb
order by created_at desc, id desc
limit 1
"""

_SOURCE_MANIFEST_FIELDS = (
    "round_key",
    "lot_key",
    "scheduled_at",
    "starting_price_eur",
    "property_type",
    "occupation_status",
    "procedure_type",
    "tribunal",
    "judicial_region",
    "horizon",
    "snapshot_hash",
    "source_manifest_hash",
    "snapshot_cutoff_at",
    "snapshot_built_at",
    "snapshot_created_at",
    "snapshot_recorded_at",
    "leakage_check_passed",
)
_PREDICTION_MANIFEST_FIELDS = (
    "round_key",
    "prediction_key",
    "prediction_hash",
    "prediction_status",
    "prediction_generated_at",
    "prediction_recorded_at",
    "horizon",
    "probabilities",
    "quantiles",
)
_OUTCOME_MANIFEST_FIELDS = (
    "round_key",
    "outcome_key",
    "outcome_version",
    "outcome_status",
    "outcome_final_hammer_price_eur",
    "outcome_finality_status",
    "outcome_result_observed_at",
    "outcome_created_at",
    "outcome_recorded_at",
    "label_available_at",
    "price_label_available_at",
    "label_eligible",
    "actual_price_eur",
)


class OutcomeEvaluationRepository:
    def __init__(
        self,
        db_url: str,
        *,
        connect: Callable[[str], Any] = _postgres_connect,
    ) -> None:
        if not db_url.strip():
            raise OutcomeEvaluationRepositoryError("SUPABASE_DB_URL is required")
        self._db_url = db_url
        self._connect = connect

    def load_records(
        self,
        config: EvaluationConfig,
        *,
        model_key: str,
        model_version: str,
        horizon: str,
        prediction_kind: str,
        max_records: int,
    ) -> tuple[EvaluationRecord, ...]:
        if max_records < 1:
            raise ValueError("max_records must be positive")
        if horizon not in ("T-30", "T-14", "T-7", "T-1", "T-2h"):
            raise ValueError("unsupported horizon")
        if prediction_kind not in ("shadow", "outcome_graph"):
            raise ValueError("unsupported prediction kind")
        start = datetime.combine(config.train_start, datetime.min.time(), tzinfo=UTC)
        end = datetime.combine(config.test_end, datetime.min.time(), tzinfo=UTC)
        cutoff = config.label_cutoff_at
        parameters: tuple[object, ...] = (
            model_key,
            model_version,
            cutoff,
            start,
            end,
            max_records + 1,
            horizon,
            prediction_kind,
            horizon,
            horizon,
        )
        try:
            with self._connect(self._db_url) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("set transaction isolation level repeatable read read only")
                    cursor.execute(_LOAD_RECORDS_SQL, parameters)
                    rows = _mapping_rows(cursor)
                connection.rollback()
        except Exception as exc:
            raise OutcomeEvaluationRepositoryError("failed to load the bounded evaluation universe") from exc
        if len(rows) > max_records:
            raise EvaluationBoundExceeded(f"evaluation universe exceeds the explicit bound ({max_records})")
        try:
            return tuple(_record_from_row(row) for row in rows)
        except (EvaluationInputError, KeyError, TypeError, ValueError) as exc:
            raise OutcomeEvaluationRepositoryError("database evaluation rows violate the input contract") from exc

    def load_universe(
        self,
        config: EvaluationConfig,
        *,
        model_key: str,
        model_version: str,
        horizon: str,
        prediction_kind: str,
        max_records: int,
    ) -> EvaluationUniverse:
        if max_records < 1:
            raise ValueError("max_records must be positive")
        if horizon not in ("T-30", "T-14", "T-7", "T-1", "T-2h"):
            raise ValueError("unsupported horizon")
        if prediction_kind not in ("shadow", "outcome_graph"):
            raise ValueError("unsupported prediction kind")
        start = datetime.combine(config.train_start, datetime.min.time(), tzinfo=UTC)
        end = datetime.combine(config.test_end, datetime.min.time(), tzinfo=UTC)
        cutoff = config.label_cutoff_at
        parameters: tuple[object, ...] = (
            model_key,
            model_version,
            cutoff,
            start,
            end,
            max_records + 1,
            horizon,
            prediction_kind,
            horizon,
            horizon,
        )
        try:
            with self._connect(self._db_url) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("set transaction isolation level repeatable read read only")
                    cursor.execute(_LOAD_MODEL_SQL, (model_key, model_version))
                    model_row = cursor.fetchone()
                    if model_row is None:
                        raise OutcomeEvaluationRepositoryError("evaluation requires an existing model version")
                    model_version_id, model_status = str(model_row[0]), str(model_row[1])
                    cursor.execute(_LOAD_RECORDS_SQL, parameters)
                    rows = _mapping_rows(cursor)
                connection.rollback()
        except OutcomeEvaluationRepositoryError:
            raise
        except Exception as exc:
            raise OutcomeEvaluationRepositoryError("failed to load the bounded evaluation universe") from exc
        if len(rows) > max_records:
            raise EvaluationBoundExceeded(f"evaluation universe exceeds the explicit bound ({max_records})")
        try:
            records = tuple(_record_from_row(row) for row in rows)
            feature_cutoffs = [
                _datetime(value) for row in rows if (value := row.get("snapshot_cutoff_at")) is not None
            ]
            return EvaluationUniverse(
                model_version_id=model_version_id,
                model_status=model_status,
                records=records,
                feature_cutoff_at=max(feature_cutoffs, default=None),
                source_manifest_hash=_manifest_hash(rows, _SOURCE_MANIFEST_FIELDS),
                prediction_manifest_hash=_manifest_hash(rows, _PREDICTION_MANIFEST_FIELDS),
                outcome_manifest_hash=_manifest_hash(rows, _OUTCOME_MANIFEST_FIELDS),
            )
        except (EvaluationInputError, KeyError, TypeError, ValueError) as exc:
            raise OutcomeEvaluationRepositoryError("database evaluation rows violate the input contract") from exc

    def persist_evaluation(
        self,
        universe: EvaluationUniverse,
        config: EvaluationConfig,
        report: Mapping[str, Any],
        *,
        computed_at: datetime,
    ) -> EvaluationPersistSummary:
        if config.mode == "historical_replay":
            raise OutcomeEvaluationRepositoryError(
                "historical persistence requires an audited validated-artifact replay executor"
            )
        status = report.get("status")
        if status not in ("insufficient_data", "failed", "passed"):
            raise OutcomeEvaluationRepositoryError("invalid evaluations cannot be persisted")
        if report.get("evaluation_mode") != config.mode:
            raise OutcomeEvaluationRepositoryError("evaluation mode and report do not match")
        if report.get("threshold_version") != "outcome-commercial-v1":
            raise OutcomeEvaluationRepositoryError("only the commercial evaluation policy can be persisted")
        if report.get("computed_at") != _utc_iso(computed_at):
            raise OutcomeEvaluationRepositoryError("evaluation computation time does not match the report")
        if report.get("writes") != 0:
            raise OutcomeEvaluationRepositoryError("only an unpersisted evaluation report can be appended")
        try:
            validate_public_report(report)
        except EvaluationInputError as exc:
            raise OutcomeEvaluationRepositoryError("evaluation report violates the public contract") from exc
        try:
            expected_report = evaluate(universe.records, config, computed_at=computed_at)
            if _canonical_json(report) != _canonical_json(expected_report):
                raise OutcomeEvaluationRepositoryError(
                    "evaluation report does not match the bounded database universe"
                )
        except OutcomeEvaluationRepositoryError:
            raise
        except (EvaluationInputError, TypeError, ValueError) as exc:
            raise OutcomeEvaluationRepositoryError("evaluation report cannot be reproduced") from exc
        if universe.model_status != "shadow":
            raise OutcomeEvaluationRepositoryError("model status is incompatible with evaluation mode")
        if universe.feature_cutoff_at is None:
            raise OutcomeEvaluationRepositoryError("evaluation persistence requires a feature cutoff")
        if not all(
            _is_sha256(value)
            for value in (
                universe.source_manifest_hash,
                universe.prediction_manifest_hash,
                universe.outcome_manifest_hash,
            )
        ):
            raise OutcomeEvaluationRepositoryError("evaluation manifest hashes are invalid")
        if computed_at.tzinfo is None or computed_at.utcoffset() is None:
            raise OutcomeEvaluationRepositoryError("knowledge cutoff must be timezone-aware")
        if not universe.feature_cutoff_at <= config.label_cutoff_at <= computed_at <= datetime.now(UTC):
            raise OutcomeEvaluationRepositoryError("evaluation persistence cutoffs are incoherent")

        coverage = report.get("coverage")
        if not isinstance(coverage, Mapping):
            raise OutcomeEvaluationRepositoryError("evaluation coverage is missing")
        observation_count = _report_count(coverage, "mature_test_records")
        eligible_count = _report_count(coverage, "label_count")
        scored_count = _report_count(coverage, "scored_label_count")
        if not 0 <= scored_count <= eligible_count <= observation_count:
            raise OutcomeEvaluationRepositoryError("evaluation counters are incoherent")
        if status == "insufficient_data" and observation_count == 0:
            raise OutcomeEvaluationRepositoryError("empty insufficient evaluations cannot be persisted")
        if status in ("failed", "passed") and (eligible_count < 300 or scored_count < 300):
            raise OutcomeEvaluationRepositoryError("complete prospective evaluations require 300 scored labels")
        try:
            promotion_summary = build_promotion_summary(report)
        except (EvaluationInputError, TypeError, ValueError) as exc:
            raise OutcomeEvaluationRepositoryError("evaluation report violates the promotion contract") from exc
        report_json = json.dumps(
            promotion_summary,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        parameters: tuple[object, ...] = (
            universe.model_version_id,
            config.mode,
            status,
            config.validation_end,
            config.test_end - timedelta(days=1),
            universe.feature_cutoff_at,
            config.label_cutoff_at,
            config.label_cutoff_at,
            300,
            observation_count,
            eligible_count,
            scored_count,
            eligible_count,
            observation_count - eligible_count,
            0,
            universe.source_manifest_hash,
            universe.prediction_manifest_hash,
            universe.outcome_manifest_hash,
            report_json,
        )
        inserted_count = 1
        try:
            with self._connect(self._db_url) as connection:
                try:
                    with connection.cursor() as cursor:
                        cursor.execute(_INSERT_EVALUATION_SQL, parameters)
                        inserted = cursor.fetchone()
                        if inserted is None:
                            inserted_count = 0
                            cursor.execute(_FIND_EXISTING_EVALUATION_SQL, parameters)
                            inserted = cursor.fetchone()
                        if inserted is None or not _is_sha256(str(inserted[0])):
                            raise OutcomeEvaluationRepositoryError(
                                "evaluation insert did not return a matching server hash"
                            )
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
        except OutcomeEvaluationRepositoryError:
            raise
        except Exception as exc:
            raise OutcomeEvaluationRepositoryError("failed to persist the aggregate evaluation") from exc
        return EvaluationPersistSummary(inserted_evaluations=inserted_count)


def _record_from_row(row: Mapping[str, object]) -> EvaluationRecord:
    raw_status = row.get("prediction_status")
    prediction_status = "ready" if raw_status == "ready" else ("abstained" if raw_status == "insufficient_data" else "missing")
    probabilities = _exclusive_probabilities(_json_object(row.get("probabilities"))) if prediction_status == "ready" else None
    quantiles = _price_quantiles(_json_object(row.get("quantiles"))) if prediction_status == "ready" else None
    outcome = _outcome_class(row.get("outcome_status")) if bool(row.get("label_eligible")) else None
    snapshot_cutoff = row.get("snapshot_cutoff_at")
    segments = {
        key: str(value)
        for key, value in (
            ("judicial_region", row.get("judicial_region")),
            ("tribunal", row.get("tribunal")),
            ("procedure_type", row.get("procedure_type")),
            ("property_type", row.get("property_type")),
            ("occupation_status", row.get("occupation_status")),
            ("horizon", row.get("horizon")),
        )
        if value is not None
    }
    actual_price = _optional_float(row.get("actual_price_eur")) if outcome == "held_adjudicated" else None
    return EvaluationRecord(
        lot_key=str(row["lot_key"]),
        scheduled_at=_datetime(row["scheduled_at"]),
        label_available_at=_optional_datetime(row.get("label_available_at")),
        price_label_available_at=_optional_datetime(row.get("price_label_available_at")),
        label_grade="A" if outcome is not None else None,
        outcome=outcome,
        actual_price_eur=actual_price,
        starting_price_eur=_optional_float(row.get("starting_price_eur")),
        snapshot_available=snapshot_cutoff is not None,
        snapshot_cutoff_at=_optional_datetime(snapshot_cutoff),
        leakage_check_passed=bool(row.get("leakage_check_passed")),
        prediction_status=prediction_status,
        prediction_generated_at=_optional_datetime(row.get("prediction_generated_at")),
        prediction_recorded_at=_optional_datetime(row.get("prediction_recorded_at")),
        probabilities=probabilities,
        price_quantiles=quantiles,
        segments=segments,
    )


def _exclusive_probabilities(payload: Mapping[str, object]) -> dict[str, float]:
    keys = (
        "held_probability",
        "postponed_probability",
        "cancelled_or_not_requested_probability",
        "adjudicated_if_held_probability",
        "no_bid_if_held_probability",
    )
    raw = {key: float(payload[key]) for key in keys}
    if not all(math.isfinite(value) and 0 <= value <= 1 for value in raw.values()):
        raise EvaluationInputError("conditional probabilities must be finite and within [0, 1]")
    if abs(
        raw["held_probability"]
        + raw["postponed_probability"]
        + raw["cancelled_or_not_requested_probability"]
        - 1.0
    ) > 1e-4 or abs(raw["adjudicated_if_held_probability"] + raw["no_bid_if_held_probability"] - 1.0) > 1e-4:
        raise EvaluationInputError("conditional probabilities are incoherent")
    held = raw["held_probability"]
    values = {
        "cancelled_or_not_requested": raw["cancelled_or_not_requested_probability"],
        "postponed": raw["postponed_probability"],
        "held_no_bid": held * raw["no_bid_if_held_probability"],
        "held_adjudicated": held * raw["adjudicated_if_held_probability"],
    }
    return values


def _price_quantiles(payload: Mapping[str, object]) -> PriceQuantiles:
    final = payload.get("final_price_eur")
    if not isinstance(final, Mapping):
        raise EvaluationInputError("final price quantiles are missing")
    return PriceQuantiles(p10=float(final["p10"]), p50=float(final["p50"]), p90=float(final["p90"]))


def _outcome_class(value: object) -> str | None:
    if value in ("cancelled", "not_requested"):
        return "cancelled_or_not_requested"
    if value in ("postponed", "held_no_bid", "held_adjudicated"):
        return str(value)
    return None


def _json_object(value: object) -> Mapping[str, object]:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, Mapping):
        raise EvaluationInputError("prediction JSON must be an object")
    return value


def _datetime(value: object) -> datetime:
    if not isinstance(value, datetime):
        raise EvaluationInputError("database timestamp is invalid")
    return value


def _optional_datetime(value: object) -> datetime | None:
    return None if value is None else _datetime(value)


def _optional_float(value: object) -> float | None:
    return None if value is None else float(value)


def _mapping_rows(cursor: Any) -> tuple[dict[str, object], ...]:
    names = [column.name if hasattr(column, "name") else column[0] for column in cursor.description]
    return tuple(dict(zip(names, row, strict=True)) for row in cursor.fetchall())


def _manifest_hash(rows: tuple[dict[str, object], ...], fields: tuple[str, ...]) -> str:
    members = [{field: _canonical_value(row.get(field)) for field in fields} for row in rows]
    members.sort(key=_canonical_json)
    payload = {
        "schemaVersion": "outcome_evaluation_manifest_v1",
        "fields": list(fields),
        "members": members,
    }
    return sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _canonical_value(value: object) -> object:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise EvaluationInputError("manifest timestamps must be timezone-aware")
        return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, Mapping):
        return {str(key): _canonical_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise EvaluationInputError("manifest numbers must be finite")
        return value
    return str(value)


def _report_count(coverage: Mapping[str, Any], key: str) -> int:
    value = coverage.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise OutcomeEvaluationRepositoryError("evaluation counter is missing or invalid")
    return value


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _utc_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
