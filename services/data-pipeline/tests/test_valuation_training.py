from __future__ import annotations

import pandas as pd

from src.valuation_training import (
    FEATURE_NAMES,
    chronological_split,
    feature_frame,
    load_local_training_transactions,
    prepare_training_frame,
)


def sample_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "sale_date": f"2025-{month:02d}-15",
                "total_price_eur": 200_000 + month * 1_000,
                "built_surface_m2": 50 + month,
                "land_surface_m2": None,
                "price_per_m2": 4_000,
                "property_type": "Appartement",
                "dvf_property_type_code": "121",
                "rooms_count": 3,
                "latitude": 44.84,
                "longitude": -0.58,
            }
            for month in range(1, 13)
        ]
    )


def test_prepare_training_frame_resolves_segment_and_target() -> None:
    prepared = prepare_training_frame(sample_frame())

    assert set(prepared["segment"]) == {"apartment"}
    assert prepared["target_price_per_m2"].gt(0).all()
    assert prepared["sale_date"].is_monotonic_increasing


def test_feature_frame_matches_production_contract() -> None:
    prepared = prepare_training_frame(sample_frame())
    features = feature_frame(prepared)

    assert tuple(features.columns) == FEATURE_NAMES
    assert features["log_surface_m2"].notna().all()
    assert features["sale_month_sin"].between(-1, 1).all()


def test_chronological_split_never_leaks_future_sales() -> None:
    prepared = prepare_training_frame(sample_frame())
    train, calibration, test = chronological_split(prepared, train_share=0.5, calibration_share=0.25)

    assert train["sale_date"].max() < calibration["sale_date"].min()
    assert calibration["sale_date"].max() < test["sale_date"].min()


def test_load_local_training_transactions_maps_and_keeps_recent_single_asset_sales(tmp_path) -> None:
    path = tmp_path / "dvf.csv.gz"
    rows = []
    for index in range(12):
        rows.append(
            {
                "id_mutation": f"apartment-{index}",
                "id_parcelle": f"parcel-{index}",
                "date_mutation": f"2025-{index + 1:02d}-15",
                "valeur_fonciere": 200_000 + index * 1_000,
                "surface_reelle_bati": 60 + index,
                "surface_terrain": None,
                "type_local": "Appartement",
                "code_type_local": "2",
                "nombre_pieces_principales": 3,
                "latitude": 44.84,
                "longitude": -0.58,
            }
        )
    pd.DataFrame(rows).to_csv(path, index=False, compression="gzip")

    frames = load_local_training_transactions(
        path,
        segments=("apartment",),
        limit=5,
        chunk_size=4,
    )

    assert len(frames["apartment"]) == 5
    assert frames["apartment"]["sale_date"].min().month == 8
    assert set(frames["apartment"]["segment"]) == {"apartment"}
