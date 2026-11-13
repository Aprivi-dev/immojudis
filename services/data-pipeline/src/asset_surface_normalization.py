from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from src.asset_normalization_helpers import add_quality_flag, decimal_value, evidence_excerpt
from src.land_parcels import parcel_m2_list, read_parcel_land_surface
from src.lot_scope import describes_one_lot, sale_fact_text
from src.models import AuctionSale
from src.multi_unit_surface import is_single_unit_surface_of_several, single_dwelling_lot_surface
from src.normalize import (
    MIN_DWELLING_SURFACE_M2,
    SURFACE_VALUE_PATTERN,
    _has_explicit_total_surface_evidence,
    _is_ambiguous_mixed_lot_surface,
    _is_coproperty_scoped_land_surface,
    _preferred_surface_evidence_value,
    _surface_evidence_for_value,
    _surface_evidence_matches_value,
    carrez_rejection_basis,
    clean_text,
    is_outside_carrez_context,
    parse_surface,
)
from src.occupancy_statements import OCCUPIED_FAMILY, occupancy_from_text
from src.room_counts import reconcile_room_counts
from src.surface_plausibility import (
    SURFACE_VALUES_CONFLICT_KEY,
    built_surfaces_equal_to_land,
    conflicting_generic_surfaces,
    is_parcel_total,
    parcel_total_surfaces,
    source_proves_built_total,
    text_states_built_surface,
)
from src.surface_text_recovery import built_value_names_other_object
from src.text_fact_scope import private_amenity_mentioned

BUSINESS_RULE_VERSION = "business_rules_v1"

SURFACE_PATTERNS = {
    "habitable_surface_m2": (
        rf"surface\s*habitable\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+habitables?",
    ),
    "carrez_surface_m2": (
        rf"{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\*)\s+(?:loi\s+)?carrez",
        rf"(?:surface\s+)?(?:loi\s+)?carrez\s*(?:totale\s*)?:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"(?:superficie|surface)\s+(?:privative|totale|habitable)?\s*"
        rf"\([^)]*loi\s+carrez[^)]*\)\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
    ),
    "land_surface_m2": (
        rf"\bcadastr[ée]e?.{{0,140}}?\b(?:total|superficie|contenance)\b.{{0,30}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\bsection\s+[A-Z]{{1,4}}\s*(?:n[°o]\s*)?[0-9A-Z]+.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:surface\s+(?:du\s+)?terrain|terrain\s+d['’]environ)\s+(?:d['’]environ\s+|environ\s+|de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        r"\b(?:cadastr[ée]e?.{0,120}?\bpour\s+)?([0-9]+)\s*ares?\s+([0-9]+)\s*centiares?\b",
        rf"(?:terrain|parcelle|jardin).{{0,60}}?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        r"contenance\s+(?:totale\s+)?(?:de\s+)?([0-9]+)\s*a\s*([0-9]+)\s*ca",
        r"([0-9]+)\s*a\s*([0-9]+)\s*ca",
    ),
}

_SURFACE_FIELDS = ("surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2")


