from __future__ import annotations

import re
from collections.abc import Callable
from decimal import Decimal

from src.normalize import clean_text, has_rented_occupancy_signal, no_lease_occupancy_status, strip_accents
from src.pdf_document_types import _canonical_document_type, _normalize_document_classifier_text

_PDF_SCALAR_CANDIDATE_KEYS = (
    "pdf_surface_candidates",
    "pdf_land_surface_candidates",
    "pdf_rooms_candidates",
    "pdf_bedrooms_candidates",
    "pdf_occupancy_candidates",
    "pdf_energy_diagnostics_candidates",
)


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
        candidate
        for candidate in candidates
        if re.search(r"\b(?:total|au\s+total)\b", str(candidate.get("evidence") or ""), re.I)
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
