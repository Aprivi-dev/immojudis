"""Replay public pages observed on 2026-10-02; no network, database or AI calls.

Expected values below were read from the listing, independently of the parser.
Known semantic gaps are strict xfails: --runxfail exposes them as failures, and
a future fix produces XPASS(strict), requiring the gap marker to be removed.
"""
from __future__ import annotations

import copy
import json
import re
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from bs4 import BeautifulSoup

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.normalize import clean_text, normalize_sale
from src.sources.avoventes import _enrich_sale_from_detail, compact_avoventes_catalogue_html, parse_avoventes_html
from src.sources.licitor import AQUITAINE_URL, parse_licitor_detail_html, parse_licitor_list_sales

ROOT = Path(__file__).resolve().parents[3]
CAPTURES = ROOT / "docs/audits/sources-2026-10-02/primary"


class FrozenClient:
    def __init__(self, html: str, expected_url: str):
        self.html = html
        self.expected_url = expected_url

    def get(self, url: str) -> str:
        assert url == self.expected_url
        return self.html


@lru_cache
def avoventes_catalogue():
    html = (CAPTURES / "avoventes-list.html").read_text()
    return parse_avoventes_html(
        compact_avoventes_catalogue_html(html),
        page_url="https://avoventes.fr/recherche?display=liste&order=asc&sort=date",
    )


@lru_cache
def replay(case_id: str):
    manifest = json.loads((CAPTURES / "browser-manifest.json").read_text())
    case = next(row for row in manifest if row["id"] == case_id)
    html = (CAPTURES / f"{case_id}.html").read_text()
    if case["source"] == "licitor":
        raw = parse_licitor_detail_html(html, case["url"])
    else:
        # The Avoventes detail parser intentionally returns an enrichment patch.
        # Exercise the actual list/detail merge rather than inventing defaults.
        raw = copy.deepcopy(next(row for row in avoventes_catalogue() if row["source_url"] == case["url"]))
        errors = []
        _enrich_sale_from_detail(FrozenClient(html, case["url"]), raw, errors)
        assert not errors
    sale = normalize_sale(copy.deepcopy(raw))
    values = [sale.title, sale.description, sale.raw_text, *sale.raw_payload.get("source_blocks", {}).values()]
    context = "\n".join(dict.fromkeys(clean_text(str(value)) for value in values if value))
    extract_and_apply_deterministic_surface_reasoning(sale, context)
    normalize_asset_features(sale)
    return raw, sale


@pytest.mark.parametrize("case_id,expected", [
    ("licitor-109932", {"city": "Savigné", "starting_price_eur": "50000", "bedrooms_count": 4,
                        "sale_date": "2026-10-13T07:00:00+00:00"}),
    ("licitor-110031", {"city": "Poitiers", "starting_price_eur": "30000",
                        "sale_date": "2026-10-27T08:00:00+00:00"}),
    ("avoventes-une-villa-a-ceyreste", {"city": "Ceyreste", "starting_price_eur": "200000.00",
        "carrez_surface_m2": "156.45", "rooms_count": 11, "bedrooms_count": 6,
        "sale_date": "2026-10-21T07:30:00+00:00", "occupancy_status": None}),
    ("avoventes-un-appartement-a-marseille-2", {"city": "Marseille", "starting_price_eur": "40000.00",
        "surface_m2": "58.04", "rooms_count": 3, "bedrooms_count": 2,
        "sale_date": "2026-11-04T08:30:00+00:00", "occupancy_status": "occupied"}),
    ("avoventes-une-piece-a-saint-cloud", {"city": "Saint-Cloud", "starting_price_eur": "18000.00",
        "surface_m2": "10.1", "rooms_count": 1,
        "sale_date": "2026-10-22T12:30:00+00:00", "occupancy_status": "occupied"}),
])
def test_source_identity_prices_dates_and_explicit_features(case_id, expected):
    _, sale = replay(case_id)
    for field, value in expected.items():
        actual = getattr(sale, field)
        if field == "sale_date":
            actual = actual.isoformat()
        elif value is not None and (field.endswith("_m2") or field == "starting_price_eur"):
            actual = str(actual)
        assert actual == value, f"{case_id}: {field}"


@pytest.mark.parametrize("case_id,count", [
    ("avoventes-une-villa-a-ceyreste", 5),
    ("avoventes-un-appartement-a-marseille-2", 3),
    ("avoventes-une-piece-a-saint-cloud", 12),
    ("licitor-109932", 0), ("licitor-110031", 0),
])
def test_all_listing_document_links_retained(case_id, count):
    raw, sale = replay(case_id)
    assert len(raw["documents"]) == count
    assert len(sale.documents) == count
    assert len({document["url"] for document in sale.documents}) == count


