from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import UUID

from src.official_sources.base import canonical_sha256
from src.outcome_ingestion.repository import (
    OutcomeIngestionRepository,
    StoredJudilibreAuctionMatchContext,
    StoredJudilibreCourtResolution,
    StoredJudilibreDecisionRecord,
)

JUDILIBRE_MATCH_RULE_VERSION = "judilibre-review-match-v1"
JUDILIBRE_MATCH_SIGNAL_SCHEMA = "judilibre_match_signals_v1"
JUDILIBRE_MATCH_SOURCE_LIMIT_MAX = 10_000
JUDILIBRE_MATCH_PAGE_SIZE_DEFAULT = 100
JUDILIBRE_MATCH_PAGE_SIZE_MAX = 1_000
JUDILIBRE_MATCH_CONTEXT_LIMIT_DEFAULT = 250
JUDILIBRE_MATCH_CONTEXT_LIMIT_MAX = 5_000
JUDILIBRE_MATCH_DATE_DELTA_DAYS_DEFAULT = 7
JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX = 30

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MONEY = re.compile(r"^(?:0|[1-9]\d{0,9})\.\d{2}$")
_CLAIM_TYPES = frozenset(
    {"starting_price_eur", "hammer_price_eur", "procedural_event"}
)
_PROCEDURAL_VALUES = frozenset(
    {
        "adjudication_pronounced",
        "held_no_bid",
        "postponed",
        "surenchere_filed",
        "reiteration_requested",
    }
)
_JUDILIBRE_V3_SAFE_PROJECTION_KEYS = frozenset(
    {
        "schema_version",
        "record_type",
        "judilibre_id",
        "jurisdiction",
        "location",
        "chamber",
        "formation",
        "number",
        "numbers",
        "ecli",
        "nac",
        "decision_date",
        "update_date",
        "decision_type",
        "solution",
        "solution_alt",
        "publication",
        "themes",
        "partial",
        "to_be_deleted",
        "raw_representation_sha256",
        "candidate_grade",
        "review_status",
        "training_eligible",
        "text_storage",
        "personal_identity_features_allowed",
        "extraction_status",
        "extraction_rule_version",
        "claims",
        "ambiguous_claim_types",
        "text_available",
    }
)


class JudilibreMatchingDataError(ValueError):
    """A minimized Judilibre candidate is not safe to use for matching."""


@dataclass(frozen=True)
class JudilibreMatchableDecision:
    location: str
    decision_date: date
    case_references: tuple[str, ...]
    claim_types: tuple[str, ...]
    claims_manifest_sha256: str
    case_reference_manifest_sha256: str
    source_projection_sha256: str


@dataclass
class JudilibreMatchingSummary:
    dry_run: bool
    source_limit: int
    context_limit: int
    max_date_delta_days: int
    page_size: int = JUDILIBRE_MATCH_PAGE_SIZE_DEFAULT
    after_source_record_id: str | None = None
    matchable_rounds_available: bool = False
    pages_loaded: int = 0
    source_records_loaded: int = 0
    last_source_record_id: str | None = None
    invalid_source_records: int = 0
    unresolved_courts: int = 0
    ambiguous_courts: int = 0
    records_without_contexts: int = 0
    context_limits_reached: int = 0
    contexts_evaluated: int = 0
    invalid_target_contexts: int = 0
    weak_contexts_skipped: int = 0
    ambiguous_targets: int = 0
    objective_candidates: int = 0
    existing_candidates: int = 0
    dry_run_candidates: int = 0
    persisted_candidates: int = 0
    automatic_matches: int = 0
    outcomes_created: int = 0
    training_eligibility_changes: int = 0
    truncated: bool = False
    empty_reason: str | None = None

    @property
    def writes(self) -> int:
        return self.persisted_candidates


