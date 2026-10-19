"""Garde-fou : une même surface lue sur des ventes de villes différentes n'est pas publiée.

Quand une extraction lit la surface d'une vente voisine (bloc « Consultez d'autres ventes », carrousel,
bandeau), la même valeur remonte sur plusieurs ventes sans rapport : 35,01 m² sur neuf ventes d'Enchères
Immobilières, de Menton à Grasse. Un seul passage d'une source ne porte jamais, par hasard, la même
surface décimale sur quatre villes. Dans ce cas, les surfaces concernées sont vidées, marquées
« à confirmer » (``ambiguous_surface``) et journalisées ; la correction de l'extraction reste à faire,
ce filet évite seulement de publier la valeur en attendant.

Seules les surfaces décimales (35,01 m²) sont examinées : une surface ronde (50 m², un garage de 12 m²)
se répète légitimement entre villes, et le filet ferait plus de mal que de bien.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from src.normalize import clean_text, parse_surface

LOGGER = logging.getLogger(__name__)

MIN_SALES_WITH_SAME_SURFACE = 4
MIN_DISTINCT_CITIES = 4
SURFACE_TOLERANCE_M2 = Decimal("0.01")
QUALITY_FLAGS = ("ambiguous_surface", "surface_shared_across_cities")


def drop_repeated_foreign_surfaces(source_name: str, raw_sales: list[dict[str, Any]]) -> list[str]:
    """Vide ``surface_m2`` des ventes d'un passage qui partagent une surface décimale entre villes.

    Retourne les ``source_url`` modifiées (vide si rien n'est touché). Les ventes sont modifiées en place.
    """
    candidates: list[tuple[Decimal, str, dict[str, Any]]] = []
    for sale in raw_sales:
        surface = parse_surface(sale.get("surface_m2"))
        city = (clean_text(sale.get("city")) or "").casefold()
        if surface is None or not city or surface == surface.to_integral_value():
            continue
        candidates.append((surface, city, sale))

    clusters: list[list[tuple[Decimal, str, dict[str, Any]]]] = []
    for item in sorted(candidates, key=lambda entry: entry[0]):
        if clusters and item[0] - clusters[-1][-1][0] <= SURFACE_TOLERANCE_M2:
            clusters[-1].append(item)
        else:
            clusters.append([item])

    flagged: list[str] = []
    for cluster in clusters:
        cities = {city for _, city, _ in cluster}
        if len(cluster) < MIN_SALES_WITH_SAME_SURFACE or len(cities) < MIN_DISTINCT_CITIES:
            continue
        for _, _, sale in cluster:
            _withdraw_surface(sale)
            flagged.append(str(sale.get("source_url") or ""))
        LOGGER.warning(
            "%s: surface %s m2 identique sur %d ventes de %d villes, surfaces non publiées (à confirmer)",
            source_name,
            cluster[0][0],
            len(cluster),
            len(cities),
        )
    return flagged


def _withdraw_surface(sale: dict[str, Any]) -> None:
    rejected = sale.get("surface_m2")
    sale["surface_m2"] = None
    blocks = sale.get("source_blocks")
    if isinstance(blocks, dict):
        # La normalisation relit ce bloc quand le champ est vide : il faut l'enlever aussi.
        blocks.pop("surface", None)
    flags = sale.get("quality_flags") if isinstance(sale.get("quality_flags"), list) else []
    sale["quality_flags"] = [*dict.fromkeys([*flags, *QUALITY_FLAGS])]
    sale["rejected_repeated_surface_m2"] = str(rejected)
