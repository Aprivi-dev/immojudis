"""n° 64 : contrôle de cohérence des coordonnées source, voie comparée, drapeaux de position retirés ou gardés."""

from __future__ import annotations

from decimal import Decimal

import pytest

from src import geocode, municipality_location
from src.geocode import GeocodeResult, geocode_sale, locate_sale_by_cadastre, verify_source_coordinates
from src.normalize import normalize_sale
from src.position_quality import (
    classify_distance_to_commune,
    distance_km,
    preserved_position_flags,
    street_name_tokens,
    street_names_match,
)
from src.recompute_scoring import _sale_from_storage_row

COMMUNES = [
    {"code_insee": "06069", "name_normalized": "grasse", "department_code": "06",
     "postal_codes": ["06130"], "latitude": 43.6584, "longitude": 6.9225},
    {"code_insee": "33063", "name_normalized": "bordeaux", "department_code": "33",
     "postal_codes": ["33000", "33100"], "latitude": 44.8412, "longitude": -0.5800},
]


@pytest.fixture
def communes(monkeypatch):
    monkeypatch.setattr(municipality_location, "load_communes", lambda: COMMUNES)
    municipality_location.reset_cache()
    yield
    municipality_location.reset_cache()


def _sale(**fields):
    return normalize_sale({"source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/position", **fields})


def _grasse(latitude: str, longitude: str):
    sale = _sale(address="12 rue Exemple 06130 Grasse", postal_code="06130", city="Grasse", department="06")
    sale.latitude, sale.longitude = Decimal(latitude), Decimal(longitude)
    return sale


# --- distance --------------------------------------------------------------------------------------


def test_distance_and_thresholds() -> None:
    assert distance_km(43.6584, 6.9225, 43.6584, 6.9225) == 0
    assert 110 < distance_km(43.0, 6.0, 44.0, 6.0) < 112
    assert classify_distance_to_commune(3.0) is None
    assert classify_distance_to_commune(15.0) == "unverified"
    assert classify_distance_to_commune(55.0) == "implausible"


# --- contrôle de cohérence des coordonnées source ------------------------------------------------


def test_a_point_in_england_for_a_sale_in_grasse_is_removed_and_flagged(communes) -> None:
    sale = _grasse("54.27", "-0.40")

    assert verify_source_coordinates(sale) == "implausible"

    assert sale.latitude is None and sale.longitude is None
    assert "implausible_coordinates" in sale.quality_flags
    assert sale.raw_payload["rejected_source_coordinates"]["reason"] == "outside_department"


def test_a_point_in_the_department_but_far_from_the_commune_is_kept_but_unverified(communes) -> None:
    # Environ 25 km à l'est de Grasse, encore dans les Alpes-Maritimes.
    sale = _grasse("43.70", "7.25")

    assert verify_source_coordinates(sale) == "unverified"

    assert sale.latitude == Decimal("43.70")
    assert sale.quality_flags == ["unverified_source_coordinates"]


def test_a_point_in_the_department_but_very_far_from_the_commune_is_implausible(communes) -> None:
    # Vers Menton, à plus de 40 km de Grasse, encore dans les Alpes-Maritimes.
    sale = _grasse("43.78", "7.50")

    assert verify_source_coordinates(sale) == "implausible"
    assert sale.latitude is None
    assert sale.raw_payload["rejected_source_coordinates"]["reason"] == "far_from_commune"


def test_a_coherent_point_gets_no_flag_and_clears_a_stale_one(communes) -> None:
    sale = _grasse("43.66", "6.93")
    sale.quality_flags = ["unverified_source_coordinates", "source_page_only"]

    assert verify_source_coordinates(sale) is None

    assert sale.latitude == Decimal("43.66")
    assert sale.quality_flags == ["source_page_only"]


def test_without_the_reference_table_only_the_department_box_applies() -> None:
    municipality_location.reset_cache()
    try:
        far_but_inside = _grasse("43.78", "7.50")
        assert verify_source_coordinates(far_but_inside) is None
        outside = _grasse("54.27", "-0.40")
        assert verify_source_coordinates(outside) == "implausible"
    finally:
        municipality_location.reset_cache()


