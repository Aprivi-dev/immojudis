"""Replay the secondary-source browser audit captured on 2026-10-02.

The test is deliberately offline.  It replays the public HTML saved by the
browser audit through the same list/detail enrichment boundary used by each
source, then runs ``normalize_sale``, deterministic surface reasoning and
``normalize_asset_features``.  Direct parser assertions and final-pipeline
assertions are kept together so a later reasoning stage cannot hide an
adapter-level regression.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.normalize import clean_text, normalize_sale
from src.sources.agrasc import parse_agrasc_html
from src.sources.agrasc_operators import enrich_agrasc_operator
from src.sources.info_encheres import (
    _enrich_sale_from_detail as enrich_info_detail,
)
from src.sources.info_encheres import (
    parse_info_encheres_list_html,
)
from src.sources.petites_affiches import (
    _enrich_sale_from_detail as enrich_petites_detail,
)
from src.sources.petites_affiches import (
    parse_petites_affiches_html,
)
from src.sources.vench import (
    _enrich_sale_from_detail as enrich_vench_detail,
)
from src.sources.vench import (
    parse_vench_list_html,
)

ROOT = Path(__file__).resolve().parents[3]
AUDIT = ROOT / "docs/audits/sources-2026-10-02/secondary"
CAPTURES = AUDIT / "responses"
MANIFEST = json.loads((AUDIT / "manifest.json").read_text())
MANIFEST_BY_ID = {str(item["id"]): item for item in MANIFEST}


class FrozenClient:
    """Small fixture client accepted by the source enrichment functions."""

    def __init__(self, html: str, expected_url: str):
        self.html = html
        self.expected_url = expected_url
        self._visited_urls = (expected_url,)

    def get(self, url: str) -> str:
        assert url == self.expected_url
        return self.html


@dataclass(frozen=True)
class Replay:
    raw: dict[str, Any]
    base: Any
    final: Any


def _response(sample_id: str) -> str:
    return (CAPTURES / f"{sample_id}-response.html").read_text(errors="replace")


def _list_rows(source: str, list_id: str) -> list[dict[str, Any]]:
    list_url = str(MANIFEST_BY_ID[list_id]["url"])
    html = _response(list_id)
    if source == "info_encheres":
        return parse_info_encheres_list_html(html, page_url=list_url)
    if source == "vench":
        return parse_vench_list_html(html, page_url=list_url)
    if source == "petites_affiches":
        return parse_petites_affiches_html(html, page_url=list_url)
    if source == "agrasc":
        return parse_agrasc_html(html, page_url=list_url)
    raise AssertionError(f"unsupported source fixture: {source}")


def _row_for_url(rows: list[dict[str, Any]], url: str) -> dict[str, Any]:
    try:
        return next(row for row in rows if str(row.get("source_url")) == url)
    except StopIteration as exc:
        raise AssertionError(f"no catalogue row for {url}") from exc


def _replay_raw(sample_id: str) -> dict[str, Any]:
    entry = MANIFEST_BY_ID[sample_id]
    source = str(entry["source"])
    url = str(entry["url"])
    list_id = {
        "info_encheres": "info-list",
        "vench": "vench-list",
        "petites_affiches": "petites-list",
        "agrasc": "agrasc-list",
    }[source]
    rows = _list_rows(source, list_id)
    sale = copy.deepcopy(_row_for_url(rows, url))

    # AGRASC's catalogue contains the identity.  The Evry operator page was
    # HTTP 410 in the capture and is intentionally kept catalogue-only.
    if sample_id == "agrasc-evry-2075541":
        return sale
    if source == "agrasc":
        detail_html = _response(sample_id)
        clients = {
            "https://www.agorastore-immo.fr": FrozenClient(detail_html, url),
            "https://agorastore-immo.fr": FrozenClient(detail_html, url),
        }
        settings = {
            "user_agent": "offline-source-audit",
            "request_delay_seconds": 0,
            "request_timeout_seconds": 1,
        }
        errors: list[str] = []
        enrich_agrasc_operator(sale, clients, settings, errors)
        assert not errors
        assert sale.get("operator_detail_status") == "complete"
        return sale

    enrichers: dict[str, Callable[[Any, dict[str, Any], list[str]], None]] = {
        "info_encheres": enrich_info_detail,
        "vench": enrich_vench_detail,
        "petites_affiches": enrich_petites_detail,
    }
    errors = []
    enrichers[source](FrozenClient(_response(sample_id), url), sale, errors)
    assert not errors
    assert sale.get("source_detail_status") in {"complete", "restricted"}
    return sale


def _surface_context(sale: Any) -> str:
    blocks = sale.raw_payload.get("source_blocks") if isinstance(sale.raw_payload, dict) else {}
    values = [sale.title, sale.description, sale.raw_text]
    if isinstance(blocks, dict):
        values.extend(blocks.values())
    return "\n".join(
        dict.fromkeys(clean_text(str(value)) for value in values if clean_text(str(value)))
    )


@cache
def replay(sample_id: str) -> Replay:
    raw = _replay_raw(sample_id)
    base = normalize_sale(copy.deepcopy(raw))
    final = copy.deepcopy(base)
    extract_and_apply_deterministic_surface_reasoning(final, _surface_context(final))
    normalize_asset_features(final)
    return Replay(raw=raw, base=base, final=final)


@pytest.mark.parametrize(
    ("sample_id", "external_id", "city", "price"),
    (
        ("info-6051", "6051", "Castillon De Lembeye", Decimal("36000")),
        ("info-6053", "6053", "Meyzieu", Decimal("75000")),
        ("vench-166665", "166665", "Cannes", Decimal("110000")),
        ("vench-166663", "166663", "Saint-Laurent-du-Var", Decimal("250000")),
        ("petites-165934", "165934", "Fréjus", Decimal("180000")),
        ("petites-165875", "165875", "Saint-Raphaël", Decimal("248600")),
    ),
)
def test_secondary_public_identity_and_price_survive_list_detail_merge(
    sample_id: str, external_id: str, city: str, price: Decimal
) -> None:
    snapshot = replay(sample_id)
    assert snapshot.raw["external_id"] == external_id
    assert snapshot.final.external_id == external_id
    assert snapshot.final.city == city
    assert snapshot.final.starting_price_eur == price
    assert snapshot.final.source_url == MANIFEST_BY_ID[sample_id]["url"]


@pytest.mark.parametrize(
    "sample_id",
    (
        "info-6051",
        "info-6053",
        "vench-166665",
        "vench-166663",
        "petites-165934",
        "petites-165875",
    ),
)
def test_secondary_source_profiles_keep_procedure_and_observation_contract(sample_id: str) -> None:
    snapshot = replay(sample_id)
    payload = snapshot.final.raw_payload or {}
    features = payload.get("source_property_features")
    observations = payload.get("source_field_observations")
    profile = payload.get("source_procedure_profile")

    assert isinstance(features, dict)
    assert isinstance(observations, dict)
    assert isinstance(profile, dict)
    assert profile["family"] == "judicial"
    assert observations["sale_legal_framework"]["state"] == "observed"
    for observation in observations.values():
        assert observation["state"] in {"observed", "inferred", "conflict", "unknown", "not_applicable"}
        for evidence in observation.get("evidence", []):
            assert evidence["grade"] in {"A", "B", "C", "none"}


@pytest.mark.parametrize(
    ("sample_id", "document_count", "minimum_image_count"),
    (
        ("info-6051", 4, 0),
        ("info-6053", 4, 0),
        ("vench-166665", 0, 1),
        ("vench-166663", 0, 1),
        ("petites-165934", 0, 1),
        ("petites-165875", 0, 1),
        # The production operator merge replaces the card preview with the
        # 21 allowlisted operator images; assert rich media without making a
        # card/operator ordering choice part of the contract.
        ("agrasc-auchel-424878", 6, 20),
    ),
)
def test_secondary_documents_and_media_are_retained(
    sample_id: str, document_count: int, minimum_image_count: int
) -> None:
    snapshot = replay(sample_id)
    assert len(snapshot.raw.get("documents") or []) == document_count
    assert len(snapshot.final.documents) == document_count
    source_images = (snapshot.final.raw_payload or {}).get("source_images") or []
    assert len(source_images) >= minimum_image_count
    if document_count:
        assert all(document.get("url") for document in snapshot.final.documents)
    if minimum_image_count:
        assert all(image.startswith("http") for image in source_images)


@pytest.mark.parametrize("sample_id", ["vench-166665", "vench-166663", "petites-165934", "petites-165875"])
def test_restricted_detail_is_recorded_as_access_state(sample_id: str) -> None:
    snapshot = replay(sample_id)
    assert snapshot.raw["source_detail_status"] == "restricted"


def test_info_encheres_qualified_total_survives_full_pipeline() -> None:
    snapshot = replay("info-6051")
    # The adapter qualifies the explicit lot total before canonical
    # normalization; the final stages retain the same scope.
    assert snapshot.base.surface_m2 == Decimal("110.80")
    assert snapshot.base.surface_scope == "total"
    assert snapshot.final.surface_m2 == Decimal("110.80")
    assert snapshot.final.raw_payload["surface_analysis"]["version"] == "surface_reasoning_v1"


def test_info_encheres_details_keep_typed_documents_and_no_property_photos() -> None:
    for sample_id in ("info-6051", "info-6053"):
        snapshot = replay(sample_id)
        assert snapshot.final.tribunal.startswith("Tribunal Judiciaire de ")
        assert snapshot.final.documents
        assert not ((snapshot.final.raw_payload or {}).get("source_images") or [])


def test_agrasc_auchel_operator_detail_merges_into_catalogue_identity() -> None:
    snapshot = replay("agrasc-auchel-424878")
    assert snapshot.raw["external_id"] == "424878"
    assert snapshot.raw["address"] == "10 rue Poiret, 62260 Auchel"
    assert snapshot.raw["source_blocks"]["operator_public_model"] == "FicheProduitApp"
    assert snapshot.final.surface_m2 == Decimal("62.60")
    assert snapshot.final.land_surface_m2 == Decimal("164")
    assert snapshot.final.bedrooms_count == 2


def test_agrasc_evry_catalogue_identity_survives_unavailable_operator_detail() -> None:
    snapshot = replay("agrasc-evry-2075541")
    assert snapshot.raw["external_id"] == "2075541"
    assert snapshot.raw["city"] == "Évry-Courcouronnes"
    assert snapshot.raw["surface_m2"] == "140"
    assert snapshot.raw["source_images"]
    assert snapshot.final.starting_price_eur == Decimal("120000")


def test_info_encheres_direct_normalization_promotes_explicit_total_surface() -> None:
    snapshot = replay("info-6051")
    assert snapshot.base.surface_m2 == Decimal("110.80")
    assert snapshot.base.surface_scope == "total"
    assert "110,80" in (snapshot.base.surface_evidence or "")


def test_agrasc_evry_does_not_infer_generic_surface_as_land() -> None:
    snapshot = replay("agrasc-evry-2075541")
    assert snapshot.final.land_surface_m2 is None
