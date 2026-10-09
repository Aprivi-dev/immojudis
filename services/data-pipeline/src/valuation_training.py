from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
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
# Local market features: one definition shared by training (statistics of the
# sales that precede each row) and serving (statistics exported in the model
# artifact under "localMarket"). See resolve_local_market().
LOCAL_MARKET_FORMAT_VERSION = 1
LOCAL_MARKET_MIN_SAMPLE = 5
LOCAL_SPREAD_MULTIPLIER = 2.563  # width of a p10-p90 band, in standard deviations
LOCAL_SPREAD_FLOOR = 0.05
LOCAL_SAMPLE_SIZE_CAP = 100
LOCAL_GLOBAL_MIN_HISTORY = 30
MAX_EXPORTED_CELLS_PER_RESOLUTION = 100_000
DEFAULT_MODEL_OUTPUT_DIR = ROOT_DIR / "data" / "processed" / "valuation_models"
LOCAL_SOURCE_COLUMNS = {
    "id_mutation": "source_mutation_id",
    "id_parcelle": "source_parcel_id",
    "nature_mutation": "mutation_nature",
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
    # Candidate / active / naive comparison and the activation decision.
    report: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ActiveModel:
    """The model currently serving a segment, as stored in valuation_model_versions."""

    version: str
    artifact: dict[str, Any]
    training_metrics: dict[str, Any]


@dataclass(frozen=True)
class PromotionDecision:
    activate: bool
    reasons: tuple[str, ...] = ()


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
                active_model=fetch_active_model_for_segment(db_url, segment) if db_url else None,
            )
            if bundle is None:
                continue
            if options.publish and db_url:
                publish_model_bundle(db_url, bundle, activate=bundle_is_activated(bundle))
            bundles.append(bundle)
        return bundles

    from src.storage.supabase_client import POSTGRES_TRAINING_STATEMENT_TIMEOUT_MS, _postgres_connect

    assert db_url is not None
    # Reading millions of DVF rows legitimately outlasts the default 2-minute limit.
    with _postgres_connect(
        db_url, statement_timeout_ms=POSTGRES_TRAINING_STATEMENT_TIMEOUT_MS
    ) as connection:
        for segment in options.segments:
            segment_frame = fetch_training_transactions(connection, segment=segment, limit=options.limit)
            bundle = train_frame_if_eligible(
                segment_frame,
                segment=segment,
                version=version,
                options=options,
                active_model=fetch_active_model(connection, segment),
            )
            if bundle is None:
                continue
            if options.publish:
                publish_model_bundle(db_url, bundle, activate=bundle_is_activated(bundle))
            bundles.append(bundle)
    return bundles


def bundle_is_activated(bundle: ModelBundle) -> bool:
    """A bundle is activated only when the promotion gate said so, never by the flag alone."""
    return bool(bundle.report.get("promotion", {}).get("activate"))


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
    active_model: ActiveModel | None = None,
) -> ModelBundle | None:
    if len(frame) < options.min_rows:
        LOGGER.warning(
            "Skipping %s: %s rows available, %s required.",
            segment,
            len(frame),
            options.min_rows,
        )
        return None
    bundle = train_segment_model(frame, segment=segment, version=version, active_model=active_model)
    # Absolute quality thresholds: a model failing them is rejected (unless forced).
    validate_promotion(bundle, force=options.force)
    # Relative gate: --force never bypasses it, so a model worse than the active
    # one or than the naive reference is published as a draft at most.
    decision = decide_activation(bundle.report, requested=options.activate)
    bundle.report["promotion"] = {
        "activation_requested": options.activate,
        "activate": decision.activate,
        "reasons": list(decision.reasons),
    }
    if options.activate and not decision.activate:
        LOGGER.warning("Model %s/%s is not activated: %s", segment, version, "; ".join(decision.reasons))
    write_model_bundle(bundle, options.output_dir)
    write_training_report(bundle, options.output_dir)
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
            "mutation_nature",
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
        # The market-value model is trained only on arm's-length DVF sales.
        # Adjudications are reserved for Outcome Graph label candidates.
        chunk = chunk.loc[
            chunk["mutation_nature"].astype("string").str.strip().str.casefold() == "vente"
        ].copy()
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
            and mutation_nature = 'Vente'
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
    ordered = frame.sort_values("sale_date", kind="mergesort").reset_index(drop=True)
    train_end = max(1, int(len(ordered) * train_share))
    calibration_end = max(train_end + 1, int(len(ordered) * (train_share + calibration_share)))
    calibration_end = min(calibration_end, len(ordered) - 1)
    return (
        ordered.iloc[:train_end].copy(),
        ordered.iloc[train_end:calibration_end].copy(),
        ordered.iloc[calibration_end:].copy(),
    )


