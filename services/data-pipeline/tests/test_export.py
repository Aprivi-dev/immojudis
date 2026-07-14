from __future__ import annotations

import json
from decimal import Decimal

from src.export import export_sales
from src.models import AuctionSale


def test_export_sales_serializes_nested_decimal_values(tmp_path) -> None:
    sale = AuctionSale(
        source_name="unit",
        source_url="https://example.test/decimal-export",
        raw_payload={
            "surface_reconciliation": {
                "rejected_surface_m2": Decimal("1877"),
                "resolved_surface_m2": Decimal("187.25"),
            }
        },
    )

    json_path, csv_path = export_sales([sale], tmp_path)

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    reconciliation = payload[0]["raw_payload"]["surface_reconciliation"]
    assert reconciliation == {
        "rejected_surface_m2": 1877,
        "resolved_surface_m2": 187.25,
    }
    assert csv_path.exists()
