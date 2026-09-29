"""Fail-closed projection of the private AI extraction review.

The real-source review manifest is deliberately kept outside the repository.
This module is the narrow adapter between that private artifact and a future
database projection.  It never guesses an ``auction_sales`` row: only one
exact ``(source_name, source_url)`` match is accepted.  Every other case is
retained as ``unmapped`` and cannot carry a value into a publishable row.

The two blind AI passes and the optional AI adjudication are treated as review
metadata, not as source truth.  A field is publishable only when:

* two independent AI passes provide the same label after the existing field
  normalization (an adjudicator can confirm that result but cannot replace it);
* the consensus AI label is a resolved ``present`` value;
* every citation supplied for that field is found in the frozen capture;
* the capture URL maps to exactly one current sale with the same source name;
* the caller later links it to the database reconciliation guard.  The local
  ``passes_local_gate`` flag is only a pre-reconciliation diagnostic; it is not
  a publication decision and does not prove current canonical equality.

This is intentionally independent from the existing catalogue views.  Until
an explicit reviewed importer consumes these rows, the private AI review does
not change ``auction_sales`` or any fiche/map projection.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from uuid import UUID

from src.real_extraction_review import (
    _agrasc_structured_evidence,
    _ai_excerpt_is_verbatim,
    _ai_labels_agree,
    _evidence_text,
)

AI_REVIEW_FIELD_KEYS: dict[str, str] = {
    "property_type": "property.property_type",
    "city": "property.city",
    "sale_date_date": "sale.sale_date",
    "starting_price_eur": "sale.starting_price_eur",
    "habitable_surface_m2": "property.habitable_surface_m2",
    "carrez_surface_m2": "property.carrez_surface_m2",
    "land_surface_m2": "property.land_surface_m2",
    "occupancy_status": "property.occupancy_status",
    "rooms_count": "property.rooms_count",
    "parking_count": "property.parking_count",
    "source_energy_dpe_class": "property.source_energy_dpe_class",
    "source_energy_ges_class": "property.source_energy_ges_class",
}

_PRESENT_OR_UNKNOWN = frozenset({"present", "unknown"})
_VALID_MAPPING_STATES = frozenset({"exact", "unmapped", "ambiguous"})


def build_ai_review_projection_rows(
    manifest: Mapping[str, Any], sales: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Build private, field-level projection rows from a validated AI review.

    ``sales`` is a read-only snapshot containing at least ``id``,
    ``source_name`` and ``source_url``.  The function is deliberately useful
    with a JSON export so an operator can dry-run the mapping without a
    database connection.  It returns all expected fields for captured cases,
    including non-publishable rows, so unresolved and unverified decisions
    cannot disappear from an audit by omission.
    """

    if not isinstance(manifest, Mapping):
        raise ValueError("AI review manifest must be an object")
    sample_sha256 = _required_digest(manifest.get("sample_sha256"), "sample_sha256")
    schema_version = _required_text(manifest.get("schema_version"), "schema_version")
    expected_fields = manifest.get("ai_review_expected_fields")
    if not isinstance(expected_fields, list) or not expected_fields:
        raise ValueError("AI review manifest needs ai_review_expected_fields")
    if any(field not in AI_REVIEW_FIELD_KEYS for field in expected_fields):
        raise ValueError("AI review manifest contains an unsupported field")
    if len(set(expected_fields)) != len(expected_fields):
        raise ValueError("AI review manifest fields must be unique")

    sale_index = _index_sales(sales)
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise ValueError("AI review manifest cases must be an array")

    rows: list[dict[str, Any]] = []
    for case in cases:
        access = case.get("access") if isinstance(case, Mapping) else None
        if not isinstance(case, Mapping) or not isinstance(access, Mapping) or access.get("state") != "captured":
            continue
        rows.extend(
            _project_case(
                case,
                expected_fields=tuple(expected_fields),
                sample_sha256=sample_sha256,
                schema_version=schema_version,
                sale_index=sale_index,
            )
        )
    return rows


