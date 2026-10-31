"""Retrait de la surface affichée tant qu'un marqueur d'ambiguïté de surface est présent.

Une surface fausse mais affichée avec assurance (dépendance de 71,95 m² au lieu de 220 m², maison de
gardien de 23,6 m² au lieu de 345,7 m², surface « créée » par un permis) est pire qu'une surface « non
communiquée ». Le retrait ne touche que ``app_surface_m2`` : les surfaces typées restent en base pour l'audit
et la valeur écartée est tracée dans ``raw_payload["app_surface_withheld"]``.
"""

from __future__ import annotations

from decimal import Decimal

from src.models import AuctionSale

# Valeur de ``asset_normalization_helpers.PRICE_PER_M2_IMPLAUSIBLE_FLAG`` (recopiée pour éviter un import
# circulaire ; un test vérifie l'égalité).
PRICE_PER_M2_IMPLAUSIBLE_MARKER = "price_per_m2_implausible"
AMBIGUOUS_SURFACE_MARKERS = (
    "ambiguous_surface",
    "surface_contradiction",
    PRICE_PER_M2_IMPLAUSIBLE_MARKER,
    "surface_unit_or_consistency_warning",
)
# Avertissements de ``surface_reasoning`` qui constatent une correction prouvée par l'arithmétique (unité m³
# corrigée d'après la somme des pièces) ou un cumul voulu de plusieurs lots : ils ne rendent pas la surface
# douteuse.
BENIGN_SURFACE_WARNINGS = frozenset(
    {"unit_m3_reconciled_as_area_from_room_sum", "aggregate_for_all_assets_in_auction_perimeter"}
)
# Écart toléré entre la surface affichée et les surfaces Carrez / habitable lues séparément (même tolérance que
# ``surface_reasoning`` : 1 m² ou 2 %, élargie à 2 m² ou 3 % pour les arrondis de deux documents).
_AGREEMENT_ABSOLUTE_M2 = Decimal("2")
_AGREEMENT_RELATIVE = Decimal("0.03")


def withhold_ambiguous_app_surface(sale: AuctionSale) -> None:
    """Retire ``app_surface_m2`` (et son genre) quand un marqueur d'ambiguïté de surface est présent."""
    if sale.app_surface_m2 is None:
        return
    markers = [flag for flag in AMBIGUOUS_SURFACE_MARKERS if flag in sale.quality_flags]
    if "surface_unit_or_consistency_warning" in markers and _selected_warnings_are_benign(sale):
        markers.remove("surface_unit_or_consistency_warning")
    if markers == ["ambiguous_surface"] and _built_surfaces_agree_with_app_surface(sale):
        # « ambiguous_surface » vient alors seulement de l'écart entre le terrain et le bâti, ou d'un arrondi
        # entre Carrez et habitable : la surface affichée reste confirmée par les autres lectures.
        markers = []
    if not markers:
        return
    sale.raw_payload["app_surface_withheld"] = {
        "withheld_surface_m2": str(sale.app_surface_m2),
        "app_surface_kind": sale.app_surface_kind,
        "markers": markers,
    }
    sale.app_surface_m2 = None
    sale.app_surface_kind = None
    sale.surface_scope = "unknown"


def _built_surfaces_agree_with_app_surface(sale: AuctionSale) -> bool:
    app_surface = sale.app_surface_m2
    if app_surface is None:
        return False
    tolerance = max(_AGREEMENT_ABSOLUTE_M2, app_surface * _AGREEMENT_RELATIVE)
    built = [value for value in (sale.carrez_surface_m2, sale.habitable_surface_m2) if value is not None]
    return all(abs(value - app_surface) <= tolerance for value in built)


def _selected_warnings_are_benign(sale: AuctionSale) -> bool:
    analysis = sale.raw_payload.get("surface_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict):
        return False
    selected_id = analysis.get("selected_derivation_id")
    derivations = analysis.get("derivations")
    if not selected_id or not isinstance(derivations, list):
        return False
    selected = next(
        (item for item in derivations if isinstance(item, dict) and item.get("derivation_id") == selected_id),
        None,
    )
    warnings = selected.get("warnings") if isinstance(selected, dict) else None
    return isinstance(warnings, list) and bool(warnings) and set(warnings) <= BENIGN_SURFACE_WARNINGS
