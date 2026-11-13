"""Vente ramenée à un lot d'une annonce à plusieurs lots : où lire ses faits.

Une page Licitor à plusieurs lots décrit tous les lots ; la vente d'une URL ne décrit que le sien
(``src.sources.licitor_lots`` pose ``raw_payload["source_lot_selection"]``). Le texte de la page
(``raw_text``, blocs ``page_text`` / ``lots_detail`` / ``lots_publics``) reste stocké pour l'empreinte de la
source et la relecture, mais une surface, des pièces, un jardin ou une mise à prix ne s'y cherchent pas :
ils seraient ceux d'un autre lot. Ces fonctions donnent le texte du seul lot à la normalisation et aux
lectures qui suivent.
"""

from __future__ import annotations

from typing import Any

from src.null_text import clean_text
from src.text_folding import ascii_alnum_words, to_ascii

LOT_SELECTION_KEY = "source_lot_selection"
SELECTED = "selected"
AMBIGUOUS = "ambiguous"
# Blocs de la fiche qui portent le texte de toute la page (tous les lots) : jamais lus comme faits d'un lot.
PAGE_WIDE_BLOCKS = frozenset({"page_text", "lots_detail", "lots_publics"})


def _selection(payload: object) -> dict[str, Any] | None:
    selection = payload.get(LOT_SELECTION_KEY) if isinstance(payload, dict) else None
    return selection if isinstance(selection, dict) else None


def is_lot_scoped(raw_sale: object) -> bool:
    """Vente d'une annonce à plusieurs lots ramenée au lot de son URL (désigné ou incertain)."""
    return _selection(raw_sale) is not None


def lot_selected(payload: object) -> bool:
    """Vrai si le lot de l'URL a été désigné avec certitude : les valeurs de la vente sont celles de ce lot."""
    selection = _selection(payload)
    return selection is not None and selection.get("status") == SELECTED


def describes_one_lot(sale: object) -> bool:
    return lot_selected(getattr(sale, "raw_payload", None))


def fact_sources(payload: object, raw_text: object) -> tuple[object, dict[str, Any]]:
    """Texte et blocs où lire des faits : ceux du seul lot si la page en a plusieurs."""
    blocks = payload.get("source_blocks") if isinstance(payload, dict) else None
    blocks = blocks if isinstance(blocks, dict) else {}
    selection = _selection(payload)
    if selection is None:
        return raw_text, blocks
    return selection.get("lot_text") or "", {key: value for key, value in blocks.items() if key not in PAGE_WIDE_BLOCKS}


def fact_view(raw_sale: dict[str, Any]) -> dict[str, Any]:
    """La vente brute telle qu'on y cherche des faits (normalisation) : sans le texte des autres lots."""
    if not is_lot_scoped(raw_sale):
        return raw_sale
    raw_text, blocks = fact_sources(raw_sale, raw_sale.get("raw_text"))
    return {**raw_sale, "raw_text": raw_text, "source_blocks": blocks}


def sale_fact_text(sale: object) -> str | None:
    """``raw_text`` d'une vente normalisée, ou le texte de son seul lot."""
    raw_text, _ = fact_sources(getattr(sale, "raw_payload", None), getattr(sale, "raw_text", None))
    return clean_text(raw_text) if is_lot_scoped(getattr(sale, "raw_payload", None)) else raw_text


def _surface_context_fields(sale: Any) -> list[object]:
    """Champs où le raisonnement sur les surfaces cherche : titre, description, texte du lot, blocs de la fiche."""
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    raw_text, source_blocks = fact_sources(payload, sale.raw_text)
    block_values = [
        value for key, value in source_blocks.items() if key not in {"listing_completeness", "caracteristiques_bien"}
    ]
    return [sale.title, sale.description, raw_text, payload.get("source_description"), *block_values]


def surface_reasoning_context(sale: Any) -> str:
    """Texte lu par le raisonnement sur les surfaces d'une vente (collecte) : chaque champ sur une ligne."""
    # Source descriptions are often copied into several payload fields. Keep
    # each distinct field once without truncating or deduplicating within it.
    parts = dict.fromkeys(clean_text(str(value)) for value in _surface_context_fields(sale) if value)
    return "\n".join(part for part in parts if part)


def recompute_surface_reasoning_context(sale: Any) -> str:
    """Le même texte pour le recalcul d'une vente stockée (``src.recompute_scoring``), champs seulement rognés.

    Écart non tranché avec ``surface_reasoning_context`` : ici les retours à la ligne d'un champ restent, et ils
    arrêtent les motifs de surface. Les aligner pourrait changer des surfaces publiées : écart à trancher.
    """
    return "\n".join(dict.fromkeys(str(value).strip() for value in _surface_context_fields(sale) if value))


def _commune_key(value: object) -> str:
    return ascii_alnum_words(to_ascii(str(value or "")).lower(), "-")


def other_commune(city: object, other: object) -> bool:
    """Deux communes connues et différentes (« Le Cannet » et « Cannes »), casse, accents et tirets ignorés."""
    return bool(clean_text(city) and clean_text(other)) and _commune_key(city) != _commune_key(other)


__all__ = [
    "AMBIGUOUS",
    "LOT_SELECTION_KEY",
    "PAGE_WIDE_BLOCKS",
    "SELECTED",
    "describes_one_lot",
    "fact_sources",
    "fact_view",
    "is_lot_scoped",
    "lot_selected",
    "other_commune",
    "recompute_surface_reasoning_context",
    "sale_fact_text",
    "surface_reasoning_context",
]
