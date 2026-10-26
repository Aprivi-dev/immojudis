"""``python -m src.reference_data {communes,risks,climate,rents,tension,all} [--dry-run]``."""

from __future__ import annotations

import argparse
import re
import tempfile
from datetime import date
from pathlib import Path

from src.config import load_settings
from src.reference_data import climate, communes, gaspar, rents, storage, tension
from src.reference_data.download import download, fetch_json
from src.storage.supabase_client import connect

DATASETS = ("communes", "risks", "climate", "rents", "tension")
# Refuse to write a source that looks truncated (France has about 34 900 communes, ANIL lines
# included; the zoning lists 34 875 communes).
MIN_RENT_COMMUNES = 34_000
MIN_TENSION_COMMUNES = 34_000
# Lines the parser may reject (broken values) before the file is considered unreliable.
MAX_REJECTED_SHARE = 0.005


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe les données de référence (communes, risques, climat, loyers, zonage tendu).")
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


_WEB_EDITION = re.compile(
    r"ANIL_CURRENT_EDITION\s*=\s*\{\s*vintage:\s*(\d{4}),\s*sourceUpdatedOn:\s*\"(\d{4}-\d{2}-\d{2})\"",
)
WEB_EDITION_FILE = Path(__file__).resolve().parents[4] / "src" / "lib" / "rent-source-notice.ts"


def web_edition_gap(vintage: int, updated_on: date | None, path: Path = WEB_EDITION_FILE) -> str | None:
    """Tell when the edition shown by the web app differs from the one just read.

    The mentions that do not depend on a sale (yield filter help, alert emails) quote
    ``ANIL_CURRENT_EDITION`` in ``src/lib/rent-source-notice.ts``: it must follow every import.
    ``None`` when they agree, or when the file is not there (a checkout without the web app).
    """
    try:
        match = _WEB_EDITION.search(path.read_text(encoding="utf-8"))
    except OSError:
        return None
    if match is None:
        return "ANIL_CURRENT_EDITION not found in the web app"
    web_vintage, web_updated = int(match.group(1)), match.group(2)
    if web_vintage == vintage and web_updated == (updated_on.isoformat() if updated_on else None):
        return None
    return (
        f"ANIL_CURRENT_EDITION says {web_vintage} / {web_updated} but the import reads "
        f"{vintage} / {updated_on}: update src/lib/rent-source-notice.ts"
    )


def _import_rents(work_dir: Path, connection) -> dict[str, object]:  # type: ignore[no-untyped-def]
    dataset = fetch_json(rents.ANIL_DATASET_API_URL)
    resources = rents.select_resources(dataset)
    vintage = rents.dataset_vintage(dataset)
    all_rows: list[dict[str, object]] = []
    summary: dict[str, object] = {"vintage": vintage}
    for segment, resource in resources.items():
        target = download(resource.url, work_dir / "rents" / f"{segment}.csv")
        rows, stats = rents.parse_rent_file(target, segment, resource.url, vintage, resource.updated_on)
        target.unlink(missing_ok=True)
        if len(rows) < MIN_RENT_COMMUNES:
            raise RuntimeError(f"Only {len(rows)} ANIL communes parsed for {segment}; refusing a partial import.")
        if stats.rejected > stats.lines * MAX_REJECTED_SHARE:
            raise RuntimeError(f"{stats.rejected} of {stats.lines} ANIL lines rejected for {segment}; refusing the import.")
        summary[segment] = len(rows)
        if segment == "apt_all":
            summary["arrondissements"] = rents.arrondissement_count(rows)
            summary["updated_on"] = resource.updated_on
        all_rows.extend(rows)
    gap = web_edition_gap(vintage, summary.get("updated_on"))  # type: ignore[arg-type]
    if gap:
        summary["web_edition_gap"] = gap
    # Everything is parsed and checked before the first write: a bad file never leaves a mix of vintages.
    if connection is None:
        summary["written"] = 0
        return summary
    started_at = storage.database_now(connection)
    summary["written"] = storage.upsert_rows(connection, "anil_rents", all_rows)
    summary["purged"] = storage.purge_untouched(connection, "anil_rents", started_at)
    found = storage.vintage_counts(connection, "anil_rents")
    if found != [(vintage, len(all_rows))]:
        raise RuntimeError(
            f"anil_rents holds {found} (vintage, rows) after the import; expected [({vintage}, {len(all_rows)})]. "
            "A mix of vintages or a wrong row count: nothing may read the table until this is understood."
        )
    return summary


def _import_tension(work_dir: Path, connection) -> dict[str, object]:  # type: ignore[no-untyped-def]
    resource = tension.select_resource(fetch_json(tension.TENSION_DATASET_API_URL))
    target = download(resource.url, work_dir / "tension" / "zonage-tlv.csv")
    rows, stats = tension.parse_tension_file(target, resource.url, resource.decree_reference, resource.updated_on)
    target.unlink(missing_ok=True)
    if len(rows) < MIN_TENSION_COMMUNES:
        raise RuntimeError(f"Only {len(rows)} communes parsed from the TLV zoning; refusing a partial import.")
    if stats.rejected > stats.lines * MAX_REJECTED_SHARE:
        raise RuntimeError(f"{stats.rejected} of {stats.lines} TLV lines rejected; refusing the import.")
    written = purged = 0
    if connection is not None:
        started_at = storage.database_now(connection)
        written = storage.upsert_rows(connection, "commune_housing_tension", rows)
        purged = storage.purge_untouched(connection, "commune_housing_tension", started_at)
        count = storage.row_count(connection, "commune_housing_tension")
        if count != len(rows):
            raise RuntimeError(
                f"commune_housing_tension holds {count} rows after the import; expected {len(rows)}."
            )
    tight = sum(1 for row in rows if row["zoning_post_decree"] != "non_tendue")
    return {
        "communes": len(rows),
        "tight_or_touristic": tight,
        "epci_columns_swapped": stats.epci_columns_swapped,
        "decree": resource.decree_reference,
        "updated_on": resource.updated_on,
        "written": written,
        "purged": purged,
    }


_IMPORTERS = {
    "communes": _import_communes,
    "risks": _import_risks,
    "climate": _import_climate,
    "rents": _import_rents,
    "tension": _import_tension,
}


if __name__ == "__main__":
    raise SystemExit(main())