def test_the_offline_path_checks_source_coordinates_then_falls_back_to_the_commune_centre(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", lambda: {"geocode_enabled": False})
    sale = _grasse("54.27", "-0.40")

    locate_sale_by_cadastre(sale)

    assert (sale.latitude, sale.longitude) == (Decimal("43.6584"), Decimal("6.9225"))
    assert sale.raw_payload["geo_precision"] == "municipality"
    assert "implausible_coordinates" in sale.quality_flags


def test_a_commune_centre_is_not_a_source_coordinate(communes) -> None:
    sale = _grasse("43.6584", "6.9225")
    sale.raw_payload["geo_precision"] = "municipality"
    sale.quality_flags = ["unverified_source_coordinates"]

    assert verify_source_coordinates(sale) is None
    assert sale.quality_flags == []


def test_a_commune_centre_without_precision_gets_municipality_precision_from_its_evidence(communes) -> None:
    sale = _grasse("43.6584", "6.9225")
    sale.raw_payload["geocode"] = {
        "provider": "reference_communes", "accepted": True, "type": "municipality",
        "latitude": 43.6584, "longitude": 6.9225,
    }
    assert "geo_precision" not in sale.raw_payload

    verify_source_coordinates(sale)

    assert sale.raw_payload["geo_precision"] == "municipality"


# --- drapeaux retirés quand la position est corrigée ----------------------------------------------


def _ban_settings():
    return {"geocode_enabled": True, "geocode_api_url": "https://ban.test", "geocode_min_score": 0.45}


def test_an_accepted_geocode_clears_every_position_flag(communes, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    sale = _grasse("43.78", "7.50")
    sale.quality_flags = ["geocode_outside_department", "implausible_coordinates", "multi_lot_sale"]
    found = GeocodeResult(
        latitude=Decimal("43.6581"), longitude=Decimal("6.9229"), score=0.95, label="12 Rue Exemple 06130 Grasse",
        result_type="housenumber", city="Grasse", citycode="06069", postcode="06130", street="Rue Exemple",
    )
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: found)

    geocode_sale(sale)

    assert sale.quality_flags == ["multi_lot_sale"]
    assert sale.raw_payload["geo_precision"] == "address"


# --- nom de voie -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("address", "tokens"),
    [
        ("5 rue du Château, 33000 Bordeaux", {"chateau"}),
        ("12 bis, avenue de la République 75011 Paris", {"republique"}),
        ("12 et 14 rue Victor Hugo", {"victor", "hugo"}),
        ("3 Boulevard Jean Sarrailh 64000 PAU", {"jean", "sarrailh"}),
        ("St-Exupéry, 2 allée des Pins", None),
        ("Résidence Les Pins, 12 rue Truc", None),
        ("Lieu-dit Le Moulin", None),
        ("", None),
    ],
)
def test_street_name_tokens_of_an_address(address: str, tokens: set[str] | None) -> None:
    assert street_name_tokens(address, require_street_type=True) == (frozenset(tokens) if tokens else None)


def test_street_names_compare_on_normalised_words() -> None:
    chateau = street_name_tokens("5 rue du Château", require_street_type=True)
    chateau_eau = street_name_tokens("Rue du Château d'Eau", require_street_type=False)
    same = street_name_tokens("Rue du Chateau", require_street_type=False)

    assert street_names_match(chateau, same, 0.6)
    assert not street_names_match(chateau, chateau_eau, 0.6)
    # Une BAN sûre d'elle (0,9) tolère un mot en plus ou en moins : la moitié des mots se retrouve.
    assert street_names_match(chateau, chateau_eau, 0.9)
    assert street_names_match(None, chateau_eau, 0.6)


def test_titles_and_typos_do_not_change_the_street() -> None:
    wanted = street_name_tokens("4 rue du Général Leclerc", require_street_type=True)

    assert street_names_match(wanted, street_name_tokens("Rue Leclerc", require_street_type=False), 0.6)
    assert street_names_match(wanted, street_name_tokens("Rue du General Leclercq", require_street_type=False), 0.6)
    assert not street_names_match(wanted, street_name_tokens("Rue du Général de Gaulle", require_street_type=False), 0.6)


