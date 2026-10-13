"""Département et coordonnées déduits des preuves déjà stockées (code INSEE, tribunal, géocodage accepté)."""

from decimal import Decimal

import pytest

from src.asset_normalization import normalize_asset_features
from src.court_competence import OfficialCourt, OfficialCourtLabelIndex
from src.department_inference import (
    department_from_citycode,
    department_from_court_evidence,
    department_from_geocode_evidence,
)
from src.geocode import restore_accepted_geocode
from src.normalize import normalize_sale
from src.recompute_scoring import _recomputed_sale_from_storage_row
from src.tribunal import fill_tribunal

MARSEILLE = OfficialCourt(
    court_code="justice_tj_1_210",
    court_name="TJ Marseille",
    official_court_name="Tribunal judiciaire de Marseille",
    court_origin_code="1",
    court_srj_code="210",
    court_department="13",
    court_city="Marseille",
)


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", OfficialCourtLabelIndex([MARSEILLE]).resolve)


def _geocode(citycode: str | None = "13055", *, accepted: bool = True, type_: str = "municipality", **extra):
    return {
        "provider": "ban_geoplateforme",
        "accepted": accepted,
        "type": type_,
        "citycode": citycode,
        "latitude": 43.2965,
        "longitude": 5.3698,
        **extra,
    }


def _raw(**overrides: object) -> dict[str, object]:
    return {
        "source_name": "petites_affiches",
        "source_url": "https://example.test/vente/dep",
        "property_type": "apartment",
        "city": "Marseille",
        "starting_price_eur": "50 000 €",
        **overrides,
    }


@pytest.mark.parametrize(
    ("citycode", "department"),
    [("33063", "33"), ("13055", "13"), ("2A004", "2A"), ("2b033", "2B"), ("97411", "974"), ("75056", "75")],
)
def test_department_from_citycode(citycode: str, department: str) -> None:
    assert department_from_citycode(citycode) == department


@pytest.mark.parametrize("citycode", [None, "", "abc", "1234", "123456"])
def test_invalid_citycode_gives_no_department(citycode: object) -> None:
    assert department_from_citycode(citycode) is None


def test_normalize_takes_the_department_from_an_accepted_geocode() -> None:
    sale = normalize_sale(_raw(geocode=_geocode("13055")))

    assert sale.department == "13"


def test_normalize_ignores_a_rejected_geocode_and_never_overrides_the_postal_code() -> None:
    rejected = normalize_sale(_raw(geocode=_geocode("13055", accepted=False)))
    assert rejected.department is None

    with_postal = normalize_sale(_raw(geocode=_geocode("13055"), postal_code="33000", address="1 rue X 33000 Bordeaux"))
    assert with_postal.department == "33"
    assert department_from_geocode_evidence({"geocode": {**_geocode(), "provider": "other"}}) is None


def test_fill_tribunal_infers_the_department_from_an_exact_court_label() -> None:
    sale = normalize_sale(_raw(tribunal="TJ Marseille"))
    assert sale.department is None

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Marseille"
    assert sale.department == "13"
    assert sale.raw_payload["department_inference"] == {"source": "tribunal", "value": "13"}
    assert "department_from_tribunal" in sale.quality_flags


def test_fill_tribunal_infers_the_department_of_a_legacy_aquitaine_court(monkeypatch) -> None:
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", lambda label: None)
    sale = normalize_sale(_raw(tribunal="TJ Dax", city="Dax"))

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Dax"
    assert sale.department == "40"


def test_fill_tribunal_prefers_the_geocode_citycode_over_the_tribunal() -> None:
    sale = normalize_sale(_raw(tribunal="TJ Marseille"))
    sale.raw_payload["geocode"] = _geocode("13055")
    sale.department = None

    fill_tribunal(sale)

    assert sale.department == "13"
    assert sale.raw_payload["department_inference"]["source"] == "geocode_citycode"
    assert "department_from_tribunal" not in sale.quality_flags


