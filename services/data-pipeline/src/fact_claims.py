"""Build immutable, source-backed fact candidates for auction sales.

The catalogue fields are still the operational read model.  This module only
emits an append-only observation for a value when the incoming source payload
contains field-level evidence that can be pointed back to the exact source
URL.  Document/PDF evidence must carry its own document URL; the listing URL
is never substituted for a missing document URL.  A candidate is deliberately
never promoted to ``accepted`` here.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime
from uuid import UUID, uuid5

from src.models import AuctionSale
from src.normalize import clean_text, normalize_occupancy_status, parse_french_datetime, parse_price, parse_surface

# The identity already includes source_url and evidence_locator.  Corrected
# document claims receive a new UUID without duplicating unchanged v2 claims.
FACT_CLAIMS_VERSION = "auction_fact_claims_v2"
FACT_CLAIMS_EXTRACTOR = "immojudis.pipeline.fact_claims"
FACT_CLAIMS_NAMESPACE = UUID("b9866b5e-df4e-4cf4-a7f5-d43cc50a4b73")

_KNOWN_OCCUPANCY = {"vacant", "occupied", "rented", "owner_occupied", "squatted"}

_FIELD_SPECS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "sale.sale_date",
        "sale_date",
        (
            "sale_date",
            "date_vente",
            "date_de_vente",
            "vente_le",
            "detail_vente_le",
            "audience",
            "ouverture_date",
        ),
    ),
    (
        "sale.starting_price_eur",
        "starting_price_eur",
        (
            "starting_price_eur",
            "starting_price",
            "mise_a_prix",
            "detail_mise_a_prix",
            "mise_a_prix_initiale",
            "prix_plancher",
        ),
    ),
    (
        "property.surface_m2",
        "surface_m2",
        (
            "surface_m2",
            "surface",
            "superficie",
            "surface_totale",
            "surface_batie",
            "surface_bati",
        ),
    ),
    (
        "property.habitable_surface_m2",
        "habitable_surface_m2",
        (
            "habitable_surface_m2",
            "surface_habitable",
            "surface_habitable_m2",
            "surface_habitable_totale",
        ),
    ),
    (
        "property.carrez_surface_m2",
        "carrez_surface_m2",
        (
            "carrez_surface_m2",
            "surface_carrez",
            "surface_loi_carrez",
            "loi_carrez",
        ),
    ),
    (
        "property.land_surface_m2",
        "land_surface_m2",
        (
            "land_surface_m2",
            "surface_terrain",
            "surface_du_terrain",
            "surface_parcelle",
            "critere_surface_terrain",
        ),
    ),
    (
        "property.occupancy_status",
        "occupancy_status",
        (
            "occupancy_status",
            "occupation",
            "situation_locative",
            "situation_locative_du_bien",
            "critere_occupation_du_bien",
        ),
    ),
)

_NUMERIC_FIELDS = {
    "starting_price_eur",
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
}

_SURFACE_FIELDS = {
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
}

# The final item is an optional source URL override.  It is populated for
# document evidence so the claim points at the document that contains the
# quote, rather than at the listing that linked to that document.
_Provenance = tuple[str, dict[str, object], float, object | None, str | None]


def build_fact_claim_candidates(sale: AuctionSale) -> list[dict[str, object]]:
    """Return source-scoped candidates for ``sale``.

    ``observations`` are included because deduplication can keep one canonical
    row while retaining source-specific payloads from other publishers.  The
    same candidate can be encountered twice; deterministic materialization
    later collapses exact duplicates by UUID.
    """
    candidates: list[dict[str, object]] = []
    for snapshot in _source_snapshots(sale):
        source_url = snapshot["source_url"]
        payload = snapshot["payload"]
        source_name = snapshot["source_name"]
        if not isinstance(source_url, str) or not source_url.startswith("https://"):
            continue
        if not isinstance(payload, dict):
            payload = {}
        for field_key, value_key, aliases in _FIELD_SPECS:
            for evidence_kind, locator, confidence, evidence_value, evidence_source_url in _field_provenances(
                value_key, aliases, payload
            ):
                candidate_value = _normalized_value(value_key, evidence_value)
                if candidate_value is None:
                    continue
                candidate_source_url = evidence_source_url or source_url
                if (
                    not isinstance(candidate_source_url, str)
                    or not candidate_source_url.startswith("https://")
                ):
                    continue
                candidates.append(
                    {
                        "field_key": field_key,
                        "value_jsonb": candidate_value,
                        "evidence_kind": evidence_kind,
                        "source_url": candidate_source_url,
                        "evidence_locator": {
                            "source_name": source_name,
                            "field": value_key,
                            **(
                                {"listing_source_url": source_url}
                                if evidence_kind == "source_document" and source_url != candidate_source_url
                                else {}
                            ),
                            **locator,
                        },
                        "confidence_score": confidence,
                        "extractor_name": FACT_CLAIMS_EXTRACTOR,
                        "extractor_version": FACT_CLAIMS_VERSION,
                    }
                )
    return _deduplicate_candidates(candidates)


def materialize_fact_claim_rows(
    sale: AuctionSale,
    auction_sale_id: str,
) -> list[dict[str, object]]:
    """Add a stable claim UUID and the canonical sale target to candidates."""
    try:
        normalized_sale_id = str(UUID(str(auction_sale_id)))
    except (TypeError, ValueError, AttributeError):
        return []
    rows: list[dict[str, object]] = []
    for candidate in build_fact_claim_candidates(sale):
        identity = json.dumps(
            {
                "version": FACT_CLAIMS_VERSION,
                "auction_sale_id": normalized_sale_id,
                "field_key": candidate["field_key"],
                "value_jsonb": candidate["value_jsonb"],
                "source_url": candidate["source_url"],
                "evidence_locator": candidate["evidence_locator"],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        rows.append(
            {
                "id": str(uuid5(FACT_CLAIMS_NAMESPACE, identity)),
                "auction_sale_id": normalized_sale_id,
                "field_key": candidate["field_key"],
                "value_jsonb": candidate["value_jsonb"],
                "claim_status": "candidate",
                "evidence_kind": candidate["evidence_kind"],
                "source_url": candidate["source_url"],
                "evidence_locator": candidate["evidence_locator"],
                "confidence_score": candidate["confidence_score"],
                "extractor_name": candidate["extractor_name"],
                "extractor_version": candidate["extractor_version"],
            }
        )
    return rows


def _source_snapshots(sale: AuctionSale) -> list[dict[str, object]]:
    snapshots: list[dict[str, object]] = [
        {
            "source_name": sale.source_name,
            "source_url": sale.source_url,
            "payload": sale.raw_payload if isinstance(sale.raw_payload, dict) else {},
        }
    ]
    for observation in sale.observations or []:
        if not isinstance(observation, dict):
            continue
        source_url = clean_text(observation.get("source_url"))
        if not source_url:
            continue
        payload = observation.get("raw_payload")
        payload = dict(payload) if isinstance(payload, dict) else {}
        values = {
            key: observation.get(key)
            for _, key, _ in _FIELD_SPECS
            if observation.get(key) is not None
        }
        # The compact observation row is the latest source-level snapshot.
        # Let its explicit scalar win over a stale embedded raw payload when a
        # refreshed observation reuses the same source URL.
        for key, value in values.items():
            payload[key] = value
        snapshots.append(
            {
                "source_name": clean_text(observation.get("source_name")) or "unknown",
                "source_url": source_url,
                "payload": payload,
        }
        )
    return snapshots


def _normalized_value(field: str, fallback: object) -> object | None:
    # Only use a scalar carried by the evidence path itself.  Falling back to
    # the canonical sale value would attach a value extracted from another
    # source or observation to this source URL's quote.
    raw_value = fallback
    if not _has_value(raw_value):
        return None
    if field == "sale_date":
        parsed = raw_value if isinstance(raw_value, datetime) else parse_french_datetime(raw_value)
        return parsed.isoformat() if parsed is not None else None
    if field in _NUMERIC_FIELDS:
        parsed = parse_price(raw_value) if field == "starting_price_eur" else parse_surface(raw_value)
        if parsed is None or parsed <= 0:
            return None
        return float(parsed)
    if field == "occupancy_status":
        normalized = normalize_occupancy_status(raw_value)
        return normalized if normalized in _KNOWN_OCCUPANCY else None
    return clean_text(raw_value)


def _field_provenances(
    field: str,
    aliases: tuple[str, ...],
    payload: dict[str, object],
) -> list[_Provenance]:
    provenances: list[_Provenance] = []
    if _has_value(payload.get(field)):
        provenances.append(
            (
                "source_listing",
                {"kind": "source_field", "quote": _quote(payload.get(field))},
                0.92,
                payload.get(field),
                None,
            )
        )

    normalized_aliases = {_normalize_key(alias) for alias in aliases}
    for path, key, value in _walk_values(payload.get("source_blocks")):
        if _normalize_key(key) not in normalized_aliases or not _has_value(value):
            continue
        provenances.append(
            (
                "source_listing",
                {"kind": "source_block", "block_key": path, "quote": _quote(value)},
                0.9,
                value,
                None,
            )
        )

    extraction_keys = {
        "starting_price_eur": ("starting_price_extraction",),
        "sale_date": ("pdf_sale_date_extraction",),
        "surface_m2": ("surface_extraction",),
        "habitable_surface_m2": ("surface_extraction",),
        "carrez_surface_m2": ("surface_extraction",),
        "land_surface_m2": ("land_surface_extraction",),
        "occupancy_status": (),
    }.get(field, ())
    for extraction_key in extraction_keys:
        extraction = payload.get(extraction_key)
        if not isinstance(extraction, dict) or not extraction:
            continue
        if not _extraction_matches_field(field, extraction_key, extraction):
            continue
        document_url = _document_source_url(extraction)
        # A document-derived value without its exact document URL would be
        # incorrectly attributed to the listing URL by the caller.  Keep the
        # candidate out of the append-only claims table until the extractor
        # records the URL that was actually read.
        if document_url is None:
            continue
        locator: dict[str, object] = {"kind": "document_extraction", "extraction_key": extraction_key}
        for key in ("document_url", "document_label", "document_type", "page_number", "extraction_method"):
            value = extraction.get(key)
            if _has_value(value):
                locator[key] = value
        if _has_value(extraction.get("evidence")):
            locator["quote"] = _quote(extraction.get("evidence"))
        page_confidence = extraction.get("page_confidence")
        try:
            confidence = min(0.9, max(0.55, float(page_confidence))) if page_confidence is not None else 0.78
        except (TypeError, ValueError):
            confidence = 0.78
        evidence_value = extraction.get("value_eur") if field == "starting_price_eur" else extraction.get("value_m2")
        provenances.append(("source_document", locator, confidence, evidence_value, document_url))

    # The normalizer stores a field-specific excerpt for surfaces.  Keep this
    # path narrow so arbitrary description text never becomes a surface claim.
    surface_evidence = _quote(payload.get("surface_evidence"))
    surface_value = _surface_evidence_value(surface_evidence) if surface_evidence else None
    if (
        field in _SURFACE_FIELDS
        and surface_evidence
        and surface_value is not None
        and _surface_evidence_matches_field(field, surface_evidence)
    ):
        provenances.append(
            (
                "source_listing",
                {"kind": "field_evidence", "quote": surface_evidence},
                0.78,
                surface_value,
                None,
            )
        )

    if field == "occupancy_status":
        text = _source_text(payload)
        quote = _occupancy_quote(text)
        text_value = normalize_occupancy_status(quote)
        if quote and text_value in _KNOWN_OCCUPANCY:
            provenances.append(
                ("source_listing", {"kind": "text_evidence", "quote": quote}, 0.72, text_value, None)
            )
    return provenances


def _document_source_url(extraction: dict[str, object]) -> str | None:
    """Return a usable URL for the exact document behind an extraction.

    A document label, page number, or OCR method is not enough to identify the
    bytes that produced a value.  The caller must therefore drop document
    evidence when the extractor did not preserve an HTTPS document URL.
    """
    document_url = clean_text(extraction.get("document_url"))
    if not document_url or not document_url.startswith("https://"):
        return None
    return document_url


def _surface_evidence_matches_field(field: str, evidence: str) -> bool:
    """Keep an untyped surface excerpt attached to only its likely field.

    ``surface_evidence`` predates field-level claims and can be populated from
    a habitable, Carrez, parcel, or generic built-surface match.  Reusing that
    excerpt for every populated numeric field would create claims whose value
    and quote describe different facts.
    """
    normalized = _normalize_key(evidence)
    if field == "habitable_surface_m2":
        return "habitable" in normalized
    if field == "carrez_surface_m2":
        return "carrez" in normalized
    if field == "land_surface_m2":
        return any(token in normalized for token in ("terrain", "parcelle", "cadastr", "hectare"))
    if field == "surface_m2":
        return not any(
            token in normalized
            for token in ("habitable", "carrez", "terrain", "parcelle", "cadastr", "hectare")
        )
    return False


def _surface_evidence_value(evidence: str) -> object | None:
    """Extract a single measurement from the legacy surface excerpt."""
    matches = re.findall(r"(?<!\d)([0-9][0-9\s.,]*)\s*m(?:2|²)\b", evidence, re.IGNORECASE)
    if len(matches) != 1:
        return None
    value = parse_surface(matches[0])
    return value if value is not None and value > 0 else None


def _extraction_matches_field(field: str, extraction_key: str, extraction: dict[str, object]) -> bool:
    if extraction_key == "land_surface_extraction":
        return field == "land_surface_m2"
    if extraction_key == "starting_price_extraction":
        return field == "starting_price_eur"
    if extraction_key == "pdf_sale_date_extraction":
        return field == "sale_date"
    if field == "surface_m2":
        return "habitable" not in _normalize_key(extraction.get("evidence")) and "carrez" not in _normalize_key(extraction.get("evidence"))
    evidence = _normalize_key(extraction.get("evidence"))
    if field == "habitable_surface_m2":
        return "habitable" in evidence
    if field == "carrez_surface_m2":
        return "carrez" in evidence
    return False


def _source_text(payload: dict[str, object]) -> str:
    parts: list[str] = []
    for key in ("raw_text", "description"):
        value = clean_text(payload.get(key))
        if value:
            parts.append(value)
    for _, _, value in _walk_values(payload.get("source_blocks")):
        if not isinstance(value, (dict, list)) and (text := clean_text(value)):
            parts.append(text)
    return "\n".join(parts)


def _occupancy_quote(text: str) -> str | None:
    if not text:
        return None
    pattern = re.compile(
        r"(?:libre(?:\s+de\s+toute\s+occupation)?|inoccup\w*|occup\w*|locataire\w*|lou[ée]e?\w*|bail|squat\w*)",
        re.IGNORECASE,
    )
    match = pattern.search(text)
    if match is None:
        return None
    start = max(0, match.start() - 100)
    end = min(len(text), match.end() + 160)
    return clean_text(text[start:end])


def _walk_values(value: object, prefix: str = "") -> list[tuple[str, str, object]]:
    rows: list[tuple[str, str, object]] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            key_text = str(key)
            path = f"{prefix}.{key_text}" if prefix else key_text
            rows.append((path, key_text, nested))
            rows.extend(_walk_values(nested, path))
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            rows.extend(_walk_values(nested, f"{prefix}.{index}" if prefix else str(index)))
    return rows


def _deduplicate_candidates(candidates: list[dict[str, object]]) -> list[dict[str, object]]:
    unique: dict[str, dict[str, object]] = {}
    for candidate in candidates:
        identity = json.dumps(
            {
                "field_key": candidate["field_key"],
                "value_jsonb": candidate["value_jsonb"],
                "evidence_kind": candidate["evidence_kind"],
                "source_url": candidate["source_url"],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        previous = unique.get(identity)
        if previous is None or float(candidate["confidence_score"]) > float(previous["confidence_score"]):
            unique[identity] = candidate
    return list(unique.values())


def _normalize_key(value: object) -> str:
    text = "" if value is None else str(value)
    text = "".join(char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _quote(value: object) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    return text[:500]


def _has_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(clean_text(value))
    if isinstance(value, (list, dict, tuple, set)):
        return bool(value)
    return True
