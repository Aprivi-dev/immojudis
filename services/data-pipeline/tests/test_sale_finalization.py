"""Collecte, file et recalculs : une seule suite d'étapes communes (``src.sale_finalization.derive_sale_facts``)."""

from __future__ import annotations

import pytest

from src import recompute_scoring, sale_finalization, source_extraction_backfill
from src.lot_scope import recompute_surface_reasoning_context, surface_reasoning_context
from src.models import AuctionSale


def _record_steps(monkeypatch: pytest.MonkeyPatch, calls: list[str]) -> None:
    monkeypatch.setattr(sale_finalization, "fill_tribunal", lambda sale: calls.append("tribunal"))
    monkeypatch.setattr(sale_finalization, "classify_sale_procedure", lambda sale: calls.append("procedure"))
    monkeypatch.setattr(
        sale_finalization,
        "extract_and_apply_deterministic_surface_reasoning",
        lambda sale, context: calls.append(f"surfaces:{context}"),
    )
    monkeypatch.setattr(sale_finalization, "normalize_asset_features", lambda sale: calls.append("assets"))
    monkeypatch.setattr(
        sale_finalization, "attach_source_property_features", lambda payload, property_type: calls.append("features")
    )


def _sale() -> AuctionSale:
    return AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/finalization",
        description="Maison\n  de 90 m²",
        raw_payload={},
    )


def test_collection_runs_its_own_steps_then_the_shared_ones(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _record_steps(monkeypatch, calls)
    monkeypatch.setattr(sale_finalization, "extract_source_description", lambda sale: None)
    monkeypatch.setattr(sale_finalization, "locate_sale_by_cadastre", lambda sale: calls.append("position"))
    monkeypatch.setattr(sale_finalization, "filter_raw_image_url", lambda payload: calls.append("image"))
    monkeypatch.setattr(sale_finalization, "apply_page_offer_deadline", lambda sale: calls.append("deadline"))
    monkeypatch.setattr(sale_finalization, "apply_catalogue_readiness", lambda sale: calls.append("readiness"))

    sale_finalization.finalize_sale_for_app(_sale(), geocode=False)

    assert calls == [
        "position",
        "image",
        "deadline",
        "tribunal",
        "procedure",
        "surfaces:Maison de 90 m²",
        "assets",
        "features",
        "readiness",
    ]


def test_recompute_runs_the_shared_steps_with_its_own_surface_context(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _record_steps(monkeypatch, calls)
    monkeypatch.setattr(recompute_scoring, "sale_from_storage_row", lambda row: _sale())
    monkeypatch.setattr(recompute_scoring, "geocode_sale", lambda sale: calls.append("position"))

    recompute_scoring._recomputed_sale_from_storage_row({}, geocode=True)

    assert calls == ["position", "tribunal", "procedure", "surfaces:Maison\n  de 90 m²", "assets", "features"]


def test_source_fact_backfill_runs_the_shared_steps_like_the_recompute(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _record_steps(monkeypatch, calls)
    monkeypatch.setattr(source_extraction_backfill, "sale_from_storage_row", lambda row: _sale())

    source_extraction_backfill._recompute_sale({})

    assert calls == ["tribunal", "procedure", "surfaces:Maison\n  de 90 m²", "assets", "features"]


def test_the_two_surface_contexts_read_the_same_fields_and_differ_only_by_line_breaks() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://example.test/context",
        title="Appartement",
        description="Séjour\n20 m²",
        raw_text="Page entière, deux lots",
        raw_payload={
            "source_description": "Séjour\n20 m²",
            "source_lot_selection": {"status": "selected", "lot_text": "Lot 1 : cave"},
            "source_blocks": {"page_text": "Lot 2 : 300 m²", "listing_completeness": "x", "visites": "Mardi"},
        },
    )

    assert surface_reasoning_context(sale) == "Appartement\nSéjour 20 m²\nLot 1 : cave\nMardi"
    assert recompute_surface_reasoning_context(sale) == "Appartement\nSéjour\n20 m²\nLot 1 : cave\nMardi"
