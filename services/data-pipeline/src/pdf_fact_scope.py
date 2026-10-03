from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from src.normalize import (
    clean_text,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
    normalize_status,
    parse_french_datetime,
    parse_price,
    source_sale_timezone,
    strip_accents,
)
from src.pdf_document_types import _canonical_document_type, _normalize_document_classifier_text

_PDF_SCALAR_CANDIDATE_KEYS = (
    "pdf_surface_candidates",
    "pdf_land_surface_candidates",
    "pdf_rooms_candidates",
    "pdf_bedrooms_candidates",
    "pdf_occupancy_candidates",
    "pdf_energy_diagnostics_candidates",
)

_PDF_FACT_PROVENANCE_KEY = "pdf_fact_provenance"
_PDF_PROVENANCE_UNSET = object()
_PDF_TEXT_ENRICHMENT_MARKER = "--- PDF TEXT ENRICHMENT ---"
_PDF_LEGACY_SCALAR_FIELDS = {
    "rooms_count": "pdf_rooms_candidates",
    "bedrooms_count": "pdf_bedrooms_candidates",
    "occupancy_status": "pdf_occupancy_candidates",
}
_PDF_SCOPE_FIELDS = {
    "surface": {
        "surface_m2",
        "habitable_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "app_surface_kind",
        "surface_scope",
        "surface_source",
        "surface_confidence",
        "surface_evidence",
    },
    "land_surface": {"land_surface_m2"},
    "rooms": {"rooms_count"},
    "bedrooms": {"bedrooms_count"},
    "occupancy": {"occupancy_status"},
    "energy": {"raw_payload:pdf_energy_diagnostics"},
    "starting_price": {"starting_price_eur"},
    "dates": {"sale_date", "visit_dates"},
}