class JudilibreDecisionMatchingService:
    """Build review-only Judilibre match candidates from objective metadata.

    The service never reads raw decision text, never creates an outcome and
    never promotes source evidence. A candidate needs a canonical court, a
    bounded hearing-date relation and either an exact case reference or a
    uniquely identifying exact court/date combination.
    """

    def __init__(self, repository: OutcomeIngestionRepository) -> None:
        self.repository = repository

    def run(
        self,
        *,
        source_limit: int,
        context_limit: int = JUDILIBRE_MATCH_CONTEXT_LIMIT_DEFAULT,
        max_date_delta_days: int = JUDILIBRE_MATCH_DATE_DELTA_DAYS_DEFAULT,
        page_size: int = JUDILIBRE_MATCH_PAGE_SIZE_DEFAULT,
        after_source_record_id: str | None = None,
        persist: bool = False,
    ) -> JudilibreMatchingSummary:
        if source_limit < 1 or source_limit > JUDILIBRE_MATCH_SOURCE_LIMIT_MAX:
            raise ValueError(
                "Judilibre source-record limit must be between 1 and "
                f"{JUDILIBRE_MATCH_SOURCE_LIMIT_MAX}"
            )
        if context_limit < 1 or context_limit > JUDILIBRE_MATCH_CONTEXT_LIMIT_MAX:
            raise ValueError(
                "Judilibre context limit must be between 1 and "
                f"{JUDILIBRE_MATCH_CONTEXT_LIMIT_MAX}"
            )
        if page_size < 1 or page_size > JUDILIBRE_MATCH_PAGE_SIZE_MAX:
            raise ValueError(
                "Judilibre page size must be between 1 and "
                f"{JUDILIBRE_MATCH_PAGE_SIZE_MAX}"
            )
        if not 0 <= max_date_delta_days <= JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX:
            raise ValueError(
                "Judilibre date delta must be between 0 and "
                f"{JUDILIBRE_MATCH_DATE_DELTA_DAYS_MAX} days"
            )
        if after_source_record_id is not None:
            try:
                after_source_record_id = str(UUID(after_source_record_id))
            except (AttributeError, ValueError) as exc:
                raise ValueError(
                    "Judilibre source-record cursor must be a UUID"
                ) from exc

        summary = JudilibreMatchingSummary(
            dry_run=not persist,
            source_limit=source_limit,
            context_limit=context_limit,
            max_date_delta_days=max_date_delta_days,
            page_size=page_size,
            after_source_record_id=after_source_record_id,
            last_source_record_id=after_source_record_id,
        )
        self.repository.require_judilibre_matching_schema()
        summary.matchable_rounds_available = (
            self.repository.has_matchable_judilibre_rounds()
        )
        if not summary.matchable_rounds_available:
            summary.empty_reason = "no_matchable_auction_rounds"
            return summary

        cursor_id = after_source_record_id
        while summary.source_records_loaded < source_limit:
            remaining = source_limit - summary.source_records_loaded
            page_limit = min(page_size, remaining)
            records = self.repository.load_active_judilibre_decision_records(
                limit=page_limit,
                after_source_record_id=cursor_id,
            )
            if not records:
                break
            if len(records) > page_limit:
                raise JudilibreMatchingDataError(
                    "Judilibre repository returned an oversized source page"
                )
            next_cursor_id = records[-1].source_record_id
            if next_cursor_id == cursor_id:
                raise JudilibreMatchingDataError(
                    "Judilibre source-record pagination did not advance"
                )

            summary.pages_loaded += 1
            summary.source_records_loaded += len(records)
            summary.last_source_record_id = next_cursor_id
            for record in records:
                self._match_record(
                    record,
                    summary=summary,
                    context_limit=context_limit,
                    max_date_delta_days=max_date_delta_days,
                    persist=persist,
                )

            cursor_id = next_cursor_id
            if len(records) < page_limit:
                break

        if summary.source_records_loaded == source_limit:
            summary.truncated = bool(
                self.repository.load_active_judilibre_decision_records(
                    limit=1,
                    after_source_record_id=cursor_id,
                )
            )
        if summary.source_records_loaded == 0:
            summary.empty_reason = "no_active_judilibre_claim_candidates"
        elif summary.objective_candidates == 0:
            summary.empty_reason = "no_objective_match_candidates"
        return summary

    def _match_record(
        self,
        record: StoredJudilibreDecisionRecord,
        *,
        summary: JudilibreMatchingSummary,
        context_limit: int,
        max_date_delta_days: int,
        persist: bool,
    ) -> None:
        try:
            decision = persisted_judilibre_matchable_decision(record)
        except (JudilibreMatchingDataError, TypeError, ValueError):
            summary.invalid_source_records += 1
            return

        court_resolutions = self.repository.load_judilibre_court_resolutions(
            location=decision.location,
        )
        if not court_resolutions:
            summary.unresolved_courts += 1
            return
        if len(court_resolutions) != 1:
            summary.ambiguous_courts += 1
            return
        court = court_resolutions[0]

        # One extra row turns a full page into an explicit truncation signal.
        contexts = self.repository.load_judilibre_auction_match_contexts(
            court_id=court.court_id,
            decision_date=decision.decision_date,
            case_references=decision.case_references,
            max_date_delta_days=max_date_delta_days,
            limit=context_limit + 1,
        )
        if not contexts:
            summary.records_without_contexts += 1
            return
        if len(contexts) > context_limit:
            summary.context_limits_reached += 1
            return

        unique_contexts: dict[
            tuple[str, str, str], StoredJudilibreAuctionMatchContext
        ] = {}
        for context in contexts:
            if not _is_valid_target_context(
                context,
                court_id=court.court_id,
                decision_date=decision.decision_date,
                max_date_delta_days=max_date_delta_days,
            ):
                summary.invalid_target_contexts += 1
                continue
            unique_contexts.setdefault(
                (context.case_id, context.lot_id, context.round_id),
                context,
            )
        summary.contexts_evaluated += len(unique_contexts)

        eligible: list[StoredJudilibreAuctionMatchContext] = []
        for context in unique_contexts.values():
            has_reference = context.portalis_number_match or context.case_number_match
            if has_reference or context.date_delta_days == 0:
                eligible.append(context)
            else:
                summary.weak_contexts_skipped += 1
        if not eligible:
            return

        exact_reference_case_ids = {
            context.case_id
            for context in eligible
            if context.portalis_number_match or context.case_number_match
        }
        if len(exact_reference_case_ids) > 1:
            summary.ambiguous_targets += 1
            return

        best_rank = max(_context_rank(context) for context in eligible)
        best = [context for context in eligible if _context_rank(context) == best_rank]
        if len(best) != 1:
            summary.ambiguous_targets += 1
            return
        context = best[0]
        summary.objective_candidates += 1
        if not persist:
            summary.dry_run_candidates += 1
            return

        score, method = _match_score_and_method(context)
        persisted = self.repository.append_judilibre_match_candidate(
            source_record_id=record.source_record_id,
            expected_source_content_hash=record.content_hash,
            expected_court_id=court.court_id,
            expected_decision_date=decision.decision_date,
            max_date_delta_days=max_date_delta_days,
            case_id=context.case_id,
            lot_id=context.lot_id,
            round_id=context.round_id,
            match_score=f"{score:.4f}",
            match_method=method,
            match_signals=_persisted_match_signals(
                record=record,
                decision=decision,
                court=court,
                context=context,
            ),
        )
        if persisted.inserted_new_candidate:
            summary.persisted_candidates += 1
        else:
            summary.existing_candidates += 1


