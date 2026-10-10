"""``python -m src.reference_data {communes,risks,climate,all} [--dry-run]``."""

from __future__ import annotations

import argparse
import tempfile
from datetime import date
from pathlib import Path

from src.config import load_settings
from src.reference_data import climate, communes, gaspar, storage
from src.reference_data.download import download
from src.storage.supabase_client import connect

DATASETS = ("communes", "risks", "climate")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe les données de référence (communes, risques, climat).")
    parser.add_argument("dataset", choices=(*DATASETS, "all"))
    parser.add_argument("--dry-run", action="store_true", help="Télécharge et analyse sans écrire en base.")
    parser.add_argument("--work-dir", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    datasets = DATASETS if args.dataset == "all" else (args.dataset,)
    db_url = load_settings().get("supabase_db_url")
    if not args.dry_run and not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required unless --dry-run is given.")
    with tempfile.TemporaryDirectory(prefix="reference-data-") as temporary:
        work_dir = args.work_dir or Path(temporary)
        work_dir.mkdir(parents=True, exist_ok=True)
        connection = None if args.dry_run else connect(str(db_url), statement_timeout_ms=600_000)
        try:
            for dataset in datasets:
                summary = _IMPORTERS[dataset](work_dir, connection)
                print(f"[{dataset}] " + ", ".join(f"{key}={value}" for key, value in summary.items()))
        finally:
            if connection is not None:
                connection.close()
    return 0


def _import_communes(work_dir: Path, connection) -> dict[str, object]:  # type: ignore[no-untyped-def]
    rows = communes.fetch_communes()
    if len(rows) < 30_000:
        raise RuntimeError(f"Only {len(rows)} communes returned by geo.api.gouv.fr; refusing a partial import.")
    written = storage.upsert_rows(connection, "reference_communes", rows) if connection else 0
    return {"communes": len(rows), "written": written}


def _import_risks(work_dir: Path, connection) -> dict[str, object]:  # type: ignore[no-untyped-def]
    archive = download(gaspar.GASPAR_ARCHIVE_URL, work_dir / "gaspar.zip")
    profiles, snapshot = gaspar.build_risk_profiles(archive)
    if len(profiles) < 30_000:
        raise RuntimeError(f"Only {len(profiles)} GASPAR communes parsed; refusing a partial import.")
    written = storage.upsert_rows(connection, "commune_risk_profiles", profiles) if connection else 0
    with_catnat = sum(1 for profile in profiles if profile["catnat_total"])
    return {"communes": len(profiles), "with_catnat": with_catnat, "snapshot": snapshot, "written": written}


def _import_climate(work_dir: Path, connection) -> dict[str, object]:  # type: ignore[no-untyped-def]
    files = climate.list_climate_files()
    if len({item.department for item in files}) < 90:
        raise RuntimeError(f"Only {len(files)} Météo-France files listed; refusing a partial import.")
    stations: dict[str, climate.ClimateStationAccumulator] = {}
    for item in files:
        target = download(item.url, work_dir / "climate" / item.name)
        climate.parse_climate_file(target, item.department, stations)
        target.unlink(missing_ok=True)
    today = date.today()
    active = climate.active_stations(stations, active_since=date(today.year - 1, 1, 1))
    station_count = month_count = deleted = 0
    if connection is not None:
        station_count = storage.upsert_rows(connection, "climate_stations", climate.station_rows(active))
        month_count = storage.upsert_rows(connection, "climate_station_months", climate.month_rows(active))
        deleted = storage.delete_climate_months_before(connection, climate.FIRST_MONTH)
    return {
        "files": len(files),
        "stations_parsed": len(stations),
        "stations_active": len(active),
        "months": sum(len(station.months) for station in active),
        "stations_written": station_count,
        "months_written": month_count,
        "months_deleted": deleted,
    }


_IMPORTERS = {
    "communes": _import_communes,
    "risks": _import_risks,
    "climate": _import_climate,
}


if __name__ == "__main__":
    raise SystemExit(main())