def fill_surfaces(sale: AuctionSale, text: str) -> None:
    # Values reloaded from a stored payload can come back as text ("45.5"):
    # every comparison below needs numbers (drain of 12/10/2026).
    for field in _SURFACE_FIELDS:
        value = getattr(sale, field, None)
        if value is not None and not isinstance(value, Decimal):
            setattr(sale, field, decimal_value(value))
    conflicting_values = _record_conflicting_surface_values(sale)
    ambiguous_mixed_lot_surface = (
        _is_ambiguous_mixed_lot_surface(sale.property_type or "", text)
        or _is_unestablished_multi_unit_surface(sale, text)
        or bool(conflicting_values)
    )
    if ambiguous_mixed_lot_surface:
        # A generic structured value can be the first lot's area. Keep the
        # typed measurements for audit, but do not expose one as the sale-wide
        # application surface while the total remains unknown.
        sale.surface_m2 = None
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        sale.surface_scope = "unknown"
        add_quality_flag(sale, "ambiguous_surface")
    if sale.habitable_surface_m2 is None:
        sale.habitable_surface_m2 = _extract_surface_kind(text, "habitable_surface_m2", sale)
    text_carrez_surface = _extract_surface_kind(text, "carrez_surface_m2", sale)
    if sale.carrez_surface_m2 is None:
        sale.carrez_surface_m2 = text_carrez_surface
    elif not _carrez_surface_is_document_backed(sale) and _should_prefer_text_measured_surface(
        sale.carrez_surface_m2,
        text_carrez_surface,
    ):
        previous_carrez_surface = sale.carrez_surface_m2
        sale.carrez_surface_m2 = text_carrez_surface
        sale.raw_payload["carrez_surface_reconciliation"] = {
            "status": "resolved",
            "rejected_carrez_surface_m2": str(previous_carrez_surface),
            "resolved_carrez_surface_m2": str(text_carrez_surface),
            "basis": "explicit_decimal_carrez_text",
        }
        add_quality_flag(sale, "surface_conflict_resolved")
    coproperty_scoped_land_surface = _is_coproperty_scoped_land_surface(sale.raw_payload, text)
    text_land_surface = (
        None
        if coproperty_scoped_land_surface
        else _extract_surface_kind(text, "land_surface_m2", sale)
    )
    if coproperty_scoped_land_surface and sale.land_surface_m2 is not None:
        sale.land_surface_m2 = None
        add_quality_flag(sale, "parcel_surface_scope_unverified")
    if sale.land_surface_m2 is None:
        sale.land_surface_m2 = text_land_surface
    elif _should_prefer_text_land_surface(sale, text_land_surface):
        previous_land_surface = sale.land_surface_m2
        sale.land_surface_m2 = text_land_surface
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "resolved",
            "rejected_land_surface_m2": str(previous_land_surface),
            "resolved_land_surface_m2": str(text_land_surface),
            "basis": "explicit_land_text_over_stored_value",
        }
        add_quality_flag(sale, "land_surface_conflict_resolved")
    elif text_land_surface is None and _should_clear_misclassified_land_surface(sale):
        rejected_land_surface = sale.land_surface_m2
        sale.land_surface_m2 = None
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "removed",
            "rejected_land_surface_m2": str(rejected_land_surface),
            "resolved_land_surface_m2": None,
            "basis": "duplicated_built_surface_without_land_evidence",
        }
        add_quality_flag(sale, "land_surface_conflict_resolved")
    _sum_listed_land_parcels(sale, text)
    _drop_dwelling_surfaces_of_bare_land(sale)
    rejected_equal_to_land = _reject_built_surface_equal_to_land(sale)
    _discard_placeholder_built_surface(sale)
    text_built_surface = _extract_built_surface(text, sale)
    if text_built_surface is None and sale.property_type in {"apartment", "house"} and not ambiguous_mixed_lot_surface:
        # Lots de copropriété : le seul logement, les autres lots étant des annexes (991d7119).
        text_built_surface = single_dwelling_lot_surface(text)
    if sale.surface_m2 is None:
        sale.surface_m2 = text_built_surface
    elif _should_prefer_text_built_surface(sale, text_built_surface):
        previous_surface = sale.surface_m2
        sale.surface_m2 = text_built_surface
        # A corrected generic area does not establish its legal measurement kind.
        if sale.habitable_surface_m2 == previous_surface:
            sale.habitable_surface_m2 = _extract_surface_kind(text, "habitable_surface_m2", sale)
        if sale.carrez_surface_m2 == previous_surface:
            sale.carrez_surface_m2 = text_carrez_surface
        if _corroborated_text_built_surface(sale) == text_built_surface:
            _record_surface_conflict_resolution(sale, previous_surface, text_built_surface)
    rejected_equal_to_land = _reject_built_surface_equal_to_land(sale) or rejected_equal_to_land
    if carrez_basis := carrez_rejection_basis(sale.carrez_surface_m2, sale.habitable_surface_m2):
        # Une Carrez à moins de 20 % de la surface habitable est une partie du bien (cave, surface hors Carrez),
        # une Carrez au-dessus de l'habitable (plus 2 %) est impossible : la surface habitable fait foi, la
        # valeur écartée reste tracée.
        rejected_carrez_surface = sale.carrez_surface_m2
        if sale.surface_m2 == rejected_carrez_surface:
            sale.surface_m2 = None
        sale.carrez_surface_m2 = None
        sale.raw_payload["carrez_surface_reconciliation"] = {
            "status": "removed",
            "rejected_carrez_surface_m2": str(rejected_carrez_surface),
            "resolved_carrez_surface_m2": None,
            "habitable_surface_m2": str(sale.habitable_surface_m2),
            "basis": carrez_basis,
        }
        add_quality_flag(sale, "surface_conflict_resolved")
    _prefer_carrez_over_smaller_generic_surface(sale)
    explicit_app_surface = None
    min_app_surface = Decimal("20")
    if sale.property_type == "apartment":
        explicit_app_surface = sale.carrez_surface_m2 or sale.habitable_surface_m2
        min_app_surface = Decimal("9")
    elif sale.property_type == "house":
        explicit_app_surface = sale.habitable_surface_m2
    if explicit_app_surface is not None and explicit_app_surface >= min_app_surface:
        sale.surface_m2 = explicit_app_surface
    if sale.land_surface_m2 is not None and sale.property_type not in {
        "land",
        "house",
        "building",
        "commercial",
        "mixed",
    }:
        sale.land_surface_m2 = None
    _set_app_surface(sale)
    if ambiguous_mixed_lot_surface:
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        sale.surface_scope = "unknown"
    _validate_app_surface_scope(sale)
    stale_land_source = sale.surface_source == "land_surface_m2" and (
        sale.land_surface_m2 is None or sale.app_surface_kind not in {None, "land"}
    )
    if stale_land_source:
        # Provenance d'un terrain écarté ou remplacé (e538fab2, ebafd1c4) : elle ne décrit plus la surface retenue.
        sale.surface_source = None
    _reconcile_surface_evidence(sale, text, ambiguous_mixed_lot_surface=ambiguous_mixed_lot_surface)
    if stale_land_source and sale.surface_source is None and sale.surface_evidence:
        sale.surface_source = "source_text"
    _flag_ambiguous_surface(sale)
    _flag_source_surface_conflict(sale)
    if rejected_equal_to_land and sale.app_surface_m2 is None:
        add_quality_flag(sale, "ambiguous_surface")
    if (
        sale.surface_scope is None
        and sale.app_surface_m2 is None
        and sale.land_surface_m2 is not None
        and sale.property_type in {"house", "building"}
    ):
        sale.surface_scope = "land"


_SOURCE_HEADER_SURFACE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*m\s*(?:2|²)\s+superficie\b", re.I)


def _flag_source_surface_conflict(sale: AuctionSale) -> None:
    """Fiche et document ne donnent pas la même surface : la valeur nommée retenue reste, l'écart est signalé.

    Règle (audit du 03/11/2026, 85136d47 : fiche « 78.78 m² superficie », descriptif « Superficie privative (Loi
    Carrez – hors balcon) : 78,20 m² » ; 332be623 : fiche 44,12 m², procès-verbal « superficie habitable de 45.45
    m2 ») : une surface nommée (Carrez, habitable, totale) l'emporte sur un compteur sans libellé ; l'écart est
    tracé dans ``raw_payload["surface_source_conflict"]`` et marqué ``surface_source_conflict``.
    """
    selected = sale.app_surface_m2
    if selected is None or sale.property_type == "land":
        return
    blocks = sale.raw_payload.get("source_blocks")
    header = _SOURCE_HEADER_SURFACE_RE.search(sale.raw_text or "")
    source_value = (
        parse_surface(sale.raw_payload.get("surface_m2"))
        or (parse_surface(blocks.get("surface")) if isinstance(blocks, dict) else None)
        or (parse_surface(header.group(1)) if header else None)
    )
    if source_value is None or abs(source_value - selected) <= max(Decimal("0.1"), selected * Decimal("0.005")):
        return
    if source_value in {sale.land_surface_m2, sale.carrez_surface_m2, sale.habitable_surface_m2}:
        return
    sale.raw_payload["surface_source_conflict"] = {
        "source_surface_m2": str(source_value),
        "selected_surface_m2": str(selected),
        "selected_surface_kind": sale.app_surface_kind,
        "rule": "named_measurement_wins_over_unlabelled_source_counter",
    }
    add_quality_flag(sale, "surface_source_conflict")


def _prefer_carrez_over_smaller_generic_surface(sale: AuctionSale) -> None:
    """Une Carrez supérieure à la surface du bien est impossible : la valeur nommée (Carrez) fait foi.

    8f9e445d : « surface selon Loi Carrez au rez-de-chaussée de 62,95 m² … au 1er étage 48,30 m² surface totale
    Loi Carrez 111,25 m² » affichait 62,95 m² (un niveau) avec une Carrez de 111,25 m².
    """
    carrez, generic = sale.carrez_surface_m2, sale.surface_m2
    if carrez is None or generic is None or sale.habitable_surface_m2 is not None:
        return
    if carrez <= generic + max(Decimal("1"), generic * Decimal("0.02")):
        return
    sale.raw_payload["surface_reconciliation"] = {
        "status": "resolved",
        "rejected_surface_m2": str(generic),
        "resolved_surface_m2": str(carrez),
        "basis": "carrez_greater_than_generic_surface",
    }
    sale.surface_m2 = carrez
    if sale.app_surface_m2 == generic:
        sale.app_surface_m2 = None
    add_quality_flag(sale, "surface_conflict_resolved")


