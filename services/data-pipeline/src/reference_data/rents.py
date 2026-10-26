"""Rent map 2025 of the ANIL (Licence Ouverte 2.0), one row per commune and segment.

The dataset ``693aa2feed1bf4da603faa49`` on data.gouv.fr publishes four CSV files, one
per segment: all apartments (``apt_all``), 1-2 room apartments (``apt_1_2``), 3 rooms or
more (``apt_3p``) and houses (``house``). Each file holds one line per commune (per
arrondissement in Paris, Lyon and Marseille; Mayotte excluded) with an advertised rent in
euros per square metre per month, charges included, unfurnished, and the 95 % prediction
interval.

Mandatory credit: « Estimations ANIL, à partir des données du Groupe SeLoger et de
leboncoin ».

This module only parses: it never opens a connection. The resources are found by their
title in the data.gouv.fr API (identifiers change with every republication), and the
files are not UTF-8 (Latin-1 / Windows-1252 as observed on 26/10/2026).
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from src.reference_data.gaspar import repair_mojibake
from src.reference_data.names import department_from_insee

ANIL_DATASET_ID = "693aa2feed1bf4da603faa49"
ANIL_DATASET_API_URL = f"https://www.data.gouv.fr/api/1/datasets/{ANIL_DATASET_ID}/"
ANIL_ATTRIBUTION = "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin"

SEGMENTS = ("apt_all", "apt_1_2", "apt_3p", "house")
# Plausible advertised rents in euros per square metre per month. The published values go from
# about 5 to 30; anything outside this range is a broken line, not a market.
MIN_RENT_PER_M2 = 1.0
MAX_RENT_PER_M2 = 100.0

_INSEE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")
_DEPARTMENT = re.compile(r"^([0-9]{2}|2A|2B|97[1-8])$")
_EPCI = re.compile(r"^[0-9]{9}$")
_VINTAGE = re.compile(r"\b(20[0-9]{2})\b")
# Observed values: commune, maille, EPCI (upper case). The spec also mentions "maile".
_PREDICTION_TYPES = {"commune": "commune", "maille": "maille", "maile": "maille", "epci": "epci"}
_EXPECTED_COLUMNS = (
    "id_zone",
    "INSEE_C",
    "LIBGEO",
    "EPCI",
    "loypredm2",
    "lwr.IPm2",
    "upr.IPm2",
    "TYPPRED",
    "nbobs_com",
    "nbobs_mail",
    "R2_adj",
)


@dataclass(frozen=True)
class RentResource:
    segment: str
    title: str
    url: str
    # Publication date of the file on data.gouv.fr (« mise à jour du 11 décembre 2025 »).
    updated_on: date | None = None


@dataclass
class RentParseStats:
    lines: int = 0
    rejected: int = 0
    duplicates: int = 0


_SEGMENT_BY_FILE = {
    "pred-app-mef-dhup.csv": "apt_all",
    "pred-app12-mef-dhup.csv": "apt_1_2",
    "pred-app3-mef-dhup.csv": "apt_3p",
    "pred-mai-mef-dhup.csv": "house",
}


def classify_segment(title: str, url: str = "") -> str | None:
    """Segment of a CSV resource: by file name first (stable), then by title."""
    by_file = _SEGMENT_BY_FILE.get(Path(url.split("?", 1)[0]).name.casefold())
    if by_file is not None:
        return by_file
    text = " ".join(title.casefold().split())
    if "maison" in text:
        return "house"
    if "appartement" in text:
        if re.search(r"\b1 ou 2 pi", text):
            return "apt_1_2"
        if re.search(r"\b3 pi\w* ou plus", text):
            return "apt_3p"
        return "apt_all"
    return None


def select_resources(dataset: Mapping[str, Any]) -> dict[str, RentResource]:
    """The four CSV resources of the dataset, by segment; refuses a dataset that lacks one."""
    found: dict[str, tuple[str, RentResource]] = {}
    for resource in dataset.get("resources") or []:
        if not isinstance(resource, Mapping):
            continue
        title = str(resource.get("title") or "")
        url = str(resource.get("url") or "")
        if str(resource.get("format") or "").casefold() != "csv" or not url:
            continue
        segment = classify_segment(title, url)
        if segment is None:
            continue
        modified = str(resource.get("last_modified") or "")
        # Two resources for one segment: the most recently modified one wins.
        if segment not in found or modified > found[segment][0]:
            found[segment] = (modified, RentResource(segment, title, url, _publication_date(modified)))
    missing = [segment for segment in SEGMENTS if segment not in found]
    if missing:
        raise RuntimeError(f"ANIL dataset has no CSV resource for: {', '.join(missing)}")
    return {segment: found[segment][1] for segment in SEGMENTS}


def _publication_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def dataset_vintage(dataset: Mapping[str, Any]) -> int:
    """Vintage of the map (« … par commune en 2025 »), read from the dataset title."""
    match = _VINTAGE.search(str(dataset.get("title") or ""))
    if match is None:
        raise RuntimeError("Cannot read the vintage of the ANIL rent map from its dataset title")
    return int(match.group(1))


def decode_csv(raw: bytes) -> str:
    """UTF-8 when the file is valid UTF-8, else Windows-1252, else Latin-1."""
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def parse_rent_file(
    path: Path, segment: str, source_url: str, vintage: int, updated_on: date | None = None
) -> tuple[list[dict[str, object]], RentParseStats]:
    return parse_rent_csv(decode_csv(path.read_bytes()), segment, source_url, vintage, updated_on)


def parse_rent_csv(
    text: str, segment: str, source_url: str, vintage: int, updated_on: date | None = None
) -> tuple[list[dict[str, object]], RentParseStats]:
    if segment not in SEGMENTS:
        raise ValueError(f"Unknown rent segment {segment!r}")
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=";")
    header = [str(name).strip() for name in reader.fieldnames or []]
    missing = [column for column in _EXPECTED_COLUMNS if column not in header]
    if missing:
        raise RuntimeError(f"ANIL {segment} file lacks the columns: {', '.join(missing)}")
    stats = RentParseStats()
    rows: dict[str, dict[str, object]] = {}
    for raw_row in reader:
        stats.lines += 1
        row = {str(key).strip(): (value or "").strip() for key, value in raw_row.items() if key}
        parsed = _parse_row(row, segment, source_url, vintage, updated_on)
        if parsed is None:
            stats.rejected += 1
        elif parsed["commune_code"] in rows:
            stats.duplicates += 1
        else:
            rows[str(parsed["commune_code"])] = parsed
    return list(rows.values()), stats


def _parse_row(
    row: dict[str, str], segment: str, source_url: str, vintage: int, updated_on: date | None
) -> dict[str, object] | None:
    code = row["INSEE_C"]
    # The department comes from the commune code, not from the DEP column (arrondissements included).
    department = department_from_insee(code) if _INSEE.match(code) else ""
    prediction_type = _PREDICTION_TYPES.get(row["TYPPRED"].casefold())
    rent = _number(row["loypredm2"])
    low = _number(row["lwr.IPm2"])
    high = _number(row["upr.IPm2"])
    name = " ".join(repair_mojibake(row["LIBGEO"]).split())
    if not _INSEE.match(code) or not _DEPARTMENT.match(department) or not name:
        return None
    if prediction_type is None or rent is None or not MIN_RENT_PER_M2 <= rent <= MAX_RENT_PER_M2:
        return None
    for bound in (low, high):
        if bound is not None and not MIN_RENT_PER_M2 / 2 <= bound <= MAX_RENT_PER_M2:
            return None
    if low is not None and high is not None and low > high:
        return None
    epci = row["EPCI"]
    return {
        "commune_code": code,
        "segment": segment,
        "commune_name": name,
        "department_code": department,
        "epci_code": epci if _EPCI.match(epci) else None,
        "zone_id": _integer(row["id_zone"]),
        "rent_per_m2": round(rent, 4),
        "rent_low_per_m2": None if low is None else round(low, 4),
        "rent_high_per_m2": None if high is None else round(high, 4),
        "prediction_type": prediction_type,
        "observations_commune": _integer(row["nbobs_com"]),
        "observations_mesh": _integer(row["nbobs_mail"]),
        "r2_adj": _ratio(row["R2_adj"]),
        "vintage": vintage,
        "source_updated_on": updated_on,
        "source_url": source_url,
    }


def _number(value: str) -> float | None:
    """French decimal (comma); ``None`` for an empty or non-numeric cell."""
    text = value.strip().replace(",", ".")
    if not text or text.upper() == "NA":
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number == number and abs(number) != float("inf") else None


def _integer(value: str) -> int | None:
    number = _number(value)
    if number is None or number < 0 or number != int(number):
        return None
    return int(number)


def _ratio(value: str) -> float | None:
    number = _number(value)
    return None if number is None or not -1 <= number <= 1 else round(number, 6)


def arrondissement_count(rows: list[dict[str, object]]) -> int:
    """Lines for the arrondissements of Paris (751xx), Lyon (6938x) and Marseille (132xx)."""
    return sum(
        1
        for row in rows
        if re.match(r"^(751(0[1-9]|1[0-9]|20)|6938[1-9]|132(0[1-9]|1[0-6]))$", str(row["commune_code"]))
    )