def persisted_judilibre_matchable_decision(
    record: StoredJudilibreDecisionRecord,
) -> JudilibreMatchableDecision:
    data = record.normalized_data
    if set(data) != _JUDILIBRE_V3_SAFE_PROJECTION_KEYS:
        raise JudilibreMatchingDataError(
            "Judilibre projection does not match the closed safe schema"
        )
    if canonical_sha256(data) != record.content_hash:
        raise JudilibreMatchingDataError("Judilibre projection hash mismatch")
    if data.get("schema_version") != "judilibre_decision_candidate_v3":
        raise JudilibreMatchingDataError("unsupported Judilibre projection schema")
    if data.get("record_type") != "judicial_decision_candidate":
        raise JudilibreMatchingDataError("unsupported Judilibre record type")
    if data.get("judilibre_id") != record.external_record_id:
        raise JudilibreMatchingDataError("Judilibre projection identity mismatch")
    if str(data.get("jurisdiction") or "").lower() != "tj":
        raise JudilibreMatchingDataError("Judilibre candidate is outside TJ scope")
    if data.get("candidate_grade") != "C" or data.get("review_status") != "pending":
        raise JudilibreMatchingDataError("Judilibre candidate has an unsafe review state")
    if data.get("training_eligible") is not False:
        raise JudilibreMatchingDataError("Judilibre candidate must remain non-training")
    if data.get("personal_identity_features_allowed") is not False:
        raise JudilibreMatchingDataError("personal identity features must stay disabled")
    if data.get("extraction_status") != "candidate_facts_extracted":
        raise JudilibreMatchingDataError("Judilibre candidate has no extracted claims")
    if data.get("extraction_rule_version") != "judilibre_candidate_claims_v1":
        raise JudilibreMatchingDataError("Judilibre claim extraction rules are unsupported")
    if data.get("ambiguous_claim_types") != []:
        raise JudilibreMatchingDataError("Judilibre candidate claims are ambiguous")
    if data.get("to_be_deleted") is not False:
        raise JudilibreMatchingDataError("Judilibre candidate deletion state is unsafe")
    if data.get("text_storage") != "private_raw_artifact":
        raise JudilibreMatchingDataError("Judilibre raw text storage is unsafe")
    if data.get("text_available") is not True:
        raise JudilibreMatchingDataError("Judilibre raw text availability is unsafe")
    raw_representation_sha256 = data.get("raw_representation_sha256")
    if (
        not isinstance(raw_representation_sha256, str)
        or _SHA256.fullmatch(raw_representation_sha256) is None
    ):
        raise JudilibreMatchingDataError(
            "Judilibre raw representation is not hash anchored"
        )

    location = _required_short_text(data.get("location"), name="location")
    decision_date_value = data.get("decision_date")
    if not isinstance(decision_date_value, str):
        raise JudilibreMatchingDataError("Judilibre projection has no decision date")
    try:
        decision_date = date.fromisoformat(decision_date_value)
    except ValueError as exc:
        raise JudilibreMatchingDataError(
            "Judilibre projection has an invalid decision date"
        ) from exc
    if decision_date != record.decision_date:
        raise JudilibreMatchingDataError("Judilibre decision dates disagree")

    claims = data.get("claims")
    if not isinstance(claims, list) or not 1 <= len(claims) <= 7:
        raise JudilibreMatchingDataError("Judilibre claims must be a bounded list")
    claim_types: list[str] = []
    safe_claims: list[dict[str, object]] = []
    for claim in claims:
        if not isinstance(claim, Mapping):
            raise JudilibreMatchingDataError("Judilibre claim must be an object")
        safe_claim = _validated_claim(claim)
        claim_type = str(safe_claim["claim_type"])
        if claim_type in claim_types:
            raise JudilibreMatchingDataError("Judilibre claim type is duplicated")
        claim_types.append(claim_type)
        safe_claims.append(safe_claim)

    references = _case_references(data)
    return JudilibreMatchableDecision(
        location=location,
        decision_date=decision_date,
        case_references=references,
        claim_types=tuple(sorted(claim_types)),
        claims_manifest_sha256=canonical_sha256(
            {
                "schema_version": "judilibre_claim_manifest_v1",
                "claims": safe_claims,
            }
        ),
        case_reference_manifest_sha256=canonical_sha256(
            {
                "schema_version": "judilibre_case_reference_manifest_v1",
                "references": references,
            }
        ),
        source_projection_sha256=record.content_hash,
    )


