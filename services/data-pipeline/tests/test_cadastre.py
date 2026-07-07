from decimal import Decimal

import pytest

from src.cadastre import cadastre_rows_from_feature_collection, fetch_cadastre_parcels_for_sale
from src.models import AuctionSale


def test_cadastre_feature_collection_builds_storage_ready_parcel() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/vente",
        city="Bordeaux",
        department="33",
        latitude=Decimal("44.8378"),
        longitude=Decimal("-0.5792"),
    )
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "idu": "33063000AB0123",
                    "code_insee": "33063",
                    "section": "AB",
                    "numero": "0123",
                    "contenance": "480",
                    "nom_com": "Bordeaux",
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [-0.5794, 44.8377],
                            [-0.579, 44.8377],
                            [-0.579, 44.838],
                            [-0.5794, 44.838],
                            [-0.5794, 44.8377],
                        ]
                    ],
                },
            }
        ],
    }

    parcels = cadastre_rows_from_feature_collection(
        sale,
        payload,
        source_api_url="https://apicarto.ign.fr/api/cadastre/parcelle",
        request_params={"geom": "{}"},
    )

    assert len(parcels) == 1
    row = parcels[0].to_storage_row()
    assert row["source_url"] == "https://example.test/vente"
    assert row["parcel_key"] == "33063000AB0123"
    assert row["code_insee"] == "33063"
    assert row["section"] == "AB"
    assert row["parcel_number"] == "0123"
    assert row["surface_m2"] == 480.0
    assert row["centroid_lat"] == pytest.approx(44.83782)
    assert row["centroid_lng"] == pytest.approx(-0.57924)
    assert row["match_kind"] == "point_intersection"
    assert row["source_api"] == "API Carto Cadastre"
    assert row["raw_payload"]["request"] == {"geom": "{}"}


def test_fetch_cadastre_parcels_uses_geojson_point_query(monkeypatch) -> None:
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
                "features": [
                    {
                        "properties": {
                            "code_insee": "33063",
                            "section": "AB",
                            "numero": "0123",
                        },
                        "geometry": {"type": "Point", "coordinates": [-0.5792, 44.8378]},
                    }
                ]
            }

    def fake_get(endpoint, params, headers, timeout):
        captured["endpoint"] = endpoint
        captured["params"] = params
        captured["headers"] = headers
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("src.cadastre.httpx.get", fake_get)

    parcels = fetch_cadastre_parcels_for_sale(
        sale,
        api_url="https://apicarto.test/cadastre/parcelle",
        source_ign="PCI",
        max_parcels=2,
        timeout_seconds=7,
        user_agent="immojudis-test",
    )

    assert len(parcels) == 1
    assert captured["endpoint"] == "https://apicarto.test/cadastre/parcelle"
    assert captured["params"]["geom"] == '{"type":"Point","coordinates":[-0.5792,44.8378]}'
    assert captured["params"]["_limit"] == 2
    assert captured["params"]["source_ign"] == "PCI"
    assert captured["headers"] == {"User-Agent": "immojudis-test"}
    assert captured["timeout"] == 7
