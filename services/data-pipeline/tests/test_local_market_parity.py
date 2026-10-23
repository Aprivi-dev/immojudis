"""Parity of the local-market features between training/serving reference and the TypeScript port.

``tests/fixtures/local_market_parity.json`` is read by this file and by
``src/lib/local-market-features.test.ts``. The expected values are produced by
``lookup_exported_local_market``; the TypeScript port must return the same numbers for the same
artifact export and the same points. Changing the definition of the local features means
regenerating the fixture and updating ``src/lib/local-market-features.ts`` together.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from src import valuation_training as vt

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "local_market_parity.json").read_text("utf-8"))


class TableH3:
    """H3 stand-in answering from the fixture's cell ids (the real library is optional)."""

    @staticmethod
    def latlng_to_cell(latitude: float, longitude: float, resolution: int) -> str:
        for name, (point_lat, point_lng) in FIXTURE["points"].items():
            if float(latitude) == point_lat and float(longitude) == point_lng:
                return FIXTURE["cellIds"][name][str(resolution)]
        raise ValueError("no cell for this point")


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["label"])
def test_reference_lookup_reproduces_the_fixture(case: dict[str, Any]) -> None:
    features = vt.lookup_exported_local_market(
        FIXTURE["exports"][case["export"]], case["latitude"], case["longitude"], h3_module=TableH3
    )
    assert set(features) == set(case["expected"])
    for name, expected in case["expected"].items():
        assert features[name] == pytest.approx(expected, abs=1e-12), name


def test_fixture_algorithm_constants_are_the_ones_of_the_training_code() -> None:
    for export in FIXTURE["exports"].values():
        assert export["formatVersion"] == vt.LOCAL_MARKET_FORMAT_VERSION
        assert export["algorithm"] == {
            "minSample": vt.LOCAL_MARKET_MIN_SAMPLE,
            "spreadMultiplier": vt.LOCAL_SPREAD_MULTIPLIER,
            "spreadFloor": vt.LOCAL_SPREAD_FLOOR,
            "sampleSizeCap": vt.LOCAL_SAMPLE_SIZE_CAP,
        }
    assert FIXTURE["exports"]["apartment"]["resolutions"] == list(vt.local_market_resolutions("apartment"))
    assert FIXTURE["exports"]["house"]["resolutions"] == list(vt.local_market_resolutions("house"))


def test_fixture_cell_ids_are_the_real_h3_cells() -> None:
    h3 = pytest.importorskip("h3")
    for name, (latitude, longitude) in FIXTURE["points"].items():
        for resolution, cell in FIXTURE["cellIds"][name].items():
            assert h3.latlng_to_cell(latitude, longitude, int(resolution)) == cell, (name, resolution)


def test_export_of_a_trained_frame_has_the_shape_the_typescript_port_reads() -> None:
    import pandas as pd

    h3 = pytest.importorskip("h3")
    rows = 60
    frame = pd.DataFrame(
        {
            "sale_date": pd.date_range("2024-01-01", periods=rows, freq="D", tz="UTC"),
            "target_price_per_m2": [3_000 + 10 * index for index in range(rows)],
            "latitude": [48.8566] * rows,
            "longitude": [2.3522] * rows,
        }
    )
    export = vt.export_local_market(frame, resolutions=(9, 8, 7), h3_module=h3)
    reference = FIXTURE["exports"]["apartment"]
    assert set(reference) <= set(export)
    assert {key: export["algorithm"][key] for key in reference["algorithm"]} == reference["algorithm"]
    assert export["formatVersion"] == reference["formatVersion"]
    assert export["cellFormat"] == reference["cellFormat"]
    cell = h3.latlng_to_cell(48.8566, 2.3522, 9)
    count, mean, std = export["cells"]["9"][cell]
    assert count == rows
    assert mean > 0 and std > 0
