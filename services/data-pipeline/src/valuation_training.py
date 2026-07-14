from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 14):
    raise RuntimeError(
        "The valuation training pipeline requires Python 3.11 or 3.12; "
        "the pinned pandas/LightGBM stack is not supported on Python 3.14."
    )

import numpy as np
import pandas as pd

try:
    from psycopg.types.json import Jsonb
except ModuleNotFoundError:  # pragma: no cover - optional in pure feature tests.
    Jsonb = None

LOGGER = logging.getLogger(__name__)
ROOT_DIR = Path(__file__).resolve().parents[1]

MODEL_KEY = "immojudis_market_value"
CONFIDENCE_LEVEL = 0.8
FEATURE_NAMES = (
    "surface_m2",
    "log_surface_m2",
    "land_surface_m2",
    "log_land_surface_m2",
    "rooms_count",
    "latitude",
    "longitude",
    "sale_year",
    "sale_month_sin",
    "sale_month_cos",
    "local_median_log",
    "local_spread_log",
    "local_sample_size_log",
)
SUPPORTED_SEGMENTS = ("apartment", "house", "building", "commercial", "land")
DEFAULT_MODEL_OUTPUT_DIR = ROOT_DIR / "data" / "processed" / "valuation_models"
LOCAL_SOURCE_COLUMNS = {
    "id_mutation": "source_mutation_id",
    "id_parcelle": "source_parcel_id",
    "date_mutation": "sale_date",
    "valeur_fonciere": "total_price_eur",
    "surface_reelle_bati": "built_surface_m2",
    "surface_terrain": "land_surface_m2",
    "type_local": "property_type",
    "code_type_local": "dvf_property_type_code",
    "nombre_pieces_principales": "rooms_count",
    "latitude": "latitude",
    "longitude": "longitude",
}


@dataclass(frozen=True)
class TrainingOptions:
    segments: tuple[str, ...]
    input_path: Path | None = None
    min_rows: int = 500
    limit: int | None = 750_000
    version: str | None = None
    output_dir: Path = DEFAULT_MODEL_OUTPUT_DIR
    publish: bool = False
    activate: bool = False
    force: bool = False


@dataclass(frozen=True)
class TrainingMetrics:
    train_rows: int
    calibration_rows: int
    test_rows: int
    test_mape_pct: float
    test_median_ape_pct: float
    test_p75_ape_pct: float
    interval_coverage_pct: float
    interval_mean_width_pct: float
    confidence_level: float


@dataclass(frozen=True)
class ModelBundle:
    segment: str
    version: str
    feature_names: tuple[str, ...]
    artifact: dict[str, Any]
    calibration: dict[str, Any]
    metrics: TrainingMetrics
    training_rows: int
    training_period_start: str
    training_period_end: str


def train_valuation_models(options: TrainingOptions) -> list[ModelBundle]:
    bundles: list[ModelBundle] = []
    version = options.version or default_version()
    db_url = valuation_database_url() if options.publish or options.input_path is None else None

    if options.input_path is not None:
        frames = load_local_training_transactions(
            options.input_path,
            segments=options.segments,
            limit=options.limit,
        )
        for segment in options.segments:
            bundle = train_frame_if_eligible(
                frames.get(segment, pd.DataFrame()),
                segment=segment,
                version=version,
                options=options,
            )
            if bundle is None:
                continue
            if options.publish and db_url:
                publish_model_bundle(db_url, bundle, activate=options.activate)
            bundles.append(bundle)
        return bundles

    from src.storage.supabase_client import _postgres_connect

    assert db_url is not None
    with _postgres_connect(db_url) as connection:
        for segment in options.segments:
            segment_frame = fetch_training_transactions(connection, segment=segment, limit=options.limit)
            bundle = train_frame_if_eligible(
                segment_frame,
                segment=segment,
                version=version,
                options=options,
            )
            if bundle is None:
                continue
            if options.publish:
                publish_model_bundle(db_url, bundle, activate=options.activate)
            bundles.append(bundle)
    return bundles


