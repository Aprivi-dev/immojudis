"""Freshness is independent of a sale's identity and enrichment versions."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from src.enrichment.display_quality import has_current_display
from src.normalize import clean_text

SOURCE_EXTRACTION_VERSION = "source_extraction_20260913_v3"

SOURCE_FACT_FIELDS = (
    "raw_text", "documents", "visit_dates", "occupancy_status", "sale_date", "starting_price_eur",
    "status", "adjudication_price_eur", "source_sale_schedule", "source_blocks", "source_conflicts",
    "source_name", "source_url", "external_id", "lot_number", "address", "city", "postal_code",
    "department", "property_type", "title", "description", "tribunal", "lawyer_name", "lawyer_contact",
    "surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2", "app_surface_m2",
    "app_surface_kind", "surface_scope", "surface_source", "surface_evidence", "rooms_count",
    "bedrooms_count", "bathrooms_count", "parking_count", "has_garden", "has_terrace", "has_garage",
    "has_pool", "has_air_conditioning", "has_double_glazing", "risk_notes", "latitude", "longitude",
)

SOURCE_OPERATIONAL_FIELDS = frozenset({
    "visit_dates", "sale_date", "starting_price_eur", "status",
    "adjudication_price_eur", "source_sale_schedule",
})


def source_evidence_fingerprint(content: dict) -> str:
    # Text is intentionally kept verbatim: changing a price inside prose may
    # also change a legal condition and must not be heuristically stripped.
    evidence = {key: content.get(key) for key in SOURCE_FACT_FIELDS if key not in SOURCE_OPERATIONAL_FIELDS}
    return hashlib.sha256(json.dumps(evidence, sort_keys=True, default=str).encode()).hexdigest()


def timestamp_is_fresh(value: object, *, hours: float = 24, now: datetime | None = None) -> bool:
    try:
        checked = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if checked.tzinfo is None:
            return False
        age = (now or datetime.now(UTC)) - checked
        return timedelta(0) <= age < timedelta(hours=hours)
    except (ValueError, TypeError):
        return False


def detail_is_fresh(row: dict[str, Any], source_url: str) -> bool:
    payload = row.get("raw_payload") or {}
    if payload.get("source_identity_mismatch") or str(row.get("status") or "").casefold() == "quarantined":
        return False
    checks = payload.get("source_checks") or {}
    check = checks.get(source_url) or {}
    if check.get("extractor_version") != SOURCE_EXTRACTION_VERSION:
        return False
    hours = 24
    try:
        sale_date = datetime.fromisoformat(str(row.get("sale_date")).replace("Z", "+00:00"))
        if sale_date.tzinfo and timedelta(0) <= sale_date - datetime.now(UTC) <= timedelta(days=7):
            hours = 6
    except (ValueError, TypeError):
        pass
    return timestamp_is_fresh(check.get("checked_at"), hours=hours)


def document_fingerprint(documents: list) -> str:
    if not isinstance(documents, list):
        return ""
    identities = sorted((str(d.get("url") or ""), str(d.get("label") or "")) for d in documents if isinstance(d, dict))
    return hashlib.sha256(json.dumps(identities).encode()).hexdigest()


def record_source_checks(raw_sales: list, known: dict) -> None:
    for sale in raw_sales:
        url = str(sale.get("source_url") or "")
        previous = (known.get(url, {}).get("raw_payload") or {}).get("source_checks") or {}
        payload = sale
        payload["source_checks"] = dict(previous)
        if sale.get("_known_unchanged") or sale.get("_detail_fetch_failed"):
            continue
        snapshot = sale.get('source_factual_snapshot') or {}
        content = {key: snapshot[key] if key in snapshot else sale.get(key) for key in SOURCE_FACT_FIELDS}
        fingerprint = hashlib.sha256(json.dumps(content, sort_keys=True, default=str).encode()).hexdigest()
        evidence_fingerprint = source_evidence_fingerprint(content)
        old = previous.get(url) or {}
        check = {
            "checked_at": sale.get("_checkpoint_checked_at") or datetime.now(UTC).isoformat(),
            "source_name": sale.get("source_name"),
            "fingerprint": fingerprint,
            "evidence_fingerprint": evidence_fingerprint,
            "extractor_version": SOURCE_EXTRACTION_VERSION,
        }
        # A detail-status marker is proof that the dedicated detail fetch was
        # validated. Listing captures must replace the previous check without
        # inheriting that proof from the stored row.
        if sale.get("source_detail_status") in {"complete", "restricted"}:
            check["detail_status"] = sale["source_detail_status"]
        payload["source_checks"][url] = check
        if old.get("fingerprint") != fingerprint:
            operational_only = old.get("evidence_fingerprint") == evidence_fingerprint
            invalidate_analysis(payload, "source_operational_changed" if operational_only else "source_content_changed", preserve_facts=operational_only)


def documents_are_current(sale: Any) -> bool:
    raw_payload = getattr(sale, "raw_payload", None)
    documents = getattr(sale, "documents", None)
    if not isinstance(raw_payload, dict) or not isinstance(documents, list):
        return False
    analysis = raw_payload.get("document_analysis")
    if not isinstance(analysis, dict):
        return False
    if any(not isinstance(document, dict) or not clean_text(document.get("url")) for document in documents):
        return False
    try:
        failed_documents = int(analysis.get("failed_documents") or 0)
    except (OverflowError, TypeError, ValueError):
        return False
    if (
        analysis.get("input_fingerprint") != document_fingerprint(documents)
        or not timestamp_is_fresh(analysis.get("checked_at"))
        or failed_documents != 0
    ):
        return False
    modern_manifest = analysis.get("progress_schema_version") == 1
    if modern_manifest and analysis.get("manifest_complete") is not True:
        return False
    if modern_manifest:
        pending_http = analysis.get("http_revalidation_pending_urls")
        if pending_http is not None and (not isinstance(pending_http, list) or pending_http):
            return False
    if not documents:
        return True

    def _document_url_set(value: object) -> set[str] | None:
        if value is None:
            return set()
        if not isinstance(value, (list, tuple, set)):
            return None
        urls = {clean_text(item) for item in value if clean_text(item)}
        return urls

    # A robots-policy-only result is a bounded, deliberate terminal state:
    # there is no local PDF cache to prove, but retrying the same URL would
    # only recreate the same blocked job. Mixed results still require proof
    # for every non-blocked document below.
    blocked_urls = _document_url_set(analysis.get("blocked_document_urls"))
    skipped_urls = _document_url_set(analysis.get("skipped_document_urls"))
    terminal_urls = _document_url_set(analysis.get("terminal_document_urls"))
    if blocked_urls is None or skipped_urls is None or terminal_urls is None:
        return False
    document_urls = {
        clean_text(document.get("url"))
        for document in documents
    }
    if (
        not blocked_urls.issubset(document_urls)
        or not skipped_urls.issubset(document_urls)
        or not terminal_urls.issubset(document_urls)
    ):
        return False
    excluded_urls = blocked_urls | skipped_urls | terminal_urls
    expected_urls = document_urls - excluded_urls
    if not expected_urls:
        return bool(excluded_urls)

    proof = analysis.get("cache_proof")
    if not isinstance(proof, dict):
        return False
    if (
        proof.get("version") != 1
        or
        proof.get("input_fingerprint") != document_fingerprint(documents)
        or not timestamp_is_fresh(proof.get("verified_at"))
    ):
        return False
    proof_documents = proof.get("documents")
    if not isinstance(proof_documents, list):
        return False
    if any(not isinstance(item, dict) or not clean_text(item.get("url")) for item in proof_documents):
        return False
    proof_by_url = {
        clean_text(item.get("url")): item
        for item in proof_documents
    }
    proof_urls = set(proof_by_url)
    if (
        len(proof_by_url) != len(proof_documents)
        or not expected_urls.issubset(proof_urls)
        or not (proof_urls - expected_urls).issubset(terminal_urls)
    ):
        return False
    profiles_payload = analysis.get("profiles")
    if not isinstance(profiles_payload, list):
        return False
    if any(not isinstance(item, dict) or not clean_text(item.get("url")) for item in profiles_payload):
        return False
    analysis_profiles = {clean_text(item.get("url")): item for item in profiles_payload}
    profile_urls = set(analysis_profiles)
    if (
        len(analysis_profiles) != len(profiles_payload)
        or not expected_urls.issubset(profile_urls)
        or not (profile_urls - expected_urls).issubset(excluded_urls)
    ):
        return False
    for url in expected_urls:
        item = proof_by_url[url]
        try:
            text_chars = int(item.get("text_chars") or 0)
        except (OverflowError, TypeError, ValueError):
            return False
        profile = analysis_profiles.get(url)
        profile_sha = clean_text(profile.get("sha256")) if isinstance(profile, dict) else ""
        profile_status = (
            (clean_text(profile.get("extraction_status")) or "").casefold()
            if isinstance(profile, dict)
            else ""
        )
        if not (
            item.get("extraction_status") == "extracted"
            and item.get("complete") is True
            and not item.get("failed_pages")
            and bool(clean_text(item.get("sha256")))
            and bool(clean_text(item.get("text_sha256")))
            and item.get("text_present") is True
            and text_chars > 0
            and bool(profile_sha)
            and profile_sha == clean_text(item.get("sha256"))
            and profile_status == "extracted"
            and profile.get("complete") is True
            and not profile.get("failed_pages")
        ):
            return False
        if modern_manifest and not timestamp_is_fresh(item.get("http_checked_at")):
            return False
    expected_hashes = {
        url: clean_text(item.get("sha256"))
        for url, item in proof_by_url.items()
        if url in expected_urls
        if clean_text(item.get("sha256"))
    }
    expected_text_hashes = {
        url: clean_text(item.get("text_sha256"))
        for url, item in proof_by_url.items()
        if url in expected_urls
        if clean_text(item.get("text_sha256"))
    }
    if set(expected_hashes) != expected_urls or set(expected_text_hashes) != expected_urls:
        return False

    # The persisted marker proves how the manifest was produced, but a
    # worker must also have the current text cache before it skips extraction.
    # A previous run's JSON profile alone would otherwise recreate the
    # unknown/pending rows when this worker has no local cache.
    return _local_pdf_cache_is_complete(sale, expected_urls, expected_hashes, expected_text_hashes)


def _local_pdf_cache_is_complete(
    sale: Any,
    expected_urls: set[str],
    expected_hashes: dict[str, str],
    expected_text_hashes: dict[str, str],
) -> bool:
    try:
        from src.config import PDF_TEXTS_DIR
        from src.pdf_enrichment import sale_storage_id

        path = PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (ImportError, OSError, TypeError, UnicodeError, ValueError, json.JSONDecodeError):
        return False
    if not isinstance(payload, list):
        return False
    if any(not isinstance(item, dict) or not clean_text(item.get("url")) for item in payload):
        return False
    by_url = {
        clean_text(item.get("url")): item
        for item in payload
    }
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    terminal_urls: set[str] = set()
    if isinstance(analysis, dict):
        raw_terminal_urls = analysis.get("terminal_document_urls")
        if raw_terminal_urls is not None and not isinstance(raw_terminal_urls, (list, tuple, set)):
            return False
        terminal_urls = {clean_text(url) for url in raw_terminal_urls or [] if clean_text(url)}
    cache_urls = set(by_url)
    if (
        len(by_url) != len(payload)
        or not expected_urls.issubset(cache_urls)
        or not (cache_urls - expected_urls).issubset(terminal_urls)
    ):
        return False
    for url in expected_urls:
        item = by_url[url]
        try:
            normalized_text = clean_text(item.get("text")) or ""
            text_chars = int(item.get("text_chars") or len(normalized_text))
        except (OverflowError, TypeError, ValueError):
            return False
        if not (
            normalized_text
            and str(item.get("sha256") or "").strip()
            and item.get("complete") is True
            and not item.get("failed_pages")
            and str(item.get("extraction_status") or "").strip().lower() == "extracted"
            and text_chars > 0
            and str(item.get("sha256")) == expected_hashes.get(str(item.get("url")))
            and hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
            == str(expected_text_hashes.get(str(item.get("url"))))
        ):
            return False
    return True


def invalidate_analysis(payload: dict, reason: str, *, preserve_facts: bool = False) -> None:
    """Retain dated evidence, never publish the superseded synthesis as current."""
    previous_content_changed = bool(payload.get("source_content_changed"))
    # A reason without its queue flag is a stale marker from a caller that
    # already consumed the previous invalidation. Do not let it make the next
    # operational revision look documentary.
    previous_content_reason = payload.get("source_content_change_reason") if previous_content_changed else None
    payload["source_content_changed"] = True
    if preserve_facts:
        payload["source_operational_changed"] = True
        # An operational-only refresh uses source_content_changed as the
        # queue-visible invalidation flag. Keep its origin explicit so a
        # later successful deterministic refresh cannot clear a documentary
        # invalidation that was already pending.
        if not previous_content_changed:
            payload["source_content_change_reason"] = reason
    else:
        payload.pop("source_operational_changed", None)
        payload["source_content_change_reason"] = reason
    if payload.get("llm_display_description"):
        fact_manifest = payload.get("llm_fact_context_manifest")
        previous_model = payload.get("llm_display_model")
        if not previous_model and isinstance(fact_manifest, dict):
            # Older structured runs did not persist a display-stage model, but
            # their validated fact manifest was produced by the same model
            # contract. Reuse that evidence when it is available; rows with
            # no model provenance remain enrichment-required.
            previous_model = fact_manifest.get("model")
        display_refreshable = bool(
            reason == "source_operational_changed"
            and not (
                previous_content_changed
                and previous_content_reason != "source_operational_changed"
            )
            and has_current_display(payload)
            and payload.get("llm_prompt_version")
            and payload.get("llm_display_prompt_version")
            and previous_model
        )
        payload["superseded_analysis"] = {
            "description": payload.pop("llm_display_description"),
            "prompt_version": payload.get("llm_prompt_version"),
            "display_prompt_version": payload.get("llm_display_prompt_version"),
            "model": previous_model,
            "quality_version": payload.get("llm_display_quality_version"),
            "status": payload.get("llm_display_status"),
            "operational_refreshable": display_refreshable,
            "source_content_changed_before": previous_content_changed,
            "source_content_change_reason_before": previous_content_reason,
            "superseded_at": datetime.now(UTC).isoformat(),
            "reason": reason,
        }
    payload["llm_display_status"] = "pending"
    keys = [
        "llm_prompt_version", "llm_extraction", "llm_due_diligence", "investment_analysis",
        "llm_display_prompt_version", "llm_display_model", "llm_display_quality_version",
        "llm_display_origin", "llm_display_description_word_count", "llm_display_source_constraints",
        "llm_display_evidence_check",
    ]
    if not preserve_facts:
        keys.extend(["document_facts_version", "llm_fact_prompt_version", "llm_fact_extraction",
                     "llm_fact_coverage", "llm_fact_input_key", "llm_fact_context_manifest", "llm_fact_context_coverage"])
    elif isinstance(payload.get("llm_fact_extraction"), dict):
        # Retain validated facts, never an old generated paragraph or financial
        # narrative bundled with an earlier extraction.
        payload["llm_fact_extraction"] = {**payload["llm_fact_extraction"],
                                         "display_description": None, "summary": None, "investor_notes": None}
    for key in keys:
        payload.pop(key, None)
