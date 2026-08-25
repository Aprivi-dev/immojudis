from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from pydantic import ValidationError

# The canary is observational only; do not create bytecode files while loading
# the application modules it exercises.
sys.dont_write_bytecode = True

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import load_settings  # noqa: E402
from src.official_sources.base import canonical_sha256  # noqa: E402
from src.official_sources.judilibre import (  # noqa: E402
    JudilibreClient,
    JudilibreDecision,
    JudilibreSearchPage,
    JudilibreSearchQuery,
)
from src.outcome_ingestion.judilibre_extraction import (  # noqa: E402
    JUDILIBRE_CLAIM_SCHEMA_VERSION,
    JUDILIBRE_EVIDENCE_HASH_VERSION,
    extract_judilibre_candidate_facts,
)
from src.outcome_ingestion.judilibre_ingestion import (  # noqa: E402
    JUDILIBRE_SEARCH_PROFILES,
)

CANARY_PROFILE_ID = "adjudication_v2"
CANARY_WINDOW_DAYS = 31
CANARY_LAG_DAYS = 7
CANARY_PAGE_SIZE = 1
CANARY_MAX_SEARCH_ATTEMPTS = 4

_CANONICAL_EXTRACTOR = extract_judilibre_candidate_facts
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
_MONEY_PATTERN = re.compile(r"(?:[1-9]\d{0,9}|0)\.\d{2}")
_MAX_CLAIMS = 7
_MAX_DISPOSITIF_FRAGMENTS = 128
_CLAIM_TYPES = frozenset({"starting_price_eur", "hammer_price_eur", "procedural_event"})
_AMBIGUOUS_CLAIM_TYPES = _CLAIM_TYPES
_PROCEDURAL_VALUES = frozenset(
    {
        "adjudication_pronounced",
        "held_no_bid",
        "postponed",
        "surenchere_filed",
        "reiteration_requested",
    }
)
_PROCEDURAL_CONFIDENCE = {
    "adjudication_pronounced": 0.85,
    "held_no_bid": 0.85,
    "postponed": 0.80,
    "surenchere_filed": 0.85,
    "reiteration_requested": 0.85,
}
_NORMALIZED_KEYS = frozenset(
    {
        "extraction_status",
        "extraction_rule_version",
        "claims",
        "ambiguous_claim_types",
        "text_available",
    }
)
_PROVENANCE_KEYS = frozenset({"hash_version", "claims"})
_CLAIM_BASE_KEYS = frozenset(
    {"claim_id", "claim_type", "normalized_value", "confidence", "evidence_hash"}
)
_ANCHOR_KEYS = frozenset(
    {
        "source_pointer",
        "start_utf8",
        "end_utf8",
        "raw_artifact_sha256",
        "evidence_sha256",
        "hash_version",
    }
)
_PUBLIC_REPORT_FIELDS = (
    "requested_window_days",
    "requested_lag_days",
    "requested_page_size",
    "search_attempt_limit",
    "search_attempt_count",
    "search_request_succeeded",
    "search_schema_valid",
    "response_not_relaxed",
    "response_bounds_valid",
    "search_tj_scope_valid",
    "result_count",
    "decision_fetch_count",
    "decision_schema_checked",
    "decision_schema_valid",
    "decision_matches_search_result",
    "decision_tj_scope_valid",
    "decision_text_present",
    "decision_zones_present",
    "decision_zones_schema_valid",
    "extraction_checked",
    "extraction_succeeded",
    "extraction_private_fields_absent",
    "candidate_claim_count",
    "provenance_anchor_count",
)
_PUBLIC_INTEGER_BOUNDS = {
    "requested_window_days": (CANARY_WINDOW_DAYS, CANARY_WINDOW_DAYS),
    "requested_lag_days": (CANARY_LAG_DAYS, CANARY_LAG_DAYS),
    "requested_page_size": (CANARY_PAGE_SIZE, CANARY_PAGE_SIZE),
    "search_attempt_limit": (CANARY_MAX_SEARCH_ATTEMPTS, CANARY_MAX_SEARCH_ATTEMPTS),
    "search_attempt_count": (0, CANARY_MAX_SEARCH_ATTEMPTS),
    "result_count": (0, CANARY_PAGE_SIZE),
    "decision_fetch_count": (0, 1),
    "candidate_claim_count": (0, _MAX_CLAIMS),
    "provenance_anchor_count": (0, _MAX_CLAIMS),
}


