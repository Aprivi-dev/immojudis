"""Small pure helpers shared by the PostgREST and Postgres writers (filters, batching, headers)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from src.freshness import timestamp_is_fresh


def _is_uuid(value: object) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return False
    return True


def _has_current_document_analysis(raw_payload: object) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return False
    try:
        listed = int(analysis.get("documents_listed") or 0)
        extracted = int(analysis.get("documents_extracted") or 0)
        blocked = int(analysis.get("blocked_documents") or 0)
        failed = int(analysis.get("failed_documents") or 0)
    except (OverflowError, TypeError, ValueError):
        return False
    if listed > 0:
        if extracted > 0:
            return True
        # A robots-policy-only result is intentionally partial, but it is a
        # completed bounded check. Keep it out of the next incremental heavy
        # pass while its persisted evidence is fresh. The downstream
        # heavy-current check still compares that fingerprint with the current
        # sale documents before skipping enrichment. Missing the explicit
        # fields keeps legacy/ambiguous zero-extraction rows eligible.
        if (
            blocked > 0
            and failed == 0
            and analysis.get("coverage_status") == "partial"
            and bool(analysis.get("input_fingerprint"))
            and bool(analysis.get("blocked_document_urls"))
            and bool(analysis.get("blocked_document_reasons"))
            and timestamp_is_fresh(analysis.get("checked_at"))
        ):
            return True
        terminal_urls = analysis.get("terminal_document_urls")
        skipped_urls = analysis.get("skipped_document_urls")
        blocked_urls = analysis.get("blocked_document_urls")
        if (
            failed == 0
            and analysis.get("coverage_status") == "partial"
            and bool(analysis.get("input_fingerprint"))
            and timestamp_is_fresh(analysis.get("checked_at"))
            and isinstance(terminal_urls, list)
            and isinstance(skipped_urls, list)
            and isinstance(blocked_urls, list)
            and len({str(url) for url in [*terminal_urls, *skipped_urls, *blocked_urls] if url}) >= listed
        ):
            return True
    return analysis.get("coverage_status") == "source_only"


def _known_source_urls(row: dict[str, Any]) -> list[str]:
    urls = [row.get("source_url")]
    if isinstance(row.get("source_urls"), list):
        urls.extend(row["source_urls"])
    elif isinstance(row.get("source_urls"), dict):
        urls.extend(row["source_urls"].values())
    return [str(url) for url in urls if url]


def _postgrest_in_filter(values: list[str]) -> str:
    quoted = []
    for value in values:
        escaped = value.replace('"', '\\"')
        quoted.append(f'"{escaped}"')
    return f"in.({','.join(quoted)})"


def _postgrest_batch_size(table: str) -> int:
    if table in {"auction_sales", "auction_extractions"}:
        return 5
    if table == "auction_observations":
        return 10
    if table in {"auction_documents", "auction_score_factors", "auction_risk_occurrences"}:
        return 25
    return 100


def _postgrest_batches(payload: list[dict[str, object]], batch_size: int) -> list[list[dict[str, object]]]:
    return [payload[index : index + batch_size] for index in range(0, len(payload), batch_size)]


def _rest_headers(api_key: str, prefer: str) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def _timestamped(row: dict[str, object], now: str) -> dict[str, object]:
    row["updated_at"] = now
    return row