def _pdf_text_chunks(pdf_texts: list[dict[str, object]] | list[str]) -> list[dict[str, object]]:
    """Return page/document chunks with stable provenance for scalar facts.

    Page text is preferred when it exists.  A document-level aggregate is used
    only for documents without usable page text, matching the bounded PDF
    extraction contract and avoiding duplicate candidates from OCR plus the
    aggregate payload.
    """
    chunks: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            text = clean_text(item)
            if text:
                chunks.append(
                    {
                        "text": text,
                        "document_label": "",
                        "document_url": "",
                        "document_type": "pdf",
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": "text",
                    }
                )
            continue
        label = clean_text(item.get("label")) or ""
        url = clean_text(item.get("url")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=url,
        )
        pages = item.get("pages")
        page_chunks: list[dict[str, object]] = []
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                text = clean_text(page.get("text"))
                if not text:
                    continue
                page_chunks.append(
                    {
                        "text": text,
                        "document_label": label,
                        "document_url": url,
                        "document_type": document_type,
                        "page_number": page.get("page") if isinstance(page.get("page"), int) else None,
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
        if page_chunks:
            chunks.extend(page_chunks)
            continue
        text = clean_text(item.get("text"))
        if text:
            chunks.append(
                {
                    "text": text,
                    "document_label": label,
                    "document_url": url,
                    "document_type": document_type,
                    "page_number": None,
                    "page_confidence": None,
                    "extraction_method": item.get("extraction_method"),
                }
            )
    return chunks


def _pdf_provenance_value(value: object) -> object:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _pdf_provenance_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_pdf_provenance_value(item) for item in value]
    return value


def _pdf_datetime_for_compare(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _pdf_datetimes_match(current: object, recorded: object) -> bool | None:
    current_datetime = _pdf_datetime_for_compare(current)
    recorded_datetime = _pdf_datetime_for_compare(recorded)
    if current_datetime is None or recorded_datetime is None:
        return None
    current_aware = current_datetime.tzinfo is not None and current_datetime.utcoffset() is not None
    recorded_aware = recorded_datetime.tzinfo is not None and recorded_datetime.utcoffset() is not None
    if current_aware != recorded_aware:
        return False
    if current_aware:
        return current_datetime.astimezone(UTC) == recorded_datetime.astimezone(UTC)
    return current_datetime == recorded_datetime


def _pdf_values_match(current: object, recorded: object) -> bool:
    if current is None or recorded is None:
        return current is recorded or (current is None and recorded is None)
    datetime_match = _pdf_datetimes_match(current, recorded)
    if datetime_match is not None:
        return datetime_match
    if isinstance(current, (list, tuple)) and isinstance(recorded, (list, tuple)):
        return len(current) == len(recorded) and all(
            _pdf_values_match(current_item, recorded_item)
            for current_item, recorded_item in zip(current, recorded, strict=True)
        )
    if isinstance(current, dict) and isinstance(recorded, dict):
        return current.keys() == recorded.keys() and all(
            _pdf_values_match(current[key], recorded[key]) for key in current
        )
    if isinstance(current, Decimal) or isinstance(recorded, (Decimal, int, float)):
        try:
            return Decimal(str(current)) == Decimal(str(recorded))
        except (ArithmeticError, TypeError, ValueError):
            pass
    return _pdf_provenance_value(current) == _pdf_provenance_value(recorded)


def _pdf_get_projected_value(sale: Any, field: str) -> object:
    if field.startswith("raw_payload:"):
        return sale.raw_payload.get(field.split(":", 1)[1])
    return getattr(sale, field, None)


def _pdf_set_projected_value(sale: Any, field: str, value: object) -> None:
    if field.startswith("raw_payload:"):
        key = field.split(":", 1)[1]
        if value is None:
            sale.raw_payload.pop(key, None)
        else:
            sale.raw_payload[key] = value
        return
    current = getattr(sale, field, None)
    if field == "status":
        value = normalize_status(value, getattr(sale, "sale_date", None))
    if value is None and isinstance(current, list):
        value = []
    if value is not None and isinstance(current, Decimal):
        try:
            value = Decimal(str(value))
        except (ArithmeticError, TypeError, ValueError):
            parsed = parse_price(value)
            if parsed is not None:
                value = parsed
    elif value is not None and isinstance(current, datetime) and not isinstance(value, datetime):
        value = parse_french_datetime(
            value,
            local_timezone=source_sale_timezone(getattr(sale, "raw_payload", {}) or {}),
        )
    elif value is not None and isinstance(current, int) and not isinstance(current, bool):
        try:
            value = int(value)
        except (TypeError, ValueError):
            pass
    setattr(sale, field, value)


def _pdf_record_fact_projection(
    sale: Any,
    fields: list[str] | tuple[str, ...] | set[str],
    *,
    candidate: dict[str, object] | None = None,
    evidence: str = "",
    document_url: str = "",
    page_number: object = None,
    payload_keys: tuple[str, ...] = (),
    baseline: object = _PDF_PROVENANCE_UNSET,
    previous_value: object = _PDF_PROVENANCE_UNSET,
) -> None:
    """Record the last PDF projection without making it source evidence.

    The value trace lets a later document replacement remove only values that
    still equal the old PDF projection.  A manually corrected field therefore
    survives invalidation, while a stale PDF value can be restored from the
    trusted source snapshot (or cleared when no source value exists).
    """
    raw_payload = getattr(sale, "raw_payload", None)
    if not isinstance(raw_payload, dict):
        return
    provenance = raw_payload.setdefault(_PDF_FACT_PROVENANCE_KEY, {})
    if not isinstance(provenance, dict):
        provenance = {}
        raw_payload[_PDF_FACT_PROVENANCE_KEY] = provenance
    candidate = candidate or {}
    evidence = str(candidate.get("evidence") or evidence)
    document_url = str(candidate.get("document_url") or document_url)
    page_number = candidate.get("page_number", page_number)
    for field in fields:
        value = _pdf_get_projected_value(sale, field)
        if value is None:
            continue
        existing_trace = provenance.get(field)
        trace_baseline = baseline
        # A partial pass can append another PDF-derived note to the previous
        # projection. Keep the original source baseline in that case. If the
        # field changed independently, the value supplied by the caller is the
        # new baseline and remains recoverable on the next replacement.
        if (
            previous_value is not _PDF_PROVENANCE_UNSET
            and isinstance(existing_trace, dict)
            and "baseline" in existing_trace
            and _pdf_values_match(previous_value, existing_trace.get("value"))
        ):
            trace_baseline = existing_trace["baseline"]
        serializable = _pdf_provenance_value(value)
        identity = {
            "field": field,
            "value": serializable,
            "evidence": evidence,
            "document_url": document_url,
            "page_number": page_number,
        }
        trace = {
            "value": serializable,
            "source": "pdf",
            "fingerprint": hashlib.sha256(
                json.dumps(identity, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest(),
            "payload_keys": list(payload_keys),
        }
        if evidence:
            trace["evidence"] = evidence[:600]
        if document_url:
            trace["document_url"] = document_url
        if page_number is not None:
            trace["page_number"] = page_number
        if trace_baseline is not _PDF_PROVENANCE_UNSET:
            trace["baseline"] = _pdf_provenance_value(trace_baseline)
        provenance[field] = trace


def _pdf_record_candidate_projection(
    sale: Any,
    field: str,
    candidate: dict[str, object] | None,
    *,
    fallback_evidence: str = "",
    payload_keys: tuple[str, ...] = (),
) -> None:
    candidate = candidate or {}
    _pdf_record_fact_projection(
        sale,
        [field],
        evidence=str(candidate.get("evidence") or fallback_evidence),
        document_url=str(candidate.get("document_url") or ""),
        page_number=candidate.get("page_number"),
        payload_keys=payload_keys,
    )


def _pdf_projection_scope_fields(fields: list[str] | tuple[str, ...] | set[str] | None) -> set[str] | None:
    if fields is None:
        return None
    selected: set[str] = set()
    for scope in fields:
        selected.update(_PDF_SCOPE_FIELDS.get(scope, {scope}))
    return selected


def _trace_derived_pdf_surface(sale: Any, provenance: dict[str, object]) -> set[str]:
    """Keep the displayed surface subject to its original PDF value proof."""
    app_surface = getattr(sale, "app_surface_m2", None)
    surface_traces = [
        trace
        for field, trace in provenance.items()
        if field in {"surface_m2", "habitable_surface_m2", "carrez_surface_m2"}
        and isinstance(trace, dict)
        and trace.get("source") == "pdf"
        and trace.get("value") is not None
    ]
    if app_surface is None or not surface_traces:
        return set()
    matching = next(
        (trace for trace in surface_traces if _pdf_values_match(app_surface, trace.get("value"))),
        None,
    )
    if matching is None:
        # A different displayed value has no proof of belonging to the old PDF.
        return {"app_surface_m2", "app_surface_kind"}
    missing = [field for field in ("app_surface_m2", "app_surface_kind") if field not in provenance]
    if missing:
        _pdf_record_fact_projection(sale, missing, candidate=matching)
    return set()


def _clear_pdf_derived_source_description(
    sale: Any,
    description_trace: dict[str, object] | None,
) -> None:
    """Drop a source-description projection that was built from PDF text.

    ``_finalize_sale_for_app`` caches ``source_description`` for downstream
    context.  When no source description exists, that cache can be the raw
    text with the PDF marker or the PDF-derived ``description`` itself.  It
    must not survive document replacement and become source evidence.
    """
    raw_payload = getattr(sale, "raw_payload", None)
    if not isinstance(raw_payload, dict):
        return
    value = raw_payload.get("source_description")
    if not isinstance(value, str):
        return
    marker_index = value.find(_PDF_TEXT_ENRICHMENT_MARKER)
    if marker_index >= 0:
        source_prefix = clean_text(value[:marker_index])
        if source_prefix:
            raw_payload["source_description"] = source_prefix
        else:
            raw_payload.pop("source_description", None)
        return
    if isinstance(description_trace, dict) and _pdf_values_match(value, description_trace.get("value")):
        raw_payload.pop("source_description", None)


def _document_texts_are_complete(
    pdf_texts: list[dict[str, object]] | list[str],
    *,
    sale: Any = None,
) -> bool:
    """Return true only when every supplied document is a complete pass."""
    if not pdf_texts:
        return False
    sale_documents = getattr(sale, "documents", None) if sale is not None else None
    sale_urls = {
        clean_text(item.get("url"))
        for item in sale_documents or []
        if isinstance(item, dict) and clean_text(item.get("url"))
    }
    payload_urls = {
        clean_text(item.get("url"))
        for item in pdf_texts
        if isinstance(item, dict) and clean_text(item.get("url"))
    }
    if sale_urls and payload_urls != sale_urls:
        return False
    for item in pdf_texts:
        if not isinstance(item, dict):
            if not clean_text(item):
                return False
            continue
        status = str(item.get("extraction_status") or "").strip().lower()
        if item.get("complete") is False or status in {"incomplete", "failed"}:
            return False
        if not clean_text(item.get("text")) and item.get("complete") is not True and status != "empty":
            pages = item.get("pages")
            if not isinstance(pages, list) or not any(
                isinstance(page, dict) and clean_text(page.get("text")) for page in pages
            ):
                return False
    return True


def _clear_pdf_fact_projections(
    sale: Any,
    *,
    fields: list[str] | tuple[str, ...] | set[str] | None = None,
) -> dict[str, set[str]]:
    """Remove unchanged stale PDF projections and restore trusted source facts."""
    raw_payload = getattr(sale, "raw_payload", None)
    if not isinstance(raw_payload, dict):
        return {"cleared": set(), "preserved": set()}
    provenance = raw_payload.get(_PDF_FACT_PROVENANCE_KEY)
    if not isinstance(provenance, dict):
        provenance = {}
    description_trace = provenance.get("description")
    description_trace = description_trace if isinstance(description_trace, dict) else None
    independent_derived_fields = _trace_derived_pdf_surface(sale, provenance)
    refreshed_provenance = raw_payload.get(_PDF_FACT_PROVENANCE_KEY)
    if isinstance(refreshed_provenance, dict):
        provenance = refreshed_provenance
    selected = _pdf_projection_scope_fields(fields)
    snapshot = raw_payload.get("source_factual_snapshot")
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    cleared: set[str] = set()
    preserved: set[str] = set(independent_derived_fields)
    removed_payload_keys: set[str] = set()
    retained_payload_keys: set[str] = set()
    remaining: dict[str, object] = {}
    for field, trace in provenance.items():
        if not isinstance(trace, dict):
            remaining[field] = trace
            continue
        if selected is not None and field not in selected:
            remaining[field] = trace
            retained_payload_keys.update(str(key) for key in (trace.get("payload_keys") or []))
            continue
        current = _pdf_get_projected_value(sale, field)
        if not _pdf_values_match(current, trace.get("value")):
            # The value was independently corrected after the PDF pass.
            remaining[field] = trace
            preserved.add(field)
            retained_payload_keys.update(str(key) for key in (trace.get("payload_keys") or []))
            continue
        if field in snapshot:
            source_value = snapshot[field]
        elif "baseline" in trace:
            source_value = trace["baseline"]
        else:
            source_value = None
        _pdf_set_projected_value(sale, field, source_value)
        cleared.add(field)
        removed_payload_keys.update(str(key) for key in (trace.get("payload_keys") or []))
    for key in removed_payload_keys - retained_payload_keys:
        raw_payload.pop(key, None)
    if selected is None or "description" in selected:
        _clear_pdf_derived_source_description(sale, description_trace)
    if remaining:
        raw_payload[_PDF_FACT_PROVENANCE_KEY] = remaining
    else:
        raw_payload.pop(_PDF_FACT_PROVENANCE_KEY, None)
    # Rows written before the per-field trace existed may still carry a
    # single PDF candidate list. Treat a matching scalar as stale only when
    # the trusted source snapshot has no independent value to restore.
    for field, candidate_key in _PDF_LEGACY_SCALAR_FIELDS.items():
        if field in provenance:
            continue
        if selected is not None and field not in selected:
            continue
        candidates = raw_payload.get(candidate_key)
        if not isinstance(candidates, list) or not candidates:
            continue
        values = { _pdf_provenance_value(item.get("value")) for item in candidates if isinstance(item, dict) }
        current = getattr(sale, field, None)
        if len(values) != 1 or not _pdf_values_match(current, next(iter(values))):
            continue
        _pdf_set_projected_value(sale, field, snapshot[field] if field in snapshot else None)
        raw_payload.pop(candidate_key, None)
        cleared.add(field)
    return {"cleared": cleared, "preserved": preserved}


def _apply_pdf_textual_facts(
    sale: Any,
    combined: str,
    *,
    property_type_extractor: Callable[[str], object | None],
    description_extractor: Callable[[str], object | None],
    risk_notes_extractor: Callable[[str], object | None],
    risk_notes_merger: Callable[..., str | None],
    energy_risk_note_extractor: Callable[[dict[str, object]], str | None],
    energy_diagnostics: dict[str, object] | None,
) -> None:
    """Project PDF text fields while retaining their pre-PDF baselines."""
    if not sale.property_type or sale.property_type == "other":
        previous = sale.property_type
        value = property_type_extractor(combined)
        if value:
            sale.property_type = value
            _pdf_record_fact_projection(
                sale, ["property_type"], evidence=combined[:600],
                baseline=previous, previous_value=previous,
            )
    if not sale.description:
        previous = sale.description
        value = description_extractor(combined)
        if value:
            sale.description = value
            _pdf_record_fact_projection(
                sale, ["description"], evidence=combined[:600],
                baseline=previous, previous_value=previous,
            )
    risk_notes = risk_notes_extractor(combined)
    if energy_diagnostics:
        risk_notes = risk_notes_merger(risk_notes, energy_risk_note_extractor(energy_diagnostics))
    if risk_notes:
        previous = sale.risk_notes
        value = clean_text(" | ".join(filter(None, [previous, risk_notes])))
        if value != previous:
            sale.risk_notes = value
            _pdf_record_fact_projection(
                sale, ["risk_notes"], evidence=combined[:600],
                baseline=previous, previous_value=previous,
            )


def _pdf_lot_scope_labels(text: str) -> set[str]:
    """Extract explicit unit labels without treating ordinary room counts as lots."""
    normalized = strip_accents(text or "").lower()
    labels: set[str] = set()
    token = r"([a-z]{0,2}\d{1,4}[a-z]?)"
    for match in re.finditer(rf"\blots?\s*(?:n[°ºo.]?\s*)?{token}\b", normalized, re.I):
        labels.add(f"lot:{match.group(1).lower()}")
    # ``lots 5 et 8`` is common cadastral wording and the second number is
    # not preceded by the word lot.  Capture only a short list following the
    # explicit plural label, never an arbitrary year or page number.
    for match in re.finditer(
        rf"\blots?\s*(?:n[°ºo.]?\s*)?{token}(?:\s*(?:,|et|/|&)\s*(?:lot\s*)?(?:n[°ºo.]?\s*)?{token})+\b",
        normalized,
        re.I,
    ):
        labels.add(f"lot:{match.group(1).lower()}")
        labels.add(f"lot:{match.group(2).lower()}")
    for match in re.finditer(rf"\b(?:unit[eé]|b[aâ]timent)\s*(?:n[°ºo.]?\s*)?{token}\b", normalized, re.I):
        labels.add(f"unit:{match.group(1).lower()}")
    # Apartment/logement letters and explicitly numbered units are safe labels;
    # avoid reading ``appartement de 3 pièces`` as unit 3.
    for match in re.finditer(
        r"\b(?:appartement|logement)\s+(?:n[°ºo.]?\s*)?([a-z]|\d{1,3})\b",
        normalized,
        re.I,
    ):
        before = normalized[max(0, match.start() - 12) : match.start()]
        if re.search(r"\bde\s*$", before) and match.group(1).isdigit():
            continue
        labels.add(f"unit:{match.group(1).lower()}")
    return labels


def _pdf_lot_scope_spans(text: str) -> list[tuple[str, int, int]]:
    normalized = strip_accents(text or "").lower()
    spans: list[tuple[str, int, int]] = []
    token = r"([a-z]{0,2}\d{1,4}[a-z]?)"
    for match in re.finditer(rf"\blots?\s*(?:n[°ºo.]?\s*)?{token}\b", normalized, re.I):
        spans.append((f"lot:{match.group(1).lower()}", match.start(), match.end()))
    for match in re.finditer(rf"\b(?:unit[eé]|b[aâ]timent)\s*(?:n[°ºo.]?\s*)?{token}\b", normalized, re.I):
        spans.append((f"unit:{match.group(1).lower()}", match.start(), match.end()))
    for match in re.finditer(
        r"\b(?:appartement|logement)\s+(?:n[°ºo.]?\s*)?([a-z]|\d{1,3})\b",
        normalized,
        re.I,
    ):
        before = normalized[max(0, match.start() - 12) : match.start()]
        after = normalized[match.end() : match.end() + 12]
        if (re.search(r"\bde\s*$", before) and match.group(1).isdigit()) or re.search(
            r"^\s*pi[eè]ces?\b", after
        ):
            continue
        spans.append((f"unit:{match.group(1).lower()}", match.start(), match.end()))
    return spans


def _pdf_scope_labels_near_value(evidence: str, value: object) -> set[str]:
    labels = _pdf_lot_scope_spans(evidence)
    if len(labels) <= 1:
        return {item[0] for item in labels}
    value_text = str(value)
    value_match = re.search(rf"(?<!\d){re.escape(value_text).replace('.', r'[,.]')}(?!\d)", evidence)
    if value_match is None:
        return {item[0] for item in labels}
    position = value_match.start()
    before = [item for item in labels if item[1] <= position and position - item[2] <= 120]
    if before:
        return {max(before, key=lambda item: item[2])[0]}
    after = [item for item in labels if item[1] > position and item[1] - position <= 45]
    if after:
        return {min(after, key=lambda item: item[1])[0]}
    return {item[0] for item in labels}


def _pdf_has_multiple_units(text: str, *, candidate_count: int = 0) -> bool:
    labels = _pdf_lot_scope_labels(text)
    if len(labels) >= 2:
        return True
    normalized = strip_accents(text or "").lower()
    if re.search(
        r"\b(?:deux|2|plusieurs|diff[eé]rents?)\s+(?:lots?|unit[eé]s?|appartements?|logements?)\b",
        normalized,
    ):
        return candidate_count >= 2
    return False


def _pdf_clear_aggregate_scope(text: str, *, field: str) -> bool:
    normalized = strip_accents(text or "").lower()
    if field in {"surface", "land", "rooms", "bedrooms"} and re.search(
        r"\b(?:surface|superficie)\s+(?:privative\s+|habitable\s+|loi\s+carrez\s+)?totale\b|"
        r"\b(?:total|totale|totalement|au\s+total|cumul(?:e|ee)?)\b[^.\n]{0,80}\b(?:m\s*(?:2|²)|pi[eè]ces?|chambres?)\b|"
        r"\b(?:en\s+un\s+seul\s+lot|vendu(?:s|es)?\s+ensemble|vendu(?:s|es)?\s+en\s+bloc|"
        r"ensemble\s+immobilier|lots?[^.\n]{0,80}(?:formant\s+un\s+ensemble|r[eé]unis?|communicants?|indissociables?))\b",
        normalized,
    ):
        return True
    if field == "occupancy" and re.search(
        r"\b(?:tous|toutes|l[' ]ensemble\s+des)\s+(?:lots?|unit[eé]s?|appartements?|logements?)\b[^.\n]{0,100}\b(?:libre|occup[eé]|lou[eé]|vacant|squatt)",
        normalized,
    ):
        return True
    return False


def _pdf_candidate_scope_labels(candidate: dict[str, object]) -> set[str]:
    labels = candidate.get("lot_labels")
    if isinstance(labels, list):
        return {str(item) for item in labels if item}
    return _pdf_lot_scope_labels(str(candidate.get("evidence") or ""))


def _pdf_scalar_scope_is_ambiguous(
    text: str,
    candidates: list[dict[str, object]],
    *,
    field: str,
) -> bool:
    """Refuse sale-level projection when scalar evidence belongs to unknown lots."""
    if not candidates or not _pdf_has_multiple_units(text, candidate_count=len(candidates)):
        return False
    labels = _pdf_lot_scope_labels(text)
    if _pdf_clear_aggregate_scope(text, field=field):
        return False
    if labels and any(labels <= _pdf_candidate_scope_labels(item) for item in candidates):
        # One explicitly labelled candidate covers every unit in the document;
        # this is an aggregate statement rather than an arbitrary first match.
        return False
    # Occupancy and diagnostics are never additive.  A single local statement
    # must not become the sale-wide value merely because another lot is present.
    return True


def _pdf_candidate_payload(candidate: dict[str, object]) -> dict[str, object]:
    payload: dict[str, object] = {}
    for key, value in candidate.items():
        if isinstance(value, Decimal):
            payload[key] = float(value)
        elif isinstance(value, set):
            payload[key] = sorted(value)
        else:
            payload[key] = value
    return payload


def _pdf_add_candidate_scope(candidate: dict[str, object], *, text: str | None = None) -> dict[str, object]:
    evidence = str(candidate.get("evidence") or "")
    labels = _pdf_scope_labels_near_value(evidence, candidate.get("value")) if candidate.get("value") is not None else _pdf_lot_scope_labels(evidence)
    if not labels and text:
        labels = _pdf_lot_scope_labels(text)
    candidate["lot_labels"] = sorted(labels)
    return candidate

def _pdf_surface_candidates_with_provenance(
    pdf_texts: list[dict[str, object]] | list[str],
    *,
    surface_extractor: Callable[[str], list[dict[str, Decimal | str]]],
    land_surface_extractor: Callable[[str], list[dict[str, Decimal | str]]],
    surface_scope_extractor: Callable[[str, str], str],
    land: bool = False,
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    chunks = _pdf_text_chunks(pdf_texts)
    document_scope_parts = [str(item.get("text") or "") for item in chunks]
    document_scope_parts.extend(
        str(item.get("text") or "") for item in pdf_texts if isinstance(item, dict) and item.get("text")
    )
    document_scope_text = "\n\n".join(document_scope_parts)
    for chunk in chunks:
        text = str(chunk.get("text") or "")
        extracted = (
            land_surface_extractor(text)
            if land
            else surface_extractor(text)
        )
        for surface in extracted:
            candidate: dict[str, object] = {
                "value": surface["value"],
                "evidence": str(surface["evidence"]),
                "document_label": chunk.get("document_label") or "",
                "document_url": chunk.get("document_url") or "",
                "document_type": chunk.get("document_type") or "pdf",
                "page_number": chunk.get("page_number"),
                "page_confidence": chunk.get("page_confidence"),
                "extraction_method": chunk.get("extraction_method"),
            }
            if not land:
                candidate["surface_scope"] = surface_scope_extractor(
                    f"{text}\n{document_scope_text}",
                    str(surface["evidence"]),
                )
            _pdf_add_candidate_scope(candidate, text=str(surface["evidence"]))
            candidates.append(candidate)
    return _dedupe_pdf_candidates(candidates)


def _document_surface_candidates(
    item: dict[str, object],
    text: str,
    *,
    surface_extractor: Callable[[str], list[dict[str, Decimal | str]]],
    surface_scope_extractor: Callable[[str, str], str],
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    pages = item.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_text = str(page.get("text") or "")
            if not page_text:
                continue
            for surface in surface_extractor(page_text):
                surface["surface_scope"] = surface_scope_extractor(
                    f"{page_text}\n{text}", str(surface["evidence"])
                )
                surface["page_number"] = page.get("page")
                surface["page_confidence"] = page.get("confidence")
                surface["extraction_method"] = page.get("method")
                candidates.append(surface)
    if not candidates:
        for surface in surface_extractor(text):
            surface["surface_scope"] = surface_scope_extractor(text, str(surface["evidence"]))
            candidates.append(surface)
    return candidates


def _document_land_surface_candidates(
    item: dict[str, object],
    text: str,
    *,
    land_surface_extractor: Callable[[str], list[dict[str, Decimal | str]]],
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    pages = item.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_text = str(page.get("text") or "")
            if not page_text:
                continue
            for surface in land_surface_extractor(page_text):
                surface["page_number"] = page.get("page")
                surface["page_confidence"] = page.get("confidence")
                surface["extraction_method"] = page.get("method")
                candidates.append(surface)
    if not candidates:
        candidates.extend(land_surface_extractor(text))
    return candidates


def _dedupe_pdf_candidates(candidates: list[dict[str, object]]) -> list[dict[str, object]]:
    unique: list[dict[str, object]] = []
    seen: set[tuple[str, str, str, object, object]] = set()
    for candidate in candidates:
        value = candidate.get("value")
        if isinstance(value, Decimal):
            value_key = str(value)
        else:
            value_key = str(value)
        key = (
            value_key,
            _normalize_document_classifier_text(str(candidate.get("evidence") or "")),
            str(candidate.get("document_url") or candidate.get("document_label") or ""),
            candidate.get("page_number"),
            tuple(candidate.get("lot_labels") or []),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def _aggregate_pdf_surface_candidates(
    candidates: list[dict[str, object]],
    *,
    text: str,
    land: bool,
) -> dict[str, object] | None:
    """Build a sale total only when a document explicitly binds its lots together."""
    if not _pdf_clear_aggregate_scope(text, field="land" if land else "surface"):
        return None
    labels = _pdf_lot_scope_labels(text)
    if len(labels) < 2:
        return None
    # Prefer an explicit total.  Individual lot measurements are used only if
    # every lot has its own evidence and no aggregate value is stated.
    explicit_totals = [
        item
        for item in candidates
        if re.search(
            r"\b(?:surface|superficie)\s+(?:privative\s+|habitable\s+|loi\s+carrez\s+)?totale\b|"
            r"\b(?:total|au\s+total|cumul(?:e|ee)?)\b[^.\n]{0,80}\b(?:m\s*(?:2|²)|ha|ares?|centiares?)\b",
            str(item.get("evidence") or ""),
            re.I,
        )
    ]
    if explicit_totals:
        return max(explicit_totals, key=lambda item: int(item.get("rank") or 0))

    by_label: dict[str, dict[str, object]] = {}
    for candidate in candidates:
        candidate_labels = _pdf_candidate_scope_labels(candidate)
        if len(candidate_labels) != 1:
            continue
        label = next(iter(candidate_labels))
        if label not in labels:
            continue
        current = by_label.get(label)
        if current is None or int(candidate.get("rank") or 0) > int(current.get("rank") or 0):
            by_label[label] = candidate
    if set(by_label) != labels:
        return None
    total = sum(
        (
            item.get("value") if isinstance(item.get("value"), Decimal) else Decimal(str(item.get("value")))
            for item in by_label.values()
        ),
        Decimal("0"),
    )
    if total <= 0:
        return None
    first = next(iter(by_label.values()))
    evidence = " + ".join(str(item.get("evidence") or "") for item in by_label.values())
    aggregate = dict(first)
    aggregate.update(
        {
            "value": total,
            "evidence": clean_text(f"Lots vendus ensemble : {evidence}") or evidence,
            "lot_labels": sorted(labels),
            "aggregate": True,
            "aggregate_sources": [_pdf_candidate_payload(item) for item in by_label.values()],
            "rank": max(int(item.get("rank") or 0) for item in by_label.values()) + 1,
        }
    )
    return aggregate


_PDF_COUNT_TOKEN = r"([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)"
_PDF_COUNT_WORDS = {
    "un": 1,
    "une": 1,
    "deux": 2,
    "trois": 3,
    "quatre": 4,
    "cinq": 5,
    "six": 6,
    "sept": 7,
    "huit": 8,
    "neuf": 9,
    "dix": 10,
}


def _pdf_count_token(value: str) -> int | None:
    value = value.strip().lower()
    if value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return _PDF_COUNT_WORDS.get(value)


def _pdf_scalar_candidate(
    value: object,
    evidence: str,
    chunk: dict[str, object],
) -> dict[str, object]:
    candidate: dict[str, object] = {
        "value": value,
        "evidence": clean_text(evidence) or "",
        "document_label": chunk.get("document_label") or "",
        "document_url": chunk.get("document_url") or "",
        "document_type": chunk.get("document_type") or "pdf",
        "page_number": chunk.get("page_number"),
        "page_confidence": chunk.get("page_confidence"),
        "extraction_method": chunk.get("extraction_method"),
    }
    return _pdf_add_candidate_scope(candidate)


def _pdf_is_rooms_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 50) : min(len(text), end + 50)]
    return bool(re.search(r"\barticle\b|\bpage\b|\blot\s+n", context, re.I))


def _extract_rooms_count_candidates(text: str, *, chunk: dict[str, object] | None = None) -> list[dict[str, object]]:
    chunk = chunk or {"document_type": "pdf"}
    candidates: list[dict[str, object]] = []
    for match in re.finditer(r"\bstudio\b", text, re.I):
        if _pdf_is_rooms_false_positive(text, match.start(), match.end()):
            continue
        candidates.append(
            _pdf_scalar_candidate(
                1,
                text[max(0, match.start() - 40) : min(len(text), match.end() + 60)],
                chunk,
            )
        )
    patterns = (
        rf"\bnombre\s+de\s+pi[eè]ces?\s*(?:principales?)?\s*:?\s*{_PDF_COUNT_TOKEN}\b",
        rf"\b{_PDF_COUNT_TOKEN}\s*pi[eè]ces?\s*(?:principales?)?\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            token = match.group(1)
            value = _pdf_count_token(token)
            if value is None or _pdf_is_rooms_false_positive(text, match.start(1), match.end(1)):
                continue
            candidates.append(
                _pdf_scalar_candidate(
                    value,
                    text[max(0, match.start() - 40) : min(len(text), match.end() + 60)],
                    chunk,
                )
            )
    return _dedupe_scalar_candidates(candidates)


def _extract_bedrooms_count_candidates(text: str, *, chunk: dict[str, object] | None = None) -> list[dict[str, object]]:
    chunk = chunk or {"document_type": "pdf"}
    candidates: list[dict[str, object]] = []
    patterns = (
        rf"\b[1-9][0-9]?\s*pi[eè]ces?\s+{_PDF_COUNT_TOKEN}\s*chambres?\b",
        rf"\b{_PDF_COUNT_TOKEN}\s*chambres?\b",
        rf"\bchambres?\s*:?\s*{_PDF_COUNT_TOKEN}\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            token = match.group(1)
            value = _pdf_count_token(token)
            if value is None or _pdf_is_rooms_false_positive(text, match.start(1), match.end(1)):
                continue
            candidates.append(
                _pdf_scalar_candidate(
                    value,
                    text[max(0, match.start() - 40) : min(len(text), match.end() + 60)],
                    chunk,
                )
            )
    return _dedupe_scalar_candidates(candidates)


def _extract_occupancy_candidates(
    text: str,
    *,
    chunk: dict[str, object] | None = None,
    occupancy_extractor: Callable[[str], str | None] | None = None,
) -> list[dict[str, object]]:
    chunk = chunk or {"document_type": "pdf"}
    candidates: list[dict[str, object]] = []
    pieces = [part for part in re.split(r"[\n\r.;]+", text) if clean_text(part)]
    if not pieces:
        pieces = [text]
    for piece in pieces:
        status = occupancy_extractor(piece) if occupancy_extractor else _pdf_default_occupancy_status(piece)
        if status:
            candidates.append(_pdf_scalar_candidate(status, piece, chunk))
    if not candidates:
        status = occupancy_extractor(text) if occupancy_extractor else _pdf_default_occupancy_status(text)
        if status:
            candidates.append(_pdf_scalar_candidate(status, text[:300], chunk))
    return _dedupe_scalar_candidates(candidates)


def _pdf_default_occupancy_status(text: str) -> str | None:
    lowered = strip_accents(text).lower()
    no_lease_status = no_lease_occupancy_status(lowered)
    if re.search(r"sans\s+droit\s+ni\s+titre|squatt?\w*", lowered):
        return "squatted"
    if re.search(r"\b(?:proprietaire\s+occupant|occupe(?:e?s?|s)?|locataire|loyer\s+mensuel)\b", lowered):
        if no_lease_status:
            return no_lease_status
        return "rented" if has_rented_occupancy_signal(lowered) else "occupied"
    if re.search(r"\blibre(?:s)?\s+(?:de\s+toute\s+occupation|d['’]occupation)\b|\binoccupe(?:e?s?|s?)\b|\bvacant(?:e?s?)?\b", lowered):
        return "vacant"
    return no_lease_status or ("occupied" if re.search(r"\boccupe(?:e?s?|s)?\b", lowered) else None)


def _dedupe_scalar_candidates(candidates: list[dict[str, object]]) -> list[dict[str, object]]:
    unique: list[dict[str, object]] = []
    seen: set[tuple[str, str, str, object]] = set()
    for candidate in candidates:
        key = (
            str(candidate.get("value")),
            _normalize_document_classifier_text(str(candidate.get("evidence") or "")),
            str(candidate.get("document_url") or candidate.get("document_label") or ""),
            candidate.get("page_number"),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def _pdf_count_has_explicit_total(candidate: dict[str, object], *, field: str) -> bool:
    value = candidate.get("value")
    try:
        numeric_value = int(value)
    except (TypeError, ValueError):
        return False
    value_tokens = [str(numeric_value)]
    value_tokens.extend(word for word, number in _PDF_COUNT_WORDS.items() if number == numeric_value)
    value_expression = "(?:" + "|".join(re.escape(token) for token in value_tokens) + ")"
    label = r"pi[eè]ces?" if field == "rooms" else r"chambres?"
    evidence = str(candidate.get("evidence") or "")
    return any(
        re.search(pattern, evidence, re.I)
        for pattern in (
            rf"\b{value_expression}\s*{label}\b[^.;:\n]{{0,16}}\b(?:au\s+total|total(?:e|es)?)\b",
            rf"\b(?:au\s+total|total(?:e|es)?(?:\s+de|\s*:)?)\s*{value_expression}\s*{label}\b",
        )
    )


def _pdf_scalar_candidates_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
    extractor: Callable[..., list[dict[str, object]]],
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for chunk in _pdf_text_chunks(pdf_texts):
        candidates.extend(extractor(str(chunk.get("text") or ""), chunk=chunk))
    return _dedupe_scalar_candidates(candidates)


def _aggregate_pdf_count_candidates(
    candidates: list[dict[str, object]],
    *,
    text: str,
    field: str,
) -> dict[str, object] | None:
    if not _pdf_clear_aggregate_scope(text, field=field):
        return None
    labels = _pdf_lot_scope_labels(text)
    if len(labels) < 2:
        return None
    explicit_total = [
        candidate for candidate in candidates if _pdf_count_has_explicit_total(candidate, field=field)
    ]
    if explicit_total:
        return explicit_total[0]
    by_label: dict[str, dict[str, object]] = {}
    for candidate in candidates:
        candidate_labels = _pdf_candidate_scope_labels(candidate)
        if len(candidate_labels) != 1:
            continue
        label = next(iter(candidate_labels))
        if label in labels and label not in by_label:
            by_label[label] = candidate
    if set(by_label) != labels:
        return None
    total = sum(int(item.get("value") or 0) for item in by_label.values())
    if total <= 0:
        return None
    first = next(iter(by_label.values()))
    aggregate = dict(first)
    aggregate.update(
        {
            "value": total,
            "evidence": clean_text(" + ".join(str(item.get("evidence") or "") for item in by_label.values())) or "",
            "lot_labels": sorted(labels),
            "aggregate": True,
            "aggregate_sources": [_pdf_candidate_payload(item) for item in by_label.values()],
        }
    )
    return aggregate


def _energy_diagnostic_candidates_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
    *,
    diagnostic_extractor: Callable[[str], dict[str, object] | None],
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            for diagnostic in _energy_diagnostics_from_text_chunks(str(item or ""), diagnostic_extractor):
                diagnostic.update(
                    {
                        "document_label": "",
                        "document_url": "",
                        "document_type": "pdf",
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": "text",
                    }
                )
                _pdf_add_candidate_scope(diagnostic)
                candidates.append(diagnostic)
            continue
        item_candidates: list[dict[str, object]] = []
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                page_text = str(page.get("text") or "")
                for diagnostic in _energy_diagnostics_from_text_chunks(page_text, diagnostic_extractor):
                    diagnostic.update(
                        {
                            "document_label": label,
                            "document_url": clean_text(item.get("url")) or "",
                            "document_type": document_type,
                            "page_number": page.get("page"),
                            "page_confidence": page.get("confidence"),
                            "extraction_method": page.get("method") or item.get("extraction_method"),
                        }
                    )
                    _pdf_add_candidate_scope(diagnostic)
                    item_candidates.append(diagnostic)
        # A top-level aggregate (for example Docling output) is useful only
        # when no page in this same document produced a diagnostic. The old
        # global ``if not candidates`` condition meant that the first document
        # suppressed top-level evidence from every later document.
        if not item_candidates:
            for diagnostic in _energy_diagnostics_from_text_chunks(
                str(item.get("text") or ""), diagnostic_extractor
            ):
                diagnostic.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                _pdf_add_candidate_scope(diagnostic)
                item_candidates.append(diagnostic)
        candidates.extend(item_candidates)
    return _dedupe_energy_candidates(candidates)


def _energy_diagnostics_from_text_chunks(
    text: str,
    diagnostic_extractor: Callable[[str], dict[str, object] | None],
) -> list[dict[str, object]]:
    """Keep separate DPE records when one page lists multiple units."""
    if not clean_text(text):
        return []
    scoped_chunks = [
        part
        for part in re.split(
            r"(?=\b(?:lots?|unit[eé]|b[aâ]timent)\s*(?:n[°ºo.]?\s*)?[a-z]?\d*[a-z]?\b)",
            text,
            flags=re.I,
        )
        if clean_text(part)
    ]
    if len(scoped_chunks) >= 2:
        diagnostics = [diagnostic_extractor(part) for part in scoped_chunks]
        diagnostics = [item for item in diagnostics if item]
        if len(diagnostics) >= 2:
            return diagnostics
    whole = diagnostic_extractor(text)
    return [whole] if whole else []


def _dedupe_energy_candidates(candidates: list[dict[str, object]]) -> list[dict[str, object]]:
    unique: list[dict[str, object]] = []
    seen: set[tuple[object, ...]] = set()
    for candidate in candidates:
        key = (
            candidate.get("dpe_class"),
            candidate.get("ges_class"),
            candidate.get("energy_consumption_kwh_m2_year"),
            candidate.get("emissions_kg_co2_m2_year"),
            str(candidate.get("document_url") or candidate.get("document_label") or ""),
            candidate.get("page_number"),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def _energy_diagnostics_are_ambiguous(
    pdf_texts: list[dict[str, object]] | list[str],
    candidates: list[dict[str, object]],
    *,
    scope_text: str | None = None,
) -> bool:
    text = scope_text or "\n\n".join(str(item.get("text") or "") for item in _pdf_text_chunks(pdf_texts))
    if _pdf_scalar_scope_is_ambiguous(text, candidates, field="energy"):
        return True
    # Two diagnostics with different values are competing evidence even when
    # the OCR omitted the lot labels.  Complementary records (DPE-only plus
    # GES-only) remain merge-compatible and retain the existing rank policy.
    for key in (
        "dpe_class",
        "ges_class",
        "energy_consumption_kwh_m2_year",
        "emissions_kg_co2_m2_year",
    ):
        values = {candidate.get(key) for candidate in candidates if candidate.get(key) is not None}
        if len(values) > 1:
            return True
    return False
