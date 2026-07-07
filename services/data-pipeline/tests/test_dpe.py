from decimal import Decimal

from src.dpe import (
    dpe_query_params_for_sale,
    dpe_rows_from_payload,
    fetch_dpe_diagnostics_for_sale,
)
from src.models import AuctionSale


def test_dpe_query_uses_geo_distance_when_coordinates_are_available() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        department="33",
        latitude=Decimal("44.8378"),
        longitude=Decimal("-0.5792"),
    )

    params = dpe_query_params_for_sale(sale, geo_radius_m=120, max_results=5)

    assert params is not None
    assert params["geo_distance"] == "-0.5792:44.8378:120"
    assert params["code_departement_ban_eq"] == "33"
    assert params["size"] == 5
    assert "numero_dpe" in str(params["select"])


def test_dpe_payload_builds_storage_ready_rows() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        city="Bordeaux",
        department="33",
        postal_code="33000",
        latitude=Decimal("44.8378"),
        longitude=Decimal("-0.5792"),
    )
    payload = {
        "results": [
            {
                "numero_dpe": "2133E0178774F",
                "etiquette_dpe": "E",
                "etiquette_ges": "C",
                "date_etablissement_dpe": "2025-05-10",
                "date_fin_validite_dpe": "2035-05-09",
                "date_derniere_modification_dpe": "2025-05-11",
                "adresse_ban": "10 Rue Exemple 33000 Bordeaux",
                "code_postal_ban": "33000",
                "nom_commune_ban": "Bordeaux",
                "code_insee_ban": "33063",
                "code_departement_ban": "33",
                "score_ban": 0.83,
                "_geopoint": "44.83785,-0.57925",
                "type_batiment": "maison",
                "surface_habitable_logement": 82.4,
                "conso_5_usages_par_m2_ep": 294.2,
                "emission_ges_5_usages_par_m2": 42,
            }
        ]
    }

    rows = dpe_rows_from_payload(
        sale,
        payload,
        source_api_url="https://data.ademe.test/lines",
        request_params={"geo_distance": "-0.5792:44.8378:120"},
    )

    assert len(rows) == 1
    row = rows[0].to_storage_row()
    assert row["source_url"] == "https://example.test/vente"
    assert row["diagnostic_number"] == "2133E0178774F"
    assert row["dpe_class"] == "E"
    assert row["ges_class"] == "C"
    assert row["established_at"] == "2025-05-10"
    assert row["valid_until"] == "2035-05-09"
    assert row["surface_m2"] == 82.4
    assert row["energy_consumption_kwh_m2_year"] == 294.2
    assert row["emissions_kg_co2_m2_year"] == 42.0
    assert row["latitude"] == 44.83785
    assert row["longitude"] == -0.57925
    assert row["match_kind"] == "geo_distance"
    assert row["confidence"] >= 0.9
    assert row["source_api"] == "ADEME DPE Open Data"


def test_fetch_dpe_diagnostics_calls_data_fair_lines_endpoint(monkeypatch) -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        latitude=Decimal("44.8378"),
        longitude=Decimal("-0.5792"),
    )
    captured = {}

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return {
                "results": [
                    {
                        "numero_dpe": "2133E0178774F",
                        "etiquette_dpe": "D",
                        "_geopoint": "44.8378,-0.5792",
                    }
                ]
            }

    def fake_get(endpoint, params, headers, timeout):
        captured["endpoint"] = endpoint
        captured["params"] = params
        captured["headers"] = headers
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("src.dpe.httpx.get", fake_get)

    rows = fetch_dpe_diagnostics_for_sale(
        sale,
        api_url="https://data.ademe.test/lines",
        geo_radius_m=80,
        max_results=3,
        timeout_seconds=9,
        user_agent="immojudis-test",
    )

    assert len(rows) == 1
    assert captured["endpoint"] == "https://data.ademe.test/lines"
    assert captured["params"]["geo_distance"] == "-0.5792:44.8378:80"
    assert captured["params"]["size"] == 3
    assert captured["headers"] == {"User-Agent": "immojudis-test"}
    assert captured["timeout"] == 9