def _drop_dwelling_surfaces_of_bare_land(sale: AuctionSale) -> None:
    """Un terrain n'a pas de surface habitable ni Carrez : celle lue vient d'un autre lot du même dossier.

    d788c7bd : lot de parcelles non bâties (« 4a 13ca … 5a 04ca ») affiché avec « la surface habitable du bien est
    de 101,3 m2 », lue dans le procès-verbal du lot 1.
    """
    if sale.property_type != "land":
        return
    rejected = {
        field: str(value)
        for field in ("habitable_surface_m2", "carrez_surface_m2")
        if (value := getattr(sale, field)) is not None
    }
    if not rejected:
        return
    if sale.surface_m2 is not None and sale.surface_m2 in {sale.habitable_surface_m2, sale.carrez_surface_m2}:
        sale.surface_m2 = None
    sale.habitable_surface_m2 = None
    sale.carrez_surface_m2 = None
    sale.raw_payload["dwelling_surface_on_land_withheld"] = rejected
    add_quality_flag(sale, "ambiguous_surface")


def _sum_listed_land_parcels(sale: AuctionSale, text: str) -> None:
    """Terrain vendu en plusieurs parcelles toutes citées : leur somme, pas la première (ni la dernière).

    « Parcelle YE n°53 de 15 840 m² Parcelle Yi n°75 de 10 065 m² », « deux parcelles … Superficie : 912 et
    871 m2 », « d'une superficie respective de 170 m² et 605 m² » (Cessions de l'État, audit du 03/11/2026).
    Seule une valeur égale à l'une des parcelles citées est remplacée.
    """
    if sale.property_type != "land" or sale.land_surface_m2 is None:
        return
    parcels = parcel_m2_list(text)
    total = sum(parcels, Decimal("0"))
    if len(parcels) < 2 or sale.land_surface_m2 == total or sale.land_surface_m2 not in parcels:
        return
    sale.raw_payload["land_surface_reconciliation"] = {
        "status": "resolved",
        "rejected_land_surface_m2": str(sale.land_surface_m2),
        "resolved_land_surface_m2": str(total),
        "basis": "sum_of_all_listed_parcels",
    }
    sale.land_surface_m2 = total
    add_quality_flag(sale, "land_surface_conflict_resolved")


def _record_conflicting_surface_values(sale: AuctionSale) -> list[Decimal]:
    """Deux valeurs sans qualificatif dans le titre ou la description : la surface reste « à confirmer ».

    Seuls le titre et la description sont comparés (le texte brut d'une page mêle les ventes voisines). Les
    valeurs en conflit sont retirées des surfaces générique et habitable ; le marqueur empêche de les relire
    dans le texte, et la trace garde les valeurs écartées.
    """
    values = conflicting_generic_surfaces("\n".join(filter(None, (sale.title, sale.description))))
    if not values:
        sale.raw_payload.pop(SURFACE_VALUES_CONFLICT_KEY, None)
        return []
    for field in ("surface_m2", "habitable_surface_m2"):
        if getattr(sale, field) in values:
            setattr(sale, field, None)
    sale.raw_payload[SURFACE_VALUES_CONFLICT_KEY] = {
        "status": "to_confirm",
        "values_m2": [str(value) for value in values],
        "basis": "two_unqualified_surface_values_for_the_same_asset",
    }
    return values


def _reject_built_surface_equal_to_land(sale: AuctionSale) -> bool:
    """Retire une surface habitable ou bâtie égale à la surface du terrain (la contenance mal recopiée).

    Quand la page qualifie elle-même cette valeur de surface bâtie (« surface habitable de 167,08 m² », « surface
    bâtie de 259,86 m² ») sans jamais en faire un terrain, c'est le terrain qui est la valeur suspecte : il est
    retiré et la surface bâtie reste.
    """
    fields = list(built_surfaces_equal_to_land(sale))
    if not fields:
        return False
    if _source_states_built_not_land_surface(sale, sale.land_surface_m2):
        sale.raw_payload["land_surface_reconciliation"] = {
            "status": "removed",
            "rejected_land_surface_m2": str(sale.land_surface_m2),
            "resolved_land_surface_m2": None,
            "basis": "land_equal_to_explicit_built_surface",
        }
        sale.land_surface_m2 = None
        add_quality_flag(sale, "land_surface_conflict_resolved")
        return False
    for field in fields:
        setattr(sale, field, None)
    sale.raw_payload["built_surface_equal_to_land_reconciliation"] = {
        "status": "removed",
        "fields": fields,
        "rejected_surface_m2": str(sale.land_surface_m2),
        "basis": "built_surface_equal_to_land_surface",
    }
    add_quality_flag(sale, "surface_conflict_resolved")
    if sale.surface_scope == "total":
        # La portée « totale » se rapportait à la valeur retirée.
        sale.surface_scope = None
    return True


def _reconcile_surface_evidence(
    sale: AuctionSale,
    text: str,
    *,
    ambiguous_mixed_lot_surface: bool,
) -> None:
    """Keep the displayed evidence aligned with the retained surface value."""

    if ambiguous_mixed_lot_surface:
        # A typed lot measurement is retained in its own field, but there is no
        # sale-level surface for the generic evidence trail to cite.
        sale.surface_evidence = None
        sale.surface_source = None
        sale.surface_confidence = None
        return

    value = _preferred_surface_evidence_value(
        sale.property_type or "",
        surface_m2=sale.surface_m2,
        habitable_surface_m2=sale.habitable_surface_m2,
        carrez_surface_m2=sale.carrez_surface_m2,
        land_surface_m2=sale.land_surface_m2,
    )
    if value is None:
        return
    if sale.surface_evidence and _surface_evidence_matches_value(sale.surface_evidence, value):
        return
    evidence = _surface_evidence_for_value(text, value)
    if evidence:
        sale.surface_evidence = evidence
        sale.surface_source = sale.surface_source or "source_text"
    elif sale.surface_evidence:
        # A stale excerpt is worse than an absent citation. It can otherwise
        # make the fiche appear to support a different numeric value.
        sale.surface_evidence = None


def _discard_placeholder_built_surface(sale: AuctionSale) -> None:
    if sale.property_type not in {"house", "building"} or sale.land_surface_m2 is None:
        return
    discarded = False
    if sale.habitable_surface_m2 is not None and sale.habitable_surface_m2 < Decimal("9"):
        sale.habitable_surface_m2 = None
        discarded = True
    if sale.surface_m2 is not None and sale.surface_m2 < Decimal("9") and sale.habitable_surface_m2 is None:
        sale.surface_m2 = None
        discarded = True
    if discarded and sale.app_surface_m2 is not None and sale.app_surface_m2 < Decimal("9"):
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        sale.surface_scope = None