def valuation_database_url() -> str:
    from src.config import load_settings

    db_url = load_settings().get("supabase_db_url")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required to publish or train from Postgres.")
    return str(db_url)


def train_frame_if_eligible(
    frame: pd.DataFrame,
    *,
    segment: str,
    version: str,
    options: TrainingOptions,
) -> ModelBundle | None:
    if len(frame) < options.min_rows:
        LOGGER.warning(
            "Skipping %s: %s rows available, %s required.",
            segment,
            len(frame),
            options.min_rows,
        )
        return None
    bundle = train_segment_model(frame, segment=segment, version=version)
    validate_promotion(bundle, force=options.force)
    write_model_bundle(bundle, options.output_dir)
    return bundle


def load_local_training_transactions(
    path: Path,
    *,
    segments: tuple[str, ...],
    limit: int | None,
    chunk_size: int = 200_000,
) -> dict[str, pd.DataFrame]:
    if not path.exists():
        raise FileNotFoundError(f"Valuation training input not found: {path}")
    unsupported = sorted(set(segments) - set(SUPPORTED_SEGMENTS))
    if unsupported:
        raise ValueError(f"Unsupported valuation segment(s): {', '.join(unsupported)}")

    buckets: dict[str, list[pd.DataFrame]] = {segment: [] for segment in segments}
    for raw_chunk in pd.read_csv(
        path,
        compression="infer",
        dtype=str,
        usecols=lambda name: name in LOCAL_SOURCE_COLUMNS,
        chunksize=chunk_size,
        low_memory=False,
    ):
        chunk = raw_chunk.rename(columns=LOCAL_SOURCE_COLUMNS)
        for column in (
            "source_mutation_id",
            "source_parcel_id",
            "sale_date",
            "total_price_eur",
            "built_surface_m2",
            "land_surface_m2",
            "property_type",
            "dvf_property_type_code",
            "rooms_count",
            "latitude",
            "longitude",
        ):
            if column not in chunk:
                chunk[column] = None
        chunk["price_per_m2"] = None
        prepared = prepare_training_frame(chunk)
        for segment in segments:
            selected = prepared.loc[prepared["segment"] == segment].copy()
            if selected.empty:
                continue
            buckets[segment].append(selected)
            if limit is not None and sum(len(item) for item in buckets[segment]) > limit * 1.5:
                buckets[segment] = [recent_single_asset_sales(buckets[segment], limit=limit)]

    frames: dict[str, pd.DataFrame] = {}
    for segment in segments:
        frames[segment] = recent_single_asset_sales(buckets[segment], limit=limit)
        LOGGER.info("Loaded %s usable local rows for %s.", len(frames[segment]), segment)
    return frames


def recent_single_asset_sales(frames: list[pd.DataFrame], *, limit: int | None) -> pd.DataFrame:
    if not frames:
        return pd.DataFrame()
    frame = pd.concat(frames, ignore_index=True)
    if "source_mutation_id" in frame:
        mutation_counts = frame.groupby("source_mutation_id")["source_mutation_id"].transform("size")
        frame = frame.loc[mutation_counts == 1].copy()
    frame.sort_values("sale_date", inplace=True)
    if limit is not None and len(frame) > limit:
        frame = frame.tail(limit).copy()
    frame.reset_index(drop=True, inplace=True)
    return frame