@dataclass(frozen=True)
class CellLevel:
    """Statistics of the earlier sales sharing each row's H3 cell at one resolution."""

    resolution: int
    count: np.ndarray
    mean: np.ndarray
    std: np.ndarray


def local_market_resolutions(segment: str) -> tuple[int, ...]:
    return (8, 7, 6) if segment == "house" else (9, 8, 7)


def resolve_local_market(
    levels: Sequence[CellLevel],
    *,
    fallback_mean: np.ndarray | float,
    fallback_spread: np.ndarray | float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pick each row's local market statistics: the finest cell with enough sales.

    This is the single definition of ``local_median_log``, ``local_spread_log``
    and the sample size, whatever the source of the cell statistics: the
    training pipeline feeds it the statistics of the sales preceding each row,
    and serving feeds it the statistics exported in the artifact
    (``lookup_exported_local_market``). A cell qualifies with at least
    ``LOCAL_MARKET_MIN_SAMPLE`` sales; the spread is the standard deviation of
    the log price per m2 scaled to a p10-p90 band.
    """
    size = len(levels[0].count)
    mean = np.full(size, np.nan)
    spread = np.full(size, np.nan)
    count = np.zeros(size, dtype=float)
    for level in levels:
        eligible = (
            np.isnan(mean)
            & (level.count >= LOCAL_MARKET_MIN_SAMPLE)
            & np.isfinite(level.mean)
            & np.isfinite(level.std)
        )
        mean[eligible] = level.mean[eligible]
        spread[eligible] = np.maximum(LOCAL_SPREAD_FLOOR, level.std[eligible] * LOCAL_SPREAD_MULTIPLIER)
        count[eligible] = level.count[eligible]
    missing = ~np.isfinite(mean)
    mean[missing] = np.broadcast_to(np.asarray(fallback_mean, dtype=float), size)[missing]
    spread[missing] = np.broadcast_to(np.asarray(fallback_spread, dtype=float), size)[missing]
    count[missing] = 0
    return mean, spread, np.log1p(np.minimum(count, LOCAL_SAMPLE_SIZE_CAP))


def past_cell_levels(
    ordered: pd.DataFrame,
    *,
    resolutions: Sequence[int],
    h3_module: Any,
) -> tuple[list[CellLevel], np.ndarray, np.ndarray]:
    """Per-row statistics computed from the sales strictly before that row.

    ``ordered`` must be sorted by sale date. A row never sees its own price,
    nor any later sale, so training features carry the same information a
    valuation made on that date would have (no leave-one-out leakage, in the
    mean or in the spread). Sales sharing a date are taken in file order.
    Returns the cell levels and the past-only global fallback (mean, spread).
    """
    target_log = np.log(ordered["target_price_per_m2"].to_numpy(dtype=float))
    shift = float(np.mean(target_log))
    centered = target_log - shift
    levels: list[CellLevel] = []
    for resolution in resolutions:
        cells = pd.Series(market_cells(ordered, resolution=resolution, h3_module=h3_module), dtype="object")
        valid = cells.notna().to_numpy()
        grouped = pd.DataFrame(
            {"cell": cells.fillna("").to_numpy(), "x": centered, "x2": centered * centered}
        ).groupby("cell", sort=False)
        count = np.where(valid, grouped.cumcount().to_numpy(dtype=float), 0.0)
        prior_sum = grouped["x"].cumsum().to_numpy() - centered
        prior_squares = grouped["x2"].cumsum().to_numpy() - centered * centered
        mean, std = _moments(count, prior_sum, prior_squares, shift)
        levels.append(CellLevel(resolution, count, mean, std))

    position = np.arange(len(ordered), dtype=float)
    mean, std = _moments(
        position,
        np.cumsum(centered) - centered,
        np.cumsum(centered * centered) - centered * centered,
        shift,
    )
    enough = position >= LOCAL_GLOBAL_MIN_HISTORY
    fallback_mean = np.where(enough, mean, np.nan)
    fallback_spread = np.where(enough, np.maximum(LOCAL_SPREAD_FLOOR, std * LOCAL_SPREAD_MULTIPLIER), np.nan)
    return levels, fallback_mean, fallback_spread


def _moments(
    count: np.ndarray, total: np.ndarray, squares: np.ndarray, shift: float
) -> tuple[np.ndarray, np.ndarray]:
    """Mean and sample standard deviation from (count, sum, sum of squares) of centered values."""
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = np.where(count >= 1, total / count + shift, np.nan)
        variance = (squares - total * total / count) / (count - 1)
    std = np.where(count >= 2, np.sqrt(np.maximum(variance, 0.0)), np.nan)
    return mean, std


def add_past_local_market_features(
    ordered: pd.DataFrame,
    *,
    segment: str,
    h3_module: Any = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Attach past-only local market features and build the artifact's ``localMarket`` export."""
    if h3_module is None:
        import h3 as h3_module

    resolutions = local_market_resolutions(segment)
    levels, fallback_mean, fallback_spread = past_cell_levels(
        ordered, resolutions=resolutions, h3_module=h3_module
    )
    mean, spread, sample_size_log = resolve_local_market(
        levels, fallback_mean=fallback_mean, fallback_spread=fallback_spread
    )
    enriched = ordered.copy()
    enriched["local_median_log"] = mean
    enriched["local_spread_log"] = spread
    enriched["local_sample_size_log"] = sample_size_log
    return enriched, export_local_market(ordered, resolutions=resolutions, h3_module=h3_module)


def export_local_market(
    ordered: pd.DataFrame,
    *,
    resolutions: Sequence[int],
    h3_module: Any,
) -> dict[str, Any]:
    """Cell statistics over every sale: what serving needs to rebuild the local features.

    Only cells with enough sales are exported, since no other cell is ever
    selected by ``resolve_local_market``.
    """
    target_log = np.log(ordered["target_price_per_m2"].to_numpy(dtype=float))
    cells_by_resolution: dict[str, dict[str, list[float]]] = {}
    truncated = False
    for resolution in resolutions:
        cells = pd.Series(market_cells(ordered, resolution=resolution, h3_module=h3_module), dtype="object")
        grouped = (
            pd.DataFrame({"cell": cells.to_numpy(), "x": target_log})
            .dropna(subset=["cell"])
            .groupby("cell")["x"]
            .agg(["count", "mean", "std"])
        )
        grouped = grouped.loc[(grouped["count"] >= LOCAL_MARKET_MIN_SAMPLE) & grouped["std"].notna()]
        if len(grouped) > MAX_EXPORTED_CELLS_PER_RESOLUTION:
            LOGGER.warning(
                "Exporting only the %s best-populated of %s cells at resolution %s.",
                MAX_EXPORTED_CELLS_PER_RESOLUTION,
                len(grouped),
                resolution,
            )
            grouped = grouped.sort_values("count", ascending=False).head(MAX_EXPORTED_CELLS_PER_RESOLUTION)
            truncated = True
        cells_by_resolution[str(resolution)] = {
            str(cell): [int(row["count"]), round(float(row["mean"]), 4), round(float(row["std"]), 4)]
            for cell, row in grouped.iterrows()
        }
    overall_mean = float(np.mean(target_log))
    overall_spread = max(LOCAL_SPREAD_FLOOR, float(np.std(target_log, ddof=1)) * LOCAL_SPREAD_MULTIPLIER)
    return {
        "formatVersion": LOCAL_MARKET_FORMAT_VERSION,
        "algorithm": {
            "description": (
                "For a point, compute its H3 cell at each resolution (finest first) and use the first "
                "cell with count >= minSample: local_median_log = mean, local_spread_log = "
                "max(spreadFloor, std * spreadMultiplier), local_sample_size_log = log1p(min(count, "
                "sampleSizeCap)). With no qualifying cell use fallback.mean / fallback.spread and a "
                "sample size of 0. Cell values are mean and sample standard deviation of "
                "log(price per m2)."
            ),
            "minSample": LOCAL_MARKET_MIN_SAMPLE,
            "spreadMultiplier": LOCAL_SPREAD_MULTIPLIER,
            "spreadFloor": LOCAL_SPREAD_FLOOR,
            "sampleSizeCap": LOCAL_SAMPLE_SIZE_CAP,
        },
        "resolutions": list(resolutions),
        "fittedThrough": pd.Timestamp(ordered["sale_date"].max()).date().isoformat(),
        "truncated": truncated,
        "fallback": {"mean": round(overall_mean, 4), "spread": round(overall_spread, 4)},
        "cells": cells_by_resolution,
        "cellFormat": ["count", "mean", "std"],
    }


def lookup_exported_local_market(
    local_market: dict[str, Any],
    latitude: float,
    longitude: float,
    *,
    h3_module: Any,
) -> dict[str, float]:
    """Reference implementation of the serving-side computation (the TypeScript port mirrors it)."""
    levels: list[CellLevel] = []
    for resolution in local_market["resolutions"]:
        try:
            cell = h3_module.latlng_to_cell(float(latitude), float(longitude), int(resolution))
        except (TypeError, ValueError):
            cell = None
        entry = (local_market["cells"].get(str(resolution)) or {}).get(cell) if cell else None
        count, mean, std = entry if entry else (0, np.nan, np.nan)
        levels.append(
            CellLevel(int(resolution), np.array([float(count)]), np.array([float(mean)]), np.array([float(std)]))
        )
    mean, spread, sample_size_log = resolve_local_market(
        levels,
        fallback_mean=float(local_market["fallback"]["mean"]),
        fallback_spread=float(local_market["fallback"]["spread"]),
    )
    return {
        "local_median_log": float(mean[0]),
        "local_spread_log": float(spread[0]),
        "local_sample_size_log": float(sample_size_log[0]),
    }


def _fit_quantile_models(x: pd.DataFrame, y: np.ndarray) -> tuple[Any, Any, Any]:
    from lightgbm import LGBMRegressor

    lower = make_quantile_estimator(LGBMRegressor, alpha=0.1)
    upper = make_quantile_estimator(LGBMRegressor, alpha=0.9)
    median = make_quantile_estimator(LGBMRegressor, alpha=0.5)
    for estimator in (lower, upper, median):
        estimator.fit(x, y)
    return lower, upper, median


def _conformalize(
    models: tuple[Any, Any, Any], x_calibration: pd.DataFrame, y_calibration: np.ndarray
) -> Any:
    from mapie.regression import ConformalizedQuantileRegressor

    lower, upper, median = models
    return ConformalizedQuantileRegressor(
        estimator=[lower, upper, median],
        confidence_level=CONFIDENCE_LEVEL,
        prefit=True,
    ).conformalize(x_calibration, y_calibration)


def _predict_intervals(
    conformal: Any, models: tuple[Any, Any, Any], x: pd.DataFrame
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
    lower, upper, _median = models
    predicted_log, intervals = conformal.predict_interval(x)
    interval_low = intervals[:, 0, 0]
    interval_high = intervals[:, 1, 0]
    lower_correction = float(np.median(lower.predict(x) - interval_low))
    upper_correction = float(np.median(interval_high - upper.predict(x)))
    return predicted_log, interval_low, interval_high, lower_correction, upper_correction


def _model_artifact(
    models: tuple[Any, Any, Any], calibration: dict[str, Any], local_market: dict[str, Any]
) -> dict[str, Any]:
    lower, upper, median = models
    return {
        "format": "lightgbm-json-v1",
        "target": "log_price_per_m2",
        "featureNames": list(FEATURE_NAMES),
        "models": {
            "p10": lower.booster_.dump_model(),
            "p50": median.booster_.dump_model(),
            "p90": upper.booster_.dump_model(),
        },
        "calibration": calibration,
        "localMarket": local_market,
    }


def _ape_summary(predicted: np.ndarray, actual: np.ndarray) -> dict[str, float]:
    errors = np.abs(predicted - actual) / actual * 100
    return {
        "median_ape_pct": rounded(np.median(errors)),
        "mape_pct": rounded(np.mean(errors)),
        "p75_ape_pct": rounded(np.quantile(errors, 0.75)),
    }


def train_segment_model(
    frame: pd.DataFrame,
    *,
    segment: str,
    version: str,
    active_model: ActiveModel | None = None,
    h3_module: Any = None,
) -> ModelBundle:
    """Validate chronologically, then publish a model refit on the newest data.

    1. Validation: fit on the oldest 70 % of sales, conformalize on the next
       15 %, evaluate on the newest 15 %. These metrics drive the promotion
       gate and are compared with the active model and a naive local reference.
    2. Publication: refit on train + calibration (the oldest 85 %) and
       recalibrate the intervals on the newest window, which the refit never
       saw and which reflects the current market.

    Local market features of every row only use the sales before that row.
    """
    ordered = frame.sort_values("sale_date", kind="mergesort").reset_index(drop=True)
    featured, local_market = add_past_local_market_features(ordered, segment=segment, h3_module=h3_module)
    train, calibration, test = chronological_split(featured)
    if min(len(train), len(calibration), len(test)) < 20:
        raise ValueError(f"Not enough chronological observations to train {segment}.")

    x_train, x_calibration, x_test = (feature_frame(part) for part in (train, calibration, test))
    y_train, y_calibration, y_test = (
        np.log(part["target_price_per_m2"].to_numpy(dtype=float)) for part in (train, calibration, test)
    )

    # -- 1. validation model -------------------------------------------------------
    validation_models = _fit_quantile_models(x_train, y_train)
    conformal = _conformalize(validation_models, x_calibration, y_calibration)
    predicted_log, interval_low, interval_high, _, _ = _predict_intervals(
        conformal, validation_models, x_test
    )
    actual = np.exp(y_test)
    predicted = np.exp(predicted_log)
    predicted_low = np.exp(interval_low)
    predicted_high = np.exp(interval_high)
    summary = _ape_summary(predicted, actual)
    coverage = np.mean((actual >= predicted_low) & (actual <= predicted_high)) * 100
    width_pct = np.mean((predicted_high - predicted_low) / predicted * 100)
    metrics = TrainingMetrics(
        train_rows=len(train),
        calibration_rows=len(calibration),
        test_rows=len(test),
        test_mape_pct=summary["mape_pct"],
        test_median_ape_pct=summary["median_ape_pct"],
        test_p75_ape_pct=summary["p75_ape_pct"],
        interval_coverage_pct=rounded(coverage),
        interval_mean_width_pct=rounded(width_pct),
        confidence_level=CONFIDENCE_LEVEL,
    )

    # -- 2. published model: refit on train + calibration, recalibrate on the newest window
    fit_part = pd.concat([train, calibration], ignore_index=True)
    published_models = _fit_quantile_models(
        feature_frame(fit_part), np.log(fit_part["target_price_per_m2"].to_numpy(dtype=float))
    )
    published_conformal = _conformalize(published_models, x_test, y_test)
    _, _, _, lower_correction, upper_correction = _predict_intervals(
        published_conformal, published_models, x_test
    )
    calibration_payload = {
        "method": "mapie_cqr",
        "confidenceLevel": CONFIDENCE_LEVEL,
        "lowerCorrection": lower_correction,
        "upperCorrection": upper_correction,
    }
    artifact = _model_artifact(published_models, calibration_payload, local_market)

    report = build_comparison_report(
        segment=segment,
        version=version,
        metrics=metrics,
        validation_summary=summary,
        train=train,
        calibration=calibration,
        test=test,
        test_features=x_test,
        actual=actual,
        active_model=active_model,
        h3_resolutions=local_market_resolutions(segment),
        h3_module=h3_module,
    )
    report["published_model"] = {
        "refit_rows": len(fit_part),
        "recalibration_rows": len(test),
        "recalibration_window": [_iso_date(test["sale_date"].min()), _iso_date(test["sale_date"].max())],
        "metrics_describe": "validation model (fit on train only), not the refit published model",
        "local_market_cells": {
            resolution: len(cells) for resolution, cells in local_market["cells"].items()
        },
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
        report=report,
    )


def _iso_date(value: Any) -> str:
    return pd.Timestamp(value).date().isoformat()


def static_cell_median_reference(
    train: pd.DataFrame, test: pd.DataFrame, *, resolutions: Sequence[int], h3_module: Any = None
) -> np.ndarray:
    """Naive reference: the median price per m2 of the training sales in the test row's cell."""
    if h3_module is None:
        import h3 as h3_module

    reference = train["target_price_per_m2"].to_numpy(dtype=float)
    prediction = np.full(len(test), float(np.median(reference)))
    assigned = np.zeros(len(test), dtype=bool)
    for resolution in resolutions:
        train_cells = pd.Series(market_cells(train, resolution=resolution, h3_module=h3_module), dtype="object")
        stats = (
            pd.DataFrame({"cell": train_cells.to_numpy(), "price": reference})
            .dropna(subset=["cell"])
            .groupby("cell")["price"]
            .agg(["count", "median"])
        )
        stats = stats.loc[stats["count"] >= LOCAL_MARKET_MIN_SAMPLE]
        test_cells = pd.Series(market_cells(test, resolution=resolution, h3_module=h3_module), dtype="object")
        medians = test_cells.map(stats["median"]).to_numpy(dtype=float, na_value=np.nan)
        usable = ~assigned & np.isfinite(medians)
        prediction[usable] = medians[usable]
        assigned |= usable
    return prediction


def build_comparison_report(
    *,
    segment: str,
    version: str,
    metrics: TrainingMetrics,
    validation_summary: dict[str, float],
    train: pd.DataFrame,
    calibration: pd.DataFrame,
    test: pd.DataFrame,
    test_features: pd.DataFrame,
    actual: np.ndarray,
    active_model: ActiveModel | None,
    h3_resolutions: Sequence[int],
    h3_module: Any = None,
) -> dict[str, Any]:
    """Candidate vs active model vs naive references, on the same newest sales."""
    local_reference = _ape_summary(np.exp(test_features["local_median_log"].to_numpy(dtype=float)), actual)
    cell_median = _ape_summary(
        static_cell_median_reference(train, test, resolutions=h3_resolutions, h3_module=h3_module), actual
    )
    naive_gate = min(local_reference["median_ape_pct"], cell_median["median_ape_pct"])
    return {
        "segment": segment,
        "version": version,
        "generated_at": datetime.now(UTC).isoformat(),
        "split": {
            "train_rows": len(train),
            "calibration_rows": len(calibration),
            "test_rows": len(test),
            "test_period": [_iso_date(test["sale_date"].min()), _iso_date(test["sale_date"].max())],
        },
        "candidate": {
            **validation_summary,
            "coverage_pct": metrics.interval_coverage_pct,
            "interval_width_pct": metrics.interval_mean_width_pct,
        },
        "active": evaluate_active_model(active_model, test_features, actual),
        "naive": {
            "local_geometric_mean": local_reference,
            "train_cell_median": cell_median,
            "gate_median_ape_pct": naive_gate,
        },
    }


def decide_activation(report: dict[str, Any], *, requested: bool) -> PromotionDecision:
    """Activate only a model whose median APE beats both the active model and the naive reference."""
    if not requested:
        return PromotionDecision(False, ("activation not requested",))
    reasons: list[str] = []
    candidate = float(report["candidate"]["median_ape_pct"])
    naive = float(report["naive"]["gate_median_ape_pct"])
    if not candidate < naive:
        reasons.append(f"median APE {candidate}% does not beat the naive local reference ({naive}%)")
    active = report.get("active", {})
    if active.get("status") == "evaluated":
        active_ape = float(active["median_ape_pct"])
        if not candidate < active_ape:
            reasons.append(
                f"median APE {candidate}% does not beat the active model {active.get('version')} ({active_ape}%)"
            )
    elif active.get("status") != "none":
        reasons.append(
            f"the active model {active.get('version')} could not be evaluated "
            f"({active.get('reason', 'unknown reason')}); a regression cannot be ruled out"
        )
    return PromotionDecision(not reasons, tuple(reasons))


# --------------------------------------------------------------------------- active model


def fetch_active_model(connection: Any, segment: str) -> ActiveModel | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            select version, artifact, training_metrics
            from public.valuation_model_versions
            where model_key = %s and segment = %s and status = 'active'
              and framework = 'lightgbm_quantile'
            """,
            (MODEL_KEY, segment),
        )
        row = cursor.fetchone()
    if not row:
        return None
    return ActiveModel(
        version=str(row[0]),
        artifact=row[1] if isinstance(row[1], dict) else {},
        training_metrics=row[2] if isinstance(row[2], dict) else {},
    )


def fetch_active_model_for_segment(db_url: str, segment: str) -> ActiveModel | None:
    from src.storage.supabase_client import _postgres_connect

    with _postgres_connect(db_url) as connection:
        return fetch_active_model(connection, segment)


def predict_lightgbm_dump(dump: dict[str, Any], matrix: np.ndarray) -> np.ndarray:
    """Evaluate a LightGBM ``dump_model()`` exactly as the TypeScript serving code does."""
    trees = dump.get("tree_info") or []
    if not trees:
        return np.full(len(matrix), np.nan)
    total = np.zeros(len(matrix))
    for tree in trees:
        values = np.full(len(matrix), np.nan)
        _walk_tree(tree.get("tree_structure"), matrix, np.arange(len(matrix)), values)
        total += values
    return total / len(trees) if dump.get("average_output") else total


def _walk_tree(node: Any, matrix: np.ndarray, rows: np.ndarray, out: np.ndarray) -> None:
    if not isinstance(node, dict) or len(rows) == 0:
        return
    if isinstance(node.get("leaf_value"), (int, float)):
        out[rows] = float(node["leaf_value"])
        return
    feature = node.get("split_feature")
    decision = node.get("decision_type", "<=")
    if not isinstance(feature, int) or decision not in {"<=", "<"}:
        return
    try:
        threshold = float(node.get("threshold"))
    except (TypeError, ValueError):
        return
    if not math.isfinite(threshold):
        return
    column = matrix[rows, feature]
    missing = ~np.isfinite(column)
    compared = column < threshold if decision == "<" else column <= threshold
    go_left = np.where(missing, bool(node.get("default_left")), compared)
    _walk_tree(node.get("left_child"), matrix, rows[go_left], out)
    _walk_tree(node.get("right_child"), matrix, rows[~go_left], out)


def evaluate_active_model(
    active_model: ActiveModel | None, features: pd.DataFrame, actual: np.ndarray
) -> dict[str, Any]:
    """Median/mean APE of the active model's p50 on the validation sales.

    The active model is fed the candidate's past-only local features. Its own
    training used static cell statistics with the same definitions, so this is
    an approximation of its production inputs, identical for both models.
    """
    if active_model is None:
        return {"status": "none"}
    artifact = active_model.artifact
    base = {
        "version": active_model.version,
        "reported_test_mape_pct": active_model.training_metrics.get("test_mape_pct"),
    }
    names = artifact.get("featureNames")
    dump = (artifact.get("models") or {}).get("p50")
    if artifact.get("format") != "lightgbm-json-v1" or not isinstance(names, list) or not isinstance(dump, dict):
        return {**base, "status": "unevaluable", "reason": "artifact is not a lightgbm-json-v1 quantile model"}
    matrix = np.column_stack(
        [
            pd.to_numeric(features[name], errors="coerce").to_numpy(dtype=float)
            if name in features
            else np.full(len(features), np.nan)
            for name in names
        ]
    )
    predicted_log = predict_lightgbm_dump(dump, matrix)
    if not np.isfinite(predicted_log).all():
        return {**base, "status": "unevaluable", "reason": "the p50 model returned non-finite predictions"}
    return {**base, "status": "evaluated", **_ape_summary(np.exp(predicted_log), actual)}


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


def write_training_report(bundle: ModelBundle, output_dir: Path) -> Path:
    """Write the candidate / active / naive comparison next to the model bundle."""
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{bundle.segment}-{bundle.version}.report.json"
    path.write_text(json.dumps(bundle.report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return path


def published_training_metrics(bundle: ModelBundle) -> dict[str, Any]:
    """Validation metrics, plus a compact comparison for the registry."""
    metrics: dict[str, Any] = asdict(bundle.metrics)
    report = bundle.report
    if report:
        active = report.get("active", {})
        metrics["comparison"] = {
            "candidate_median_ape_pct": report["candidate"]["median_ape_pct"],
            "active_version": active.get("version"),
            "active_median_ape_pct": active.get("median_ape_pct"),
            "naive_median_ape_pct": report["naive"]["gate_median_ape_pct"],
            "activated": bundle_is_activated(bundle),
        }
    return metrics


def format_step_summary(bundles: Sequence[ModelBundle]) -> str:
    lines = [
        "### Valuation models: candidate vs active vs naive (median APE on the newest sales)",
        "",
        "| Segment | Candidate | Active | Naive local | Test rows | Activated | Reasons |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for bundle in bundles:
        report = bundle.report
        active = report.get("active", {})
        active_cell = (
            f"{active['median_ape_pct']}% ({active.get('version')})"
            if active.get("status") == "evaluated"
            else "none" if active.get("status") == "none" else f"not evaluable ({active.get('reason', '?')})"
        )
        promotion = report.get("promotion", {})
        lines.append(
            "| {segment} | {candidate}% | {active} | {naive}% | {rows} | {activated} | {reasons} |".format(
                segment=bundle.segment,
                candidate=report["candidate"]["median_ape_pct"],
                active=active_cell,
                naive=report["naive"]["gate_median_ape_pct"],
                rows=report["split"]["test_rows"],
                activated="yes" if promotion.get("activate") else "no",
                reasons="; ".join(promotion.get("reasons", [])) or "-",
            )
        )
    return "\n".join(lines) + "\n"


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
                Jsonb(published_training_metrics(bundle)),
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
    summary_path = os.getenv("GITHUB_STEP_SUMMARY")
    if bundles and summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as handle:
            handle.write(format_step_summary(bundles))
    return 0 if bundles else 2


if __name__ == "__main__":
    raise SystemExit(main())
