"""Proof that each public Notaires API partition was read in full (inventory certificate).

Split from ``notaires.py`` (31/10/2026). A partition is one (transaction type, department) query of the
public API; its state records what the API advertised and what the scraper emitted, and the certificate
says whether every discovered announcement was returned, excluded for a stated reason, or is missing.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from src.sources.common import PaginationCoverage

_INVENTORY_SHIFT_REASONS = frozenset({"advertised_total_changed", "advertised_page_count_changed"})


def new_inventory_partition(
    transaction_type: str,
    department: str | None,
    pagination: PaginationCoverage,
) -> dict[str, Any]:
    """Create the API evidence state for one (transaction, department) query."""
    return {
        "transaction_type": transaction_type,
        "department": department,
        "partition": f"{transaction_type}:{department or 'all'}",
        "pagination": pagination,
        "advertised_total": None,
        "advertised_pages": None,
        "metadata_pages_seen": 0,
        "metadata_complete": True,
        "json_valid": True,
        "api_rows_seen": 0,
        "source_emitted_rows": 0,
        "source_urls": set(),
        "duplicate_source_urls": set(),
        "in_scope_urls": set(),
        "in_scope_departments": {},
        "department_exclusions": {},
        "unhandled_urls": set(),
        "unhandled_reasons": {},
        "returned_validated_urls": set(),
        "validation_failed_urls": set(),
        "unparsed_rows": 0,
        "terminal_page_seen": False,
        "out_of_range": False,
        "api_errors": [],
        "reasons": [],
    }


def inventory_shifted(state: dict[str, Any]) -> bool:
    """True when the only flaw a new read can cure is visible: the inventory moved while it was read."""
    if state["api_errors"] or not state["json_valid"] or not state["metadata_complete"]:
        return False
    return bool(state["duplicate_source_urls"]) or bool(_INVENTORY_SHIFT_REASONS.intersection(state["reasons"]))


def finalize_inventory_partition(state: dict[str, Any], *, max_pages: int) -> None:
    pagination = state["pagination"]
    metrics = pagination.metrics()
    if not pagination.exhausted and metrics["stop_reason"] not in state["reasons"]:
        state["reasons"].append(metrics["stop_reason"])
    if state["advertised_pages"] is not None and not state["terminal_page_seen"]:
        state["reasons"].append("terminal_page_not_reached")
    if pagination.pages_fetched >= max_pages and not pagination.exhausted:
        state["reasons"].append("page_limit_or_count_mismatch")
    if state["advertised_total"] is not None:
        if state["source_emitted_rows"] != state["advertised_total"]:
            state["reasons"].append("source_emitted_count_mismatch")
        if len(state["source_urls"]) != state["advertised_total"]:
            state["reasons"].append("unique_source_url_count_mismatch")
    # Keep reasons deterministic and JSON-friendly for audit output.
    state["reasons"] = list(dict.fromkeys(state["reasons"]))


def _validation_error_urls(errors: list[str]) -> set[str]:
    urls: set[str] = set()
    for error in errors:
        if not error.startswith("validation "):
            continue
        marker = error[len("validation "):]
        url, separator, _ = marker.partition(": ")
        if separator and url:
            urls.add(url)
    return urls


def record_validated_results(
    partition_states: list[dict[str, Any]],
    validated_sales: list[dict[str, Any]],
    validation_errors: list[str],
) -> None:
    """Attach final returned URLs to their API partition after one validation pass."""
    validated_urls = {
        str(sale.get("source_url") or "")
        for sale in validated_sales
        if sale.get("source_url")
    }
    validation_failed_urls = _validation_error_urls(validation_errors)
    for state in partition_states:
        state["returned_validated_urls"].update(
            state["in_scope_urls"] & validated_urls
        )
        state["validation_failed_urls"].update(
            state["in_scope_urls"] & validation_failed_urls
        )
        for _url, exclusion in state["department_exclusions"].items():
            # Department-filtered rows are intentionally outside the returned
            # scope and therefore count as successful, URL-addressed exclusions.
            exclusion.setdefault("successful", True)
        for url in sorted(state["in_scope_urls"] - state["returned_validated_urls"]):
            reason = (
                "validation_failed"
                if url in state["validation_failed_urls"]
                else "returned_validated_missing"
            )
            # A validation failure is a public row that was not returned.  It
            # is deliberately unhandled, rather than a successful exclusion:
            # only an explicit configured-department filter can exclude a URL.
            state["unhandled_urls"].add(url)
            state["unhandled_reasons"][url] = reason


def partition_metrics(state: dict[str, Any], departments: Iterable[str]) -> dict[str, Any]:
    pagination = state["pagination"]
    metrics = pagination.metrics()
    metrics.update(
        {
            "partition": state["partition"],
            "transaction_type": state["transaction_type"],
            "department": state["department"],
            "api_scope": {
                "transaction_type": state["transaction_type"],
                "department": state["department"],
            },
            "returned_scope": {
                "departments": sorted(departments),
            },
            "advertised_pages": state["advertised_pages"],
            "metadata_pages_seen": state["metadata_pages_seen"],
            "terminal_page_seen": state["terminal_page_seen"],
            "out_of_range": state["out_of_range"],
            "json_valid": state["json_valid"],
            "metadata_complete": state["metadata_complete"],
            "api_rows_seen": state["api_rows_seen"],
            "source_emitted_rows": state["source_emitted_rows"],
            "source_emitted_before_filters": state["source_emitted_rows"],
            "source_unique_urls": len(state["source_urls"]),
            "source_unique_urls_before_filters": len(state["source_urls"]),
            "public_urls": sorted(state["source_urls"]),
            "public_parsed_urls": sorted(state["source_urls"]),
            "public_urls_parsed": sorted(state["source_urls"]),
            "returned_validated_urls": sorted(state["returned_validated_urls"]),
            "in_scope_public_urls": sorted(state["in_scope_urls"]),
            "excluded_urls": [
                {
                    "url": url,
                    "reason": state["department_exclusions"][url]["reason"],
                }
                for url in sorted(state["department_exclusions"])
            ],
            "exclusion_reasons": {
                url: record["reason"]
                for url, record in sorted(state["department_exclusions"].items())
            },
            "exclusions": [
                state["department_exclusions"][url]
                for url in sorted(state["department_exclusions"])
            ],
            "successful_excluded_urls": sorted(
                url
                for url, record in state["department_exclusions"].items()
                if record.get("successful") is True
            ),
            "validation_failed_urls": sorted(state["validation_failed_urls"]),
            "unhandled_urls": sorted(state["unhandled_urls"]),
            "unhandled_reasons": dict(sorted(state["unhandled_reasons"].items())),
            "duplicate_source_urls": sorted(state["duplicate_source_urls"]),
            "unparsed_rows": state["unparsed_rows"],
            "api_errors": list(state["api_errors"]),
            "reasons": list(state["reasons"]),
        }
    )
    return metrics


def inventory_certificate(
    partition_states: list[dict[str, Any]],
    inventory_errors: list[str],
    departments: Iterable[str],
) -> dict[str, Any]:
    partitions: list[dict[str, Any]] = []
    for state in partition_states:
        metrics = partition_metrics(state, departments)
        public_certified = bool(
            state["metadata_complete"]
            and state["json_valid"]
            and state["advertised_total"] is not None
            and state["advertised_pages"] is not None
            and state["terminal_page_seen"]
            and state["pagination"].exhausted
            and not state["api_errors"]
            and not state["duplicate_source_urls"]
            and state["unparsed_rows"] == 0
            and state["source_emitted_rows"] == state["advertised_total"]
            and len(state["source_urls"]) == state["advertised_total"]
            and not state["reasons"]
        )
        returned_validated_complete = bool(
            public_certified
            and state["in_scope_urls"] <= state["returned_validated_urls"]
            and not state["validation_failed_urls"]
            and not state["unhandled_urls"]
            and all(
                record.get("successful") is True
                for record in state["department_exclusions"].values()
            )
        )
        metrics["public_inventory_certified"] = public_certified
        metrics["returned_validated_complete"] = returned_validated_complete
        metrics["all_discovered_announcements_emitted"] = returned_validated_complete
        metrics["certified"] = public_certified
        partitions.append(metrics)

    public_certified = bool(partitions) and all(
        partition["public_inventory_certified"] for partition in partitions
    ) and not inventory_errors
    all_emitted = bool(partitions) and all(
        partition["all_discovered_announcements_emitted"] for partition in partitions
    ) and not inventory_errors
    public_urls = sorted({url for state in partition_states for url in state["source_urls"]})
    returned_validated_urls = sorted(
        {url for state in partition_states for url in state["returned_validated_urls"]}
    )
    exclusions = {
        url: record["reason"]
        for state in partition_states
        for url, record in state["department_exclusions"].items()
    }
    exclusion_records = [
        state["department_exclusions"][url]
        for state in partition_states
        for url in sorted(state["department_exclusions"])
    ]
    unhandled_urls = sorted({
        url for state in partition_states for url in state["unhandled_urls"]
    })
    unhandled_reasons = {
        url: reason
        for state in partition_states
        for url, reason in state["unhandled_reasons"].items()
    }
    validation_failed_urls = sorted({
        url for state in partition_states for url in state["validation_failed_urls"]
    })
    return {
        "scope": (
            "Public Notaires API inventory partitioned by typeTransaction and "
            "department; source rows are counted before output filters; database persistence is excluded."
        ),
        "scope_detail": (
            "API partitions are certified independently; returned rows are the validated listings "
            "kept for the configured department scope."
        ),
        "partitioning": ["transaction_type", "department"],
        "public_inventory_certified": public_certified,
        # Keep the catalogue-proof vocabulary available to callers that consume
        # multiple source adapters through the same summary shape.
        "public_inventorycertified": public_certified,
        "public_discovery_certified": public_certified,
        "addressable_public_inventory_certified": public_certified,
        "all_discovered_announcements_emitted": all_emitted,
        "database_completeness_certified": False,
        "public_parsed_urls": public_urls,
        "public_urls_parsed": public_urls,
        "returned_validated_urls": returned_validated_urls,
        "excluded_urls": [
            {"url": url, "reason": exclusions[url]}
            for url in sorted(exclusions)
        ],
        "exclusions": exclusion_records,
        "exclusion_reasons": exclusions,
        "unhandled_public_urls": unhandled_urls,
        "unhandled_reasons": unhandled_reasons,
        "validation_failed_urls": validation_failed_urls,
        "discovered_but_not_emitted_count": len(unhandled_urls),
        "discovered_but_not_emitted_urls": unhandled_urls,
        "invalid_exclusion_urls": [],
        "api_scope": {
            "partitioning": ["transaction_type", "department"],
            "description": "Rows advertised by each public Notaires API partition before output filters.",
        },
        "returned_scope": {
            "departments": sorted(departments),
            "description": "Validated rows retained for the configured department scope.",
        },
        "inventory_errors": list(inventory_errors),
        "partitions": partitions,
    }