def fetch_training_transactions(
    connection: Any,
    *,
    segment: str | None = None,
    limit: int | None = None,
) -> pd.DataFrame:
    query = """
        with resolved as (
          select
            sale_date,
            total_price_eur,
            built_surface_m2,
            land_surface_m2,
            price_per_m2,
            property_type,
            dvf_property_type_code,
            rooms_count,
            latitude,
            longitude,
            case
              when dvf_property_type_code = '121'
                or lower(coalesce(property_type, '')) ~ '(appartement|studio|apartment)'
                then 'apartment'
              when dvf_property_type_code = '111'
                or lower(coalesce(property_type, '')) ~ '(maison|villa|pavillon|house)'
                then 'house'
              when dvf_property_type_code in ('112', '122', '123', '151')
                or lower(coalesce(property_type, '')) ~ '(immeuble|building)'
                then 'building'
              when dvf_property_type_code like '14%'
                or dvf_property_type_code = '152'
                or lower(coalesce(property_type, '')) ~ '(commerce|commercial|bureau|local professionnel)'
                then 'commercial'
              when dvf_property_type_code like '2%'
                or lower(coalesce(property_type, '')) ~ '(terrain|land|parcelle)'
                then 'land'
              else null
            end as resolved_segment
          from public.dvf_transactions
          where sale_date is not null
            and total_price_eur > 0
            and latitude is not null
            and longitude is not null
            and (built_surface_m2 > 0 or land_surface_m2 > 0)
        )
        select
          sale_date,
          total_price_eur,
          built_surface_m2,
          land_surface_m2,
          price_per_m2,
          property_type,
          dvf_property_type_code,
          rooms_count,
          latitude,
          longitude
        from resolved
        where resolved_segment is not null
    """
    params: list[object] = []
    if segment is not None:
        if segment not in SUPPORTED_SEGMENTS:
            raise ValueError(f"Unsupported valuation segment: {segment}")
        query += " and resolved_segment = %s"
        params.append(segment)
    query += " order by sale_date desc" if limit is not None else " order by sale_date asc"
    if limit is not None:
        query += " limit %s"
        params.append(limit)
    frame = pd.read_sql_query(query, connection, params=tuple(params))
    return prepare_training_frame(frame)


def prepare_training_frame(frame: pd.DataFrame) -> pd.DataFrame:
    prepared = frame.copy()
    prepared["sale_date"] = pd.to_datetime(prepared["sale_date"], errors="coerce", utc=True)
    numeric_columns = (
        "total_price_eur",
        "built_surface_m2",
        "land_surface_m2",
        "price_per_m2",
        "rooms_count",
        "latitude",
        "longitude",
    )
    for column in numeric_columns:
        prepared[column] = pd.to_numeric(prepared.get(column), errors="coerce")
    prepared["segment"] = prepared.apply(resolve_transaction_segment, axis=1)
    prepared["surface_m2"] = np.where(
        prepared["segment"] == "land",
        prepared["land_surface_m2"],
        prepared["built_surface_m2"],
    )
    prepared["target_price_per_m2"] = np.where(
        prepared["segment"] == "land",
        prepared["total_price_eur"] / prepared["land_surface_m2"],
        prepared["total_price_eur"] / prepared["built_surface_m2"],
    )
    prepared = prepared.loc[
        prepared["sale_date"].notna()
        & prepared["segment"].isin(SUPPORTED_SEGMENTS)
        & prepared["surface_m2"].gt(0)
        & prepared["target_price_per_m2"].gt(0)
    ].copy()
    prepared = prepared.loc[prepared.apply(valid_price_row, axis=1)].copy()
    prepared.sort_values("sale_date", inplace=True)
    prepared.reset_index(drop=True, inplace=True)
    return prepared


def resolve_transaction_segment(row: pd.Series) -> str | None:
    code = str(row.get("dvf_property_type_code") or "").strip()
    text = str(row.get("property_type") or "").lower()
    if code == "121" or any(token in text for token in ("appartement", "studio", "apartment")):
        return "apartment"
    if code == "111" or any(token in text for token in ("maison", "villa", "pavillon", "house")):
        return "house"
    if code in {"112", "122", "123", "151"} or "immeuble" in text or "building" in text:
        return "building"
    if (
        code.startswith("14")
        or code == "152"
        or any(token in text for token in ("commerce", "commercial", "bureau", "local professionnel"))
    ):
        return "commercial"
    if code.startswith("2") or any(token in text for token in ("terrain", "land", "parcelle")):
        return "land"
    return None


