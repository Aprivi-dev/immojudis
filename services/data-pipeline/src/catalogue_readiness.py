"""Deterministic premium-catalogue readiness evaluation.

Readiness is deliberately separate from the investment score.  The latter
answers whether a sale may be interesting; this module answers whether the
information available is rich and trustworthy enough to show to a premium
user.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from src.admission import quarantine_reason
from src.models import AuctionSale

CATALOGUE_READINESS_POLICY_VERSION = "premium_readiness_v1"
PREMIUM_READINESS_THRESHOLD = 75
NEEDS_ENRICHMENT_THRESHOLD = 55
PREMIUM_READINESS_CONFIDENCE_THRESHOLD = Decimal("0.70")

AXIS_WEIGHTS: dict[str, int] = {
    "sale_provenance": 30,
    "property": 25,
    "proofs": 25,
    "practical": 10,
    "analysis": 10,
}


@dataclass(frozen=True, slots=True)
class CatalogueReadiness:
    """Result of one versioned readiness evaluation.

    ``factors`` is intentionally JSON-shaped so the exact contribution and
    missing information can be displayed by the admin UI without reproducing
    the scoring rules there.
    """

    score: int
    status: str
    policy_version: str
    factors: dict[str, dict[str, Any]]
    blockers: list[str]
    missing_fields: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "status": self.status,
            "policy_version": self.policy_version,
            "factors": self.factors,
            "blockers": self.blockers,
            "missing_fields": self.missing_fields,
        }

    def __getitem__(self, key: str) -> Any:
        """Allow callers/tests to consume the result like a JSON object."""
        return self.to_dict()[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.to_dict().get(key, default)


def assess_catalogue_readiness(sale: AuctionSale) -> CatalogueReadiness:
    """Evaluate ``sale`` without mutating it.

    The score is always in the inclusive range 0..100.  Hard blockers keep a
    high-scoring row out of ``premium_ready``; they do not erase the row or
    reduce its numeric score, which lets an administrator see what is still
    worth enriching.
    """
    state_sale = _is_state_sale(sale)
    source_proof = _has_source_proof(sale)
    location_level = _location_level(sale)
    confidence = _normalise_confidence(sale.score_confidence)

    checks: tuple[tuple[str, str, int, bool | Decimal], ...] = (
        # Vente / provenance — 30 points.
        ("source_identity", "sale_provenance", 5, _has_source_identity(sale)),
        ("sale_date", "sale_provenance", 8, sale.sale_date is not None),
        ("starting_price_eur", "sale_provenance", 8, sale.starting_price_eur is not None or state_sale),
        ("sale_procedure", "sale_provenance", 5, _has_sale_procedure(sale)),
        (
            "tribunal",
            "sale_provenance",
            4,
            bool(_text(sale.tribunal) or _text(sale.sale_venue_type) not in {"", "unknown"}),
        ),
        # Bien — 25 points.
        ("property_type", "property", 5, _has_property_type(sale)),
        ("location", "property", 8, location_level == 2),
        ("surface", "property", 7, _has_surface(sale)),
        ("title_or_description", "property", 5, bool(_text(sale.title) or _text(sale.description))),
        # Preuves — 25 points.
        ("source_proof", "proofs", 10, source_proof),
        ("documents", "proofs", 7, _has_documents(sale)),
        ("source_corroboration", "proofs", 4, _has_source_corroboration(sale)),
        ("images", "proofs", 4, _has_images(sale)),
        # Informations pratiques — 10 points.
        ("visit_dates", "practical", 3, bool(sale.visit_dates)),
        ("occupancy_status", "practical", 3, _has_occupancy(sale)),
        ("lawyer_contact", "practical", 2, bool(_text(sale.lawyer_name) or _text(sale.lawyer_contact))),
        ("energy_diagnostics", "practical", 2, _has_energy_diagnostics(sale)),
        # Analyse — 10 points.
        ("investment_score", "analysis", 3, sale.investment_score is not None),
        ("investment_summary", "analysis", 3, bool(_text(sale.investment_summary))),
        ("score_confidence", "analysis", 4, confidence),
    )

    axis_rows: dict[str, dict[str, Any]] = {
        axis: {
            "axis": axis,
            "weight": weight,
            "score": 0,
            "checks": [],
        }
        for axis, weight in AXIS_WEIGHTS.items()
    }
    missing_fields: list[str] = []
    for key, axis, max_points, availability in checks:
        if isinstance(availability, Decimal):
            ratio = max(Decimal("0"), min(Decimal("1"), availability))
            points = float(Decimal(max_points) * ratio)
            available = ratio > 0
            confidence_value: float | None = float(ratio)
        else:
            available = bool(availability)
            points = float(max_points if available else 0)
            confidence_value = None
        row = {
            "key": key,
            "available": available,
            "points": _number(points),
            "max_points": max_points,
        }
        if confidence_value is not None:
            row["confidence"] = confidence_value
        axis_rows[axis]["checks"].append(row)
        axis_rows[axis]["score"] += points
        if not available:
            missing_fields.append(key)

    # Location with only a department or a source block is useful evidence,
    # but is not enough for the full location contribution.
    if location_level == 1:
        _replace_check_points(axis_rows, "location", 4)
        if "location" not in missing_fields:
            missing_fields.append("location")

    # A state disposal may legitimately have no reserve/start price. Keep this
    # fact visible in the factor trace without treating it as a gap.
    if state_sale and sale.starting_price_eur is None:
        _replace_check_available(axis_rows, "starting_price_eur", True, note="not_required_for_state_sale")

    blockers = _hard_blockers(sale, source_proof=source_proof, state_sale=state_sale)
    score = int(
        Decimal(str(sum(float(axis["score"]) for axis in axis_rows.values()))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )
    score = max(0, min(100, score))
    status = _status_for(score, blockers, confidence)
    factors = {axis: axis_rows[axis] for axis in AXIS_WEIGHTS}
    if confidence is None:
        missing_fields.append("score_confidence")
    elif confidence < PREMIUM_READINESS_CONFIDENCE_THRESHOLD:
        # This is a gate, rather than a hard blocker: the data may be usable
        # after the investment analysis is recomputed with better evidence.
        factors["analysis"]["confidence_gate"] = {
            "required": float(PREMIUM_READINESS_CONFIDENCE_THRESHOLD),
            "actual": float(confidence),
            "passed": False,
        }
    else:
        factors["analysis"]["confidence_gate"] = {
            "required": float(PREMIUM_READINESS_CONFIDENCE_THRESHOLD),
            "actual": float(confidence),
            "passed": True,
        }

    return CatalogueReadiness(
        score=score,
        status=status,
        policy_version=CATALOGUE_READINESS_POLICY_VERSION,
        factors=factors,
        blockers=blockers,
        missing_fields=_unique(missing_fields),
    )


def apply_catalogue_readiness(sale: AuctionSale) -> CatalogueReadiness:
    """Evaluate and persist readiness fields on an ``AuctionSale``."""
    result = assess_catalogue_readiness(sale)
    materially_changed = any(
        (
            sale.premium_readiness_score != result.score,
            sale.premium_readiness_status != result.status,
            sale.premium_readiness_policy_version != result.policy_version,
            sale.premium_readiness_factors != result.factors,
            sale.premium_readiness_blockers != result.blockers,
            sale.premium_readiness_missing_fields != result.missing_fields,
        )
    )
    sale.premium_readiness_score = result.score
    sale.premium_readiness_status = result.status
    sale.premium_readiness_policy_version = result.policy_version
    sale.premium_readiness_factors = result.factors
    sale.premium_readiness_blockers = result.blockers
    sale.premium_readiness_missing_fields = result.missing_fields
    if materially_changed or sale.premium_readiness_evaluated_at is None:
        sale.premium_readiness_evaluated_at = datetime.now(UTC)
    return result


def calculate_catalogue_readiness(sale: AuctionSale) -> CatalogueReadiness:
    """Backward-friendly public entry point that also stores the result."""
    return apply_catalogue_readiness(sale)


def _status_for(score: int, blockers: list[str], confidence: Decimal | None) -> str:
    if score < NEEDS_ENRICHMENT_THRESHOLD:
        return "internal_only"
    if score < PREMIUM_READINESS_THRESHOLD:
        return "needs_enrichment"
    if blockers or confidence is None or confidence < PREMIUM_READINESS_CONFIDENCE_THRESHOLD:
        return "needs_enrichment"
    return "premium_ready"


def _hard_blockers(sale: AuctionSale, *, source_proof: bool, state_sale: bool) -> list[str]:
    blockers: list[str] = []
    reason = quarantine_reason(sale)
    if reason:
        blockers.append(reason)

    conflicts = sale.raw_payload.get("source_conflicts") if isinstance(sale.raw_payload, dict) else None
    if isinstance(conflicts, list):
        for conflict in conflicts:
            if not isinstance(conflict, dict):
                continue
            field = str(conflict.get("field") or conflict.get("code") or "").strip().lower()
            if any(token in field for token in ("identity", "procedure", "lot", "source_url", "external_id")):
                blockers.append("identity_procedure_conflict")
                break

    if sale.sale_date is None:
        blockers.append("sale_date")
    if _location_level(sale) == 0:
        blockers.append("location")
    if sale.starting_price_eur is None and not state_sale:
        blockers.append("starting_price_eur")
    if not source_proof:
        blockers.append("source_proof")
    return _unique(blockers)


def _has_source_identity(sale: AuctionSale) -> bool:
    return bool(_text(sale.source_name) and _text(sale.source_url))


def _has_sale_procedure(sale: AuctionSale) -> bool:
    procedure = sale.sale_procedure
    return bool(
        isinstance(procedure, dict) and any(value not in (None, "", [], {}) for value in procedure.values())
    ) or bool(
        _text(sale.sale_legal_framework) not in {"", "unknown"}
        or _text(sale.sale_venue_type) not in {"", "unknown"}
        or _text(sale.sale_verification_status) not in {"", "pending", "unknown"}
    )


def _has_property_type(sale: AuctionSale) -> bool:
    return _text(sale.property_type).lower() not in {"", "unknown", "other"}


def _location_level(sale: AuctionSale) -> int:
    if any(_text(value) for value in (sale.address, sale.city, sale.postal_code)):
        return 2
    if _text(sale.department):
        return 1
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    blocks = payload.get("source_blocks")
    if isinstance(blocks, dict):
        exact_keys = {
            "address",
            "adresse",
            "detail_adresse",
            "city",
            "ville",
            "commune",
            "location",
            "localisation",
            "postal_code",
            "code_postal",
        }
        if any(_text(blocks.get(key)) for key in exact_keys):
            return 1
    return 0


def _has_surface(sale: AuctionSale) -> bool:
    return any(
        value is not None
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.land_surface_m2,
            sale.app_surface_m2,
        )
    )


def _has_source_proof(sale: AuctionSale) -> bool:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    blocks = payload.get("source_blocks")
    if isinstance(blocks, dict) and any(_text(value) for value in blocks.values()):
        return True
    if any(
        _text(value)
        for value in (
            sale.raw_text,
            sale.title,
            sale.description,
            payload.get("source_description"),
            payload.get("source_factual_snapshot"),
        )
    ):
        return True
    if _has_documents(sale) or _has_images(sale):
        return True
    return bool(
        isinstance(sale.observations, list)
        and any(isinstance(item, dict) and item.get("source_url") for item in sale.observations)
    )


def _has_documents(sale: AuctionSale) -> bool:
    stored_documents = bool(
        isinstance(sale.documents, list)
        and any(
            (isinstance(document, dict) and any(_text(document.get(key)) for key in ("url", "label", "name", "text")))
            or (isinstance(document, str) and _text(document))
            for document in sale.documents
        )
    )
    if stored_documents:
        return True
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    verified_facts = payload.get("information_agent_verified_facts")
    if not isinstance(verified_facts, dict):
        return False
    document_fact = verified_facts.get("document")
    if not isinstance(document_fact, dict):
        return False
    value = document_fact.get("value")
    return bool(
        any(_text(document_fact.get(key)) for key in ("display_value", "fact_id", "public_url"))
        or (isinstance(value, dict) and any(_text(value.get(key)) for key in ("public_url", "url")))
    )


def _has_source_corroboration(sale: AuctionSale) -> bool:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_urls = [url for url in sale.source_urls if _text(url) and url != sale.source_url]
    observations = sale.observations if isinstance(sale.observations, list) else []
    presence = payload.get("source_presence")
    if len(source_urls) > 0 or len(observations) > 0:
        return True
    return isinstance(presence, dict) and len(presence) > 1


def _has_images(sale: AuctionSale) -> bool:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    images = payload.get("source_images")
    return bool(
        _text(payload.get("raw_image_url")) or (isinstance(images, list) and any(_text(item) for item in images))
    )


def _has_occupancy(sale: AuctionSale) -> bool:
    return bool(_text(sale.occupancy_status) and sale.occupancy_status != "unknown")


def _has_energy_diagnostics(sale: AuctionSale) -> bool:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    for key in ("source_energy_diagnostics", "pdf_energy_diagnostics"):
        diagnostics = payload.get(key)
        if isinstance(diagnostics, dict) and any(
            diagnostics.get(field)
            for field in (
                "dpe_class",
                "ges_class",
                "energy_consumption_kwh_m2_year",
                "emissions_kg_co2_m2_year",
            )
        ):
            return True
    blocks = payload.get("source_blocks")
    if isinstance(blocks, dict):
        return any(_text(blocks.get(key)) for key in ("dpe", "ges", "diagnostic", "diagnostics"))
    return False


def _is_state_sale(sale: AuctionSale) -> bool:
    values = (
        sale.source_name,
        sale.primary_source,
        sale.sale_venue_type,
        sale.sale_legal_framework,
    )
    normalized = {
        "".join(
            char for char in unicodedata.normalize("NFKD", _text(value).lower()) if not unicodedata.combining(char)
        ).replace("-", "_")
        for value in values
    }
    return bool(normalized & {"cessions_etat", "state", "etat", "domaines"})


def _normalise_confidence(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        confidence = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if not confidence.is_finite():
        return None
    if confidence > 1 and confidence <= 100:
        confidence /= Decimal("100")
    return max(Decimal("0"), min(Decimal("1"), confidence))


def _replace_check_points(axis_rows: dict[str, dict[str, Any]], key: str, points: int) -> None:
    for axis in axis_rows.values():
        for check in axis["checks"]:
            if check["key"] == key:
                old = float(check["points"])
                check["points"] = points
                axis["score"] += points - old
                return


def _replace_check_available(axis_rows: dict[str, dict[str, Any]], key: str, available: bool, *, note: str) -> None:
    for axis in axis_rows.values():
        for check in axis["checks"]:
            if check["key"] == key:
                check["available"] = available
                check["note"] = note
                return


def _text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple, set)):
        return ""
    return str(value).strip()


def _number(value: float) -> int | float:
    return int(value) if value.is_integer() else round(value, 4)


def _unique(values: Iterator[str] | list[str]) -> list[str]:
    return list(dict.fromkeys(str(value) for value in values if value))


# Short aliases keep imports readable for callers that use ``evaluate`` as the
# verb while retaining one implementation and one policy version.
evaluate_catalogue_readiness = assess_catalogue_readiness