def test_a_known_department_is_never_replaced() -> None:
    sale = normalize_sale(_raw(tribunal="TJ Marseille", department="83"))
    fill_tribunal(sale)

    assert sale.department == "83"
    assert "department_inference" not in sale.raw_payload


def test_an_unknown_tribunal_gives_no_department() -> None:
    sale = normalize_sale(_raw(tribunal=None, city="Nulle-Part"))
    fill_tribunal(sale)

    assert sale.department is None


def test_court_evidence_must_belong_to_the_sale_court() -> None:
    payload = {"tribunal_label_assignment": {"court_code": "justice_tj_1_210", "court_department": "13"}}

    assert department_from_court_evidence(payload, "justice_tj_1_210") == "13"
    assert department_from_court_evidence(payload, "bordeaux") is None
    assert department_from_court_evidence(payload, None) is None


def test_restore_copies_an_accepted_municipality_geocode_with_its_precision() -> None:
    sale = normalize_sale(_raw(geocode=_geocode("13055")))
    assert sale.latitude is None

    assert restore_accepted_geocode(sale) is True

    assert sale.latitude == Decimal("43.2965")
    assert sale.longitude == Decimal("5.3698")
    assert sale.raw_payload["geo_precision"] == "municipality"


def test_restore_keeps_existing_coordinates_and_ignores_unaccepted_or_out_of_department_points() -> None:
    kept = normalize_sale(_raw(geocode=_geocode(), latitude=44.0, longitude=1.0))
    assert restore_accepted_geocode(kept) is False
    assert kept.latitude == Decimal("44.0")

    rejected = normalize_sale(_raw(geocode=_geocode(accepted=False)))
    assert restore_accepted_geocode(rejected) is False
    assert rejected.latitude is None

    outside = normalize_sale(_raw(geocode=_geocode("33063", latitude=48.85, longitude=2.35), department="33"))
    assert restore_accepted_geocode(outside) is False
    assert outside.latitude is None

    broken = normalize_sale(_raw(geocode={**_geocode(), "latitude": "n/a"}))
    assert restore_accepted_geocode(broken) is False


def test_restore_does_not_bring_back_coordinates_of_a_rejected_address() -> None:
    address_point = normalize_sale(
        _raw(
            geocode=_geocode(type_="housenumber"),
            invalid_address_evidence={"value": "30 000 €", "reason": "monetary_value_is_not_address"},
        )
    )
    assert restore_accepted_geocode(address_point) is False

    commune_point = normalize_sale(
        _raw(
            geocode=_geocode(type_="municipality"),
            invalid_address_evidence={"value": "30 000 €", "reason": "monetary_value_is_not_address"},
        )
    )
    assert restore_accepted_geocode(commune_point) is True


def test_missing_gps_flag_follows_the_coordinates() -> None:
    sale = normalize_sale(_raw(description="Appartement de 40 m2"))
    sale.quality_flags = ["missing_gps"]
    sale.latitude, sale.longitude = Decimal("43.3"), Decimal("5.4")
    normalize_asset_features(sale)
    assert "missing_gps" not in sale.quality_flags

    sale.latitude = sale.longitude = None
    normalize_asset_features(sale)
    assert "missing_gps" in sale.quality_flags


def test_recompute_repairs_department_coordinates_and_the_stale_flag_from_stored_evidence() -> None:
    row = {
        "id": "pa-1",
        "source_name": "petites_affiches",
        "source_url": "https://example.test/vente/pa-1",
        "property_type": "apartment",
        "city": "Marseille",
        "department": None,
        "latitude": None,
        "longitude": None,
        "quality_flags": ["missing_gps"],
        "description": "Appartement de 45 m2",
        "raw_payload": {"geocode": _geocode("13055"), "city": "Marseille"},
    }

    sale = _recomputed_sale_from_storage_row(row)

    assert sale.department == "13"
    assert (sale.latitude, sale.longitude) == (Decimal("43.2965"), Decimal("5.3698"))
    assert sale.raw_payload["geo_precision"] == "municipality"
    assert "missing_gps" not in sale.quality_flags