def valid_price_row(row: pd.Series) -> bool:
    value = float(row["target_price_per_m2"])
    if row["segment"] == "land":
        return 1 <= value <= 100_000
    return 300 <= value <= 50_000 and float(row["surface_m2"]) >= 9


def feature_frame(frame: pd.DataFrame) -> pd.DataFrame:
    sale_date = pd.to_datetime(frame["sale_date"], utc=True)
    month_angle = 2 * math.pi * sale_date.dt.month.sub(1) / 12
    surface = pd.to_numeric(frame["surface_m2"], errors="coerce")
    land = pd.to_numeric(frame["land_surface_m2"], errors="coerce")
    features = pd.DataFrame(
        {
            "surface_m2": surface,
            "log_surface_m2": np.log(surface),
            "land_surface_m2": land,
            "log_land_surface_m2": np.where(land > 0, np.log(land), np.nan),
            "rooms_count": pd.to_numeric(frame["rooms_count"], errors="coerce"),
            "latitude": pd.to_numeric(frame["latitude"], errors="coerce"),
            "longitude": pd.to_numeric(frame["longitude"], errors="coerce"),
            "sale_year": sale_date.dt.year,
            "sale_month_sin": np.sin(month_angle),
            "sale_month_cos": np.cos(month_angle),
            "local_median_log": numeric_feature(frame, "local_median_log"),
            "local_spread_log": numeric_feature(frame, "local_spread_log"),
            "local_sample_size_log": numeric_feature(frame, "local_sample_size_log"),
        }
    )
    return features.loc[:, FEATURE_NAMES]


