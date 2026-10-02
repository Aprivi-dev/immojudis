"""Deterministic source extraction profiles and evidence contracts.

The source adapters intentionally keep their HTML parsing small.  This module
adds a stable, evidence-bearing layer on top of the values that are already
visible in a public listing.  It does not fill legal or technical defaults:
unknown values remain unknown and inferred values retain their provenance.

The output is stored on the raw sale payload so that the canonical
``AuctionSale`` model can evolve independently from source specific facts.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from typing import Any

PROPERTY_FEATURE_SCHEMA_VERSION = "source_property_features_v1"
PROCEDURE_PROFILE_SCHEMA_VERSION = "source_procedure_profile_v1"
_GENERATED_FEATURE_ORIGIN = "source_text_extraction"


def _clean(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return " ".join(part for part in (_clean(item) for item in value) if part)
    if isinstance(value, Mapping):
        return " ".join(
            part
            for key, item in value.items()
            for part in (_clean(key), _clean(item))
            if part
        )
    return re.sub(r"\s+", " ", str(value)).strip()


def _fold(value: Any) -> str:
    text = _clean(value).casefold()
    return "".join(
        char
        for char in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(char)
    )


def _clip(value: Any, limit: int = 280) -> str:
    text = _clean(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _unique_values(values: Iterable[Any]) -> list[Any]:
    """Deduplicate scalar and structured claims without requiring hashability."""

    unique: list[Any] = []
    for value in values:
        if not any(value == previous for previous in unique):
            unique.append(value)
    return unique


def _number(value: Any) -> int | float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    text = _clean(value).replace("\u202f", " ").replace("\xa0", " ")
    text = re.sub(r"[^0-9,.-]", "", text.replace(" ", ""))
    if not text:
        return None
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    else:
        text = text.replace(",", ".")
    try:
        parsed = float(text)
    except ValueError:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _source_url(raw_sale: Mapping[str, Any]) -> str | None:
    for key in ("source_url", "url", "detail_url", "source_detail_url"):
        value = raw_sale.get(key)
        if value:
            return _clean(value)
    nested = raw_sale.get("raw_payload")
    if isinstance(nested, Mapping):
        for key in ("source_url", "url", "detail_url", "source_detail_url"):
            value = nested.get(key)
            if value:
                return _clean(value)
    return None


def _input_view(raw_sale: Mapping[str, Any]) -> dict[str, Any]:
    """Expose preserved raw payload fields to future deterministic recomputes."""

    nested = raw_sale.get("raw_payload")
    if not isinstance(nested, Mapping):
        return dict(raw_sale)
    merged = dict(nested)
    merged.update({key: value for key, value in raw_sale.items() if key != "raw_payload"})
    return merged


def _text_values(value: Any) -> Iterable[str]:
    if value is None:
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if _fold(key) == "listing_completeness":
                continue
            yield from _text_values(key)
            yield from _text_values(item)
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            yield from _text_values(item)
        return
    text = _clean(value)
    if text:
        yield text


def _corpus(raw_sale: Mapping[str, Any]) -> str:
    """Build a text corpus from fields that are visible on the source page.

    ``source_blocks`` is deliberately included because operator adapters often
    put labelled facts there.  It is not used as a source of invented values;
    every emitted field still carries the exact matched quote.
    """

    keys = (
        "title",
        "description",
        "raw_text",
        "address",
        "city",
        "postal_code",
        "tribunal",
        "lawyer_name",
        "lawyer_contact",
        "occupancy_status",
        "source_blocks",
        "operator_fields",
        "operator_public_model",
    )
    values: list[str] = []
    nested = raw_sale.get("raw_payload")
    nested_sale = nested if isinstance(nested, Mapping) else {}
    for key in keys:
        values.extend(_text_values(raw_sale.get(key)))
        if key in nested_sale:
            values.extend(_text_values(nested_sale.get(key)))
    return "\n".join(dict.fromkeys(values))


def _primary_corpus(raw_sale: Mapping[str, Any]) -> str:
    keys = (
        "title",
        "description",
        "raw_text",
        "address",
        "city",
        "postal_code",
        "tribunal",
        "lawyer_name",
        "lawyer_contact",
        "occupancy_status",
    )
    values: list[str] = []
    nested = raw_sale.get("raw_payload")
    nested_sale = nested if isinstance(nested, Mapping) else {}
    for key in keys:
        values.extend(_text_values(raw_sale.get(key)))
        if key in nested_sale:
            values.extend(_text_values(nested_sale.get(key)))
    return "\n".join(dict.fromkeys(values))


def _scope_for_quote(quote: str) -> str:
    folded = _fold(quote)
    if re.search(r"parties communes|syndic|charges de copro|copropriete", folded):
        return "coownership"
    if re.search(r"batiment|immeuble|ensemble immobilier", folded):
        return "building"
    return "asset"


def _claim(
    field: str,
    value: Any,
    quote: str,
    *,
    raw_sale: Mapping[str, Any],
    state: str = "present",
    provenance: str = "explicit",
    subject_scope: str | None = None,
    source_kind: str = "source_listing",
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    evidence = {
        "field": field,
        "value": value,
        "quote": _clip(quote),
        "source_url": _source_url(raw_sale),
        "source_kind": source_kind,
        "subject_scope": subject_scope or _scope_for_quote(quote),
        "provenance": provenance,
        "state": state,
        "origin": _GENERATED_FEATURE_ORIGIN,
    }
    if extra:
        evidence.update(dict(extra))
    return evidence


def _field(claim: Mapping[str, Any]) -> dict[str, Any]:
    """Convert an evidence row to the compact field representation."""

    result = {
        "state": claim.get("state", "present"),
        "value": claim.get("value"),
        "provenance": claim.get("provenance", "explicit"),
        "subject_scope": claim.get("subject_scope", "asset"),
        "evidence": claim.get("quote", ""),
        "origin": _GENERATED_FEATURE_ORIGIN,
    }
    for key in (
        "label",
        "mode",
        "energy",
        "distribution",
        "period",
        "rate_pct",
        "method",
        "inference",
        "input_fields",
        "confidence",
        "values",
    ):
        if key in claim:
            result[key] = claim[key]
    return result


def _is_claim_mapping(value: Any) -> bool:
    return isinstance(value, Mapping) and (
        "state" in value
        or ("value" in value and ("provenance" in value or "evidence" in value))
    )


def _feature_claims(
    features: Mapping[str, Any],
    *,
    raw_sale: Mapping[str, Any],
    prefix: str = "",
) -> Iterable[tuple[str, dict[str, Any]]]:
    """Flatten legacy nested source features into observation claims.

    Notaires and Cessions already publish rich nested feature objects.  The
    profile layer must preserve those objects while making their high-value
    leaves available to the common observation contract.
    """

    skip_collections = {"images", "documents"}
    for raw_key, value in features.items():
        key = f"{prefix}.{raw_key}" if prefix else str(raw_key)
        if value in (None, "", [], {}):
            continue
        if _is_claim_mapping(value):
            yield key, dict(value)
            continue
        if isinstance(value, Mapping):
            yield from _feature_claims(value, raw_sale=raw_sale, prefix=key)
            continue
        if isinstance(value, list):
            if raw_key in skip_collections:
                continue
            scalar_values = [item for item in value if not isinstance(item, Mapping)]
            if scalar_values:
                yield key, {
                    "value": scalar_values,
                    "state": "present",
                    "provenance": "parser_field",
                    "subject_scope": "asset",
                    "evidence": _legacy_feature_quote(raw_sale, key, value),
                }
            elif value and all(isinstance(item, Mapping) for item in value[:20]):
                yield key, {
                    "value": [dict(item) for item in value[:20]],
                    "state": "present",
                    "provenance": "parser_field",
                    "subject_scope": "asset",
                    "evidence": _legacy_feature_quote(raw_sale, key, value),
                }
            continue
        yield key, {
            "value": value,
            "state": "present",
            "provenance": "parser_field",
            "subject_scope": "asset",
            "evidence": _legacy_feature_quote(raw_sale, key, value),
        }


def _legacy_feature_quote(raw_sale: Mapping[str, Any], key: str, value: Any) -> str:
    """Return a compact structured quote when a legacy API field has no text quote."""

    root = key.split(".", 1)[0]
    source_evidence = raw_sale.get("source_evidence")
    if isinstance(source_evidence, Mapping):
        item = source_evidence.get(root)
        if isinstance(item, Mapping):
            quote = item.get("quote") or item.get("aggregate_quote")
            if quote:
                return _clip(quote)
            field = item.get("field") or item.get("source")
            if field:
                return f"{field}={_clean(value)}"
    return f"{key}={_clean(value)}"


_CATALOGUE_OBSERVATION_IDS = frozenset(
    {
        "listing_id",
        "source_name",
        "source_url",
        "primary_source",
        "source_urls",
        "external_id",
        "source_title",
        "source_description",
        "capture_text",
        "source_blocks",
        "source_presence",
        "source_conflicts",
        "capture_checked_at",
        "extractor_version",
        "source_detail_status",
        "source_last_seen_at",
        "property_type",
        "sale_venue_type",
        "sale_legal_framework",
        "sale_verification_status",
        "listing_status",
        "auction_round",
        "sale_date",
        "sale_schedule",
        "procedure_record",
        "tribunal",
        "starting_price_eur",
        "adjudication_price_eur",
        "outcome_status",
        "venue_name",
        "venue_address",
        "visit_dates",
        "participation_mode",
        "bid_method",
        "lawyer_required",
        "eligible_bar",
        "lawyer_name",
        "lawyer_contact",
        "consignation",
        "sale_fees",
        "payment_terms",
        "surenchere_window",
        "address",
        "postal_code",
        "city",
        "department",
        "insee_code",
        "coordinates",
        "location_precision",
        "lot_reference",
        "lot_count",
        "cadastral_references",
        "land_surface_m2",
        "land_surface_scope",
        "surface_habitable_m2",
        "surface_carrez_m2",
        "surface_built_m2",
        "surface_scope",
        "surface_provenance",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "shower_rooms_count",
        "wc_count",
        "floor_number",
        "building_floor_count",
        "elevator",
        "layout",
        "flooring",
        "ceiling_height_m",
        "year_built",
        "condition",
        "works_needed",
        "accessibility",
        "orientation",
        "view",
        "heating_mode",
        "heating_energy",
        "heating_distribution",
        "hot_water_mode",
        "hot_water_energy",
        "dpe_class",
        "ges_class",
        "energy_consumption_kwh_m2_year",
        "emissions_kg_co2_m2_year",
        "dpe_established_at",
        "dpe_valid_until",
        "dpe_number",
        "windows_insulation",
        "building_insulation",
        "ventilation",
        "cooling",
        "utilities_connections",
        "garden",
        "terrace",
        "balcony",
        "garage",
        "parking",
        "cellar",
        "attic",
        "pool",
        "outbuildings",
        "land_use",
        "boundary_access",
        "occupancy_status",
        "occupancy_details",
        "lease_status",
        "rent_eur",
        "lease_end_date",
        "coownership",
        "coownership_lot_description",
        "coownership_charges_eur",
        "coownership_works",
        "easements",
        "urban_planning",
        "environmental_risks",
        "technical_diagnostics",
        "property_tax_eur",
        "documents_inventory",
        "document_extraction_status",
        "pv_description",
        "conditions_sale",
        "diagnostics_documents",
        "lease_documents",
        "photos_count",
        "photos_usable_count",
        "floorplan_media",
        "cadastre_media",
        "media_origin",
        "media_rights_status",
    }
)


def _feature_observation_id(path: str) -> str | None:
    if path.startswith("_extracted."):
        path = path.removeprefix("_extracted.")
    aliases = {
        "floor": "floor_number",
        "energy.dpe.class": "dpe_class",
        "energy.dpe.value": "energy_consumption_kwh_m2_year",
        "energy.dpe.date": "dpe_established_at",
        "energy.ges.class": "ges_class",
        "energy.ges.value": "emissions_kg_co2_m2_year",
        "energy.ges.date": "dpe_established_at",
        "property_tax.amount_eur": "property_tax_eur",
        "coownership.annual_charges_eur": "coownership_charges_eur",
        "coownership.is_coownership": "coownership",
        "surfaces.aggregate_carrez_m2": "surface_carrez_m2",
        "technical.heating": "__expand_heating__",
        "technical.heating_api": "__expand_heating__",
        "technical.heating.mode": "heating_mode",
        "technical.heating.energy": "heating_energy",
        "technical.heating.distribution": "heating_distribution",
        "technical.heating_api.mode": "heating_mode",
        "technical.heating_api.energy": "heating_energy",
        "technical.heating_api.distribution": "heating_distribution",
        "heating": "__expand_heating__",
        "heating.mode": "heating_mode",
        "heating.energy": "heating_energy",
        "heating.distribution": "heating_distribution",
        "technical.hot_water": "__expand_hot_water__",
        "technical.hot_water_api": "__expand_hot_water__",
        "technical.hot_water.mode": "hot_water_mode",
        "technical.hot_water.energy": "hot_water_energy",
        "technical.hot_water_api.mode": "hot_water_mode",
        "technical.hot_water_api.energy": "hot_water_energy",
        "hot_water": "__expand_hot_water__",
        "hot_water.mode": "hot_water_mode",
        "hot_water.energy": "hot_water_energy",
        "technical.energy": "heating_energy",
        "technical.energy_api": "heating_energy",
        "annexes.parking_count": "parking",
        "annexes.garage": "garage",
        "annexes.garden": "garden",
        "annexes.terrace": "terrace",
        "annexes.patio": "terrace",
        "annexes.balcony": "balcony",
        "annexes.cellar": "cellar",
        "annexes.celliers": "cellar",
        "annexes.pool": "pool",
        "annexes.air_conditioning": "cooling",
        "building.floors_count": "building_floor_count",
        "habitable_surface_m2": "surface_habitable_m2",
        "surface_m2": "surface_built_m2",
        "surface_source": "surface_provenance",
        "surface_origin": "surface_provenance",
        "property_tax_amount_eur": "property_tax_eur",
        "coownership_charges_annual_eur": "coownership_charges_eur",
        "coownership_charges": "coownership_charges_eur",
        "is_coownership": "coownership",
        "carrez_surface_m2": "surface_carrez_m2",
        "surface_habitable_m2": "surface_habitable_m2",
        "building_floors_count": "building_floor_count",
        "parking_count": "parking",
        "showers_count": "shower_rooms_count",
        "occupancy_physical": "occupancy_status",
        "legal_possession": None,
        "dpe_value": "energy_consumption_kwh_m2_year",
        "ges_value": "emissions_kg_co2_m2_year",
        "dpe_date": "dpe_established_at",
        "ges_date": "dpe_established_at",
        "dpe_unit": None,
        "ges_unit": None,
        "conditions_documents": "conditions_sale",
        "conditions": "conditions_sale",
        "cadastre": "cadastral_references",
        "urbanism": "urban_planning",
        "audience": "sale_date",
        "sale_window": "sale_schedule",
        "visits": "visit_dates",
        "bid": "bid_method",
        "notary_study": "venue_name",
        "sale_method": "participation_mode",
        "deadline": "sale_schedule",
        "procedure_family": "sale_legal_framework",
        "eligible_lawyer": "__expand_eligible_lawyer__",
        "contact.name": "lawyer_name",
        "contact.phone": "lawyer_contact",
        "contact.email": "lawyer_contact",
        "technical.condition": "condition",
        "technical.orientation": "orientation",
        "technical.kitchen_type": "layout",
        "technical.works_to_plan": "works_needed",
        "works_to_plan": "works_needed",
        "media.image_count": "photos_count",
    }
    candidate = aliases.get(path, path)
    if candidate is None or candidate.startswith("__expand_"):
        return candidate
    return candidate if candidate in _CATALOGUE_OBSERVATION_IDS else None


def _normalized_heating_energy(value: Any) -> Any:
    folded = _fold(value)
    for canonical, markers in (
        ("gas", ("gaz",)),
        ("electricity", ("electrique", "electricite")),
        ("fuel_oil", ("fioul", "fuel")),
        ("wood", ("bois", "granule", "pellet")),
        ("heat_pump", ("pompe a chaleur", "pac")),
        ("solar", ("solaire",)),
    ):
        if any(marker in folded for marker in markers):
            return canonical
    return value


def _feature_claim_projections(
    path: str,
    claim: Mapping[str, Any],
) -> Iterable[tuple[str, dict[str, Any]]]:
    """Expand nested source facts into catalogue field claims.

    The source feature tree intentionally keeps rich objects such as
    ``heating={mode,energy,distribution}``.  The completeness catalogue has
    one field per facet, so each facet receives the same source quote and
    state.  Unsupported helper/meta fields stay in the rich tree but are not
    emitted as phantom catalogue fields.
    """

    observation_id = _feature_observation_id(path)
    if observation_id is None:
        return
    value = claim.get("value")
    if observation_id in {"__expand_heating__", "__expand_hot_water__"}:
        prefix = "heating" if observation_id == "__expand_heating__" else "hot_water"
        targets = (
            (("mode", "heating_mode"), ("energy", "heating_energy"), ("distribution", "heating_distribution"))
            if prefix == "heating"
            else (("mode", "hot_water_mode"), ("energy", "hot_water_energy"))
        )
        if isinstance(value, Mapping):
            for source_key, target in targets:
                if value.get(source_key) in (None, "", [], {}):
                    continue
                projected = dict(claim)
                projected["field"] = target
                projected["value"] = value[source_key]
                if target == "heating_energy":
                    projected["value"] = _normalized_heating_energy(projected["value"])
                yield target, projected
        elif prefix == "heating" and value not in (None, "", [], {}):
            projected = dict(claim)
            projected["field"] = "heating_energy"
            projected["value"] = _normalized_heating_energy(value)
            yield "heating_energy", projected
        return
    if observation_id == "__expand_eligible_lawyer__":
        if isinstance(value, Mapping):
            for source_key, target in (
                ("name", "lawyer_name"),
                ("contact", "lawyer_contact"),
                ("bar", "eligible_bar"),
            ):
                if value.get(source_key) in (None, "", [], {}):
                    continue
                projected = dict(claim)
                projected["field"] = target
                projected["value"] = value[source_key]
                yield target, projected
        elif value not in (None, "", [], {}):
            projected = dict(claim)
            projected["field"] = "lawyer_name"
            yield "lawyer_name", projected
        return
    projected = dict(claim)
    projected["field"] = observation_id
    if observation_id == "heating_energy":
        projected["value"] = _normalized_heating_energy(value)
    yield observation_id, projected


def _append_claim(
    fields: dict[str, Any],
    evidence: list[dict[str, Any]],
    claim: dict[str, Any],
) -> None:
    field = _clean(claim.get("field"))
    if not field:
        return
    evidence.append(claim)
    previous = fields.get(field)
    if previous is None:
        fields[field] = _field(claim)
        return
    if previous.get("value") == claim.get("value") and previous.get("state") == claim.get("state"):
        return
    # A source may legitimately expose two scopes or two conflicting values.
    # Preserve both claims rather than silently selecting one.
    values: list[Any] = []
    old_values = previous.get("values")
    if isinstance(old_values, list):
        values.extend(old_values)
    elif "value" in previous:
        values.append(previous.get("value"))
    values.append(claim.get("value"))
    previous["state"] = "conflict"
    previous["values"] = _unique_values(values)
    previous.setdefault("evidence", "")
    if claim.get("quote"):
        previous["evidence"] = f"{previous['evidence']} | {claim['quote']}".strip(" |")


def _first_match(text: str, patterns: Iterable[str], flags: int = re.IGNORECASE) -> re.Match[str] | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags)
        if match:
            return match
    return None


def _quote(text: str, match: re.Match[str], radius: int = 100) -> str:
    start = max(0, match.start() - radius)
    end = min(len(text), match.end() + radius)
    return text[start:end].strip()


def _explicit_room_claims(text: str, raw_sale: Mapping[str, Any]) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    patterns = (
        ("rooms_count", r"\b(\d{1,2})\s*(?:pi[eè]ces?|pi[eè]ce)\b"),
        ("rooms_count", r"\b(?:type|t|f)\s*([1-9]\d?)(?:[a-z])?\b"),
        ("bedrooms_count", r"\b(\d{1,2})\s*chambres?\b"),
        ("bathrooms_count", r"\b(\d{1,2})\s*salles?\s*de\s*bains?\b"),
        ("showers_count", r"\b(\d{1,2})\s*salles?\s*d['’]?eau\b"),
        ("wc_count", r"\b(\d{1,2})\s*(?:wc|w\.c\.)\b"),
    )
    for field, pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            claims.append(
                _claim(
                    field,
                    int(match.group(1)),
                    _quote(text, match),
                    raw_sale=raw_sale,
                    subject_scope="asset",
                )
            )
    # A parser field without an explicit textual match is still useful, but
    # must remain visibly inferred so exact-count assertions cannot treat it as
    # source evidence.
    for field in ("rooms_count", "bedrooms_count", "bathrooms_count", "showers_count", "wc_count"):
        value = _number(raw_sale.get(field))
        if value is None or any(claim["field"] == field for claim in claims):
            continue
        claims.append(
            _claim(
                field,
                value,
                _clip(raw_sale.get("title") or raw_sale.get("description") or text),
                raw_sale=raw_sale,
                state="inferred",
                provenance="inferred",
                subject_scope="asset",
                extra={
                    "inference": {
                        "method": "parser_field_without_explicit_source_text",
                        "input_fields": [field],
                        "confidence": 0.6,
                    }
                },
            )
        )
    return claims


def _technical_claims(raw_sale: Mapping[str, Any]) -> list[dict[str, Any]]:
    text = _primary_corpus(raw_sale)
    claims: list[dict[str, Any]] = []

    # Floor.  ``rez-de-jardin`` is preserved as a label and does not create a
    # land-surface fact.
    floor_patterns = (
        r"\b(rez[- ]de[- ]chauss(?:ée|ee)|rdc)\b",
        r"\b(\d{1,2})(?:er|e|eme|ème)\s+étage\b",
        r"\b(?:au|du|en)\s+(\d{1,2})(?:er|e|eme|ème)\s+étage\b",
        r"\b(sous[- ]sol|combles)\b",
        r"\b(rez[- ]de[- ]jardin)\b",
    )
    for floor_pattern in floor_patterns:
        floor_match = re.search(floor_pattern, text, re.IGNORECASE)
        if not floor_match:
            continue
        label = _clean(floor_match.group(1))
        prefix = text[max(0, floor_match.start() - 90) : floor_match.start()]
        if re.search(
            r"(?:celliers?|caves?|parkings?|garages?|annexes?|local\s+technique)\s+(?:au|a|en|du|de)?\s*$",
            prefix,
            re.IGNORECASE,
        ):
            continue
        normalized = _fold(label)
        value: Any = label
        if normalized in {"rez-de-chaussee", "rdc"}:
            value = 0
        elif label.isdigit():
            value = int(label)
        claim = _claim("floor", value, _quote(text, floor_match), raw_sale=raw_sale, subject_scope="asset")
        claim["label"] = label
        claims.append(claim)

    # Heating mode, energy and distribution are kept separate because a
    # listing can disclose one without the others.
    heating_match = re.search(r"\bchauffage\b[^.\n]{0,140}", text, re.IGNORECASE)
    if heating_match:
        quote = heating_match.group(0).strip()
        heating_folded = _fold(quote)
        mode = None
        if re.search(r"chauffage\s+(?:tr[eè]s\s+)?collectif|collectif", heating_folded):
            mode = "collective"
        elif re.search(r"chauffage\s+(?:tr[eè]s\s+)?individuel|individuel|privatif", heating_folded):
            mode = "individual"
        energy = None
        for candidate, aliases in (
            ("gas", ("gaz",)),
            ("electricity", ("electrique", "électrique")),
            ("fuel_oil", ("fioul", "fuel")),
            ("wood", ("bois", "granules", "pellet")),
            ("heat_pump", ("pompe a chaleur", "pompe à chaleur", "pac")),
            ("solar", ("solaire",)),
        ):
            if any(alias in heating_folded for alias in aliases):
                energy = candidate
                break
        distribution = None
        for candidate, aliases in (
            ("radiators", ("radiateur", "radiateurs")),
            ("boiler", ("chaudiere", "chaudière")),
            ("convectors", ("convecteur", "convecteurs")),
            ("underfloor", ("plancher chauffant",)),
        ):
            if any(alias in heating_folded for alias in aliases):
                distribution = candidate
                break
        value = {key: item for key, item in (("mode", mode), ("energy", energy), ("distribution", distribution)) if item}
        if value:
            claim = _claim("heating", value, quote, raw_sale=raw_sale, subject_scope="asset")
            claim.update(value)
            claims.append(claim)

    flooring_match = _first_match(
        text,
        (
            r"\b(?:rev[êe]tement(?:s)?(?:\s+de\s+sol)?|sols?)\s*:\s*([^.;\n]{1,100})",
            r"\b(?:rev[êe]tement(?:s)?|sols?)\s+(?:en|de)\s+(parquet|carrelage|moquette|tomettes?|lino(?:l[eé]um)?)\b",
            r"\b(parquet(?:\s+massif)?|carrelage|moquette|tomettes?|lino(?:l[eé]um)?)\b",
        ),
    )
    if flooring_match:
        value = _clean(flooring_match.group(1) if flooring_match.lastindex and flooring_match.lastindex > 0 else flooring_match.group(0))
        claims.append(_claim("flooring", value, _quote(text, flooring_match), raw_sale=raw_sale, subject_scope="asset"))

    year_match = _first_match(
        text,
        (
            r"(?:construit|construction|ann[ée]e\s+de\s+construction)[^0-9]{0,24}((?:19|20)\d{2})",
        ),
    )
    if year_match:
        claims.append(_claim("year_built", int(year_match.group(1)), _quote(text, year_match), raw_sale=raw_sale, subject_scope="asset"))

    orientation_match = _first_match(
        text,
        (
            r"orientation\s*:?\s*([^.;\n]{1,50})",
            r"expos[ée]e?\s+(?:plein\s+)?(nord|sud|est|ouest|nord[- ]est|nord[- ]ouest|sud[- ]est|sud[- ]ouest)",
        ),
    )
    if orientation_match:
        value = _clean(orientation_match.group(1))
        claims.append(_claim("orientation", value, _quote(text, orientation_match), raw_sale=raw_sale, subject_scope="asset"))

    copro_match = re.search(r"\bcopropri[eé]t[ée]\b", text, re.IGNORECASE)
    charges_match = re.search(
        r"charges?[^\d]{0,35}([\d\s\u202f.,]+)\s*€?[^.\n]{0,25}(par mois|/\s*mois|mensuel(?:le)?|par an|annuel(?:le)?|/\s*an)",
        text,
        re.IGNORECASE,
    )
    if copro_match:
        quote = _quote(text, copro_match)
        value: dict[str, Any] = {"is_coownership": True}
        claim = _claim("coownership", value, quote, raw_sale=raw_sale)
        claims.append(claim)
    if charges_match:
        amount = _number(charges_match.group(1))
        period = _fold(charges_match.group(2))
        if amount is not None:
            value = {"amount_eur": amount, "period": period}
            claim = _claim("coownership_charges", value, _quote(text, charges_match), raw_sale=raw_sale)
            claim["period"] = period
            claims.append(claim)

    dpe_not_applicable = re.search(r"\bdpe\b[^.\n]{0,30}(?:non soumis|non applicable|sans objet)", text, re.IGNORECASE)
    if dpe_not_applicable:
        claims.append(
            _claim("dpe_class", None, _quote(text, dpe_not_applicable), raw_sale=raw_sale, state="not_applicable", subject_scope="asset")
        )
    else:
        dpe_match = _first_match(
            text,
            (r"\bdpe\b\s*:?\s*(?:classe\s*)?([a-g])\b", r"classe\s+[ée]nergie\s*:?\s*([a-g])\b"),
        )
        if dpe_match:
            claims.append(_claim("dpe_class", dpe_match.group(1).upper(), _quote(text, dpe_match), raw_sale=raw_sale, subject_scope="asset"))
    ges_match = _first_match(text, (r"\bges\b\s*:?\s*(?:classe\s*)?([a-g])\b", r"[ée]missions?\s+ges\s*:?\s*([a-g])\b"))
    if ges_match:
        claims.append(_claim("ges_class", ges_match.group(1).upper(), _quote(text, ges_match), raw_sale=raw_sale, subject_scope="asset"))

    # Keep physical occupation and legal possession distinct.  A phrase such
    # as "occupé mais vendu libre juridiquement" therefore yields two rows.
    owner_match = re.search(
        r"occup[ée]e?s?\s+par le propri[ée]taire|propri[ée]taire occupant", text, re.IGNORECASE
    )
    tenant_match = re.search(
        r"occup[ée]e?s?\s+par un locataire|lou[ée]e?s?|locataire en place", text, re.IGNORECASE
    )
    negative_match = re.search(
        r"ne\s+sont?\s+pas\s+occup[ée]e?s?|pas\s+d['’]?occupation|\bvacant(?:e|s)?\b|\bsans occupation\b|libre\s+physiquement",
        text,
        re.IGNORECASE,
    )
    positive_match = owner_match or tenant_match
    if positive_match:
        value = "owner_occupied" if owner_match else "tenant_occupied"
        claims.append(_claim("occupancy_physical", value, _quote(text, positive_match), raw_sale=raw_sale, subject_scope="asset"))
        if negative_match:
            claims.append(_claim("occupancy_physical", "vacant", _quote(text, negative_match), raw_sale=raw_sale, subject_scope="asset"))
    elif negative_match:
        claims.append(_claim("occupancy_physical", "vacant", _quote(text, negative_match), raw_sale=raw_sale, subject_scope="asset"))
        occupied_match = next(
            (
                match
                for match in re.finditer(r"\boccup[ée]e?s?\b", text, re.IGNORECASE)
                if not re.search(r"(?:ne\s+sont?\s+|pas\s+)$", text[max(0, match.start() - 24) : match.start()], re.IGNORECASE)
            ),
            None,
        )
        if occupied_match:
            claims.append(_claim("occupancy_physical", "occupied", _quote(text, occupied_match), raw_sale=raw_sale, subject_scope="asset"))
    else:
        occupied_match = re.search(r"\boccup[ée]e?s?\b", text, re.IGNORECASE)
        if occupied_match:
            claims.append(_claim("occupancy_physical", "occupied", _quote(text, occupied_match), raw_sale=raw_sale, subject_scope="asset"))
    legal_match = _first_match(
        text,
        (
            r"libres?\s+de\s+toute\s+occupation",
            r"libres?\s+juridiquement",
            r"sans\s+droit\s+ni\s+titre",
            r"droit\s+de\s+possession",
        ),
    )
    if legal_match:
        claims.append(_claim("legal_possession", "free", _quote(text, legal_match), raw_sale=raw_sale, subject_scope="asset"))
    elif re.search(r"vendu\s+occup[ée]|occupation\s+juridique", text, re.IGNORECASE):
        match = re.search(r"vendu\s+occup[ée]|occupation\s+juridique", text, re.IGNORECASE)
        if match:
            claims.append(_claim("legal_possession", "occupied", _quote(text, match), raw_sale=raw_sale, subject_scope="asset"))

    claims.extend(_explicit_room_claims(text, raw_sale))
    return claims


def extract_source_property_features(raw_sale: Mapping[str, Any]) -> dict[str, Any]:
    """Extract technical facts without changing canonical sale fields."""

    fields: dict[str, Any] = {}
    evidence: list[dict[str, Any]] = []
    for claim in _technical_claims(raw_sale):
        _append_claim(fields, evidence, claim)
    return {
        "schema_version": PROPERTY_FEATURE_SCHEMA_VERSION,
        "fields": fields,
        "evidence": evidence,
        "source_url": _source_url(raw_sale),
        "extraction_status": "complete" if evidence else "no_explicit_facts",
    }


def _value_field(raw_sale: Mapping[str, Any], key: str) -> Any:
    value = raw_sale.get(key)
    if value is not None and value != "":
        return value
    features = raw_sale.get("source_property_features")
    if isinstance(features, Mapping):
        field = features.get(key)
        if isinstance(field, Mapping):
            return field.get("value")
    return None


def _without_generated_feature_claims(value: Any) -> Any:
    """Remove claims produced by an earlier attach pass before recomputing.

    Structured API/parser trees remain trusted inputs.  Claims written by this
    module are recomputed from the retained source text instead of becoming a
    new source for a later pass.
    """

    if isinstance(value, Mapping):
        if value.get("origin") == _GENERATED_FEATURE_ORIGIN:
            return None
        result: dict[str, Any] = {}
        for key, item in value.items():
            if key == "_extracted":
                continue
            filtered = _without_generated_feature_claims(item)
            if filtered not in (None, "", [], {}):
                result[key] = filtered
        return result
    if isinstance(value, list):
        return [
            filtered
            for item in value
            if (filtered := _without_generated_feature_claims(item)) not in (None, "", [], {})
        ]
    if isinstance(value, tuple):
        return tuple(
            filtered
            for item in value
            if (filtered := _without_generated_feature_claims(item)) not in (None, "", [], {})
        )
    return value


def _evidence_field(raw_sale: Mapping[str, Any], key: str) -> str:
    features = raw_sale.get("source_property_features")
    if isinstance(features, Mapping):
        field = features.get(key)
        if isinstance(field, Mapping):
            return _clean(field.get("evidence"))
    return ""


def _procedure_family(raw_sale: Mapping[str, Any], text: str) -> tuple[str, str, list[dict[str, Any]]]:
    """Resolve a procedure only from verified metadata or explicit text.

    ``source_name`` is returned as a hint by the caller but never decides the
    family.  This avoids treating an aggregator's branding as legal proof.
    """

    evidence: list[dict[str, Any]] = []
    verified = raw_sale.get("sale_procedure")
    if isinstance(verified, Mapping):
        verification_block = verified.get("verification")
        nested_status = verification_block.get("status") if isinstance(verification_block, Mapping) else None
        status = _fold(
            nested_status
            or verified.get("verification_status")
            or verified.get("status")
            or raw_sale.get("sale_verification_status")
        )
        venue = _fold(
            verified.get("venue_type")
            or verified.get("procedure_family")
            or verified.get("family")
            or raw_sale.get("sale_venue_type")
        )
        legal = _fold(verified.get("legal_framework") or raw_sale.get("sale_legal_framework"))
        is_verified = status in {"verified", "cross_checked", "explicit", "source_verified"}
        # A state sale can be administered through a notarial venue.  The
        # verified legal framework is the governing procedure; retain the
        # notarial venue as a complementary modality for its window/bid/visit
        # facts instead of allowing it to replace the state-sale priorities.
        if is_verified and legal and ("etat" in legal or "state" in legal):
            evidence.append({
                "field": "procedure_family",
                "value": "state",
                "quote": _clip(_clean(verified)),
                "provenance": "verified_metadata",
                "state": "present",
            })
            if venue in {"notary", "notarial"}:
                evidence.append({
                    "field": "procedure_modality",
                    "value": "notarial",
                    "quote": "venue_type=notary",
                    "provenance": "verified_metadata",
                    "state": "present",
                })
            return "state", "verified_metadata", evidence
        if is_verified and venue:
            family = "judicial" if venue in {"tribunal", "judicial", "auction_court"} else "notarial" if venue in {"notary", "notarial"} else "state" if venue in {"state", "cessions_etat", "public_state"} else "unknown"
            if family != "unknown":
                evidence.append({"field": "procedure_family", "value": family, "quote": _clip(_clean(verified)), "provenance": "verified_metadata", "state": "present"})
                return family, "verified_metadata", evidence
        if is_verified and legal:
            if "notari" in legal:
                return "notarial", "verified_metadata", evidence
            if "judicia" in legal or "tribunal" in legal:
                return "judicial", "verified_metadata", evidence
            if "etat" in legal or "state" in legal:
                return "state", "verified_metadata", evidence

    folded = _fold(text)
    matches: list[tuple[str, str, str]] = []
    if re.search(r"tribunal\s+judiciaire|tribunal\s+de\s+grande\s+instance|juge de l[' ]ex[ée]cution|audience d[' ]adjudication", folded):
        matches.append(("judicial", "explicit_text", "tribunal/audience"))
    if re.search(r"vente\s+notariale|notaire|[ée]tude notariale|chambre des notaires", folded):
        matches.append(("notarial", "explicit_text", "notary"))
    if re.search(r"cessions? de l[' ]etat|domaine de l[' ]etat|appel d[' ]offres de l[' ]etat|service des domaines|direction generale des finances publiques|dgfip", folded):
        matches.append(("state", "explicit_text", "state"))
    families = {item[0] for item in matches}
    if len(families) == 1:
        family, provenance, marker = matches[0]
        evidence.append({"field": "procedure_family", "value": family, "quote": marker, "provenance": provenance, "state": "present"})
        return family, provenance, evidence
    if len(families) > 1:
        for family, provenance, marker in matches:
            evidence.append({"field": "procedure_family", "value": family, "quote": marker, "provenance": provenance, "state": "conflict"})
        return "unknown", "conflict", evidence
    return "unknown", "pending_verification", evidence


def _procedure_field(
    field: str,
    value: Any,
    *,
    raw_sale: Mapping[str, Any],
    quote: str = "",
    state: str = "present",
    provenance: str = "explicit",
) -> dict[str, Any]:
    if value is None or value == "" or value == [] or value == {}:
        return {
            "state": "unknown" if state == "present" else state,
            "value": None,
            "provenance": "unavailable",
            "subject_scope": "sale",
            "evidence": quote,
        }
    return {
        "state": state,
        "value": value,
        "provenance": provenance,
        "subject_scope": "sale",
        "evidence": quote,
        "source_url": _source_url(raw_sale),
    }


def _matching_documents(raw_sale: Mapping[str, Any], pattern: str) -> list[str]:
    values: list[str] = []
    for value in _text_values(raw_sale.get("documents")):
        if re.search(pattern, _fold(value), re.IGNORECASE):
            values.append(value)
    return list(dict.fromkeys(values))


def _lawyer_bar(text: str) -> tuple[str | None, str | None]:
    match = re.search(r"(?:barreau|inscrit(?:e)?\s+au\s+barreau)\s*(?:de|d['’])?\s*([A-Za-zÀ-ÿ' -]{2,60})", text, re.IGNORECASE)
    if not match:
        return None, None
    quote = _clip(match.group(0))
    return match.group(1).strip(" .,-"), quote


def _consignation(raw_sale: Mapping[str, Any], text: str) -> tuple[Any, str]:
    match = re.search(
        r"(?:consignation|garantie|ch[eè]que de banque|caution bancaire)[^.;\n]{0,140}",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None, ""
    quote = match.group(0).strip()
    rate_match = re.search(r"(\d{1,2}(?:[,.]\d+)?)\s*%", quote)
    amount_match = re.search(r"([\d\s\u202f.,]+)\s*€", quote)
    value: dict[str, Any] = {"methods": []}
    for method, pattern in (
        ("bank_cheque", r"ch[eè]que de banque"),
        ("bank_guarantee", r"caution bancaire"),
        ("consignation", r"consignation"),
    ):
        if re.search(pattern, quote, re.IGNORECASE):
            value["methods"].append(method)
    if rate_match:
        value["rate_pct"] = _number(rate_match.group(1))
    if amount_match:
        value["amount_eur"] = _number(amount_match.group(1))
    return value, quote


def build_procedure_profile(raw_sale: Mapping[str, Any]) -> dict[str, Any]:
    """Build procedure-specific completeness priorities from verified facts."""

    text = _corpus(raw_sale)
    family, verification, family_evidence = _procedure_family(raw_sale, text)
    source_hint = _clean(raw_sale.get("source_name") or raw_sale.get("source")) or None
    fields: dict[str, Any] = {}
    evidence: list[dict[str, Any]] = list(family_evidence)
    complementary_families = list(
        dict.fromkeys(
            str(item.get("value"))
            for item in family_evidence
            if item.get("field") == "procedure_modality" and item.get("value")
        )
    )

    def add(field: str, value: Any, quote: str = "", *, state: str = "present", provenance: str = "explicit") -> None:
        fields[field] = _procedure_field(field, value, raw_sale=raw_sale, quote=quote, state=state, provenance=provenance)
        if value not in (None, "", [], {}):
            evidence.append({
                "field": field,
                "value": value,
                "quote": _clip(quote),
                "source_url": _source_url(raw_sale),
                "source_kind": "source_listing",
                "subject_scope": "sale",
                "provenance": provenance,
                "state": state,
            })

    if family == "judicial":
        priorities = ["audience", "tribunal", "eligible_lawyer", "consignation", "conditions_documents"]
        sale_date = raw_sale.get("sale_date")
        add("audience", sale_date, _evidence_field(raw_sale, "sale_date"))
        tribunal = raw_sale.get("tribunal")
        add("tribunal", tribunal, _clean(tribunal))
        lawyer = raw_sale.get("lawyer_name") or raw_sale.get("lawyer_contact")
        bar, bar_quote = _lawyer_bar(text)
        lawyer_value = {"name": raw_sale.get("lawyer_name"), "contact": raw_sale.get("lawyer_contact"), "bar": bar}
        lawyer_value = {key: value for key, value in lawyer_value.items() if value not in (None, "")}
        add("eligible_lawyer", lawyer_value if lawyer_value else lawyer, bar_quote or _clean(lawyer))
        consign_value, consign_quote = _consignation(raw_sale, text)
        add("consignation", consign_value, consign_quote)
        # A diagnostic is a separate technical document.  It cannot by itself
        # prove that the sale conditions/cahier were published.
        docs = _matching_documents(raw_sale, r"conditions|cahier|pv|proc[eè]s[- ]verbal")
        add("conditions_documents", docs, " ; ".join(docs))
    elif family == "notarial":
        priorities = ["notary_study", "sale_window", "bid", "visits", "coownership"]
        study_match = _first_match(text, (r"(?:[ée]tude|office|notaire)\s*:?\s*([^.;\n]{2,100})",))
        study = _clean(study_match.group(1)) if study_match else None
        add("notary_study", study, _quote(text, study_match) if study_match else "")
        schedule = raw_sale.get("source_sale_schedule") or raw_sale.get("sale_schedule")
        add("sale_window", schedule, _clean(schedule))
        bid_match = _first_match(text, (r"(?:ench[eè]res|offres?)\s+(?:en ligne|online|sur internet)", r"vente\s+interactive"))
        bid = _clean(bid_match.group(0)) if bid_match else None
        add("bid", bid, _quote(text, bid_match) if bid_match else "")
        visits = raw_sale.get("visit_dates") or raw_sale.get("visits")
        add("visits", visits, _clean(visits))
        copro = raw_sale.get("source_property_features", {})
        copro_value = copro.get("coownership") if isinstance(copro, Mapping) else None
        if copro_value is None and re.search(r"\bcopropri[eé]t[ée]\b", text, re.IGNORECASE):
            copro_value = {"is_coownership": True}
        add("coownership", copro_value, _evidence_field(raw_sale, "coownership"))
    elif family == "state":
        priorities = ["sale_method", "manager", "cadastre", "urbanism", "conditions", "deadline"]
        method_match = _first_match(text, (r"cession\s+amiable", r"appel\s+d[' ]offres", r"adjudication", r"vente\s+aux\s+ench[eè]res"))
        add("sale_method", _clean(method_match.group(0)) if method_match else None, _quote(text, method_match) if method_match else "")
        manager_match = _first_match(
            text,
            (
                r"\b(?:organisateur|gestionnaire|direction)\b\s*:?[ \t]*([^.;\n]{2,100})",
                r"\bservice(?:\s+(?:des|de la|de l['’]))?[ \t]+[^.;\n]{2,100}",
            ),
        )
        if manager_match:
            manager_value = _clean(manager_match.group(1) if manager_match.lastindex else manager_match.group(0))
        else:
            manager_value = raw_sale.get("organizer") or raw_sale.get("manager")
        add("manager", manager_value, _quote(text, manager_match) if manager_match else "")
        cadastral = [value for value in _text_values(raw_sale.get("source_blocks")) if re.search(r"cadastre|section|parcelle", _fold(value))]
        add("cadastre", list(dict.fromkeys(cadastral)), " ; ".join(cadastral))
        urbanism = [value for value in _text_values(raw_sale.get("source_blocks")) if re.search(r"urbanisme|plu|zonage|constructibilit", _fold(value))]
        add("urbanism", list(dict.fromkeys(urbanism)), " ; ".join(urbanism))
        conditions = _matching_documents(raw_sale, r"condition|cahier|r[eè]glement")
        if not conditions:
            match = re.search(r"conditions?[^.;\n]{0,160}", text, re.IGNORECASE)
            conditions = [match.group(0).strip()] if match else []
        add("conditions", conditions, " ; ".join(conditions))
        deadline_match = _first_match(text, (r"date\s+limite[^.;\n]{0,100}", r"cl[oô]ture[^.;\n]{0,100}", r"avant\s+le\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"))
        add("deadline", _clean(deadline_match.group(0)) if deadline_match else None, _quote(text, deadline_match) if deadline_match else "")
        if "notarial" in complementary_families:
            add(
                "notarial_modality",
                {"venue_type": "notary"},
                "venue_type=notary",
                provenance="verified_metadata",
            )
    else:
        priorities = []

    missing = [field for field in priorities if fields.get(field, {}).get("state") == "unknown"]
    return {
        "schema_version": PROCEDURE_PROFILE_SCHEMA_VERSION,
        "family": family,
        "verification_status": verification,
        "source_hint": source_hint,
        "complementary_families": complementary_families,
        "priorities": priorities,
        "fields": fields,
        "missing_priority_fields": missing,
        "evidence": evidence,
        "source_url": _source_url(raw_sale),
    }


def build_source_field_observations(
    raw_sale: Mapping[str, Any],
    property_features: Mapping[str, Any] | None = None,
    procedure_profile: Mapping[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Project profile evidence into the UI/recompute observation contract.

    Observation keys are stable catalogue paths rather than canonical model
    field names.  This lets later recomputes rebuild the same observations
    from ``raw_text`` and source blocks without scraping again.
    """

    features = property_features or raw_sale.get("source_property_features") or {}
    profile = procedure_profile or raw_sale.get("source_procedure_profile") or {}
    captured_at = raw_sale.get("captured_at") or raw_sale.get("checked_at")
    processing_at = raw_sale.get("processing_at")
    url = _source_url(raw_sale)
    observations: dict[str, dict[str, Any]] = {}

    def inference_contract(key: str, claim: Mapping[str, Any], state: str) -> dict[str, Any] | None:
        """Return the explicit contract required for an inferred observation.

        Parser fields can be useful without a matching phrase in the retained
        source text, but the UI must be able to tell that they are inferred.
        Keep this contract deterministic so recomputes produce the same
        metadata from the same raw payload.
        """

        if state != "inferred":
            return None
        candidate = claim.get("inference")
        candidate = candidate if isinstance(candidate, Mapping) else {}
        method = _clean(candidate.get("method") or claim.get("inference_method"))
        method = method or "deterministic_source_inference"
        raw_inputs = candidate.get("input_fields") or claim.get("input_fields")
        if isinstance(raw_inputs, (list, tuple)):
            input_fields = [_clean(item) for item in raw_inputs if _clean(item)]
        else:
            input_fields = []
        if not input_fields:
            input_fields = [key]
        confidence = candidate.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            confidence = claim.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            confidence = 0.6
        return {
            "method": method,
            "input_fields": input_fields,
            "confidence": float(confidence),
        }

    def conflict_rows(
        key: str,
        value: Any,
        claim: Mapping[str, Any],
        evidence_rows: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Attach one source-backed row to every competing value.

        ``conflicts`` is intentionally a small, stable transport shape.  The
        full evidence remains in ``evidence``; these rows give the TypeScript
        consumer the value-level proof it needs to render a conflict.
        """

        values = claim.get("values")
        if not isinstance(values, list) or not values:
            values = [value]
        rows: list[dict[str, Any]] = []
        source_evidence = evidence_rows or [{}]
        for candidate_value in values:
            for item in source_evidence:
                rows.append(
                    {
                        "source_url": item.get("source_url") or url,
                        "excerpt": _clean(item.get("quote") or claim.get("evidence") or claim.get("quote")),
                        "captured_at": item.get("captured_at") or captured_at,
                        "value": candidate_value,
                    }
                )
        return rows

    def unique_rows(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for row in rows:
            normalized = dict(row)
            if normalized not in result:
                result.append(normalized)
        return result

    def add(key: str, claim: Mapping[str, Any]) -> None:
        raw_state = _clean(claim.get("state")) or "unknown"
        state = "observed" if raw_state == "present" else raw_state
        provenance = _clean(claim.get("provenance")) or "explicit"
        grade = {"explicit": "A", "verified_metadata": "A", "explicit_text": "A", "parser_field": "B", "inferred": "C", "unavailable": "none"}.get(provenance, "B")
        if state == "not_applicable":
            grade = "none"
        elif state == "conflict":
            grade = "C"
        elif state == "unknown" and not claim.get("value"):
            grade = "none"
        quote = _clean(claim.get("evidence") or claim.get("quote"))
        if not quote and grade == "A":
            # A canonical parser field without a retained source quote is
            # useful but cannot receive the same grade as an observed quote.
            grade = "B"
        observation = {
            "value": claim.get("value"),
            "state": state,
            "evidence": [
                {
                    "source_url": url,
                    "locator": f"{url}#text" if url else "source_text",
                    "quote": quote,
                    "grade": grade,
                    "captured_at": captured_at,
                    "processing_at": processing_at,
                }
            ] if quote or claim.get("value") is not None else [],
            "provenance": provenance,
            "subject_scope": claim.get("subject_scope", "asset"),
        }
        inference = inference_contract(key, claim, state)
        if inference is not None:
            observation["inference"] = inference
        if state == "conflict":
            observation["conflicts"] = conflict_rows(
                key,
                claim.get("value"),
                claim,
                observation.get("evidence", []),
            )
        existing = observations.get(key)
        if not existing:
            observations[key] = observation
            return
        if existing.get("value") == observation.get("value"):
            existing_evidence = existing.setdefault("evidence", [])
            for item in observation.get("evidence", []):
                if item not in existing_evidence:
                    existing_evidence.append(item)
            if existing.get("state") == "unknown" and observation.get("state") != "unknown":
                existing["state"] = observation["state"]
                if observation.get("inference") is not None:
                    existing["inference"] = observation["inference"]
            return
        previous_values = existing.get("values") if isinstance(existing.get("values"), list) else [existing.get("value")]
        current_values = observation.get("value")
        current_values = current_values if isinstance(current_values, list) else [current_values]
        previous_evidence = list(existing.get("evidence", []))
        current_evidence = list(observation.get("evidence", []))
        existing["state"] = "conflict"
        existing["values"] = _unique_values([*previous_values, *current_values])
        existing.setdefault("evidence", []).extend(
            item for item in observation.get("evidence", []) if item not in existing["evidence"]
        )
        prior_conflicts = existing.get("conflicts")
        if not isinstance(prior_conflicts, list):
            prior_conflicts = conflict_rows(
                key,
                previous_values[0] if previous_values else existing.get("value"),
                {"value": previous_values[0] if previous_values else existing.get("value"), "values": previous_values},
                previous_evidence,
            )
        current_conflicts = conflict_rows(
            key,
            observation.get("value"),
            {"value": observation.get("value"), "values": current_values},
            current_evidence,
        )
        existing["conflicts"] = unique_rows([*prior_conflicts, *current_conflicts])

    def add_projected(key: str, claim: Mapping[str, Any]) -> None:
        for observation_id, projected in _feature_claim_projections(key, claim):
            add(observation_id, projected)

    if isinstance(features, Mapping):
        for field, claim in _feature_claims(features, raw_sale=raw_sale):
            add_projected(field, claim)
    # A few adapters expose canonical values beside the rich feature tree.
    # Project those values too, otherwise the detail API's habitable/Carrez
    # surfaces and tax facts disappear before the catalogue layer sees them.
    direct_feature_fields = (
        "habitable_surface_m2",
        "carrez_surface_m2",
        "surface_m2",
        "surface_scope",
        "surface_source",
        "land_surface_m2",
        "land_surface_scope",
        "floor",
        "building_floors_count",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "showers_count",
        "wc_count",
        "parking_count",
        "dpe_class",
        "dpe_value",
        "ges_class",
        "ges_value",
        "dpe_date",
        "ges_date",
        "dpe_valid_until",
        "dpe_number",
        "property_tax_eur",
        "property_tax_amount_eur",
        "coownership_charges_annual_eur",
        "heating",
        "hot_water",
        "occupancy_physical",
    )
    for field in direct_feature_fields:
        value = raw_sale.get(field)
        if value in (None, "", [], {}):
            continue
        add_projected(
            field,
            {
                "field": field,
                "value": value,
                "state": "present",
                "provenance": "parser_field",
                "subject_scope": "asset",
                "evidence": _legacy_feature_quote(raw_sale, field, value),
            },
        )
    if isinstance(profile, Mapping):
        family = _clean(profile.get("family")) or "unknown"
        add_projected(
            "procedure_family",
            {
                "value": family if family != "unknown" else None,
                "state": "present" if family != "unknown" else "unknown",
                "provenance": profile.get("verification_status") or "unavailable",
                "subject_scope": "sale",
                "evidence": next(
                    (
                        _clean(item.get("quote"))
                        for item in profile.get("evidence", [])
                        if isinstance(item, Mapping) and item.get("field") == "procedure_family"
                    ),
                    "",
                ),
            },
        )
        fields = profile.get("fields")
        if isinstance(fields, Mapping):
            for field, claim in fields.items():
                if isinstance(claim, Mapping):
                    add_projected(str(field), claim)
    return observations


def _bounded_block_features(features: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the UI block projection shallow and free of raw media/doc payloads."""

    blocked = {"media", "contact", "images", "documents", "contacts", "_extracted"}
    projection: dict[str, Any] = {}
    for key, value in features.items():
        if str(key) in blocked or str(key).startswith("_"):
            continue
        if _is_claim_mapping(value):
            projection[str(key)] = {
                field: value.get(field)
                for field in ("value", "state", "provenance", "subject_scope", "evidence")
                if field in value
            }
        elif isinstance(value, (str, int, float, bool)):
            projection[str(key)] = value
    return projection


def attach_source_property_features(raw_sale: dict[str, Any]) -> dict[str, Any]:
    """Attach feature and procedure profiles to a parser payload in place."""

    view = _input_view(raw_sale)
    existing_features = view.get("source_property_features")
    existing_features = _without_generated_feature_claims(existing_features)
    existing_features = existing_features if isinstance(existing_features, Mapping) else {}
    extracted = extract_source_property_features(view)
    merged_features = dict(existing_features)
    feature_collisions: dict[str, Any] = {}
    for field, claim in extracted["fields"].items():
        if field not in merged_features or merged_features[field] in (None, "", [], {}):
            merged_features[field] = claim
        elif merged_features[field] != claim:
            feature_collisions[field] = claim
    if feature_collisions:
        extracted_bucket = merged_features.get("_extracted")
        extracted_bucket = dict(extracted_bucket) if isinstance(extracted_bucket, Mapping) else {}
        extracted_bucket.update(feature_collisions)
        merged_features["_extracted"] = extracted_bucket
    raw_sale["source_property_features"] = merged_features
    existing_evidence = _without_generated_feature_claims(view.get("source_property_feature_evidence"))
    existing_evidence = existing_evidence if isinstance(existing_evidence, list) else []
    raw_sale["source_property_feature_evidence"] = [
        *existing_evidence,
        *[item for item in extracted["evidence"] if item not in existing_evidence],
    ]
    raw_sale["source_property_features_meta"] = {
        "schema_version": extracted["schema_version"],
        "extraction_status": extracted["extraction_status"],
        "source_url": extracted["source_url"],
    }
    profile_input = dict(view)
    profile_input["source_property_features"] = merged_features
    raw_sale["source_procedure_profile"] = build_procedure_profile(profile_input)
    raw_sale["source_field_observations"] = build_source_field_observations(
        profile_input,
        merged_features,
        raw_sale["source_procedure_profile"],
    )
    source_blocks = raw_sale.get("source_blocks")
    if source_blocks is None:
        source_blocks = {}
        raw_sale["source_blocks"] = source_blocks
    if isinstance(source_blocks, dict):
        source_blocks["listing_completeness"] = {
            "source_property_features": _bounded_block_features(raw_sale["source_property_features"]),
            "source_field_observations": raw_sale["source_field_observations"],
            "source_procedure_profile": raw_sale["source_procedure_profile"],
            "source_property_features_meta": raw_sale["source_property_features_meta"],
        }
    return raw_sale


__all__ = [
    "PROPERTY_FEATURE_SCHEMA_VERSION",
    "PROCEDURE_PROFILE_SCHEMA_VERSION",
    "attach_source_property_features",
    "build_source_field_observations",
    "build_procedure_profile",
    "extract_source_property_features",
]
