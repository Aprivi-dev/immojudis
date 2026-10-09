"""Frozen live-source smoke checks captured on 2026-10-02.

These tests never access the network.  They replay the public HTML/JSON saved by
the browser audit so a parser change can be checked against real source shapes.
The Enchères Immobilières case is intentionally a transport assertion because
both referenced URLs timed out before any HTML was received.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.normalize import clean_text, normalize_sale
from src.sources.cessions_etat import parse_cessions_etat_detail_html
from src.sources.notaires import parse_notaires_detail_json

REPO_ROOT = Path(__file__).resolve().parents[3]
AUDIT_DIR = REPO_ROOT / "docs/audits/sources-2026-10-02/dynamic"


def _surface_context(sale: object) -> str:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = raw_payload.get("source_blocks")
    values = [sale.title, sale.description, sale.raw_text]
    if isinstance(source_blocks, dict):
        values.extend(source_blocks.values())
    return "\n".join(
        dict.fromkeys(text for value in values if (text := clean_text(value)))
    )


def _replay_final(stem: str):
    if stem == "cessions-39823-saint-junien":
        url = "https://cessions.immobilier-etat.gouv.fr/biens/parcelle-br-ndeg104-saint-junien-87200"
        raw = parse_cessions_etat_detail_html(
            (AUDIT_DIR / "clean" / f"{stem}-response.html").read_text(), url
        )
    elif stem == "cessions-39632-bordeaux":
        url = "https://cessions.immobilier-etat.gouv.fr/biens/vendre-hyper-centre-ville-de-bordeaux"
        raw = parse_cessions_etat_detail_html(
            (AUDIT_DIR / "clean" / f"{stem}-response.html").read_text(), url
        )
    elif stem in {"notaires-2083008-arcachon", "notaires-2074289-bordeaux"}:
        external_id = {
            "notaires-2083008-arcachon": "2083008",
            "notaires-2074289-bordeaux": "2074289",
        }[stem]
        api_url = f"https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/{external_id}"
        raw = {
            "source_name": "notaires",
            "source_url": api_url,
            "external_id": external_id,
            **parse_notaires_detail_json(
                (AUDIT_DIR / "clean" / f"{stem}-response.html").read_text(),
                fallback={"source_url": api_url},
            ),
        }
    else:
        raise AssertionError(f"unsupported dynamic fixture: {stem}")
    final = normalize_sale(copy.deepcopy(raw))
    extract_and_apply_deterministic_surface_reasoning(final, _surface_context(final))
    normalize_asset_features(final)
    return final


@pytest.mark.parametrize(
    ("stem", "url", "title", "city", "expected_property_type", "surface", "documents"),
    (
        (
            "cessions-39823-saint-junien",
            "https://cessions.immobilier-etat.gouv.fr/biens/parcelle-br-ndeg104-saint-junien-87200",
            "Parcelle Br N°104 à Saint Junien (87200)",
            "Saint-junien",
            "land",
            "13037",
            5,
        ),
        (
            "cessions-39632-bordeaux",
            "https://cessions.immobilier-etat.gouv.fr/biens/vendre-hyper-centre-ville-de-bordeaux",
            "A Vendre Hyper Centre Ville De Bordeaux",
            "Bordeaux",
            None,
            "338",
            3,
        ),
    ),
)
def test_cessions_frozen_live_details_replay_core_fields(
    stem: str,
    url: str,
    title: str,
    city: str,
    expected_property_type: str | None,
    surface: str,
    documents: int,
) -> None:
    html = (AUDIT_DIR / "clean" / f"{stem}-response.html").read_text()
    parsed = parse_cessions_etat_detail_html(html, url)

    assert parsed["title"] == title
    assert parsed["city"] == city
    assert parsed["surface_m2"] == surface
    assert len(parsed["documents"]) == documents
    assert parsed["source_images"]
    if expected_property_type is not None:
        assert parsed["property_type"] == expected_property_type


def test_cessions_bordeaux_type_comes_from_explicit_detail_semantics() -> None:
    """The page's descriptive block wins over the site's navigation label."""
    parsed = parse_cessions_etat_detail_html(
        (AUDIT_DIR / "clean" / "cessions-39632-bordeaux-response.html").read_text(),
        "https://cessions.immobilier-etat.gouv.fr/biens/vendre-hyper-centre-ville-de-bordeaux",
    )
    assert parsed["property_type"] == "building"
    assert parsed["source_blocks"]["type_bien_source"] == "Maisons"
    assert "immeuble" in parsed["source_blocks"]["description"].lower()


def test_cessions_audit_does_not_promote_attachment_or_relative_countdown() -> None:
    """Site chrome such as "Pièces jointes" and "Fini dans N jours" is not
    an advertised room count or an absolute sale date.
    """
    audit = json.loads((AUDIT_DIR / "extraction-audit.json").read_text())
    for entry in audit:
        if entry["source"] != "cessions_etat":
            continue
        assert entry["fields"]["rooms_count"]["source_present"] is False
        assert entry["fields"]["sale_date"]["source_present"] is False


def test_cessions_detail_promotes_qualified_identity_and_procedure_features() -> None:
    saint = parse_cessions_etat_detail_html(
        (AUDIT_DIR / "clean" / "cessions-39823-saint-junien-response.html").read_text(),
        "https://cessions.immobilier-etat.gouv.fr/biens/parcelle-br-ndeg104-saint-junien-87200",
    )
    assert saint["postal_code"] == "87200"
    assert saint["land_surface_m2"] == "13037"
    assert saint["source_blocks"]["code_insee"] == "87154"
    assert saint["source_blocks"]["references_cadastrales"].startswith("BR n° 104")
    assert saint["source_blocks"]["plu"] == "zone A"
    assert saint["source_blocks"]["procedure_vente"] == "Appel d'offres"
    assert saint["source_property_features"]["manager"]["email"]
    assert saint["source_property_features"]["media"]["document_count"] == 5

    bordeaux = parse_cessions_etat_detail_html(
        (AUDIT_DIR / "clean" / "cessions-39632-bordeaux-response.html").read_text(),
        "https://cessions.immobilier-etat.gouv.fr/biens/vendre-hyper-centre-ville-de-bordeaux",
    )
    assert bordeaux["property_type"] == "building"
    assert bordeaux["source_blocks"]["nombre_etages_batiment"] == 2
    assert bordeaux["source_property_features"]["manager"]["phone"] == "0556907738"
    assert bordeaux["source_property_features"]["cadastre"]["reference"] == "KS 48"
    assert bordeaux["source_property_features"]["procedure"]["method"] == "Appel d'offres"


def test_notaires_detail_preserves_qualified_diagnostics_finance_and_scoped_surfaces() -> None:
    arcachon = parse_notaires_detail_json(
        (AUDIT_DIR / "clean" / "notaires-2083008-arcachon-response.html").read_text()
    )
    blocks = arcachon["source_blocks"]
    assert blocks["etage"] == 4
    assert blocks["nb_etages"] == 6
    assert blocks["dpe_value"] == 146
    assert blocks["ges_value"] == 5
    assert blocks["dpe_date"] == "2026-09-08"
    assert blocks["property_tax_eur"] == 2941
    assert blocks["charges_copropriete_annuelles_eur"] == 3956
    assert arcachon["source_property_features"]["energy"]["dpe"] == {
        "class": "C",
        "value": 146,
        "unit": "kWh/m²/an",
        "date": "2026-09-08",
    }
    surfaces = arcachon["source_property_features"]["surfaces"]
    assert surfaces["aggregate_carrez_m2"] == 117.58
    assert [item["carrez_surface_m2"] for item in surfaces["assets"]] == [83.21, 34.37]
    assert surfaces["sum_check"]["status"] == "matches"
    assert arcachon["parking_count"] == 2

    bordeaux = parse_notaires_detail_json(
        (AUDIT_DIR / "clean" / "notaires-2074289-bordeaux-response.html").read_text()
    )
    technical = bordeaux["source_property_features"]["technical"]
    assert technical["heating"] == "pompe à chaleur"
    assert technical["solar_panels"] is True
    assert technical["thermodynamic_water_heater"] is True
    assert bordeaux["source_property_features"]["works_to_plan"] is True


def test_deterministic_final_replay_is_preserved_for_surface_and_equipment_checks() -> None:
    """Replay the current parser and deterministic stages on frozen fixtures."""
    audit = json.loads((AUDIT_DIR / "extraction-audit.json").read_text())
    by_id = {entry["id"]: entry for entry in audit}

    arcachon = _replay_final("notaires-2083008-arcachon")
    assert arcachon.raw_payload["surface_analysis"]["version"] == "surface_reasoning_v1"
    assert float(arcachon.carrez_surface_m2) == 117.58
    assert float(arcachon.app_surface_m2) == 117.58
    assert arcachon.parking_count == 2

    bordeaux = _replay_final("notaires-2074289-bordeaux")
    assert float(bordeaux.surface_m2) == 76.36
    assert float(bordeaux.land_surface_m2) == 118

    for stem in by_id:
        assert isinstance(by_id[stem]["deterministic_final"], dict)


def test_notaires_public_inventory_counts_match_clean_fixtures() -> None:
    expected = {
        "notaires-public-2083008-arcachon": (19, 78),
        "notaires-public-2074289-bordeaux": (19, 73),
    }
    for stem, (images, blocks) in expected.items():
        inventory = json.loads((AUDIT_DIR / "clean" / f"{stem}-inventory.json").read_text())
        assert len(inventory["images"]) == images
        assert len(inventory["blocks"]) == blocks


def test_cessions_saint_junien_final_promotes_land_surface() -> None:
    final = _replay_final("cessions-39823-saint-junien")
    assert final.land_surface_m2 is not None
    assert float(final.land_surface_m2) == 13037


def test_cessions_bordeaux_final_uses_detail_property_semantics() -> None:
    final = _replay_final("cessions-39632-bordeaux")
    assert final.property_type != "house"


@pytest.mark.parametrize(
    ("stem", "id_", "city", "property_type", "surface", "land", "rooms", "bedrooms", "images"),
    (
        ("notaires-2083008-arcachon", "2083008", "Arcachon", "appartement", 117.58, None, 4, 3, 12),
        ("notaires-2074289-bordeaux", "2074289", "Bordeaux", "maison", 76.36, 118, 4, 2, 12),
    ),
)
def test_notaires_frozen_live_api_replays_detail_fields(
    stem: str,
    id_: str,
    city: str,
    property_type: str,
    surface: float,
    land: float | None,
    rooms: int,
    bedrooms: int,
    images: int,
) -> None:
    payload = (AUDIT_DIR / "clean" / f"{stem}-response.html").read_text()
    parsed = parse_notaires_detail_json(payload)

    assert json.loads(payload)["id"] == int(id_)
    assert parsed["city"] == city
    assert parsed["property_type"] == property_type
    assert float(parsed["surface_m2"]) == surface
    assert parsed["land_surface_m2"] == land
    assert parsed["rooms_count"] == rooms
    assert parsed["bedrooms_count"] == bedrooms
    assert len(parsed["source_images"]) == images
    assert parsed["starting_price_eur"] in (140000, 480000)
    assert parsed["source_sale_schedule"]["opens_at"]
    assert parsed["source_sale_schedule"]["closes_at"]


def test_encheres_immobilieres_frozen_transport_failures_are_explicit() -> None:
    captures = json.loads((AUDIT_DIR / "encheres-immobilieres-captures.json").read_text())
    failures = {
        entry["id"]: entry
        for entry in captures
        if entry.get("source") == "encheres_immobilieres"
    }

    assert set(failures) == {
        "encheres-immobilieres-9486-reference",
        "encheres-immobilieres-9354-reference",
    }
    assert all(entry["state"] == "capture_failed" for entry in failures.values())
    assert any("Timeout" in entry.get("error", "") or "TIMED_OUT" in entry.get("error", "") for entry in failures.values())
