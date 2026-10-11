"""Localisation par références cadastrales (API Carto IGN), sans réseau réel."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from src import cadastre_references as refs
from src.cadastre import fetch_cadastre_parcels_for_sale
from src.cadastre_references import (
    ParcelRef,
    designation,
    parse_cadastral_references,
    ref_label,
    references_signature,
    resolve_sale_cadastre,
)
from src.models import AuctionSale


@pytest.fixture(autouse=True)
def _isolated_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("CADASTRE_REFERENCE_CACHE_PATH", str(tmp_path / "parcels.json"))
    monkeypatch.setattr(refs, "REQUEST_DELAY_SECONDS", 0)
    monkeypatch.setattr(refs, "RETRY_BACKOFF_SECONDS", (0.0,))
    refs._MEMORY.clear()
    refs._FAILURES[0] = 0
    yield
    refs._MEMORY.clear()
    refs._FAILURES[0] = 0


def _labels(value: str) -> list[str]:
    return [ref_label(ref) for ref in parse_cadastral_references(value)]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("AR326", ["AR 326"]),
        ("AR N° 236", ["AR 236"]),
        ("AM 346 349 352 359", ["AM 346", "AM 349", "AM 352", "AM 359"]),
        ("section ZD parcelles n° 323 et 328", ["ZD 323", "ZD 328"]),
        ("AC 27-85 AD 48", ["AC 27", "AC 85", "AD 48"]),
        ("A 1213 à 1216", ["A 1213", "A 1214", "A 1215", "A 1216"]),
        ("826 AE 188 826 AE 283", ["826 AE 188", "826 AE 283"]),
        ("274XB22", ["274 XB 22"]),
        ("Section 000 A parcelle 870", ["A 870"]),
        ("KT0044", ["KT 44"]),
        ("BR n° 104 issue de la parcelle BR n° 85", ["BR 104"]),
        ("DW 65 (anciennement AE 96)", ["DW 65"]),
        ("A 2 (531 m²) et A 841 (126 m²)", ["A 2", "A 841"]),
        ("BB 410 lots 685,686,687", ["BB 410"]),
        ("AI53 pour 14a 64ca surface 1155 m2.", ["AI 53"]),
        ("YE 53 et Yi 75", ["YE 53", "YI 75"]),
        ("REPRISE DE DONNEES", []),
        ("Voir cahier des charges", []),
    ],
)
def test_parse_cadastral_references(raw: str, expected: list[str]) -> None:
    assert _labels(raw) == expected


def test_designation_and_api_format() -> None:
    parsed = parse_cadastral_references("AM 346 349 352 359 361")
    assert designation(parsed, "Pessines") == "Parcelles AM 346, 349, 352, 359… à Pessines"
    assert designation(parse_cadastral_references("AR 236"), "Dissay") == "Parcelle AR 236 à Dissay"
    single = ParcelRef("A", "973")
    assert (single.api_section, single.api_number, single.key("17275")) == ("0A", "0973", "17275000" + "0A0973")


def _feature(idu: str, area: int, lng: float, lat: float) -> dict:
    return {
        "type": "Feature",
        "properties": {"idu": idu, "contenance": area, "code_insee": idu[:5], "section": idu[8:10], "numero": idu[10:]},
        "geometry": {"type": "Polygon", "coordinates": [[[lng, lat], [lng + 0.001, lat], [lng, lat + 0.001], [lng, lat]]]},
    }


def _sale(location: dict, **kwargs) -> AuctionSale:
    return AuctionSale(
        source_name="cessions_etat",
        source_url="https://cessions.immobilier-etat.gouv.fr/biens/test",
        city=kwargs.get("city", "Dissay"),
        department=kwargs.get("department", "86"),
        raw_payload={"cadastre_location": location, **kwargs.get("payload", {})},
    )


def _location(insee: str | None, *candidates: tuple[str, list[str]], surface: str | None = None) -> dict:
    parsed = [ref for _, labels in candidates for ref in map(refs.ref_from_label, labels) if ref]
    return {
        "insee_code": insee,
        "candidates": [{"source_label": label, "parcels": labels} for label, labels in candidates],
        "designation": "Parcelle AR 236 à Dissay",
        "published_surface_m2": surface,
        "signature": references_signature(insee, parsed),
    }


def _mock_client(monkeypatch, handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    original = httpx.Client

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return original(*args, transport=httpx.MockTransport(wrapped), **kwargs)

    monkeypatch.setattr(refs.httpx, "Client", factory)
    return seen


def test_resolution_picks_the_reading_closest_to_the_published_surface(monkeypatch) -> None:
    features = {
        "86095000AR0326": _feature("86095000AR0326", 587, 0.40, 46.70),
        "86095000AR0236": _feature("86095000AR0236", 2649, 0.43, 46.71),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        numbers = request.url.params.get_list("numero")
        found = [feature for idu, feature in features.items() if idu[-4:] in numbers]
        return httpx.Response(200, json={"type": "FeatureCollection", "features": found})

    seen = _mock_client(monkeypatch, handler)
    sale = _sale(_location("86095", ("Références cadastrales", ["AR 236"]), ("Référence cadastrale", ["AR 326"]),
                           surface="2609"))

    assert resolve_sale_cadastre(sale, settings={}) is True
    resolution = sale.raw_payload["cadastre_location"]["resolution"]
    assert resolution["status"] == "resolved"
    assert resolution["surface_m2"] == 2649
    assert resolution["source_label"] == "Références cadastrales"
    assert sale.raw_payload["geo_precision"] == "parcel"
    assert sale.raw_payload["geocode"]["provider"] == refs.PROVIDER
    assert abs(float(sale.latitude) - 46.7103) < 0.01
    assert all(request.url.params["code_insee"] == "86095" for request in seen)

    # Same references again: the stored resolution is reused without any request.
    replay = _sale(dict(sale.raw_payload["cadastre_location"]))
    requests_before = len(seen)
    assert resolve_sale_cadastre(replay, network=False) is True
    assert len(seen) == requests_before
    assert replay.latitude == sale.latitude


def test_several_parcels_of_a_section_share_one_request(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        numbers = request.url.params.get_list("numero")
        return httpx.Response(200, json={"features": [
            _feature(f"17275000AM{number}", 1000, -0.7, 45.7) for number in numbers
        ]})

    seen = _mock_client(monkeypatch, handler)
    sale = _sale(_location("17275", ("Référence cadastrale", ["AM 346", "AM 349", "AM 352"])), city="Pessines",
                 department="17")
    assert resolve_sale_cadastre(sale, settings={}) is True
    assert len(seen) == 1
    assert seen[0].url.params.get_list("numero") == ["0346", "0349", "0352"]
    assert sale.raw_payload["cadastre_location"]["resolution"]["resolved"] == 3


def test_network_failure_freezes_nothing_and_trips_the_breaker(monkeypatch) -> None:
    seen = _mock_client(monkeypatch, lambda request: httpx.Response(503))
    for index in range(5):
        sale = _sale(_location("86095", ("Référence cadastrale", [f"AR {index + 1}"])))
        assert resolve_sale_cadastre(sale, settings={}) is False
        assert "resolution" not in sale.raw_payload["cadastre_location"]
    # Two attempts per request until three consecutive failures, then no request at all.
    assert len(seen) == 3 * 2
    assert refs._FAILURES[0] >= refs.MAX_CONSECUTIVE_FAILURES


def test_rejected_reference_is_unresolved_not_a_failure(monkeypatch) -> None:
    _mock_client(monkeypatch, lambda request: httpx.Response(400, json={"code": 400}))
    sale = _sale(_location("86095", ("Référence cadastrale", ["AR 1"])))
    assert resolve_sale_cadastre(sale, settings={}) is False
    assert sale.raw_payload["cadastre_location"]["resolution"]["status"] == "unresolved"
    assert refs._FAILURES[0] == 0


def test_missing_insee_uses_a_matching_ban_commune_only(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["code_insee"] == "66123"
        return httpx.Response(200, json={"features": [_feature("661230000A0559", 9115, 2.2, 42.5)]})

    _mock_client(monkeypatch, handler)
    ban = {"provider": "ban_geoplateforme", "accepted": True, "city": "Nyer", "citycode": "66123"}
    sale = _sale(_location(None, ("Référence cadastrale", ["A 559"])), city="NYER", department="66",
                 payload={"geocode": ban})
    assert resolve_sale_cadastre(sale, settings={}) is True
    assert sale.raw_payload["cadastre_location"]["insee_source"] == "ban_citycode"
    assert sale.raw_payload["geocode_ban"] == ban

    homonym = {"provider": "ban_geoplateforme", "accepted": True, "city": "Saint-André", "citycode": "97409"}
    other = _sale(_location(None, ("Référence cadastrale", ["AK 190"])), city="SAINT ANDRE", department="66",
                  payload={"geocode": homonym})
    assert resolve_sale_cadastre(other, settings={}) is False


def test_geocode_prefers_parcels_and_trusts_their_evidence(monkeypatch) -> None:
    from src import geocode

    monkeypatch.setattr(geocode, "load_settings", lambda: {"geocode_enabled": False})
    location = _location("86095", ("Référence cadastrale", ["AR 236"]))
    location["resolution"] = {
        "version": refs.RESOLUTION_VERSION,
        "signature": location["signature"],
        "status": "resolved",
        "latitude": 46.71,
        "longitude": 0.43,
        "resolved": 1,
        "requested": 1,
    }
    sale = _sale(location)
    sale.latitude, sale.longitude = Decimal("46.70014"), Decimal("0.43343")
    geocode.geocode_sale(sale)
    assert (sale.latitude, sale.longitude) == (Decimal("46.71"), Decimal("0.43"))
    assert geocode.coordinates_are_verified(sale)


def test_cadastre_rows_use_the_referenced_parcels(monkeypatch) -> None:
    feature = _feature("86095000AR0236", 2649, 0.43, 46.71)
    refs._MEMORY["86095000AR0236"] = feature
    sale = _sale({"resolution": {"status": "resolved", "parcels": [{"idu": "86095000AR0236"}]}})
    monkeypatch.setattr("src.cadastre.httpx.get", lambda *args, **kwargs: pytest.fail("no point lookup"))
    rows = fetch_cadastre_parcels_for_sale(sale)
    assert [row.parcel_id for row in rows] == ["86095000AR0236"]
    assert rows[0].match_kind == "reference_lookup"