def _should_prefer_text_built_surface(sale: AuctionSale, candidate: Decimal | None) -> bool:
    if candidate is None or sale.surface_m2 is None or candidate == sale.surface_m2:
        return False
    if sale.property_type not in {"house", "apartment", "building"}:
        return False
    if _surface_is_document_backed(sale):
        return False
    if sale.surface_m2 < Decimal("9"):
        return True
    if candidate >= Decimal("20") and candidate > sale.surface_m2:
        return True
    return candidate >= Decimal("9") and _corroborated_text_built_surface(sale) == candidate


def _should_prefer_text_measured_surface(current: Decimal, candidate: Decimal | None) -> bool:
    if candidate is None or candidate == current or candidate < Decimal("9"):
        return False
    if current == current.to_integral_value() and candidate != candidate.to_integral_value():
        return abs(current - candidate) < Decimal("1")
    if min(current, candidate) <= 0:
        return False
    return max(current, candidate) / min(current, candidate) >= Decimal("1.5")


def _surface_is_document_backed(sale: AuctionSale) -> bool:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("source") != "pdf":
        return sale.surface_source == "pdf"
    documented_value = parse_surface(extraction.get("value_m2"))
    return documented_value is not None and documented_value == sale.surface_m2


def _carrez_surface_is_document_backed(sale: AuctionSale) -> bool:
    extraction = sale.raw_payload.get("surface_extraction")
    if not isinstance(extraction, dict) or extraction.get("source") != "pdf":
        return sale.surface_source == "pdf"
    documented_value = parse_surface(extraction.get("value_m2"))
    return documented_value is not None and documented_value == sale.carrez_surface_m2


def _should_prefer_text_land_surface(sale: AuctionSale, candidate: Decimal | None) -> bool:
    current = sale.land_surface_m2
    if candidate is None or current is None or candidate == current:
        return False
    extraction = sale.raw_payload.get("land_surface_extraction")
    if isinstance(extraction, dict) and extraction.get("source") == "pdf":
        documented_value = parse_surface(extraction.get("value_m2"))
        if documented_value == current:
            return False
    built_values = _built_surface_values(sale)
    if current in built_values and candidate not in built_values:
        return True
    if candidate < current:
        return False
    current_digits = _surface_integer_digits(current)
    candidate_digits = _surface_integer_digits(candidate)
    if not current_digits or not candidate_digits:
        return False
    return candidate_digits.endswith(current_digits) or (
        candidate >= current * Decimal("9") and candidate <= current * Decimal("11")
    )


def _surface_integer_digits(value: Decimal) -> str | None:
    if value != value.to_integral_value():
        return None
    return str(int(value))


def _should_clear_misclassified_land_surface(sale: AuctionSale) -> bool:
    current = sale.land_surface_m2
    if current is None or sale.property_type not in {"house", "apartment", "building"}:
        return False
    if current not in _built_surface_values(sale):
        return False
    extraction = sale.raw_payload.get("land_surface_extraction")
    if isinstance(extraction, dict) and extraction.get("source") == "pdf":
        # Un terrain lu dans une pièce reste protégé, sauf si la page qualifie elle-même cette valeur de surface
        # bâtie (07228862 : « surface habitable de 167,08 m² » ; la pièce lisait « maison … d'une surface de
        # 167,08 m2 avec jardin privatif » comme terrain).
        return _source_states_built_not_land_surface(sale, current)
    return True


def _source_states_built_not_land_surface(sale: AuctionSale, value: Decimal | None) -> bool:
    """La page qualifie ``value`` de surface bâtie et jamais de terrain : un terrain égal est la valeur suspecte."""
    return text_states_built_surface(
        (sale.description, sale.title, sale.raw_text), value
    ) and not _source_qualifies_surface_as_land(sale, value)


def _built_surface_values(sale: AuctionSale) -> set[Decimal]:
    return {
        value
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.app_surface_m2,
        )
        if value is not None
    }


def _corroborated_text_built_surface(sale: AuctionSale) -> Decimal | None:
    title_surface = _extract_built_surface(clean_text(sale.title) or "")
    description_surface = _extract_built_surface(clean_text(sale.description) or "")
    if title_surface is None or title_surface != description_surface:
        return None
    return title_surface


def _record_surface_conflict_resolution(
    sale: AuctionSale,
    previous_surface: Decimal,
    resolved_surface: Decimal,
) -> None:
    evidence = clean_text(" ".join(filter(None, (sale.title, sale.description))))
    sale.surface_source = "corroborated_source_text"
    sale.surface_confidence = Decimal("0.92")
    sale.surface_evidence = evidence[:500] if evidence else None
    sale.raw_payload["surface_reconciliation"] = {
        "status": "resolved",
        "rejected_surface_m2": str(previous_surface),
        "resolved_built_surface_m2": str(resolved_surface),
        "basis": "matching_title_and_description",
    }
    add_quality_flag(sale, "surface_conflict_resolved")


def apply_document_consistency_corrections(sale: AuctionSale, text: str) -> None:
    lowered = text.lower()
    if sale.property_type in {"building", "other", "unknown", None} and _text_describes_single_apartment(lowered):
        evidence = _first_rule_evidence(
            text,
            (
                r"\bappartement\s+de\s+type\s+studio\b",
                r"\btype\s+d['’]habitat\s*:?\s*studio\b",
                r"\bstudio\b.{0,80}\b(?:rez-de-chauss[ée]e|copropri[ée]t[ée]|surface\s+habitable|bail)\b",
            ),
        )
        previous_value = sale.property_type
        sale.property_type = "apartment"
        add_quality_flag(sale, "type_corrected_from_documents")
        _record_business_rule(
            sale,
            "property_type_from_specific_asset",
            factor_key="type",
            decision="Type retenu : appartement/studio, et non immeuble.",
            evidence=evidence,
            reasoning=(
                "Le mot immeuble peut désigner juridiquement le bâtiment ou la copropriété. "
                "Quand le dossier rattache l'actif vendu à un logement précis, un lot, un studio "
                "ou un appartement, le scoring doit qualifier l'actif analysé et non le support cadastral."
            ),
            impact=(
                f"La valeur structurée initiale ({previous_value or 'non renseignée'}) est corrigée "
                "pour éviter de survaloriser à tort un potentiel d'immeuble de rapport."
            ),
            confidence=0.78,
        )

    if sale.occupancy_status in {"vacant", "free", "unknown"} and _has_unresolved_occupancy_conflict(
        text, declared_vacant=sale.occupancy_status != "unknown"
    ):
        evidence = _first_rule_evidence(
            text,
            (
                r"\b(?:actuellement\s+)?occup[ée]\b.{0,120}\b(?:bail|locataire|loyer)\b",
                r"\b(?:bail|locataire|loyer\s+mensuel)\b.{0,120}\b(?:occup[ée]|meubl[ée]|charges?\s+comprises)\b",
            ),
        )
        previous_value = sale.occupancy_status
        sale.occupancy_status = "unknown"
        add_quality_flag(sale, "occupation_conflict")
        _record_business_rule(
            sale,
            "occupation_conflict_requires_confirmation",
            factor_key="occupation",
            decision="Occupation retenue : à confirmer.",
            evidence=evidence,
            reasoning=(
                "Une annonce peut indiquer libre, mais un PV, un bail ou une pièce d'occupation a une portée "
                "plus opérationnelle pour l'investisseur. Si ces documents signalent un locataire, un bail "
                "ou un loyer sans preuve de départ effectif, l'application ne doit pas conclure que le bien "
                "sera libre à l'adjudication."
            ),
            impact=(
                f"Le statut initial ({previous_value}) est neutralisé : le score retire le bonus de liquidité "
                "et demande une vérification avant de calculer un scénario locatif ou de revente."
            ),
            confidence=0.82,
        )