def _validated_claim(claim: Mapping[str, Any]) -> dict[str, object]:
    claim_id = claim.get("claim_id")
    evidence_hash = claim.get("evidence_hash")
    claim_type = claim.get("claim_type")
    normalized_value = claim.get("normalized_value")
    confidence = claim.get("confidence")
    if not isinstance(claim_id, str) or _SHA256.fullmatch(claim_id) is None:
        raise JudilibreMatchingDataError("Judilibre claim id is not SHA-256")
    if not isinstance(evidence_hash, str) or _SHA256.fullmatch(evidence_hash) is None:
        raise JudilibreMatchingDataError("Judilibre evidence hash is not SHA-256")
    if claim_type not in _CLAIM_TYPES:
        raise JudilibreMatchingDataError("Judilibre claim type is unsupported")
    if not isinstance(normalized_value, str) or not normalized_value:
        raise JudilibreMatchingDataError("Judilibre claim value is missing")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise JudilibreMatchingDataError("Judilibre claim confidence is invalid")
    if not 0 <= float(confidence) <= 1:
        raise JudilibreMatchingDataError("Judilibre claim confidence is out of range")
    if claim_type in {"starting_price_eur", "hammer_price_eur"}:
        if _MONEY.fullmatch(normalized_value) is None or claim.get("currency") != "EUR":
            raise JudilibreMatchingDataError("Judilibre money claim is invalid")
    elif normalized_value not in _PROCEDURAL_VALUES:
        raise JudilibreMatchingDataError("Judilibre procedural claim is invalid")
    return {
        "claim_id": claim_id,
        "claim_type": claim_type,
        "normalized_value": normalized_value,
        "confidence": float(confidence),
        "evidence_hash": evidence_hash,
        **(
            {"currency": "EUR"}
            if claim_type in {"starting_price_eur", "hammer_price_eur"}
            else {}
        ),
    }