def asset_key(url: str) -> str:
    return re.sub(r"^(?:resized_|cropped_)", "", Path(urlsplit(url).path).name)


@pytest.mark.parametrize("case_id,count", [
    ("avoventes-une-villa-a-ceyreste", 55),
    ("avoventes-un-appartement-a-marseille-2", 1),
    ("avoventes-une-piece-a-saint-cloud", 14),
])
def test_gallery_assets_match_without_logos_maps_or_nearby_properties(case_id, count):
    raw, _ = replay(case_id)
    soup = BeautifulSoup((CAPTURES / f"{case_id}.html").read_text(), "html.parser")
    gallery = soup.select_one("#lightSliderDetails")
    expected = {asset_key(node["data-src"]) for node in gallery.select("[data-src]")}
    extracted = {asset_key(url) for url in raw["source_images"]}
    assert len(expected) == count
    assert extracted == expected


@pytest.mark.parametrize("case_id", ["licitor-109932", "licitor-110031"])
def test_licitor_site_branding_is_not_a_property_photo(case_id):
    assert replay(case_id)[0]["source_images"] == []


def test_conflicting_occupation_is_preserved_as_unknown_with_a_flag():
    raw, sale = replay("avoventes-une-villa-a-ceyreste")
    assert "les lieux ne sont pas occupés" in raw["description"]
    assert "Actuellement occupée" in raw["description"]
    assert sale.occupancy_status is None
    assert "ambiguous_occupancy" in sale.raw_payload["quality_flags"]


@pytest.mark.parametrize("case_id,dpe,ges", [
    ("avoventes-une-villa-a-ceyreste", "D", None),
    ("avoventes-une-piece-a-saint-cloud", "F", "F"),
])
def test_energy_labels_survive_in_the_actual_payload_location(case_id, dpe, ges):
    _, sale = replay(case_id)
    diagnostics = sale.raw_payload["source_energy_diagnostics"]
    assert diagnostics["dpe_class"] == dpe
    assert diagnostics["ges_class"] == ges


def test_licitor_list_does_not_use_price_as_sale_date():
    html = (CAPTURES / "licitor-list.html").read_text()
    rows = parse_licitor_list_sales(html, AQUITAINE_URL)
    assert rows
    assert all(row["sale_date"] is None for row in rows)


def test_licitor_lawyer_postcode_does_not_become_property_postcode():
    raw, sale = replay("licitor-110031")
    assert "86002 Poitiers" in raw["lawyer_contact"]
    assert sale.postal_code is None


def test_cold_rooms_are_not_bedrooms():
    raw, sale = replay("licitor-110031")
    assert "deux chambres froides" in raw["description"]
    assert sale.bedrooms_count is None


def test_saint_cloud_retains_carrez_surface():
    raw, sale = replay("avoventes-une-piece-a-saint-cloud")
    assert "SUPERFICIE privative (Loi Carrez) : 10,10 m²" in raw["description"]
    assert sale.carrez_surface_m2 == Decimal("10.10")


def test_building_terrace_is_not_assigned_to_the_apartment():
    raw, sale = replay("avoventes-un-appartement-a-marseille-2")
    assert "cinquième étage, divers locaux et terrasse" in raw["description"]
    assert "premier étage à droite" in raw["description"]
    assert sale.has_terrace is not True


def test_ground_floor_word_does_not_prove_garden_rights():
    raw, sale = replay("avoventes-une-piece-a-saint-cloud")
    assert "En rez-de-jardin" in raw["description"]
    assert sale.has_garden is not True


def test_conflicting_land_area_is_not_silently_selected():
    raw, sale = replay("avoventes-une-villa-a-ceyreste")
    assert "51 a 04 ca" in raw["description"]
    assert raw["land_surface_m2"] == "51.04"
    # Exclusive rights/surface need verification; do not assume all 5104m2 belong to this villa.
    assert sale.land_surface_m2 is None


def test_visit_contact_does_not_replace_lawyer_contact():
    raw, sale = replay("avoventes-une-villa-a-ceyreste")
    assert "04.42.83.81.30" in raw["visit_dates"][0]
    assert "+33491331459" in sale.lawyer_contact or "jeanne.giraud@rousselcabaye.fr" in sale.lawyer_contact


def test_department_known_on_the_licitor_card_survives_detail_enrichment():
    rows = parse_licitor_list_sales((CAPTURES / "licitor-list.html").read_text(), AQUITAINE_URL)
    listing = next(row for row in rows if row["external_id"] == "109932")
    assert listing["department"] == "86"
    assert replay("licitor-109932")[1].department == "86"