def _text_describes_single_apartment(text: str) -> bool:
    if re.search(
        r"\bimmeuble\s+(?:entier|comprenant|compos[ée]|[àa]\s+usage)|"
        r"\bplusieurs\s+appartements?\b|"
        r"\bensemble\s+immobilier\s+comprenant\b",
        text,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\bappartement\s+de\s+type\s+studio\b|"
            r"\bappartement\b.{0,80}\bstudio\b|"
            r"\bstudio\b.{0,80}\b(?:rez-de-chauss[ée]e|copropri[ée]t[ée]|surface\s+habitable|bail)\b|"
            r"\btype\s+d['’]habitat\s*:?\s*studio\b|"
            r"\blogement\b.{0,80}\bstudio\b",
            text,
            re.I,
        )
    )


def _has_unresolved_occupancy_conflict(text: str, *, declared_vacant: bool) -> bool:
    """A lease, a tenant or an occupant stated in the documents, against a « libre » that nothing confirms.

    Read sentence by sentence (03/11/2026): « Information acquéreur-locataire », « Si l'immeuble est loué »
    or « Le locataire a quitté les lieux » are not an occupation.
    """
    decision = occupancy_from_text(text)
    if decision.reason == "conflict":
        return True
    return declared_vacant and decision.status in OCCUPIED_FAMILY


def _first_rule_evidence(text: str, patterns: tuple[str, ...], *, window: int = 170) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        return evidence_excerpt(text, match.start(), match.end(), window=window)
    return None


def _record_business_rule(
    sale: AuctionSale,
    rule_id: str,
    *,
    factor_key: str,
    decision: str,
    evidence: str | None,
    reasoning: str,
    impact: str,
    confidence: float,
) -> None:
    rules = sale.raw_payload.setdefault("business_rules", [])
    if not isinstance(rules, list):
        rules = []
        sale.raw_payload["business_rules"] = rules
    rule = {
        "rule_id": rule_id,
        "version": BUSINESS_RULE_VERSION,
        "factor_key": factor_key,
        "decision": decision,
        "evidence": evidence,
        "reasoning": reasoning,
        "impact": impact,
        "confidence": confidence,
    }
    for index, item in enumerate(rules):
        if isinstance(item, dict) and item.get("rule_id") == rule_id:
            rules[index] = rule
            return
    rules.append(rule)


def business_rule(sale: AuctionSale, rule_id: str) -> dict[str, Any] | None:
    rules = sale.raw_payload.get("business_rules")
    if not isinstance(rules, list):
        return None
    for item in rules:
        if isinstance(item, dict) and item.get("rule_id") == rule_id:
            return item
    return None


def business_rule_refs(sale: AuctionSale, factor_key: str | None = None) -> list[dict[str, Any]]:
    rules = sale.raw_payload.get("business_rules")
    if not isinstance(rules, list):
        return []
    refs = []
    for item in rules:
        if not isinstance(item, dict):
            continue
        if factor_key is not None and item.get("factor_key") != factor_key:
            continue
        refs.append(business_rule_to_ref(item))
    return refs


def business_rule_to_ref(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": rule.get("decision") or rule.get("rule_id"),
        "excerpt": rule.get("evidence"),
        "document_type": "règle métier",
        "confidence": rule.get("confidence"),
        "reasoning": rule.get("reasoning"),
    }


def _extract_surface_kind(text: str, kind: str, sale: AuctionSale | None = None) -> Decimal | None:
    if kind == 'land_surface_m2':
        # « …, soit superficie totale 1550 m² » conclut une liste de parcelles : c'est la contenance du terrain.
        if parcel_totals := parcel_total_surfaces(text):
            return parcel_totals[-1]
        # Total écrit, liste complète additionnée ; jamais la première parcelle d'une liste (src/land_parcels.py).
        if (parcels := read_parcel_land_surface(text)) is not None:
            if parcels.value is None and sale is not None:
                add_quality_flag(sale, 'parcel_surface_scope_unverified')
            return parcels.value
    for pattern in SURFACE_PATTERNS[kind]:
        match = next(
            (
                candidate
                for candidate in re.finditer(pattern, text, re.I | re.S)
                # « hors Carrez 4,16 m² » est une surface exclue de la mesure légale.
                if not (kind == "carrez_surface_m2" and is_outside_carrez_context(text, candidate.start(), candidate.end()))
            ),
            None,
        )
        if not match:
            continue
        if len(match.groups()) == 2:
            return Decimal(match.group(1)) * Decimal("100") + Decimal(match.group(2))
        value = _parse_surface_decimal(match.group(1))
        if (
            value
            and not _surface_false_positive(text, match.start(), match.end())
            and not _land_surface_false_positive(text, match, kind)
            and not _living_surface_false_positive(text, match.start(), match.end(), kind)
        ):
            if sale is not None:
                _set_surface_evidence(sale, kind, evidence_excerpt(text, match.start(), match.end()))
            return value
    return None