@dataclass
class JudilibreContractReport:
    """Public, aggregate-only result of the bounded Judilibre contract check."""

    requested_window_days: int = CANARY_WINDOW_DAYS
    requested_lag_days: int = CANARY_LAG_DAYS
    requested_page_size: int = CANARY_PAGE_SIZE
    search_attempt_limit: int = CANARY_MAX_SEARCH_ATTEMPTS
    search_attempt_count: int = 0
    search_request_succeeded: bool = False
    search_schema_valid: bool = False
    response_not_relaxed: bool = False
    response_bounds_valid: bool = False
    search_tj_scope_valid: bool = False
    result_count: int = 0
    decision_fetch_count: int = 0
    decision_schema_checked: bool = False
    decision_schema_valid: bool = False
    decision_matches_search_result: bool = False
    decision_tj_scope_valid: bool = False
    decision_text_present: bool = False
    decision_zones_present: bool = False
    decision_zones_schema_valid: bool = False
    extraction_checked: bool = False
    extraction_succeeded: bool = False
    extraction_private_fields_absent: bool = False
    candidate_claim_count: int = 0
    provenance_anchor_count: int = 0

    @property
    def contract_valid(self) -> bool:
        search_valid = (
            self.search_request_succeeded
            and 1 <= self.search_attempt_count <= self.search_attempt_limit
            and self.search_schema_valid
            and self.response_not_relaxed
            and self.response_bounds_valid
            and self.search_tj_scope_valid
        )
        if not search_valid:
            return False
        if self.result_count == 0:
            return False
        return (
            self.decision_fetch_count == 1
            and self.decision_schema_checked
            and self.decision_schema_valid
            and self.decision_matches_search_result
            and self.decision_tj_scope_valid
            and self.decision_text_present
            and self.decision_zones_schema_valid
            and self.extraction_checked
            and self.extraction_succeeded
            and self.extraction_private_fields_absent
            and self.candidate_claim_count == self.provenance_anchor_count
        )

    def public_payload(self) -> dict[str, bool | int]:
        # Explicit allowlist: adding an attribute to this report can never make
        # extraction content or provenance appear in stdout by accident.
        payload: dict[str, bool | int] = {
            field_name: getattr(self, field_name) for field_name in _PUBLIC_REPORT_FIELDS
        }
        payload["contract_valid"] = self.contract_valid
        for field_name, value in payload.items():
            bounds = _PUBLIC_INTEGER_BOUNDS.get(field_name)
            if bounds is None:
                if type(value) is not bool:
                    raise ValueError("Judilibre canary public report contains an unsafe boolean")
                continue
            lower, upper = bounds
            if type(value) is not int or not lower <= value <= upper:
                raise ValueError("Judilibre canary public report contains an unsafe aggregate")
        return payload


def build_canary_query(
    *,
    today: date | None = None,
    attempt: int = 0,
) -> JudilibreSearchQuery:
    """Build the single immutable exact-TJ profile used by the live canary."""

    profile = JUDILIBRE_SEARCH_PROFILES[CANARY_PROFILE_ID]
    if profile.operator != "exact" or profile.jurisdictions != ("tj",):
        raise ValueError("Judilibre canary profile is not exact and TJ-only")
    if (
        not isinstance(attempt, int)
        or isinstance(attempt, bool)
        or not 0 <= attempt < CANARY_MAX_SEARCH_ATTEMPTS
    ):
        raise ValueError("Judilibre canary search attempt is outside its safety bound")

    date_end = (today or date.today()) - timedelta(
        days=CANARY_LAG_DAYS + attempt * CANARY_WINDOW_DAYS
    )
    date_start = date_end - timedelta(days=CANARY_WINDOW_DAYS - 1)
    window_days = (date_end - date_start).days + 1
    if not 1 <= window_days <= CANARY_WINDOW_DAYS:
        raise ValueError("Judilibre canary date window is outside its safety bound")

    return JudilibreSearchQuery(
        query=profile.query,
        field=list(profile.fields),
        operator="exact",
        jurisdiction=["tj"],
        date_start=date_start,
        date_end=date_end,
        sort="date",
        order="desc",
        page_size=CANARY_PAGE_SIZE,
        page=0,
        resolve_references=False,
    )