def _project_case(
    case: Mapping[str, Any],
    *,
    expected_fields: tuple[str, ...],
    sample_sha256: str,
    schema_version: str,
    sale_index: Mapping[tuple[str, str], tuple[Mapping[str, Any], ...]],
) -> list[dict[str, Any]]:
    source_name = _required_text(case.get("source"), "case source")
    source_url = _required_https(case.get("source_url"), "case source_url")
    case_id = _required_text(case.get("id"), "case id")
    capture = case.get("capture")
    if not isinstance(capture, Mapping):
        raise ValueError(f"captured case {case_id} has no capture")
    capture_sha256 = _required_digest(capture.get("sha256"), "capture sha256")

    matches = sale_index.get((source_name, source_url), ())
    if len(matches) == 1:
        mapping_status = "exact"
        sale_id = _optional_uuid_text(matches[0].get("id"))
        # A row without a usable UUID is not an exact target.  Keep it
        # unmapped rather than allowing an arbitrary database identifier.
        if sale_id is None:
            mapping_status = "unmapped"
    elif len(matches) > 1:
        mapping_status = "ambiguous"
        sale_id = None
    else:
        mapping_status = "unmapped"
        sale_id = None

    raw_capture, capture_error = _read_capture(capture.get("private_ref"), capture_sha256)
    capture_text = _evidence_text(raw_capture)
    structured_capture_text, structured_leaf_texts = _agrasc_structured_evidence(
        raw_capture, source_name, source_url
    )
    ai_reviews = _review_list(case.get("ai_reviews"))
    adjudication = case.get("ai_adjudication")
    if adjudication is not None and not isinstance(adjudication, Mapping):
        raise ValueError(f"AI adjudication for {case_id} must be an object")
    adjudication_labels = (
        adjudication.get("labels", {}) if isinstance(adjudication, Mapping) else {}
    )
    if not isinstance(adjudication_labels, Mapping):
        raise ValueError(f"AI adjudication labels for {case_id} must be an object")

    projected: list[dict[str, Any]] = []
    for field in expected_fields:
        labels = [
            review.get("labels", {}).get(field)
            for review in ai_reviews
            if isinstance(review.get("labels"), Mapping) and field in review["labels"]
        ]
        labels = [label for label in labels if isinstance(label, Mapping)]
        adjudicated_label = adjudication_labels.get(field)
        final_label, unresolved_reason = _final_label(
            labels,
            adjudicated_label,
            field,
            reviewers=[review.get("reviewer") for review in ai_reviews],
        )
        bad_citations = _unverified_citations(
            ai_reviews,
            field,
            raw_capture,
            capture_text,
            structured_capture_text,
            structured_leaf_texts,
            capture_sha256=capture_sha256,
            adjudication=adjudication,
        )

        final_state = final_label.get("state") if final_label else "unresolved"
        reasons: list[str] = []
        if unresolved_reason:
            reasons.append(unresolved_reason)
        if capture_error and final_state in _PRESENT_OR_UNKNOWN:
            reasons.append(capture_error)
        if bad_citations:
            reasons.append("AI citation not found in the frozen capture")

        citation_status = "not_required"
        if final_state == "present":
            citation_status = "unverified" if bad_citations or capture_error else "verified"
        elif bad_citations or capture_error:
            # A non-present label is never publishable.  Preserve a citation
            # failure as an explicit quarantine state, while avoiding the
            # invalid combination (review_state=unknown/absent,
            # citation_status=verified) rejected by the SQL guard.
            citation_status = "unverified"

        review_state = final_state if final_state in {"absent", "unknown"} else "resolved"
        if final_state == "unresolved" or unresolved_reason:
            review_state = "unresolved"
        if bad_citations or (capture_error and final_state in _PRESENT_OR_UNKNOWN):
            review_state = "unverified"
        value = None
        if (
            review_state == "resolved"
            and citation_status == "verified"
            and mapping_status == "exact"
            and final_label is not None
            and final_label.get("state") == "present"
        ):
            value = final_label.get("value")
            if value is None:
                review_state = "unresolved"
                citation_status = "not_required"
                reasons.append("present AI label has no value")

        if mapping_status != "exact":
            reasons.append(f"auction_sales exact mapping is {mapping_status}")
            if final_state == "present" and review_state == "resolved":
                # The value must stay out of the projection until an exact
                # canonical sale target exists.  Represent this as a blocked
                # review state so the SQL value/citation constraints remain
                # valid instead of pretending a detached value is resolved.
                review_state = "unresolved"
                citation_status = "not_required"

        locator = _safe_locator(final_label, bad_citations)
        projected.append(
            {
                "schema_version": schema_version,
                "sample_sha256": sample_sha256,
                "case_id": case_id,
                "source_name": source_name,
                "source_url": source_url,
                "capture_sha256": capture_sha256,
                "auction_sale_id": sale_id,
                "mapping_status": mapping_status,
                "field_key": AI_REVIEW_FIELD_KEYS[field],
                "review_field": field,
                "review_state": review_state,
                "citation_status": citation_status,
                "value_jsonb": value,
                "evidence_locator": locator,
                "block_reason": "; ".join(dict.fromkeys(reasons)) or None,
                # This local gate intentionally excludes the live canonical
                # value and content hash.  The SQL reconciliation view owns
                # the publication decision after import.
                "passes_local_gate": bool(
                    mapping_status == "exact"
                    and sale_id
                    and review_state == "resolved"
                    and citation_status == "verified"
                    and value is not None
                ),
            }
        )
    return projected


def _index_sales(
    sales: Sequence[Mapping[str, Any]],
) -> dict[tuple[str, str], tuple[Mapping[str, Any], ...]]:
    index: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for sale in sales:
        if not isinstance(sale, Mapping):
            raise ValueError("auction_sales snapshot rows must be objects")
        source_name = _required_text(sale.get("source_name"), "sale source_name")
        source_url = _required_https(sale.get("source_url"), "sale source_url")
        index.setdefault((source_name, source_url), []).append(sale)
    return {key: tuple(value) for key, value in index.items()}


