"""Dernière préparation d'une vente normalisée avant sa publication dans l'application.

Sans lecture des pièces ni modèle : description de la source, position, tribunal, échéance d'un appel d'offres
lue sur la page, procédure, surfaces, caractéristiques et préparation au catalogue. Partagée par la collecte
(``src.main``) et la relecture d'une fiche (``src.source_detail``). Le recalcul d'une vente stockée
(``src.recompute_scoring``), la réparation des faits de la source (``src.source_extraction_backfill``) et la file des
pièces et des faits (``src.queued_runner``) en reprennent la partie commune, ``derive_sale_facts``.
"""

from __future__ import annotations

from collections.abc import Callable

from src.asset_normalization import normalize_asset_features
from src.catalogue_readiness import apply_catalogue_readiness
from src.enrichment.extract_structured import extract_source_description
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.extraction_profiles import attach_source_property_features
from src.geocode import geocode_sale, locate_sale_by_cadastre
from src.image_validation import filter_raw_image_url
from src.lot_scope import surface_reasoning_context
from src.models import AuctionSale
from src.pdf_offer_deadline import apply_page_offer_deadline
from src.sale_procedure import classify_sale_procedure
from src.tribunal import fill_tribunal


def finalize_sale_for_app(sale: AuctionSale, *, geocode: bool = True) -> None:
    source_description = extract_source_description(sale)
    if source_description:
        sale.raw_payload["source_description"] = source_description
    else:
        sale.raw_payload.pop("source_description", None)
    (geocode_sale if geocode else locate_sale_by_cadastre)(sale)
    filter_raw_image_url(sale.raw_payload)
    apply_page_offer_deadline(sale)  # appel d'offres : date limite publiée sur la page (AGRASC, notaires, Cessions)
    derive_sale_facts(sale, surface_context=surface_reasoning_context)
    apply_catalogue_readiness(sale)


def derive_sale_facts(sale: AuctionSale, *, surface_context: Callable[[AuctionSale], str]) -> None:
    """Tribunal, procédure, surfaces et caractéristiques : ce que la collecte, la file et les recalculs refont tous.

    L'ordre compte : la procédure lit le tribunal, et le contexte des surfaces se lit après la procédure, qui
    ajoute son bloc à ``source_blocks``. ``surface_context`` est celui de l'appelant (voir
    ``src.lot_scope.recompute_surface_reasoning_context``).
    """
    fill_tribunal(sale)
    classify_sale_procedure(sale)
    context = surface_context(sale)
    if context:
        extract_and_apply_deterministic_surface_reasoning(sale, context)
    normalize_asset_features(sale)
    attach_source_property_features(sale.raw_payload, property_type=sale.property_type)