def fill_counts(sale: AuctionSale, text: str) -> None:
    # Les pièces ne se déduisent plus des chambres (« chambres + séjour ») : sans compte écrit, pas de compte
    # (audit du 03/11/2026 : « 4 Appartements Loués » -> 3 pièces, pièces = chambres).
    if sale.rooms_count is None:
        sale.rooms_count = _infer_rooms_count(text, sale)
    if sale.bedrooms_count is None and sale.rooms_count == 1 and _STUDIO_RE.search(text):
        sale.bedrooms_count = 0
    reconcile_room_counts(sale, text)
    if sale.bathrooms_count is None:
        sale.bathrooms_count = _extract_count(
            text,
            (
                r"\b([1-9][0-9]?)\s+salles?\s+(?:de\s+)?bains?\b",
                r"\b([1-9][0-9]?)\s+salles?\s+d['’]eau\b",
                r"\bsalles?\s+(?:de\s+)?bains?\s*:?\s*([1-9][0-9]?)\b",
            ),
        )
    if sale.parking_count is None:
        sale.parking_count = _extract_count(
            text,
            (
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:places?\s+de\s+)?parkings?\b",
                r"\b([1-9][0-9]?|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+places?\s+de\s+stationnement\b",
            ),
        )
        if sale.parking_count is None and re.search(r"\bparking\b|\bstationnement\b", text, re.I):
            sale.parking_count = 1


def fill_booleans(sale: AuctionSale, text: str) -> None:
    checks = {
        "has_garden": r"\bjardin\b",
        "has_terrace": r"\bterrasse\b",
        "has_garage": r"\bgarage\b",
        "has_pool": r"\bpiscine\b",
        "has_air_conditioning": r"\bclimatisation\b|\bclimatis[ée]\b",
        "has_double_glazing": r"double\s+vitrage",
    }
    for flag_name, pattern in checks.items():
        if getattr(sale, flag_name) is not None:
            continue
        if flag_name in {"has_garden", "has_pool"}:
            # Le jardin ou la piscine du bien lui-même, pas ceux de la copropriété ni la « rue du Jardin ».
            feature = "garden" if flag_name == "has_garden" else "pool"
            setattr(sale, flag_name, private_amenity_mentioned(text, feature) is True)
            continue
        setattr(sale, flag_name, bool(re.search(pattern, text, re.I)))


# Plafonds de vraisemblance de la surface affichée (m²). Au-delà, la valeur est presque toujours celle
# d'une parcelle, d'un lot voisin ou d'un chiffre du titre (appartement à 34 596 m², maison à 48 256 m²).
# Prudents : seul l'évidemment faux est écarté ; les types commercial, mixte et autres gardent leur règle
# propre (plus de 1 000 m² sans preuve).
MAX_PLAUSIBLE_BUILT_SURFACE_M2 = {"apartment": Decimal("500"), "house": Decimal("1000")}


# Une surface habitable étiquetée comme telle garde le plafond d'une maison (1 000 m²) : « Surface habitable :
# 2 464,70 m² » est presque toujours une parcelle ou un total d'ensemble. Seul un texte qui prouve un total
# bâti (« surface totale bâtie », « de plancher ») relève le plafond.
MAX_PLAUSIBLE_LABELLED_HOUSE_SURFACE_M2 = Decimal("1000")


MAX_PLAUSIBLE_PROVEN_BUILT_TOTAL_HOUSE_SURFACE_M2 = Decimal("5000")


def _plausible_surface_ceiling(sale: AuctionSale) -> Decimal | None:
    if sale.property_type == "house" and sale.app_surface_kind == "habitable":
        if source_proves_built_total(
            (sale.surface_evidence, sale.description, sale.title, sale_fact_text(sale)), sale.app_surface_m2
        ):
            return MAX_PLAUSIBLE_PROVEN_BUILT_TOTAL_HOUSE_SURFACE_M2
        return MAX_PLAUSIBLE_LABELLED_HOUSE_SURFACE_M2
    return MAX_PLAUSIBLE_BUILT_SURFACE_M2.get(sale.property_type or "")


_UNIT_WORD = r"(?:appartements?|logements?|studios?|lots?|locaux)"


_MULTI_UNIT_PATTERN = re.compile(
    rf"\b(?:[2-9]|[1-9][0-9])\s+{_UNIT_WORD}\b|"
    rf"\b(?:deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+{_UNIT_WORD}\b",
    re.I,
)


def _is_unestablished_multi_unit_surface(sale: AuctionSale, text: str) -> bool:
    """Immeuble ou annonce multi-lots sans surface totale explicite.

    La seule surface lue est alors celle d'un lot (le premier, le plus souvent) : « surface non établie »
    vaut mieux que de l'afficher comme surface du bien (immeuble de 6 appartements à 29,51 m²).
    """
    current = sale.app_surface_m2 or sale.carrez_surface_m2 or sale.habitable_surface_m2 or sale.surface_m2
    if sale.property_type != "land" and is_single_unit_surface_of_several(text, current):
        return True  # la surface d'un des logements cités, même qualifiée « totale » pour ce logement
    if not text or _has_explicit_total_surface_evidence(text):
        return False
    if "multi_lot_sale" in sale.quality_flags and not describes_one_lot(sale):  # lot Licitor désigné : sa surface
        return True
    return sale.property_type == "building" and bool(_MULTI_UNIT_PATTERN.search(text))


def _set_app_surface(sale: AuctionSale) -> None:
    if sale.surface_scope == "partial":
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        return
    if sale.property_type == "apartment":
        sale.app_surface_m2 = sale.carrez_surface_m2 or sale.habitable_surface_m2
        if sale.app_surface_m2 is None:
            sale.app_surface_kind = None
        else:
            sale.app_surface_kind = "carrez" if sale.carrez_surface_m2 is not None else "habitable"
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type == "land":
        sale.app_surface_m2 = sale.land_surface_m2
        sale.app_surface_kind = "land" if sale.land_surface_m2 is not None else None
        sale.surface_scope = "land" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type == "building":
        sale.app_surface_m2 = sale.surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2
        sale.app_surface_kind = "built" if sale.app_surface_m2 is not None else None
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope
    elif sale.property_type in {"commercial", "mixed"}:
        sale.app_surface_m2 = (
            sale.surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.land_surface_m2
        )
        sale.app_surface_kind = (
            "land"
            if (
                sale.app_surface_m2 is not None
                and sale.surface_m2 is None
                and sale.habitable_surface_m2 is None
                and sale.carrez_surface_m2 is None
                and sale.land_surface_m2 is not None
            )
            else "built"
            if sale.app_surface_m2 is not None
            else None
        )
        sale.surface_scope = (
            "land"
            if sale.app_surface_kind == "land"
            else "total"
            if sale.app_surface_m2 is not None
            else sale.surface_scope
        )
    else:
        sale.app_surface_m2 = sale.habitable_surface_m2
        sale.app_surface_kind = "habitable" if sale.habitable_surface_m2 is not None else None
        sale.surface_scope = "total" if sale.app_surface_m2 is not None else sale.surface_scope

    if sale.property_type in {"house", "apartment"} and sale.app_surface_m2 is None and sale.surface_m2 is not None:
        sale.app_surface_m2 = sale.surface_m2
        sale.app_surface_kind = "built"
        # « unknown » relu en base vient d'un retrait précédent (e34acc33) : il est recalculé ensuite.
        sale.surface_scope = "total" if sale.surface_scope in {None, "unknown"} else sale.surface_scope
        add_quality_flag(sale, "surface_type_unverified")