def _review_list(value: Any) -> list[Mapping[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("AI reviews must be an array")
    return [review for review in value if isinstance(review, Mapping)]


def _final_label(
    labels: Sequence[Mapping[str, Any]],
    adjudicated: Any,
    field: str,
    *,
    reviewers: Sequence[Any] = (),
) -> tuple[Mapping[str, Any] | None, str | None]:
    """Return only a consensus from two independent AI passes.

    The adjudicator is deliberately not a third vote.  It may repeat a
    consensus label and remain useful as audit metadata, but it cannot turn a
    disagreement or an incomplete pair into a value that can be projected.
    ``reviewers`` is checked here as well as by the manifest validator because
    this module is also used directly by the offline exporter and its tests.
    """

    if len(labels) != 2:
        if len(labels) == 0:
            return None, "AI field has no complete label"
        return None, "AI projection requires two independent passes"
    if len(reviewers) != 2 or any(
        not isinstance(reviewer, str) or not reviewer.strip() for reviewer in reviewers
    ):
        return None, "AI projection requires two named independent passes"
    if reviewers[0] == reviewers[1]:
        return None, "AI projection requires distinct independent passes"
    if not _ai_labels_agree(field, labels[0], labels[1]):
        return None, "AI passes disagree; adjudication cannot override the disagreement"

    # Keep the first blind pass as the canonical representation.  The
    # comparison above already applies the established field normalization;
    # returning an adjudicator's label here would allow a third pass to change
    # a value that the two-pass contract has accepted.
    return labels[0], None


def _unverified_citations(
    reviews: Sequence[Mapping[str, Any]],
    field: str,
    raw_capture: str,
    capture_text: str,
    structured_capture_text: str,
    structured_leaf_texts: frozenset[str],
    *,
    capture_sha256: str,
    adjudication: Mapping[str, Any] | None = None,
) -> list[dict[str, str]]:
    bad: list[dict[str, str]] = []
    citation_sources: list[Mapping[str, Any]] = list(reviews)
    if adjudication is not None:
        citation_sources.append({"reviewer": "ai-adjudicator", "labels": adjudication.get("labels", {})})
    for review in citation_sources:
        labels = review.get("labels")
        if not isinstance(labels, Mapping):
            continue
        label = labels.get(field)
        if not isinstance(label, Mapping) or label.get("state") not in _PRESENT_OR_UNKNOWN:
            continue
        evidence = label.get("evidence")
        if not isinstance(evidence, Mapping):
            bad.append({"reviewer": str(review.get("reviewer") or "unknown"), "locator": ""})
            continue
        if evidence.get("capture_sha256") != capture_sha256:
            bad.append(
                {
                    "reviewer": str(review.get("reviewer") or "unknown"),
                    "locator": str(evidence.get("locator") or ""),
                }
            )
            continue
        excerpt = str(evidence.get("excerpt") or "")
        if not _ai_excerpt_is_verbatim(
            excerpt,
            raw_capture,
            capture_text,
            structured_capture_text,
            structured_leaf_texts,
        ):
            bad.append(
                {
                    "reviewer": str(review.get("reviewer") or "unknown"),
                    "locator": str(evidence.get("locator") or ""),
                }
            )
    return bad


def _safe_locator(
    final_label: Mapping[str, Any] | None, bad_citations: Sequence[Mapping[str, str]]
) -> dict[str, Any]:
    """Keep locators but never copy private citation text into the projection."""

    evidence = final_label.get("evidence") if isinstance(final_label, Mapping) else None
    locator = evidence.get("locator") if isinstance(evidence, Mapping) else None
    result: dict[str, Any] = {}
    if isinstance(locator, str) and locator.strip():
        result["final_locator"] = locator[:500]
    if bad_citations:
        result["unverified_citations"] = [
            {"reviewer": item.get("reviewer", "unknown"), "locator": item.get("locator", "")[:500]}
            for item in bad_citations
        ]
    return result


def _read_capture(value: Any, expected_sha256: str) -> tuple[str, str | None]:
    if not isinstance(value, str) or not value:
        return "", "frozen capture is unavailable"
    try:
        content = Path(value).read_bytes()
    except OSError:
        return "", "frozen capture is unavailable"
    text = content.decode("utf-8", errors="replace")
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        return text, "frozen capture digest mismatch"
    return text, None


def _required_text(value: Any, description: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{description} must be non-empty text")
    return value.strip()


def _required_https(value: Any, description: str) -> str:
    text = _required_text(value, description)
    if not text.startswith("https://"):
        raise ValueError(f"{description} must use HTTPS")
    return text


def _required_digest(value: Any, description: str) -> str:
    text = _required_text(value, description)
    if len(text) != 64 or any(char not in "0123456789abcdef" for char in text):
        raise ValueError(f"{description} must be a lowercase SHA-256 digest")
    return text


def _optional_uuid_text(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = UUID(text)
    except ValueError:
        return None
    return str(parsed)
