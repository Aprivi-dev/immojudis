"""``python -m src.reference_data {communes,risks,climate,rents,tension,all} [--dry-run]``.

``python -m src.reference_data rents --check-new-vintage`` only looks for a newer ANIL edition
(no write, no database): it exits 1 with a ``::warning::`` when one is published.
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

from src.config import load_settings
from src.reference_data import climate, communes, gaspar, rents, storage, tension
from src.reference_data.download import download, fetch_json
from src.storage.supabase_client import connect

DATASETS = ("communes", "risks", "climate", "rents", "tension")
# Refuse to write a source that looks truncated (France has about 34 900 communes, ANIL lines
# included; the zoning lists 34 875 communes). The absolute floor leaves about 100 communes of
# slack; the relative floor below follows the table as it grows or shrinks.
MIN_RENT_COMMUNES = 34_800
MIN_TENSION_COMMUNES = 34_800
# A new file with fewer rows than this share of what the table holds now is refused: a cut of a
# few percent passes any fixed floor, and the purge would then delete the communes it lost.
MIN_SHARE_OF_CURRENT_ROWS = 0.99
# Lines the parser may reject (broken values) before the file is considered unreliable.
MAX_REJECTED_SHARE = 0.005


class ImportRefused(RuntimeError):
    """An import stopped before writing; ``summary`` is what was read, to be printed anyway."""

    def __init__(self, message: str, summary: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.summary = summary or {}


class Database:
    """One lazily opened connection per dataset.

    The climate import downloads 96 files before its first write: a connection opened up front
    sits idle for a long time and the pooler may close it. Opening it on the first use, and closing
    it as soon as the dataset is done, keeps every connection short-lived and isolated.
    """

    def __init__(self, url: str) -> None:
        self._url = url
        self._connection = None

    def connection(self):  # type: ignore[no-untyped-def]
        if self._connection is None:
            self._connection = connect(self._url, statement_timeout_ms=600_000)
        return self._connection

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe les données de référence (communes, risques, climat, loyers, zonage tendu).")
    parser.add_argument("dataset", choices=(*DATASETS, "all"))
    parser.add_argument("--dry-run", action="store_true", help="Télécharge et analyse sans écrire en base.")
    parser.add_argument(
        "--check-new-vintage",
        action="store_true",
        help="Avec `rents` : cherche un millésime ANIL plus récent (sortie 1 et ::warning:: s'il existe).",
    )
    parser.add_argument("--work-dir", type=Path, default=None)
    args = parser.parse_args(argv)
    if args.check_new_vintage and args.dataset != "rents":
        parser.error("--check-new-vintage only applies to the `rents` dataset")
    return args


def _print_summary(dataset: str, summary: dict[str, object]) -> None:
    print(f"[{dataset}] " + ", ".join(f"{key}={value}" for key, value in summary.items()), flush=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.check_new_vintage:
        return check_new_vintage()
    datasets = DATASETS if args.dataset == "all" else (args.dataset,)
    db_url = load_settings().get("supabase_db_url")
    if not args.dry_run and not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required unless --dry-run is given.")
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="reference-data-") as temporary:
        work_dir = args.work_dir or Path(temporary)
        work_dir.mkdir(parents=True, exist_ok=True)
        for dataset in datasets:
            # One dataset must not stop the others (a failing climate import used to skip rents and tension).
            database = None if args.dry_run else Database(str(db_url))
            try:
                _print_summary(dataset, _IMPORTERS[dataset](work_dir, database))
            except Exception as error:  # noqa: BLE001 - reported below, with a non-zero exit code
                failures.append(dataset)
                if isinstance(error, ImportRefused) and error.summary:
                    _print_summary(dataset, error.summary)
                print(f"::error title=Import {dataset}::{type(error).__name__}: {error}", flush=True)
            finally:
                if database is not None:
                    try:
                        database.close()
                    except Exception:  # noqa: BLE001 - a closing failure must not hide the result
                        pass
    if failures:
        print(f"Datasets failed: {', '.join(failures)} (of {len(datasets)}).", file=sys.stderr, flush=True)
        return 1
    return 0


def _refuse_shrinking_import(table: str, new_rows: int, current_rows: int) -> None:
    """Refuse a file much smaller than the table it would replace (truncation under the fixed floors)."""
    if current_rows and new_rows < current_rows * MIN_SHARE_OF_CURRENT_ROWS:
        raise ImportRefused(
            f"{new_rows} rows read for {table}, below {MIN_SHARE_OF_CURRENT_ROWS:.0%} of the {current_rows} "
            "it holds now: refusing a probably truncated import."
        )


def _import_communes(work_dir: Path, database: Database | None) -> dict[str, object]:
    rows = communes.fetch_communes()
    if len(rows) < 30_000:
        raise RuntimeError(f"Only {len(rows)} communes returned by geo.api.gouv.fr; refusing a partial import.")
    written = storage.upsert_rows(database.connection(), "reference_communes", rows) if database else 0
    return {"communes": len(rows), "written": written}


def _import_risks(work_dir: Path, database: Database | None) -> dict[str, object]:
    archive = download(gaspar.GASPAR_ARCHIVE_URL, work_dir / "gaspar.zip")
    profiles, snapshot = gaspar.build_risk_profiles(archive)
    if len(profiles) < 30_000:
        raise RuntimeError(f"Only {len(profiles)} GASPAR communes parsed; refusing a partial import.")
    written = storage.upsert_rows(database.connection(), "commune_risk_profiles", profiles) if database else 0
    with_catnat = sum(1 for profile in profiles if profile["catnat_total"])
    return {"communes": len(profiles), "with_catnat": with_catnat, "snapshot": snapshot, "written": written}


def _import_climate(work_dir: Path, database: Database | None) -> dict[str, object]:
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
    if database is not None:
        # Opened only now: the 96 downloads above can take a long time.
        connection = database.connection()
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


def web_edition_vintage(path: Path = WEB_EDITION_FILE) -> int | None:
    """Vintage quoted by the web app, or ``None`` when it cannot be read."""
    try:
        match = _WEB_EDITION.search(path.read_text(encoding="utf-8"))
    except OSError:
        return None
    return int(match.group(1)) if match else None


def check_new_vintage(web_path: Path = WEB_EDITION_FILE) -> int:
    """Look for an ANIL rent map newer than the edition the web app quotes (no write).

    The pinned dataset id changes with every republication, so a new edition (expected each
    December) would otherwise go unnoticed: the import would keep re-reading the old one without
    error. Exit code 1 with a ``::warning::`` per newer edition found, 0 otherwise.
    """
    current = fetch_json(rents.ANIL_DATASET_API_URL)
    baseline = web_edition_vintage(web_path) or rents.dataset_vintage(current)
    found = rents.newer_vintages(fetch_json(rents.ANIL_SEARCH_URL), baseline)
    pinned = rents.dataset_vintage(current)
    if pinned > baseline and all(item.vintage != pinned for item in found):
        found.append(rents.NewerVintage(pinned, str(current.get("title") or ""), rents.ANIL_DATASET_ID))
    if not found:
        print(f"No ANIL rent map newer than {baseline} found.")
        return 0
    for item in sorted(found, key=lambda entry: entry.vintage):
        print(
            f"::warning title=Nouveau millésime ANIL::{item.vintage} publié (« {item.title} », dataset {item.identifier}) "
            f"alors que le site cite {baseline}. Suivre docs/runbooks/import-annuel-anil.md : "
            "mettre à jour ANIL_DATASET_ID, ANIL_CURRENT_EDITION et les tests, puis lancer l'import."
        )
    return 1


def _import_rents(work_dir: Path, database: Database | None) -> dict[str, object]:
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
        # Blocking, before any write: the pull request that updates the constant comes first.
        summary["web_edition_gap"] = gap
        summary["written"] = 0
        raise ImportRefused(f"web_edition_gap: {gap}", summary)
    if database is None:
        summary["written"] = 0
        return summary
    connection = database.connection()
    _refuse_shrinking_import("anil_rents", len(all_rows), storage.row_count(connection, "anil_rents"))
    # One transaction for the upsert, the purge and the vintage check: rolled back on any failure.
    summary["written"], summary["purged"] = storage.replace_snapshot(
        connection, "anil_rents", all_rows, vintage=vintage
    )
    return summary


def _import_tension(work_dir: Path, database: Database | None) -> dict[str, object]:
    resource = tension.select_resource(fetch_json(tension.TENSION_DATASET_API_URL))
    target = download(resource.url, work_dir / "tension" / "zonage-tlv.csv")
    decree = tension.choose_decree(resource, tension.file_decree_date(target))
    rows, stats = tension.parse_tension_file(target, resource.url, decree, resource.updated_on)
    target.unlink(missing_ok=True)
    if len(rows) < MIN_TENSION_COMMUNES:
        raise RuntimeError(f"Only {len(rows)} communes parsed from the TLV zoning; refusing a partial import.")
    if stats.rejected > stats.lines * MAX_REJECTED_SHARE:
        raise RuntimeError(f"{stats.rejected} of {stats.lines} TLV lines rejected; refusing the import.")
    written = purged = 0
    if database is not None:
        connection = database.connection()
        _refuse_shrinking_import(
            "commune_housing_tension", len(rows), storage.row_count(connection, "commune_housing_tension")
        )
        written, purged = storage.replace_snapshot(connection, "commune_housing_tension", rows)
    tight = sum(1 for row in rows if row["zoning_post_decree"] != "non_tendue")
    return {
        "communes": len(rows),
        "tight_or_touristic": tight,
        "epci_columns_swapped": stats.epci_columns_swapped,
        "decree": decree,
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