def _case_references(data: Mapping[str, object]) -> tuple[str, ...]:
    number = data.get("number")
    numbers = data.get("numbers")
    if number is not None and not isinstance(number, str):
        raise JudilibreMatchingDataError("Judilibre number has an invalid type")
    if numbers is not None and not isinstance(numbers, list):
        raise JudilibreMatchingDataError("Judilibre numbers has an invalid type")
    if isinstance(numbers, list) and any(not isinstance(value, str) for value in numbers):
        raise JudilibreMatchingDataError("Judilibre numbers contains a non-text value")
    values = [number] if isinstance(number, str) else []
    values.extend(numbers if isinstance(numbers, list) else [])
    references: list[str] = []
    for value in values:
        normalized = _normalize_reference(value)
        if normalized is not None and normalized not in references:
            references.append(normalized)
    return tuple(references)


def _normalize_reference(value: str) -> str | None:
    normalized = re.sub(r"\s+", " ", value.strip()).lower()
    if not normalized or len(normalized) > 128 or any(
        character in normalized for character in ("\x00", "\r", "\n")
    ):
        return None
    return normalized


def _required_short_text(value: object, *, name: str) -> str:
    if not isinstance(value, str):
        raise JudilibreMatchingDataError(f"Judilibre {name} is missing")
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 128 or any(
        character in cleaned for character in ("\x00", "\r", "\n")
    ):
        raise JudilibreMatchingDataError(f"Judilibre {name} is invalid")
    return cleaned


def _context_rank(context: StoredJudilibreAuctionMatchContext) -> tuple[int, int]:
    reference_rank = (
        2
        if context.portalis_number_match
        else 1
        if context.case_number_match
        else 0
    )
    return reference_rank, -context.date_delta_days


def _is_valid_target_context(
    context: StoredJudilibreAuctionMatchContext,
    *,
    court_id: str,
    decision_date: date,
    max_date_delta_days: int,
) -> bool:
    return (
        bool(context.case_id and context.lot_id and context.round_id)
        and context.court_id == court_id
        and context.date_delta_days
        == abs((context.scheduled_date - decision_date).days)
        and 0 <= context.date_delta_days <= max_date_delta_days
    )


def _match_score_and_method(
    context: StoredJudilibreAuctionMatchContext,
) -> tuple[float, str]:
    exact_date = context.date_delta_days == 0
    if context.portalis_number_match:
        return (0.98 if exact_date else 0.94), "exact_portalis_number"
    if context.case_number_match:
        return (0.95 if exact_date else 0.90), "exact_case_number"
    return 0.75, "composite"


def _persisted_match_signals(
    *,
    record: StoredJudilibreDecisionRecord,
    decision: JudilibreMatchableDecision,
    court: StoredJudilibreCourtResolution,
    context: StoredJudilibreAuctionMatchContext,
) -> dict[str, object]:
    return {
        "schema_version": JUDILIBRE_MATCH_SIGNAL_SCHEMA,
        "match_rule_version": JUDILIBRE_MATCH_RULE_VERSION,
        "court": True,
        "court_resolution_method": court.resolution_method,
        "court_resolution_reference_sha256": court.reference_sha256,
        "hearing_date": True,
        "hearing_date_exact": context.date_delta_days == 0,
        "hearing_date_delta_days": context.date_delta_days,
        "case_number": context.case_number_match,
        "portalis_number": context.portalis_number_match,
        "claim_types": list(decision.claim_types),
        "claims_manifest_sha256": decision.claims_manifest_sha256,
        "case_reference_manifest_sha256": decision.case_reference_manifest_sha256,
        "source_projection_sha256": decision.source_projection_sha256,
        "target_context_sha256": canonical_sha256(
            {
                "schema_version": "judilibre_target_context_v1",
                "case_id": context.case_id,
                "lot_id": context.lot_id,
                "round_id": context.round_id,
                "court_id": context.court_id,
                "scheduled_date": context.scheduled_date,
            }
        ),
        "source_record_version_current_at_scan": True,
        "source_training_eligible": False,
        "selection_requires_human_review": True,
        "automatic_link_allowed": False,
        "outcome_creation_allowed": False,
        "training_eligible": False,
        "claim_value_used_for_matching": False,
        "price_used_for_matching": False,
        "text_used_for_matching": False,
        "address_used_for_matching": False,
        "personal_identity_used_for_matching": False,
        "source_record_sha256": canonical_sha256(
            {
                "schema_version": "judilibre_source_record_reference_v1",
                "source_record_id": record.source_record_id,
            }
        ),
    }