def _validate_app_surface_scope(sale: AuctionSale) -> None:
    if sale.app_surface_m2 is None:
        return
    if (
        sale.property_type in {"house", "building"} and sale.app_surface_m2 < Decimal("20")
    ) or (sale.property_type == "apartment" and sale.app_surface_m2 < MIN_DWELLING_SURFACE_M2):
        # Moins de 9 m² n'est pas un logement : c'est une cave, un parking ou une annexe.
        if sale.property_type == "apartment":
            # Le type suit la surface : un « appartement » de 5 m² est une annexe, et le titre affiché le dit
            # (build_display_title). La trace garde le type d'origine et la surface écartée.
            sale.raw_payload["annex_reclassification"] = {
                "from_property_type": "apartment",
                "surface_m2": str(sale.app_surface_m2),
                "minimum_dwelling_m2": str(MIN_DWELLING_SURFACE_M2),
            }
            sale.property_type = "other"
            add_quality_flag(sale, "annex_lot")
        sale.surface_scope = "room_or_annex"
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        add_quality_flag(sale, "ambiguous_surface")
    elif (
        sale.property_type in {"commercial", "mixed", "other", "unknown"}
        and sale.app_surface_m2 > Decimal("1000")
        and not _large_non_residential_surface_is_supported(sale)
    ):
        sale.surface_scope = "unknown"
        sale.app_surface_m2 = None
        sale.app_surface_kind = None
        add_quality_flag(sale, "ambiguous_surface")
    elif (ceiling := _plausible_surface_ceiling(sale)) is not None and sale.app_surface_m2 > ceiling:
        _demote_implausible_built_surface(sale, ceiling)
    elif sale.property_type == "land":
        sale.surface_scope = "land"


def _demote_implausible_built_surface(sale: AuctionSale, ceiling: Decimal) -> None:
    """Retire de la surface affichée une valeur au-dessus du plafond du type de bien.

    Une maison la garde comme surface de terrain seulement si le texte source la qualifie lui-même de
    terrain, de parcelle ou de superficie du sol et si aucun terrain n'est connu ; sinon (et pour un
    appartement, qui n'a pas de terrain propre) la valeur est seulement écartée : la recopier en terrain
    serait une extrapolation. La valeur rejetée reste tracée dans
    ``raw_payload["implausible_surface_reconciliation"]``.
    """
    rejected = sale.app_surface_m2
    demoted_to_land = (
        sale.property_type == "house"
        and sale.land_surface_m2 is None
        and _source_qualifies_surface_as_land(sale, rejected)
    )
    for field in ("surface_m2", "habitable_surface_m2", "carrez_surface_m2"):
        if getattr(sale, field) == rejected:
            setattr(sale, field, None)
    if demoted_to_land:
        sale.land_surface_m2 = rejected
    sale.app_surface_m2 = None
    sale.app_surface_kind = None
    sale.surface_scope = "unknown"
    sale.raw_payload["implausible_surface_reconciliation"] = {
        "status": "demoted_to_land" if demoted_to_land else "removed",
        "property_type": sale.property_type,
        "rejected_surface_m2": str(rejected),
        "ceiling_m2": str(ceiling),
        "basis": "built_surface_above_plausibility_ceiling",
    }
    add_quality_flag(sale, "ambiguous_surface")


_LAND_QUALIFIER_PATTERN = re.compile(
    r"\b(?:terrains?|parcelles?|contenance|cadastr[a-zé]*|(?:superficie|surface)\s+(?:totale\s+)?du\s+sol)\b",
    re.I,
)


_BUILT_QUALIFIER_PATTERN = re.compile(
    r"\b(?:habitables?|carrez|privative|b[âa]ti(?:e|es|s)?|plancher|r[ée]f[ée]rence)\b", re.I
)


_SURFACE_NUMBER_PATTERN = re.compile(rf"{SURFACE_VALUE_PATTERN}\s*(?:m\s*(?:2|²)|mètres?\s+carrés?)", re.I)


def _source_qualifies_surface_as_land(sale: AuctionSale, value: Decimal | None) -> bool:
    """Vrai si le texte source étiquette lui-même ``value`` m² comme surface de terrain.

    Le qualificatif (terrain, parcelle, contenance, superficie du sol) doit se trouver juste autour du
    nombre, dans la même phrase, sans mention de surface bâtie (habitable, Carrez, bâti) entre les deux.
    """
    if value is None:
        return False
    # « …, soit superficie totale 1550 m² » à la suite de parcelles cadastrales : la contenance du terrain.
    if is_parcel_total((sale.surface_evidence, sale.description, sale.title, sale_fact_text(sale)), value):
        return True
    for text in (sale.surface_evidence, sale.description, sale.title, sale_fact_text(sale)):
        if not text:
            continue
        for match in _SURFACE_NUMBER_PATTERN.finditer(text):
            if _parse_surface_decimal(match.group(1)) != value:
                continue
            before = re.split(r"[;\n]|\.\s", text[max(0, match.start() - 80) : match.start()])[-1]
            after = re.split(r"[;\n]|\.\s", text[match.end() : match.end() + 40])[0]
            window = f"{before} {after}"
            if _LAND_QUALIFIER_PATTERN.search(window) and not _BUILT_QUALIFIER_PATTERN.search(window):
                return True
    return False


def _large_non_residential_surface_is_supported(sale: AuctionSale) -> bool:
    context = clean_text(" ".join(filter(None, (sale.surface_evidence, sale.description, sale_fact_text(sale))))) or ""
    if not context:
        return False
    if re.search(r"\b(?:cadastr|parcelle|terrain|contenance)\b", context, re.I) and not re.search(
        r"\b(?:surface\s+totale|b[âa]timent|stabulation|hangar|stockage|salle\s+de\s+traite|"
        r"local\s+(?:commercial|industriel)|entrep[oô]t|atelier)\b",
        context,
        re.I,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:surface\s+totale|b[âa]timent|stabulation|hangar|stockage|salle\s+de\s+traite|"
            r"local\s+(?:commercial|industriel)|entrep[oô]t|atelier)\b",
            context,
            re.I,
        )
    )


def _flag_ambiguous_surface(sale: AuctionSale) -> None:
    surface_values = {
        value
        for value in (sale.habitable_surface_m2, sale.carrez_surface_m2, sale.land_surface_m2)
        if value is not None
    }
    if len(surface_values) > 1 and sale.property_type not in {"house", "building"}:
        add_quality_flag(sale, "ambiguous_surface")
    if sale.app_surface_m2 is None and sale.surface_m2 is not None:
        add_quality_flag(sale, "ambiguous_surface")