def _street_result(street: str, score: float) -> GeocodeResult:
    return GeocodeResult(
        latitude=Decimal("44.84"), longitude=Decimal("-0.58"), score=score, label=f"1 {street} 33000 Bordeaux",
        result_type="housenumber", city="Bordeaux", citycode="33063", postcode="33000", street=street,
    )


def test_a_ban_result_on_another_street_is_refused_and_the_commune_centre_is_used(communes, monkeypatch) -> None:
    calls = []

    def fake_geocode_address(**kwargs):
        calls.append(kwargs.get("result_type"))
        if kwargs.get("result_type") == "municipality":
            return GeocodeResult(
                latitude=Decimal("44.8412"), longitude=Decimal("-0.58"), score=0.8, label="Bordeaux",
                result_type="municipality", city="Bordeaux", citycode="33063", postcode="33000",
            )
        return _street_result("Rue du Château d'Eau", 0.6)

    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    monkeypatch.setattr(geocode, "geocode_address", fake_geocode_address)
    sale = _sale(address="5 rue du Château", postal_code="33000", city="Bordeaux", department="33")

    geocode_sale(sale)

    assert calls == [None, "municipality"]
    assert sale.raw_payload["geo_precision"] == "municipality"
    assert sale.raw_payload["geocode"]["type"] == "municipality"


def test_a_ban_result_on_another_street_leaves_no_point_and_is_cached_when_nothing_else_is_found(monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: _street_result("Rue du Château d'Eau", 0.6))
    sale = _sale(address="5 rue du Château", postal_code="33000", department="33")

    geocode_sale(sale)

    assert sale.latitude is None
    assert sale.raw_payload["geocode"]["rejection_reason"] == "street_mismatch"
    assert sale.raw_payload["geocode"]["accepted"] is False


def test_the_same_street_is_accepted(monkeypatch) -> None:
    monkeypatch.setattr(geocode, "resolve_sale_cadastre", lambda *args, **kwargs: False)
    monkeypatch.setattr(geocode, "load_settings", _ban_settings)
    monkeypatch.setattr(geocode, "geocode_address", lambda **kwargs: _street_result("Rue du Château", 0.6))
    sale = _sale(address="5 rue du Château", postal_code="33000", department="33")

    geocode_sale(sale)

    assert sale.latitude == Decimal("44.84")
    assert sale.raw_payload["geo_precision"] == "address"


def test_a_feature_carries_the_street_of_an_address_result_only() -> None:
    feature = {
        "properties": {"score": 0.9, "type": "housenumber", "name": "5 Rue du Château", "street": "Rue du Château",
                       "city": "Bordeaux", "citycode": "33063", "postcode": "33000"},
        "geometry": {"coordinates": [-0.58, 44.84]},
    }
    commune = {"properties": {"score": 0.9, "type": "municipality", "name": "Bordeaux", "city": "Bordeaux"},
               "geometry": {"coordinates": [-0.58, 44.84]}}

    assert geocode._result_from_feature(feature, 0.45).street == "Rue du Château"
    assert geocode._result_from_feature(commune, 0.45).street is None


# --- recalcul : les drapeaux de position survivent -----------------------------------------------------


def test_recompute_keeps_position_flags_and_drops_the_others() -> None:
    row = {
        "id": "keep-flags",
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/keep-flags",
        "quality_flags": ["implausible_coordinates", "source_page_only", "unverified_source_coordinates", "oops"],
        "raw_payload": {},
    }

    sale = _sale_from_storage_row(row)

    assert sale.quality_flags == ["implausible_coordinates", "unverified_source_coordinates"]


def test_preserved_position_flags_ignores_what_is_not_a_known_flag() -> None:
    assert preserved_position_flags(None) == []
    assert preserved_position_flags("implausible_coordinates") == []
    assert preserved_position_flags([1, "geocode_outside_department", "geocode_outside_department", "x"]) == [
        "geocode_outside_department"
    ]


# --- repli BAN commune : le centre est retenté ----------------------------------------------------------


def test_a_commune_centre_is_recognised_so_that_the_enrichment_retries_the_ban(communes) -> None:
    sale = _sale(address="chemin sans nom", postal_code="33000", city="Bordeaux", department="33")
    assert municipality_location.is_municipality_point(sale) is False

    municipality_location.locate_sale_by_municipality(sale)

    assert municipality_location.is_municipality_point(sale) is True