def chronological_split(
    frame: pd.DataFrame,
    *,
    train_share: float = 0.7,
    calibration_share: float = 0.15,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    ordered = frame.sort_values("sale_date").reset_index(drop=True)
    train_end = max(1, int(len(ordered) * train_share))
    calibration_end = max(train_end + 1, int(len(ordered) * (train_share + calibration_share)))
    calibration_end = min(calibration_end, len(ordered) - 1)
    return (
        ordered.iloc[:train_end].copy(),
        ordered.iloc[train_end:calibration_end].copy(),
        ordered.iloc[calibration_end:].copy(),
    )


def train_segment_model(frame: pd.DataFrame, *, segment: str, version: str) -> ModelBundle:
    from lightgbm import LGBMRegressor
    from mapie.regression import ConformalizedQuantileRegressor

    train, calibration, test = chronological_split(frame)
    if min(len(train), len(calibration), len(test)) < 20:
        raise ValueError(f"Not enough chronological observations to train {segment}.")

    train, calibration, test = add_historical_local_market_features(
        train,
        calibration,
        test,
        segment=segment,
    )

    x_train = feature_frame(train)
    x_calibration = feature_frame(calibration)
    x_test = feature_frame(test)
    y_train = np.log(train["target_price_per_m2"].to_numpy(dtype=float))
    y_calibration = np.log(calibration["target_price_per_m2"].to_numpy(dtype=float))
    y_test = np.log(test["target_price_per_m2"].to_numpy(dtype=float))

    lower = make_quantile_estimator(LGBMRegressor, alpha=0.1)
    upper = make_quantile_estimator(LGBMRegressor, alpha=0.9)
    median = make_quantile_estimator(LGBMRegressor, alpha=0.5)
    for estimator in (lower, upper, median):
        estimator.fit(x_train, y_train)

    conformal = ConformalizedQuantileRegressor(
        estimator=[lower, upper, median],
        confidence_level=CONFIDENCE_LEVEL,
        prefit=True,
    ).conformalize(x_calibration, y_calibration)
    predicted_log, intervals = conformal.predict_interval(x_test)
    interval_low = intervals[:, 0, 0]
    interval_high = intervals[:, 1, 0]
    base_low = lower.predict(x_test)
    base_high = upper.predict(x_test)
    lower_correction = float(np.median(base_low - interval_low))
    upper_correction = float(np.median(interval_high - base_high))

    actual = np.exp(y_test)
    predicted = np.exp(predicted_log)
    predicted_low = np.exp(interval_low)
    predicted_high = np.exp(interval_high)
    absolute_percentage_errors = np.abs(predicted - actual) / actual * 100
    coverage = np.mean((actual >= predicted_low) & (actual <= predicted_high)) * 100
    width_pct = np.mean((predicted_high - predicted_low) / predicted * 100)
    metrics = TrainingMetrics(
        train_rows=len(train),
        calibration_rows=len(calibration),
        test_rows=len(test),
        test_mape_pct=rounded(np.mean(absolute_percentage_errors)),
        test_median_ape_pct=rounded(np.median(absolute_percentage_errors)),
        test_p75_ape_pct=rounded(np.quantile(absolute_percentage_errors, 0.75)),
        interval_coverage_pct=rounded(coverage),
        interval_mean_width_pct=rounded(width_pct),
        confidence_level=CONFIDENCE_LEVEL,
    )
    calibration_payload = {
        "method": "mapie_cqr",
        "confidenceLevel": CONFIDENCE_LEVEL,
        "lowerCorrection": lower_correction,
        "upperCorrection": upper_correction,
    }
    artifact = {
        "format": "lightgbm-json-v1",
        "target": "log_price_per_m2",
        "featureNames": list(FEATURE_NAMES),
        "models": {
            "p10": lower.booster_.dump_model(),
            "p50": median.booster_.dump_model(),
            "p90": upper.booster_.dump_model(),
        },
        "calibration": calibration_payload,
    }
    return ModelBundle(
        segment=segment,
        version=version,
        feature_names=FEATURE_NAMES,
        artifact=artifact,
        calibration=calibration_payload,
        metrics=metrics,
        training_rows=len(frame),
        training_period_start=frame["sale_date"].min().date().isoformat(),
        training_period_end=frame["sale_date"].max().date().isoformat(),
    )


def add_historical_local_market_features(
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    test: pd.DataFrame,
    *,
    segment: str,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    import h3

    resolutions = (8, 7, 6) if segment == "house" else (9, 8, 7)
    reference = train.copy()
    reference["_target_log"] = np.log(reference["target_price_per_m2"].to_numpy(dtype=float))
    statistics: list[tuple[int, pd.DataFrame]] = []
    for resolution in resolutions:
        cells = market_cells(reference, resolution=resolution, h3_module=h3)
        grouped = (
            reference.assign(_market_cell=cells)
            .dropna(subset=["_market_cell"])
            .groupby("_market_cell")["_target_log"]
            .agg(["count", "sum", "std"])
        )
        statistics.append((resolution, grouped))

    global_mean = float(reference["_target_log"].mean())
    global_spread = max(0.05, float(reference["_target_log"].std()) * 2.563)
    return (
        apply_local_market_features(
            train,
            statistics=statistics,
            global_mean=global_mean,
            global_spread=global_spread,
            leave_one_out=True,
            h3_module=h3,
        ),
        apply_local_market_features(
            calibration,
            statistics=statistics,
            global_mean=global_mean,
            global_spread=global_spread,
            leave_one_out=False,
            h3_module=h3,
        ),
        apply_local_market_features(
            test,
            statistics=statistics,
            global_mean=global_mean,
            global_spread=global_spread,
            leave_one_out=False,
            h3_module=h3,
        ),
    )


def apply_local_market_features(
    frame: pd.DataFrame,
    *,
    statistics: list[tuple[int, pd.DataFrame]],
    global_mean: float,
    global_spread: float,
    leave_one_out: bool,
    h3_module: Any,
) -> pd.DataFrame:
    enriched = frame.copy()
    target_log = np.log(enriched["target_price_per_m2"].to_numpy(dtype=float))
    local_mean = np.full(len(enriched), np.nan)
    local_spread = np.full(len(enriched), np.nan)
    local_count = np.zeros(len(enriched), dtype=float)

    for resolution, grouped in statistics:
        cells = pd.Series(
            market_cells(enriched, resolution=resolution, h3_module=h3_module),
            index=enriched.index,
        )
        counts = cells.map(grouped["count"]).to_numpy(dtype=float, na_value=np.nan)
        sums = cells.map(grouped["sum"]).to_numpy(dtype=float, na_value=np.nan)
        deviations = cells.map(grouped["std"]).to_numpy(dtype=float, na_value=np.nan)
        available_counts = counts - 1 if leave_one_out else counts
        means = np.divide(
            sums - target_log if leave_one_out else sums,
            available_counts,
            out=np.full(len(enriched), np.nan),
            where=available_counts > 0,
        )
        eligible = np.isnan(local_mean) & (available_counts >= 5) & np.isfinite(means)
        local_mean[eligible] = means[eligible]
        local_spread[eligible] = np.maximum(0.05, deviations[eligible] * 2.563)
        local_count[eligible] = available_counts[eligible]

    missing = ~np.isfinite(local_mean)
    local_mean[missing] = global_mean
    local_spread[missing] = global_spread
    local_count[missing] = 0
    enriched["local_median_log"] = local_mean
    enriched["local_spread_log"] = local_spread
    enriched["local_sample_size_log"] = np.log1p(local_count)
    return enriched


def market_cells(frame: pd.DataFrame, *, resolution: int, h3_module: Any) -> list[str | None]:
    cells: list[str | None] = []
    for latitude, longitude in zip(frame["latitude"], frame["longitude"], strict=True):
        try:
            cells.append(h3_module.latlng_to_cell(float(latitude), float(longitude), resolution))
        except (TypeError, ValueError):
            cells.append(None)
    return cells


def numeric_feature(frame: pd.DataFrame, name: str) -> pd.Series:
    if name not in frame:
        return pd.Series(np.nan, index=frame.index, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce")


def make_quantile_estimator(estimator_class: Any, *, alpha: float) -> Any:
    return estimator_class(
        objective="quantile",
        alpha=alpha,
        n_estimators=350,
        learning_rate=0.035,
        num_leaves=31,
        min_child_samples=30,
        subsample=0.85,
        colsample_bytree=0.9,
        reg_alpha=0.05,
        reg_lambda=0.2,
        random_state=42,
        n_jobs=-1,
        verbosity=-1,
    )


def validate_promotion(bundle: ModelBundle, *, force: bool = False) -> None:
    failures: list[str] = []
    if bundle.metrics.test_rows < 50:
        failures.append("fewer than 50 chronological test rows")
    if bundle.metrics.test_median_ape_pct > 30:
        failures.append(f"median APE {bundle.metrics.test_median_ape_pct}% > 30%")
    if bundle.metrics.test_mape_pct > 40:
        failures.append(f"MAPE {bundle.metrics.test_mape_pct}% > 40%")
    if bundle.metrics.interval_coverage_pct < 72:
        failures.append(f"coverage {bundle.metrics.interval_coverage_pct}% < 72%")
    if bundle.metrics.interval_mean_width_pct > 110:
        failures.append(f"interval width {bundle.metrics.interval_mean_width_pct}% > 110%")
    if failures and not force:
        raise ValueError(f"Model {bundle.segment}/{bundle.version} rejected: {', '.join(failures)}")
    if failures:
        LOGGER.warning("Forced promotion despite: %s", ", ".join(failures))


def write_model_bundle(bundle: ModelBundle, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{bundle.segment}-{bundle.version}.json"
    payload = {
        "segment": bundle.segment,
        "version": bundle.version,
        "featureNames": list(bundle.feature_names),
        "artifact": bundle.artifact,
        "calibration": bundle.calibration,
        "metrics": asdict(bundle.metrics),
        "trainingRows": bundle.training_rows,
        "trainingPeriodStart": bundle.training_period_start,
        "trainingPeriodEnd": bundle.training_period_end,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return path


def publish_model_bundle(db_url: str, bundle: ModelBundle, *, activate: bool) -> None:
    from src.storage.supabase_client import _postgres_connect

    if Jsonb is None:
        raise RuntimeError("psycopg Jsonb support is required to publish a valuation model.")
    now = datetime.now(UTC)
    status = "active" if activate else "draft"
    with _postgres_connect(db_url) as connection, connection.cursor() as cursor:
        if activate:
            cursor.execute(
                """
                update public.valuation_model_versions
                set status = 'retired', retired_at = %s, updated_at = %s
                where model_key = %s and segment = %s and status = 'active'
                """,
                (now, now, MODEL_KEY, bundle.segment),
            )
        cursor.execute(
            """
            insert into public.valuation_model_versions (
              model_key, version, segment, framework, status, feature_names,
              artifact, calibration, training_metrics, training_rows,
              training_period_start, training_period_end, trained_at, activated_at
            ) values (%s, %s, %s, 'lightgbm_quantile', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (model_key, segment, version) do update set
              status = excluded.status,
              feature_names = excluded.feature_names,
              artifact = excluded.artifact,
              calibration = excluded.calibration,
              training_metrics = excluded.training_metrics,
              training_rows = excluded.training_rows,
              training_period_start = excluded.training_period_start,
              training_period_end = excluded.training_period_end,
              trained_at = excluded.trained_at,
              activated_at = excluded.activated_at,
              updated_at = now()
            """,
            (
                MODEL_KEY,
                bundle.version,
                bundle.segment,
                status,
                list(bundle.feature_names),
                Jsonb(bundle.artifact),
                Jsonb(bundle.calibration),
                Jsonb(asdict(bundle.metrics)),
                bundle.training_rows,
                bundle.training_period_start,
                bundle.training_period_end,
                now,
                now if activate else None,
            ),
        )
        connection.commit()


def default_version() -> str:
    return datetime.now(UTC).strftime("lgbm-cqr-%Y%m%dT%H%MZ")


def rounded(value: float) -> float:
    return round(float(value), 2)


def parse_args() -> TrainingOptions:
    parser = argparse.ArgumentParser(description="Train ImmoJudis LightGBM + MAPIE valuation models.")
    parser.add_argument("--segment", action="append", choices=SUPPORTED_SEGMENTS)
    parser.add_argument(
        "--input",
        type=Path,
        dest="input_path",
        help="Optional local geolocated DVF .csv or .csv.gz source instead of Postgres.",
    )
    parser.add_argument("--min-rows", type=int, default=500)
    parser.add_argument(
        "--limit",
        type=int,
        default=750_000,
        help="Most recent rows loaded per segment (default: 750000).",
    )
    parser.add_argument("--version")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_MODEL_OUTPUT_DIR)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    return TrainingOptions(
        segments=tuple(args.segment or SUPPORTED_SEGMENTS),
        input_path=args.input_path,
        min_rows=max(100, args.min_rows),
        limit=args.limit,
        version=args.version,
        output_dir=args.output_dir,
        publish=args.publish or args.activate,
        activate=args.activate,
        force=args.force,
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    bundles = train_valuation_models(parse_args())
    for bundle in bundles:
        LOGGER.info(
            "%s %s: median APE %.2f%%, coverage %.2f%%, rows %s",
            bundle.segment,
            bundle.version,
            bundle.metrics.test_median_ape_pct,
            bundle.metrics.interval_coverage_pct,
            bundle.training_rows,
        )
    return 0 if bundles else 2


if __name__ == "__main__":
    raise SystemExit(main())