def run_contract_canary(
    client: JudilibreClient,
    *,
    today: date | None = None,
) -> JudilibreContractReport:
    """Probe at most four search pages and one decision in read-only mode."""

    report = JudilibreContractReport()
    selected_page: JudilibreSearchPage | None = None
    for attempt in range(CANARY_MAX_SEARCH_ATTEMPTS):
        report.search_attempt_count += 1
        report.search_request_succeeded = False
        report.search_schema_valid = False
        report.response_not_relaxed = False
        report.response_bounds_valid = False
        report.search_tj_scope_valid = False
        try:
            query = build_canary_query(today=today, attempt=attempt)
            raw_page = client.search(query)
            report.search_request_succeeded = True
            page = JudilibreSearchPage.model_validate(raw_page)
            report.search_schema_valid = True
        except ValidationError:
            return report
        except Exception:
            # Contract output must never echo response data, URLs, credentials,
            # or validation input. The non-zero exit status carries the failure.
            return report

        report.response_not_relaxed = not page.relaxed
        page_result_count = len(page.results)
        report.result_count = 0
        report.response_bounds_valid = (
            page.page == 0
            and page.page_size == CANARY_PAGE_SIZE
            and page_result_count <= CANARY_PAGE_SIZE
            and page.total >= page_result_count
            and (page_result_count > 0 or page.total == 0)
        )
        report.search_tj_scope_valid = all(
            result.jurisdiction == "tj" for result in page.results
        )
        if not (report.response_bounds_valid and report.search_tj_scope_valid):
            return report
        if not report.response_not_relaxed:
            # Judilibre may relax an exact query that has no exact hit. Never
            # fetch such a candidate; probe the next older bounded window.
            continue
        report.result_count = page_result_count
        if page.results:
            selected_page = page
            break

    if selected_page is None:
        return report

    search_result = selected_page.results[0]
    report.decision_fetch_count = 1
    report.decision_schema_checked = True
    try:
        raw_decision = client.decision(search_result.id, resolve_references=False)
        decision = JudilibreDecision.model_validate(raw_decision)
        report.decision_schema_valid = True
    except ValidationError:
        return report
    except Exception:
        return report

    report.decision_matches_search_result = decision.id == search_result.id
    report.decision_tj_scope_valid = decision.jurisdiction == "tj"
    report.decision_text_present = bool(decision.text and decision.text.strip())
    report.decision_zones_present = bool(decision.zones)
    try:
        _validate_dispositif_zones(decision)
        report.decision_zones_schema_valid = True
    except Exception:
        return report
    report.extraction_checked = True
    try:
        extraction = extract_judilibre_candidate_facts(decision)
        normalized = extraction.normalized_fields()
        provenance = extraction.field_provenance()
        claim_count, anchor_count = _validate_extraction_contract(
            normalized=normalized,
            provenance=provenance,
            decision=decision,
        )
        report.candidate_claim_count = claim_count
        report.provenance_anchor_count = anchor_count
        report.extraction_private_fields_absent = True
        report.extraction_succeeded = True
    except Exception:
        return report
    return report


