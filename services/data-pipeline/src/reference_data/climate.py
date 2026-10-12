"""Météo-France monthly climatological data (Licence Ouverte Etalab 2.0).

Files ``MENSQ_<department>_previous-1950-<year>.csv.gz`` and
``MENSQ_<department>_latest-<year>-<year>.csv.gz`` are published on
``object.files.data.gouv.fr``; their names move every year, so they are found
by listing the bucket instead of being hard-coded.
"""

from __future__ import annotations

import calendar
import csv
import gzip
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote

from src.reference_data.download import fetch_text

CLIMATE_BUCKET_URL = "https://object.files.data.gouv.fr/meteofrance"
CLIMATE_PREFIX = "data/synchro_ftp/BASE/MENS/"
CLIMATE_SOURCE_URL = "https://meteo.data.gouv.fr/datasets/donnees-climatologiques-de-base-mensuelles"
FIRST_MONTH = date(2016, 1, 1)
MIN_DAY_COVERAGE = 0.8
# Météo-France quality codes: 0 protected, 1 validated, 9 filled but not yet
# validated; 2 means "doubtful, being checked" and is dropped.
REJECTED_QUALITY_CODES = frozenset({"2"})
_FILE = re.compile(r"^MENSQ_([0-9]{2,3})_(previous-1950-\d{4}|latest-\d{4}-\d{4})\.csv\.gz$")
_KEY = re.compile(r"<Key>([^<]+)</Key>")
_STATION = re.compile(r"^[0-9]{8}$")


@dataclass(frozen=True)
class ClimateFile:
    department: str
    name: str

    @property
    def url(self) -> str:
        return f"{CLIMATE_BUCKET_URL}/{CLIMATE_PREFIX}{self.name}"


def list_climate_files(fetch: Callable[[str], str] = fetch_text) -> list[ClimateFile]:
    """``previous`` and ``latest`` files of every metropolitan and overseas department."""
    files: list[ClimateFile] = []
    marker = ""
    while True:
        url = f"{CLIMATE_BUCKET_URL}/?prefix={quote(CLIMATE_PREFIX + 'MENSQ_')}&max-keys=1000"
        if marker:
            url += f"&marker={quote(marker)}"
        listing = fetch(url)
        keys = _KEY.findall(listing)
        for key in keys:
            name = key.rsplit("/", 1)[-1]
            match = _FILE.match(name)
            if match:
                files.append(ClimateFile(department=match.group(1), name=name))
        if "<IsTruncated>true</IsTruncated>" not in listing or not keys:
            break
        marker = keys[-1]
    return sorted(set(files), key=lambda item: item.name)


@dataclass
class ClimateStationAccumulator:
    station_id: str
    name: str
    department_code: str
    latitude: float
    longitude: float
    altitude_m: int | None
    months: dict[date, dict[str, object]] = field(default_factory=dict)


def parse_climate_file(
    path: Path,
    department: str,
    stations: dict[str, ClimateStationAccumulator],
    *,
    first_month: date = FIRST_MONTH,
) -> None:
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            _add_row(row, department, stations, first_month)


def _add_row(
    row: dict[str, str],
    department: str,
    stations: dict[str, ClimateStationAccumulator],
    first_month: date,
) -> None:
    station_id = (row.get("NUM_POSTE") or "").strip()
    month = _month(row.get("AAAAMM"))
    latitude = _float(row.get("LAT"))
    longitude = _float(row.get("LON"))
    if not _STATION.match(station_id) or month is None or month < first_month:
        return
    if latitude is None or longitude is None:
        return
    days = calendar.monthrange(month.year, month.month)[1]
    values = {
        "precipitation_mm": _measure(row, "RR", "NBRR", days),
        "mean_temperature_c": _measure(row, "TM", "NBTM", days),
        "mean_min_temperature_c": _measure(row, "TN", "NBTN", days),
        "mean_max_temperature_c": _measure(row, "TX", "NBTX", days),
        "sunshine_minutes": _integer(_measure(row, "INST", "NBINST", days)),
    }
    if all(value is None for value in values.values()):
        return
    values["rain_days"] = _count(row.get("NBJRR1"), days) if values["precipitation_mm"] is not None else None
    values["frost_days"] = _count(row.get("NBJGELEE"), days) if values["mean_min_temperature_c"] is not None else None
    values["hot_days"] = _count(row.get("NBJTX30"), days) if values["mean_max_temperature_c"] is not None else None
    station = stations.get(station_id)
    if station is None:
        station = ClimateStationAccumulator(
            station_id=station_id,
            name=" ".join((row.get("NOM_USUEL") or station_id).split()),
            department_code=department,
            latitude=latitude,
            longitude=longitude,
            altitude_m=_integer(_decimal(row.get("ALTI"))),
        )
        stations[station_id] = station
    station.months[month] = values


def active_stations(
    stations: dict[str, ClimateStationAccumulator], *, active_since: date
) -> list[ClimateStationAccumulator]:
    """Stations still reporting since ``active_since`` (closed stations are dropped)."""
    return [
        station
        for station in sorted(stations.values(), key=lambda item: item.station_id)
        if station.months and max(station.months) >= active_since
    ]


def station_rows(stations: Iterable[ClimateStationAccumulator]) -> Iterator[dict[str, object]]:
    for station in stations:
        months = station.months.values()
        yield {
            "station_id": station.station_id,
            "name": station.name,
            "department_code": station.department_code,
            "latitude": station.latitude,
            "longitude": station.longitude,
            "altitude_m": station.altitude_m,
            "first_month": min(station.months),
            "last_month": max(station.months),
            "has_temperature": any(month.get("mean_temperature_c") is not None for month in months),
            "has_precipitation": any(month.get("precipitation_mm") is not None for month in months),
            "has_sunshine": any(month.get("sunshine_minutes") is not None for month in months),
            "source_url": CLIMATE_SOURCE_URL,
        }


def month_rows(stations: Iterable[ClimateStationAccumulator]) -> Iterator[dict[str, object]]:
    for station in stations:
        for month, values in sorted(station.months.items()):
            yield {"station_id": station.station_id, "month": month, **values}


def _measure(row: dict[str, str], column: str, count_column: str, days: int) -> Decimal | None:
    value = _decimal(row.get(column))
    if value is None or (row.get(f"Q{column}") or "").strip() in REJECTED_QUALITY_CODES:
        return None
    observed_days = _decimal(row.get(count_column))
    if observed_days is not None and observed_days < Decimal(days) * Decimal(str(MIN_DAY_COVERAGE)):
        return None
    return value


def _count(value: str | None, days: int) -> int | None:
    number = _integer(_decimal(value))
    return number if number is not None and 0 <= number <= days else None


def _month(value: str | None) -> date | None:
    text = (value or "").strip()
    if not re.fullmatch(r"\d{6}", text):
        return None
    year, month = int(text[:4]), int(text[4:])
    return date(year, month, 1) if 1 <= month <= 12 else None


def _decimal(value: str | None) -> Decimal | None:
    text = (value or "").strip().replace(",", ".")
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def _float(value: str | None) -> float | None:
    number = _decimal(value)
    return float(number) if number is not None else None


def _integer(value: Decimal | None) -> int | None:
    return int(value) if value is not None else None