def _extract_count(text: str, patterns: tuple[str, ...]) -> int | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            value = match.group(1)
            return int(value) if value.isdigit() else _number_word_to_int(value)
    return None


def _extract_built_surface(text: str, sale: AuctionSale | None = None) -> Decimal | None:
    if sale is not None and (
        _is_ambiguous_mixed_lot_surface(sale.property_type or "", text)
        or _is_unestablished_multi_unit_surface(sale, text)
        or sale.raw_payload.get(SURFACE_VALUES_CONFLICT_KEY)
    ):
        return None
    patterns = (
        rf"superficie\s+au\s+sol\s+(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"d['’]une\s+superficie\s+au\s+sol\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\b.{{0,80}}?"
        rf"d['’]une\s+superficie\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\b(?:ensemble\s+immobilier|propri[ée]t[ée])"
        rf"(?:\s+de\s+[0-9]+\s+pi[eè]ces?)?\s+de\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"d['’]une\s+superficie\s+d['’]environ\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"surface\s+au\s+sol\s+(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
        rf"\btotal\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m(?:2|²|\*)",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m(?:2|²)\s+(?:de\s+)?(?:surface\s+)?superficie\b",
    )
    if sale is not None and sale.source_name == "licitor":
        patterns = (*patterns, rf"\bde\s+{SURFACE_VALUE_PATTERN}\s*²\b")
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.S)
        if not match:
            continue
        value = _parse_surface_decimal(match.group(1))
        if (
            value
            and not _surface_false_positive(text, match.start(), match.end())
            and not built_value_names_other_object(text, match.start(), match.end())
        ):
            if sale is not None:
                _set_surface_evidence(sale, "built_surface_text", evidence_excerpt(text, match.start(), match.end()))
            return value

    # Un seul qualificatif peut séparer le bien de sa surface (« maison éclusière d'environ 80 m² »), à
    # condition que ce ne soit pas une annexe (« maison avec garage de 25 m² » est la surface du garage).
    short_pattern = (
        rf"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|hangar)\s+"
        rf"(?:(?!(?:avec|et|sur|de|d|du|des|garage|cave|jardin|terrain|parking|piscine|d[ée]pendances?|annexes?|"
        rf"cour|terrasse|balcon|combles?|grenier)\b)[a-zà-ÿ]+\s+)?"
        rf"(?:d['’]environ\s+|de\s+){SURFACE_VALUE_PATTERN}\s*m(?:2|²)"
    )
    candidates: list[tuple[Decimal, re.Match[str]]] = []
    for match in re.finditer(short_pattern, text, re.I | re.S):
        value = _parse_surface_decimal(match.group(1))
        if value and not _surface_false_positive(text, match.start(), match.end()):
            candidates.append((value, match))
    if candidates and len({value for value, _ in candidates}) == 1:
        value, match = candidates[0]
        if sale is not None:
            _set_surface_evidence(sale, "built_surface_text", evidence_excerpt(text, match.start(), match.end()))
        return value
    return None


def _infer_rooms_count(text: str, sale: AuctionSale) -> int | None:
    """Un studio écrit compte une pièce ; aucun autre compte n'est déduit (chambres + séjour n'est pas une preuve).

    « T 1 » seul (« servitudes AS 1 ; T 1 ») ne dit rien d'un logement : seul un type de logement nommé compte.
    """
    if sale.property_type in {"apartment", "house"} and _STUDIO_RE.search(text):
        return 1
    return None


_STUDIO_RE = re.compile(
    r"\bstudio\b(?!\s+(?:photo|d['’]enregistrement|de\s+(?:danse|musique|yoga)))"
    r"|\b(?:appartement|logement)\s+(?:de\s+)?(?:type\s+)?[TF]\s*1\b|\btype\s+[TF]?\s*1\b(?![,.]\d)",
    re.I,
)


def _number_word_to_int(value: str) -> int | None:
    lowered = value.lower()
    mapping = {
        "une": 1,
        "un": 1,
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
    if lowered in mapping:
        return mapping[lowered]
    if lowered.isdigit():
        return int(lowered)
    return None


def _surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 20) : min(len(text), end + 30)]
    return bool(
        re.search(
            r"\bkwh(?:ep)?\b|kg\s*co2|m(?:2|²)\s*/\s*(?:an|year)",
            context,
            re.I,
        )
    )


def _land_surface_false_positive(text: str, match: re.Match[str], kind: str) -> bool:
    if kind != "land_surface_m2":
        return False
    matched_text = text[match.start() : match.end()]
    value_start = match.start(1)
    value_end = match.end(1)
    before_value = text[max(match.start(), value_start - 45) : value_start]
    after_value = text[value_end : min(len(text), value_end + 25)]
    # « Résidence « Les Jardins d'Arcadie » Studio de 31m² » (e538fab2), « Jardin derrière Le tout représente une
    # surface bâtie de 259,86 m² » (ebafd1c4) : la valeur est celle du logement nommé ou qualifié juste avant elle.
    return bool(
        re.search(
            r"\b(?:maison|villa|appartement|immeuble|b[âa]timent|local|hangar|studio|pavillon|logement)\s+de\s*$",
            before_value,
            re.I,
        )
        or re.search(
            rf"\b(?:maison|villa|appartement|immeuble|b[âa]timent|local|hangar|studio|pavillon|logement)\b.{{0,60}}?"
            rf"\b(?:de|d['’]une\s+surface\s+de|d['’]une\s+superficie\s+de)\s+{SURFACE_VALUE_PATTERN}\s*m(?:2|²)",
            matched_text,
            re.I | re.S,
        )
        or re.search(
            r"\b(?:surface|superficie)\s+(?:totale\s+)?(?:habitable|carrez|b[âa]tie|construite|de\s+plancher)\b"
            r"|\bloi\s+carrez\b",
            before_value,
            re.I,
        )
        or re.search(r"\bhabitables?\b", after_value, re.I)
    )


def _living_surface_false_positive(text: str, start: int, end: int, kind: str) -> bool:
    if kind == "land_surface_m2":
        return False
    context = text[max(0, start - 45) : start]
    return bool(
        re.search(r"\b(?:terrain|parcelle|jardin|garage|cave|parking|stationnement|d[ée]pendance)\b", context, re.I)
    )


def _parse_surface_decimal(value: str) -> Decimal | None:
    return parse_surface(value)


def _set_surface_evidence(sale: AuctionSale, source: str, evidence: str | None) -> None:
    if sale.surface_source is None:
        sale.surface_source = source
    if sale.surface_confidence is None:
        sale.surface_confidence = Decimal("0.8") if evidence else Decimal("0.55")
    if evidence and sale.surface_evidence is None:
        sale.surface_evidence = evidence