def _validate_extraction_contract(
    *,
    normalized: object,
    provenance: object,
    decision: JudilibreDecision,
) -> tuple[int, int]:
    """Accept only the finite, hash-anchored extraction contract.

    Every string slot is constrained to a fixed enum, a decimal amount, a
    JSON pointer, or a SHA-256 digest. Judicial prose therefore has no valid
    path through ``normalized_value`` or an unexpected projection field.
    """

    normalized_data = _exact_dict(normalized, keys=_NORMALIZED_KEYS)
    if normalized_data["extraction_rule_version"] != JUDILIBRE_CLAIM_SCHEMA_VERSION:
        raise ValueError("unexpected Judilibre extraction schema version")
    if normalized_data["text_available"] is not True:
        raise ValueError("canary extraction must operate on available text")

    claims = normalized_data["claims"]
    ambiguous = normalized_data["ambiguous_claim_types"]
    if type(claims) is not list or len(claims) > _MAX_CLAIMS:
        raise ValueError("invalid Judilibre claim collection")
    if type(ambiguous) is not list or len(ambiguous) > len(_AMBIGUOUS_CLAIM_TYPES):
        raise ValueError("invalid Judilibre ambiguous-claim collection")
    if any(type(value) is not str or value not in _AMBIGUOUS_CLAIM_TYPES for value in ambiguous):
        raise ValueError("unexpected Judilibre ambiguous claim type")
    if ambiguous != sorted(set(ambiguous)):
        raise ValueError("Judilibre ambiguous claim types must be unique and sorted")

    provenance_data = _exact_dict(provenance, keys=_PROVENANCE_KEYS)
    if provenance_data["hash_version"] != JUDILIBRE_EVIDENCE_HASH_VERSION:
        raise ValueError("unexpected Judilibre provenance hash version")
    anchors = provenance_data["claims"]
    if type(anchors) is not dict or len(anchors) > _MAX_CLAIMS:
        raise ValueError("invalid Judilibre provenance collection")

    validated_claims: dict[str, dict[str, object]] = {}
    seen_claim_types: set[str] = set()
    seen_money_types: set[str] = set()
    seen_procedural_values: set[str] = set()
    for raw_claim in claims:
        claim = _validate_claim(raw_claim)
        claim_id = claim["claim_id"]
        claim_type = claim["claim_type"]
        normalized_value = claim["normalized_value"]
        assert isinstance(claim_id, str)
        assert isinstance(claim_type, str)
        assert isinstance(normalized_value, str)
        if claim_id in validated_claims:
            raise ValueError("duplicate Judilibre claim identifier")
        seen_claim_types.add(claim_type)
        if claim_type in {"starting_price_eur", "hammer_price_eur"}:
            if claim_type in seen_money_types:
                raise ValueError("duplicate Judilibre monetary claim type")
            seen_money_types.add(claim_type)
        else:
            if normalized_value in seen_procedural_values:
                raise ValueError("duplicate Judilibre procedural value")
            seen_procedural_values.add(normalized_value)
        validated_claims[claim_id] = claim

    if set(anchors) != set(validated_claims):
        raise ValueError("Judilibre claim and provenance identifiers differ")
    if set(ambiguous) & seen_claim_types:
        raise ValueError("ambiguous Judilibre claim type cannot also be selected")

    decision_text = decision.text
    if not isinstance(decision_text, str) or not decision_text.strip():
        raise ValueError("Judilibre canary decision text is unavailable")
    text_utf8 = decision_text.encode("utf-8")
    raw_artifact_sha256 = decision.canonical_sha256()
    for claim_id, claim in validated_claims.items():
        anchor = _validate_anchor(
            anchors[claim_id],
            text_utf8=text_utf8,
            raw_artifact_sha256=raw_artifact_sha256,
        )
        if claim["evidence_hash"] != anchor["evidence_sha256"]:
            raise ValueError("Judilibre claim and provenance evidence hashes differ")
        currency = claim.get("currency")
        expected_claim_id = canonical_sha256(
            {
                "schema_version": JUDILIBRE_CLAIM_SCHEMA_VERSION,
                "claim_type": claim["claim_type"],
                "normalized_value": claim["normalized_value"],
                "currency": currency,
                "evidence_hash": claim["evidence_hash"],
            }
        )
        if claim_id != expected_claim_id:
            raise ValueError("Judilibre claim identifier is not canonical")

    expected_status = (
        "candidate_facts_extracted"
        if claims
        else "ambiguous_candidates_only"
        if ambiguous
        else "no_candidate_facts"
    )
    if normalized_data["extraction_status"] != expected_status:
        raise ValueError("Judilibre extraction status is inconsistent")

    # Re-run the extractor reference captured at module import. Exact equality
    # binds every normalized value to the evidence semantics derived from this
    # decision, not merely to a syntactically valid hash chain.
    canonical_extraction = _CANONICAL_EXTRACTOR(decision)
    if (
        canonical_extraction.normalized_fields() != normalized_data
        or canonical_extraction.field_provenance() != provenance_data
    ):
        raise ValueError("Judilibre extraction differs from canonical extraction")
    return len(claims), len(anchors)


def _validate_dispositif_zones(decision: JudilibreDecision) -> None:
    zones = decision.zones
    if type(zones) is not dict:
        raise ValueError("Judilibre zones must be a plain object")
    if "dispositif" not in zones:
        return

    fragments = zones["dispositif"]
    if (
        type(fragments) is not list
        or not fragments
        or len(fragments) > _MAX_DISPOSITIF_FRAGMENTS
    ):
        raise ValueError("Judilibre dispositif zone must be a non-empty bounded list")
    text = decision.text
    if not isinstance(text, str):
        raise ValueError("Judilibre dispositif zones require decision text")

    previous_end = 0
    for fragment in fragments:
        if type(fragment) is not dict or set(fragment) != {"start", "end"}:
            raise ValueError("invalid Judilibre dispositif fragment")
        start = fragment["start"]
        end = fragment["end"]
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start < end <= len(text)
            or start < previous_end
        ):
            raise ValueError("invalid Judilibre dispositif offsets")
        previous_end = end


