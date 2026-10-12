"""Valuation model: past-only local features, exported statistics, promotion gate (P2-08)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src import valuation_training as vt
from src.valuation_training import (
    ActiveModel,
    CellLevel,
    decide_activation,
    export_local_market,
    lookup_exported_local_market,
    past_cell_levels,
    predict_lightgbm_dump,
    resolve_local_market,
)


class FakeH3:
    """Deterministic grid: finer resolutions give smaller cells."""

    @staticmethod
    def latlng_to_cell(latitude: float, longitude: float, resolution: int) -> str:
        scale = 10 ** (resolution - 6)
        return f"{resolution}:{round(latitude * scale)}:{round(longitude * scale)}"


def _sales(prices: list[float], *, cells: list[tuple[float, float]] | None = None, start="2024-01-01") -> pd.DataFrame:
    dates = pd.date_range(start, periods=len(prices), freq="D", tz="UTC")
    cells = cells or [(44.84, -0.58)] * len(prices)
    return pd.DataFrame(
        {
            "sale_date": dates,
            "target_price_per_m2": prices,
            "latitude": [cell[0] for cell in cells],
            "longitude": [cell[1] for cell in cells],
        }
    )


def _levels(frame: pd.DataFrame, segment: str = "apartment"):
    return past_cell_levels(frame, resolutions=vt.local_market_resolutions(segment), h3_module=FakeH3)


# --- past-only statistics -----------------------------------------------------


def test_each_row_only_sees_the_sales_before_it() -> None:
    prices = [3000, 3100, 2900, 3300, 3200, 3500, 3400, 3600]
    levels, _, _ = _levels(_sales(prices))
    finest = levels[0]
    logs = np.log(prices)

    assert finest.count.tolist() == list(range(len(prices)))
    assert np.isnan(finest.mean[0])
    for index in range(1, len(prices)):
        assert finest.mean[index] == pytest.approx(logs[:index].mean())
    for index in range(2, len(prices)):
        assert finest.std[index] == pytest.approx(logs[:index].std(ddof=1))


def test_changing_a_sale_never_changes_the_features_of_earlier_or_same_rows() -> None:
    base = [3000 + 25 * index for index in range(40)]
    reference, _, _ = _levels(_sales(base))
    for changed in (0, 17, 39):
        edited = list(base)
        edited[changed] = 90_000  # an extreme outlier
        levels, _, _ = _levels(_sales(edited))
        for before, after in zip(reference, levels, strict=True):
            untouched = slice(0, changed + 1)  # the row itself is excluded from its own statistics
            np.testing.assert_allclose(after.count[untouched], before.count[untouched])
            np.testing.assert_allclose(after.mean[untouched], before.mean[untouched], equal_nan=True)
            np.testing.assert_allclose(after.std[untouched], before.std[untouched], equal_nan=True)


def test_the_spread_is_past_only_too_not_just_the_mean() -> None:
    """The old training excluded the row from the mean but kept it in the standard deviation."""
    prices = [3000.0] * 12 + [30_000.0]
    levels, _, _ = _levels(_sales(prices))
    finest = levels[0]

    assert finest.std[12] == pytest.approx(0.0, abs=1e-9)  # the outlier does not widen its own spread


def test_cells_are_independent_and_rows_without_coordinates_have_no_history() -> None:
    frame = _sales([3000, 5000, 3010, 5010, 3020, 5020], cells=[(44.84, -0.58), (45.5, 1.0)] * 3)
    frame.loc[0, "latitude"] = np.nan
    levels, _, _ = _levels(frame)

    assert levels[0].count.tolist() == [0, 0, 0, 1, 1, 2]
    assert levels[0].mean[3] == pytest.approx(math.log(5000))


# --- the shared selection function --------------------------------------------


def _level(resolution: int, count, mean, std) -> CellLevel:
    return CellLevel(resolution, np.array(count, dtype=float), np.array(mean, dtype=float), np.array(std, dtype=float))


def test_finest_cell_with_enough_sales_wins_then_coarser_then_fallback() -> None:
    levels = [
        _level(9, [5, 4, 0, 9], [8.1, 8.2, np.nan, 8.0], [0.20, 0.30, np.nan, 0.10]),
        _level(8, [50, 50, 7, 3], [8.5, 8.6, 8.7, 8.8], [0.40, 0.40, 0.50, 0.50]),
    ]

    mean, spread, sample_size_log = resolve_local_market(levels, fallback_mean=7.9, fallback_spread=0.9)

    assert mean.tolist() == [8.1, 8.6, 8.7, 8.0]
    assert spread[0] == pytest.approx(0.20 * vt.LOCAL_SPREAD_MULTIPLIER)
    assert spread[1] == pytest.approx(0.40 * vt.LOCAL_SPREAD_MULTIPLIER)
    # Row 3 had no qualifying cell at resolution 8 (3 sales) but 9 sales at resolution 9.
    assert sample_size_log[3] == pytest.approx(math.log1p(9))

    only_coarse = [_level(9, [1], [8.0], [0.1]), _level(8, [2], [8.0], [0.1])]
    mean, spread, sample_size_log = resolve_local_market(only_coarse, fallback_mean=7.9, fallback_spread=0.9)
    assert (mean[0], spread[0], sample_size_log[0]) == (7.9, 0.9, 0.0)


def test_minimum_sample_spread_floor_and_sample_size_cap() -> None:
    levels = [_level(9, [4, 5, 5, 400], [8.0, 8.0, 8.0, 8.0], [0.3, 0.0, 0.3, 0.3])]

    mean, spread, sample_size_log = resolve_local_market(levels, fallback_mean=7.0, fallback_spread=1.0)

    assert mean.tolist() == [7.0, 8.0, 8.0, 8.0]  # 4 sales is not enough, 5 is
    assert spread[1] == vt.LOCAL_SPREAD_FLOOR
    assert sample_size_log[3] == pytest.approx(math.log1p(vt.LOCAL_SAMPLE_SIZE_CAP))


# --- export and training/serving consistency ----------------------------------


def _market(rows: int = 400, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    centers = [(44.84, -0.58, 4200.0), (44.90, -0.50, 3000.0), (44.70, -0.70, 2200.0)]
    picks = rng.integers(0, len(centers), size=rows)
    cells = [(centers[pick][0] + rng.normal(0, 0.004), centers[pick][1] + rng.normal(0, 0.004)) for pick in picks]
    prices = [centers[pick][2] * math.exp(rng.normal(0, 0.15)) for pick in picks]
    return _sales(prices, cells=cells)


def test_exported_cells_only_contain_cells_the_selection_can_use() -> None:
    frame = _market()
    export = export_local_market(frame, resolutions=(9, 8, 7), h3_module=FakeH3)

    assert export["resolutions"] == [9, 8, 7]
    assert export["cellFormat"] == ["count", "mean", "std"]
    assert export["algorithm"]["minSample"] == vt.LOCAL_MARKET_MIN_SAMPLE
    for cells in export["cells"].values():
        assert cells
        assert all(count >= vt.LOCAL_MARKET_MIN_SAMPLE and std > 0 for count, _mean, std in cells.values())
    assert export["fittedThrough"] == frame["sale_date"].max().date().isoformat()
    json.dumps(export)  # JSON serialisable as stored in the artifact


def test_serving_features_from_the_export_equal_the_training_features() -> None:
    """A valuation made after the last sale uses the exported statistics and must match training."""
    history = _market()
    future_points = [(44.84, -0.58), (44.90, -0.50), (44.70, -0.70), (45.9, 2.0), (44.8401, -0.5801)]
    export = export_local_market(history, resolutions=(9, 8, 7), h3_module=FakeH3)

    for latitude, longitude in future_points:
        appended = pd.concat(
            [
                history,
                pd.DataFrame(
                    {
                        "sale_date": [history["sale_date"].max() + pd.Timedelta(1, unit="D")],
                        "target_price_per_m2": [3000.0],
                        "latitude": [latitude],
                        "longitude": [longitude],
                    }
                ),
            ],
            ignore_index=True,
        )
        trained, _ = vt.add_past_local_market_features(appended, segment="apartment", h3_module=FakeH3)
        served = lookup_exported_local_market(export, latitude, longitude, h3_module=FakeH3)

        last = trained.iloc[-1]
        assert served["local_median_log"] == pytest.approx(last["local_median_log"], abs=5e-4)
        assert served["local_spread_log"] == pytest.approx(last["local_spread_log"], abs=5e-4)
        assert served["local_sample_size_log"] == pytest.approx(last["local_sample_size_log"], abs=1e-9)


def test_export_is_trimmed_to_the_best_populated_cells_and_says_so(monkeypatch) -> None:
    monkeypatch.setattr(vt, "MAX_EXPORTED_CELLS_PER_RESOLUTION", 2)

    export = export_local_market(_market(), resolutions=(9, 8, 7), h3_module=FakeH3)

    assert export["truncated"] is True
    assert all(len(cells) <= 2 for cells in export["cells"].values())


# --- LightGBM dump evaluation (mirrors the TypeScript serving code) ------------


def _leaf(value: float) -> dict:
    return {"leaf_value": value}


def _split(feature: int, threshold: float, left: dict, right: dict, *, default_left=True, decision="<=") -> dict:
    return {
        "split_feature": feature,
        "threshold": threshold,
        "decision_type": decision,
        "default_left": default_left,
        "left_child": left,
        "right_child": right,
    }


def test_dump_evaluation_sums_trees_and_routes_missing_values_like_the_typescript() -> None:
    dump = {
        "tree_info": [
            {"tree_structure": _split(0, 5.0, _leaf(1.0), _leaf(2.0))},
            {"tree_structure": _split(1, 0.0, _leaf(10.0), _leaf(20.0), default_left=False)},
        ]
    }
    matrix = np.array([[5.0, -1.0], [5.1, 0.0], [np.nan, np.nan], [1.0, 3.0]])

    assert predict_lightgbm_dump(dump, matrix).tolist() == [11.0, 12.0, 21.0, 21.0]


def test_dump_evaluation_strict_inequality_average_output_and_unsupported_splits() -> None:
    strict = {"tree_info": [{"tree_structure": _split(0, 5.0, _leaf(1.0), _leaf(2.0), decision="<")}]}
    assert predict_lightgbm_dump(strict, np.array([[5.0], [4.9]])).tolist() == [2.0, 1.0]

    averaged = {"average_output": True, "tree_info": [{"tree_structure": _leaf(2.0)}, {"tree_structure": _leaf(4.0)}]}
    assert predict_lightgbm_dump(averaged, np.array([[0.0]])).tolist() == [3.0]

    categorical = {"tree_info": [{"tree_structure": _split(0, 5.0, _leaf(1.0), _leaf(2.0), decision="==")}]}
    assert np.isnan(predict_lightgbm_dump(categorical, np.array([[5.0]]))).all()
    assert np.isnan(predict_lightgbm_dump({"tree_info": []}, np.array([[0.0]]))).all()


# --- activation gate ----------------------------------------------------------


def _report(candidate: float, naive: float, active: dict | None = None) -> dict:
    return {
        "candidate": {"median_ape_pct": candidate},
        "naive": {"gate_median_ape_pct": naive},
        "active": active or {"status": "none"},
    }


def _evaluated(version: str, median_ape: float) -> dict:
    return {"status": "evaluated", "version": version, "median_ape_pct": median_ape}


def test_nothing_activates_unless_requested() -> None:
    decision = decide_activation(_report(5, 20), requested=False)

    assert decision.activate is False
    assert decision.reasons == ("activation not requested",)


def test_a_model_beating_the_naive_reference_and_the_active_model_is_activated() -> None:
    assert decide_activation(_report(9.0, 12.0, _evaluated("v1", 10.0)), requested=True).activate is True
    assert decide_activation(_report(9.0, 12.0), requested=True).activate is True  # first model of the segment


@pytest.mark.parametrize("candidate", [10.0, 10.5, 25.0])
def test_a_model_not_better_than_the_active_one_is_never_activated(candidate: float) -> None:
    decision = decide_activation(_report(candidate, 40.0, _evaluated("v1", 10.0)), requested=True)

    assert decision.activate is False
    assert "active model v1" in decision.reasons[0]


@pytest.mark.parametrize("candidate", [12.0, 12.4, 30.0])
def test_a_model_not_better_than_the_naive_reference_is_never_activated(candidate: float) -> None:
    decision = decide_activation(_report(candidate, 12.0), requested=True)

    assert decision.activate is False
    assert "naive local reference" in decision.reasons[0]


def test_an_active_model_that_cannot_be_evaluated_blocks_activation() -> None:
    active = {"status": "unevaluable", "version": "v0", "reason": "artifact is not a lightgbm-json-v1 quantile model"}

    decision = decide_activation(_report(5.0, 12.0, active), requested=True)

    assert decision.activate is False
    assert "could not be evaluated" in decision.reasons[0]


def test_both_failures_are_reported() -> None:
    decision = decide_activation(_report(15.0, 12.0, _evaluated("v1", 10.0)), requested=True)

    assert len(decision.reasons) == 2


def _ready_to_train_options(tmp_path: Path, **overrides):
    return vt.TrainingOptions(segments=("apartment",), min_rows=100, output_dir=tmp_path, **overrides)


def test_force_bypasses_absolute_thresholds_but_never_the_relative_gate(tmp_path, monkeypatch) -> None:
    metrics = vt.TrainingMetrics(500, 100, 100, 60.0, 55.0, 70.0, 10.0, 300.0, 0.8)  # fails every threshold
    bundle = vt.ModelBundle(
        "apartment", "v", vt.FEATURE_NAMES, {}, {}, metrics, 700, "2024-01-01", "2025-01-01",
        report=_report(55.0, 12.0, _evaluated("v1", 10.0)) | {"split": {}},
    )
    monkeypatch.setattr(vt, "train_segment_model", lambda frame, **kwargs: bundle)
    monkeypatch.setattr(vt, "write_model_bundle", lambda *a, **k: tmp_path / "bundle.json")
    monkeypatch.setattr(vt, "write_training_report", lambda *a, **k: tmp_path / "report.json")
    frame = pd.DataFrame({"x": range(200)})

    with pytest.raises(ValueError, match="rejected"):
        vt.train_frame_if_eligible(frame, segment="apartment", version="v", options=_ready_to_train_options(tmp_path, activate=True))

    forced = vt.train_frame_if_eligible(
        frame, segment="apartment", version="v", options=_ready_to_train_options(tmp_path, activate=True, force=True)
    )
    assert forced is bundle
    assert vt.bundle_is_activated(forced) is False
    assert forced.report["promotion"]["activation_requested"] is True
    assert len(forced.report["promotion"]["reasons"]) == 2


def test_training_publishes_a_draft_when_the_gate_refuses_activation(tmp_path, monkeypatch) -> None:
    metrics = vt.TrainingMetrics(500, 100, 100, 12.0, 9.0, 14.0, 80.0, 30.0, 0.8)
    report = _report(9.0, 12.0, _evaluated("v1", 8.0)) | {"split": {"test_rows": 100}}
    bundle = vt.ModelBundle(
        "apartment", "v", vt.FEATURE_NAMES, {}, {}, metrics, 700, "2024-01-01", "2025-01-01", report=report
    )
    published: list[tuple[str, bool]] = []
    monkeypatch.setattr(vt, "valuation_database_url", lambda: "postgresql://example/db")
    monkeypatch.setattr(vt, "fetch_active_model_for_segment", lambda url, segment: ActiveModel("v1", {}, {}))
    monkeypatch.setattr(vt, "train_segment_model", lambda frame, **kwargs: bundle)
    monkeypatch.setattr(vt, "write_model_bundle", lambda *a, **k: tmp_path / "b.json")
    monkeypatch.setattr(vt, "write_training_report", lambda *a, **k: tmp_path / "r.json")
    monkeypatch.setattr(vt, "publish_model_bundle", lambda url, b, *, activate: published.append((b.segment, activate)))
    monkeypatch.setattr(
        vt, "load_local_training_transactions", lambda *a, **k: {"apartment": pd.DataFrame({"x": range(5)})}
    )
    options = vt.TrainingOptions(
        segments=("apartment",), input_path=tmp_path / "dvf.csv", min_rows=1, output_dir=tmp_path, publish=True, activate=True
    )

    vt.train_valuation_models(options)

    assert published == [("apartment", False)]


def test_activation_still_publishes_when_the_gate_agrees(tmp_path, monkeypatch) -> None:
    metrics = vt.TrainingMetrics(500, 100, 100, 12.0, 9.0, 14.0, 80.0, 30.0, 0.8)
    bundle = vt.ModelBundle(
        "apartment", "v", vt.FEATURE_NAMES, {}, {}, metrics, 700, "2024-01-01", "2025-01-01",
        report=_report(9.0, 12.0, _evaluated("v1", 11.0)) | {"split": {"test_rows": 100}},
    )
    published: list[bool] = []
    monkeypatch.setattr(vt, "valuation_database_url", lambda: "postgresql://example/db")
    monkeypatch.setattr(vt, "load_local_training_transactions", lambda *a, **k: {"apartment": pd.DataFrame({"x": range(5)})})
    monkeypatch.setattr(vt, "fetch_active_model_for_segment", lambda url, segment: None)
    monkeypatch.setattr(vt, "train_segment_model", lambda frame, **kwargs: bundle)
    monkeypatch.setattr(vt, "write_model_bundle", lambda *a, **k: tmp_path / "b.json")
    monkeypatch.setattr(vt, "write_training_report", lambda *a, **k: tmp_path / "r.json")
    monkeypatch.setattr(vt, "publish_model_bundle", lambda url, b, *, activate: published.append(activate))

    vt.train_valuation_models(
        vt.TrainingOptions(
            segments=("apartment",), input_path=tmp_path / "dvf.csv", min_rows=1, output_dir=tmp_path,
            publish=True, activate=True,
        )
    )

    assert published == [True]


# --- active model evaluation ---------------------------------------------------


def test_active_model_is_scored_on_the_same_sales_as_the_candidate() -> None:
    constant = {"tree_info": [{"tree_structure": _leaf(math.log(3000.0))}]}
    active = ActiveModel(
        "v1",
        {"format": "lightgbm-json-v1", "featureNames": ["surface_m2"], "models": {"p50": constant}},
        {"test_mape_pct": 21.5},
    )
    features = pd.DataFrame({"surface_m2": [40.0, 50.0, 60.0, 70.0]})
    actual = np.array([3000.0, 3300.0, 2700.0, 6000.0])

    result = vt.evaluate_active_model(active, features, actual)

    assert result["status"] == "evaluated"
    assert result["version"] == "v1"
    assert result["reported_test_mape_pct"] == 21.5
    assert result["median_ape_pct"] == pytest.approx(np.median([0, 9.09, 11.11, 50]), abs=0.01)


def test_active_model_that_cannot_be_scored_is_reported_not_ignored() -> None:
    features = pd.DataFrame({"surface_m2": [40.0]})
    actual = np.array([3000.0])

    assert vt.evaluate_active_model(None, features, actual) == {"status": "none"}
    legacy = ActiveModel("v0", {"format": "something-else"}, {})
    assert vt.evaluate_active_model(legacy, features, actual)["status"] == "unevaluable"
    broken = ActiveModel(
        "v2",
        {"format": "lightgbm-json-v1", "featureNames": ["surface_m2"], "models": {"p50": {"tree_info": []}}},
        {},
    )
    assert vt.evaluate_active_model(broken, features, actual)["status"] == "unevaluable"


def test_fetch_active_model_reads_the_active_lightgbm_row() -> None:
    executed: list[tuple[str, tuple]] = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return None

        def execute(self, statement, parameters):
            executed.append((" ".join(statement.split()), parameters))

        def fetchone(self):
            return ("lgbm-v1", {"format": "lightgbm-json-v1"}, {"test_mape_pct": 12.0})

    class Connection:
        def cursor(self):
            return Cursor()

    active = vt.fetch_active_model(Connection(), "house")

    assert active == ActiveModel("lgbm-v1", {"format": "lightgbm-json-v1"}, {"test_mape_pct": 12.0})
    statement, parameters = executed[0]
    assert "status = 'active'" in statement and "framework = 'lightgbm_quantile'" in statement
    assert parameters == (vt.MODEL_KEY, "house")


# --- reports -------------------------------------------------------------------


def test_training_report_and_registry_metrics_carry_the_comparison(tmp_path) -> None:
    metrics = vt.TrainingMetrics(500, 100, 100, 12.0, 9.0, 14.0, 80.0, 30.0, 0.8)
    report = _report(9.0, 12.0, _evaluated("v1", 11.0)) | {
        "split": {"test_rows": 100},
        "promotion": {"activation_requested": True, "activate": True, "reasons": []},
    }
    bundle = vt.ModelBundle(
        "apartment", "v9", vt.FEATURE_NAMES, {}, {}, metrics, 700, "2024-01-01", "2025-01-01", report=report
    )

    path = vt.write_training_report(bundle, tmp_path)

    assert path.name == "apartment-v9.report.json"
    assert json.loads(path.read_text())["candidate"]["median_ape_pct"] == 9.0
    registry = vt.published_training_metrics(bundle)
    assert registry["test_mape_pct"] == 12.0  # still the key the serving code reads
    assert registry["comparison"] == {
        "candidate_median_ape_pct": 9.0,
        "active_version": "v1",
        "active_median_ape_pct": 11.0,
        "naive_median_ape_pct": 12.0,
        "activated": True,
    }
    summary = vt.format_step_summary([bundle])
    assert "| apartment | 9.0% | 11.0% (v1) | 12.0% | 100 | yes | - |" in summary


# --- end to end with the real stack -------------------------------------------


@pytest.fixture
def small_models(monkeypatch):
    """Keep LightGBM fast in tests; the training logic is unchanged."""
    pytest.importorskip("lightgbm")
    pytest.importorskip("mapie")
    original = vt.make_quantile_estimator

    def small(estimator_class, *, alpha):
        estimator = original(estimator_class, alpha=alpha)
        estimator.set_params(n_estimators=25, n_jobs=2, min_child_samples=10)
        return estimator

    monkeypatch.setattr(vt, "make_quantile_estimator", small)


def _training_frame(rows: int = 1500, seed: int = 11) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    centers = [(44.84, -0.58, 4200.0), (44.86, -0.55, 3200.0), (44.80, -0.62, 2600.0)]
    dates = pd.date_range("2022-01-01", periods=rows, freq="12h", tz="UTC")
    records = []
    for index in range(rows):
        latitude, longitude, base = centers[int(rng.integers(0, len(centers)))]
        surface = float(rng.integers(20, 140))
        price = base * (1 + 0.00005 * index) * (1 + (60 - surface) / 300) * math.exp(rng.normal(0, 0.1))
        records.append(
            {
                "sale_date": dates[index],
                "total_price_eur": price * surface,
                "built_surface_m2": surface,
                "land_surface_m2": None,
                "price_per_m2": price,
                "property_type": "Appartement",
                "dvf_property_type_code": "121",
                "rooms_count": int(max(1, surface // 25)),
                "latitude": latitude + rng.normal(0, 0.006),
                "longitude": longitude + rng.normal(0, 0.006),
            }
        )
    return vt.prepare_training_frame(pd.DataFrame(records))


def test_published_model_is_refit_on_train_and_calibration_and_recalibrated_on_the_newest_window(small_models) -> None:
    pytest.importorskip("h3")
    bundle = vt.train_segment_model(_training_frame(), segment="apartment", version="t1")

    report = bundle.report
    split = report["split"]
    published = report["published_model"]
    assert published["refit_rows"] == split["train_rows"] + split["calibration_rows"]
    assert published["recalibration_rows"] == split["test_rows"]
    assert published["recalibration_window"] == split["test_period"]
    assert published["metrics_describe"].startswith("validation model")
    # Metrics are those of the held-out validation, computed on rows nobody fitted.
    assert bundle.metrics.train_rows == split["train_rows"]
    assert bundle.metrics.test_rows == split["test_rows"]
    assert bundle.artifact["calibration"]["lowerCorrection"] == bundle.calibration["lowerCorrection"]
    assert set(report["naive"]) == {"local_geometric_mean", "train_cell_median", "gate_median_ape_pct"}
    assert report["active"] == {"status": "none"}
    assert report["candidate"]["median_ape_pct"] < report["naive"]["gate_median_ape_pct"]


def test_artifact_carries_the_cell_statistics_needed_to_rebuild_the_features(small_models) -> None:
    h3 = pytest.importorskip("h3")
    frame = _training_frame()
    bundle = vt.train_segment_model(frame, segment="apartment", version="t1")

    local_market = bundle.artifact["localMarket"]
    assert bundle.artifact["featureNames"] == list(vt.FEATURE_NAMES)
    assert {"local_median_log", "local_spread_log", "local_sample_size_log"} <= set(vt.FEATURE_NAMES)
    assert local_market["resolutions"] == [9, 8, 7]
    assert local_market["fittedThrough"] == frame["sale_date"].max().date().isoformat()
    json.dumps(bundle.artifact)  # stays JSON serialisable for the jsonb column
    served = lookup_exported_local_market(local_market, 44.84, -0.58, h3_module=h3)
    assert 7.5 < served["local_median_log"] < 9.0 and served["local_spread_log"] >= vt.LOCAL_SPREAD_FLOOR


def test_dump_evaluation_matches_the_booster_it_was_dumped_from(small_models) -> None:
    pytest.importorskip("h3")
    from lightgbm import LGBMRegressor

    featured, _ = vt.add_past_local_market_features(_training_frame(), segment="apartment")
    features = vt.feature_frame(featured)
    estimator = vt.make_quantile_estimator(LGBMRegressor, alpha=0.5)
    estimator.fit(features, np.log(featured["target_price_per_m2"].to_numpy(dtype=float)))

    mine = predict_lightgbm_dump(estimator.booster_.dump_model(), features.to_numpy(dtype=float))

    np.testing.assert_allclose(mine, estimator.predict(features), rtol=1e-9, atol=1e-9)


def test_end_to_end_gate_with_a_weak_and_an_identical_active_model(small_models, tmp_path) -> None:
    pytest.importorskip("h3")
    frame = _training_frame()
    first = vt.train_segment_model(frame, segment="apartment", version="t1")

    weak = ActiveModel(
        "weak",
        {
            "format": "lightgbm-json-v1",
            "featureNames": list(vt.FEATURE_NAMES),
            "models": {"p50": {"tree_info": [{"tree_structure": _leaf(math.log(9000.0))}]}},
        },
        {"test_mape_pct": 70.0},
    )
    options = _ready_to_train_options(tmp_path, activate=True)
    against_weak = vt.train_frame_if_eligible(frame, segment="apartment", version="t2", options=options, active_model=weak)
    assert against_weak is not None
    assert against_weak.report["active"]["status"] == "evaluated"
    assert against_weak.report["active"]["median_ape_pct"] > against_weak.report["candidate"]["median_ape_pct"]
    assert vt.bundle_is_activated(against_weak) is True

    identical = ActiveModel("same", first.artifact, first.metrics.__dict__)
    against_same = vt.train_frame_if_eligible(
        frame, segment="apartment", version="t3", options=options, active_model=identical
    )
    assert against_same is not None
    report = against_same.report
    assert report["active"]["status"] == "evaluated"
    # Whatever the scores, the decision follows the rule: strictly better than both references.
    expected = report["candidate"]["median_ape_pct"] < min(
        report["naive"]["gate_median_ape_pct"], report["active"]["median_ape_pct"]
    )
    assert vt.bundle_is_activated(against_same) is expected
    assert (tmp_path / "apartment-t3.report.json").exists()
    assert (tmp_path / "apartment-t3.json").exists()


# --- workflow ------------------------------------------------------------------


def test_training_workflow_publishes_drafts_unless_activation_is_explicitly_requested() -> None:
    workflow = (
        Path(__file__).resolve().parents[3] / ".github" / "workflows" / "valuation-model-training.yml"
    ).read_text(encoding="utf-8")

    activate = workflow.split("      activate:\n", 1)[1].split("      confirm_target:", 1)[0]
    assert "default: false" in activate
    assert "default: true" not in activate
    confirm = workflow.split("      confirm_target:\n", 1)[1].split("\npermissions:", 1)[0]
    assert "required: false" in confirm
    # The confirmation is still enforced when someone does activate.
    assert 'REQUESTED_ACTIVATE" = "true" ] && [ "$REQUESTED_CONFIRM_TARGET" != "production"' in workflow
    assert 'args+=(--activate)' in workflow