def _validate_claim(value: object) -> dict[str, object]:
    if type(value) is not dict:
        raise ValueError("Judilibre claim must be a plain object")
    claim_type = value.get("claim_type")
    if type(claim_type) is not str or claim_type not in _CLAIM_TYPES:
        raise ValueError("unexpected Judilibre claim type")
    expected_keys = _CLAIM_BASE_KEYS | ({"currency"} if claim_type != "procedural_event" else set())
    claim = _exact_dict(value, keys=expected_keys)

    claim_id = claim["claim_id"]
    evidence_hash = claim["evidence_hash"]
    if not _is_sha256(claim_id) or not _is_sha256(evidence_hash):
        raise ValueError("invalid Judilibre claim digest")
    confidence = claim["confidence"]
    if type(confidence) is not float:
        raise ValueError("invalid Judilibre claim confidence")

    normalized_value = claim["normalized_value"]
    if type(normalized_value) is not str:
        raise ValueError("invalid Judilibre normalized value")
    if claim_type == "procedural_event":
        if normalized_value not in _PROCEDURAL_VALUES:
            raise ValueError("unexpected Judilibre procedural value")
        if confidence != _PROCEDURAL_CONFIDENCE[normalized_value]:
            raise ValueError("unexpected Judilibre procedural confidence")
    else:
        if not _MONEY_PATTERN.fullmatch(normalized_value):
            raise ValueError("unexpected Judilibre monetary value")
        amount = Decimal(normalized_value)
        if not Decimal("0") < amount <= Decimal("1000000000"):
            raise ValueError("Judilibre monetary value is outside its allowed range")
        if claim["currency"] != "EUR":
            raise ValueError("unexpected Judilibre claim currency")
        expected_confidence = 0.75 if claim_type == "starting_price_eur" else 0.85
        if confidence != expected_confidence:
            raise ValueError("unexpected Judilibre monetary confidence")
    return claim


def _validate_anchor(
    value: object,
    *,
    text_utf8: bytes,
    raw_artifact_sha256: str,
) -> dict[str, object]:
    anchor = _exact_dict(value, keys=_ANCHOR_KEYS)
    if anchor["source_pointer"] != "/text":
        raise ValueError("unexpected Judilibre provenance pointer")
    if anchor["hash_version"] != JUDILIBRE_EVIDENCE_HASH_VERSION:
        raise ValueError("unexpected Judilibre anchor hash version")
    if anchor["raw_artifact_sha256"] != raw_artifact_sha256:
        raise ValueError("Judilibre provenance does not match its raw artifact")
    if not _is_sha256(anchor["raw_artifact_sha256"]) or not _is_sha256(
        anchor["evidence_sha256"]
    ):
        raise ValueError("invalid Judilibre provenance digest")

    start_utf8 = anchor["start_utf8"]
    end_utf8 = anchor["end_utf8"]
    if (
        type(start_utf8) is not int
        or type(end_utf8) is not int
        or not 0 <= start_utf8 < end_utf8 <= len(text_utf8)
    ):
        raise ValueError("invalid Judilibre provenance offsets")
    try:
        exact_span = text_utf8[start_utf8:end_utf8].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Judilibre provenance offsets split a UTF-8 sequence") from exc
    expected_evidence_sha256 = canonical_sha256(
        {
            "domain": "immojudis.judilibre.evidence",
            "hash_version": JUDILIBRE_EVIDENCE_HASH_VERSION,
            "raw_artifact_sha256": raw_artifact_sha256,
            "source_pointer": "/text",
            "start_utf8": start_utf8,
            "end_utf8": end_utf8,
            "exact_span": exact_span,
        }
    )
    if anchor["evidence_sha256"] != expected_evidence_sha256:
        raise ValueError("Judilibre evidence digest is not canonical")
    return anchor


def _exact_dict(value: object, *, keys: frozenset[str] | set[str]) -> dict[str, object]:
    if type(value) is not dict or not all(type(key) is str for key in value):
        raise ValueError("Judilibre extraction value must be a plain string-keyed object")
    if set(value) != set(keys):
        raise ValueError("unexpected Judilibre extraction field")
    return value


def _is_sha256(value: object) -> bool:
    return type(value) is str and _SHA256_PATTERN.fullmatch(value) is not None


def _bounded_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Force local read bounds without overriding auth or source-policy gates."""

    bounded = dict(settings)
    bounded["judilibre_page_size"] = CANARY_PAGE_SIZE
    bounded["judilibre_max_results"] = CANARY_PAGE_SIZE
    bounded["judilibre_max_retries"] = 0
    return bounded


def main() -> int:
    report = JudilibreContractReport()
    try:
        settings = _bounded_settings(load_settings())
        with JudilibreClient.from_settings(settings) as client:
            report = run_contract_canary(client)
    except Exception:
        # Keep stdout secret-safe even when configuration, authentication, or
        # transport setup fails. Detailed diagnostics belong in local tooling.
        pass

    try:
        payload = report.public_payload()
    except Exception:
        payload = JudilibreContractReport().public_payload()
        report = JudilibreContractReport()
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0 if report.contract_valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
