"""Rental-tension zoning (« zonage TLV ») by commune (Licence Ouverte 2.0).

Dataset « Liste des communes selon le zonage TLV » on data.gouv.fr: one CSV line per
commune with the 2013 zoning, the 2023 zoning and the zoning after the decree
n° 2025-1267 of 22 December 2025. Paris, Lyon and Marseille appear once (75056, 69123,
13055), never per arrondissement.

Observed on 26/10/2026: UTF-8, ``;`` separator, and the two EPCI columns are swapped
(« Code EPCI » holds the name, « Libellé EPCI » the 9-digit code), so the code is detected
by its shape rather than by the header.

This module only parses: it never opens a connection.
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

from src.reference_data.names import department_from_insee

# Pinned by identifier: a slug can be taken over by another dataset, an identifier cannot.
TENSION_DATASET_ID = "657c88da2947e13be0597058"
TENSION_DATASET_API_URL = f"https://www.data.gouv.fr/api/1/datasets/{TENSION_DATASET_ID}/"

_INSEE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")
_DEPARTMENT = re.compile(r"^([0-9]{2}|2A|2B|97[1-8])$")
_EPCI = re.compile(r"^[0-9]{9}$")
_DECREE = re.compile(r"D[ée]cret\s+n°\s*(\d{4}-\d+)\s+du\s+(\d{1,2}(?:er)?)\s+([^\W\d_]+)\s+(\d{4})", re.IGNORECASE)
_HEADER_DATE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
_ZONING_2013 = {"tlv": "tlv", "non tlv": "non_tlv"}
_ZONING = {
    "zone tendue": "tendue",
    "zone touristique et tendue": "touristique_tendue",
    "non tendue": "non_tendue",
}
_COLUMN_CODE = "CODGEO25"


_MONTHS = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7,
    "août": 8, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}  # fmt: skip


def decree_reference_date(reference: str) -> date | None:
    """Date of a decree reference (« Décret n° 2025-1267 du 22 décembre 2025 »)."""
    match = _DECREE.search(reference)
    if match is None:
        return None
    month = _MONTHS.get(match.group(3).casefold())
    day = re.match(r"\d+", match.group(2))
    if month is None or day is None:
        return None
    try:
        return date(int(match.group(4)), month, int(day.group()))
    except ValueError:
        return None


@dataclass(frozen=True)
class TensionResource:
    title: str
    url: str
    updated_on: date | None
    decree_reference: str
    # Every decree named by the documentation, whatever the API order: the CSV header decides.
    decree_candidates: tuple[str, ...] = ()


@dataclass
class TensionParseStats:
    lines: int = 0
    rejected: int = 0
    duplicates: int = 0
    epci_columns_swapped: int = 0


def select_resource(dataset: Mapping[str, Any]) -> TensionResource:
    """The zoning CSV and the decree it applies, from the dataset description."""
    candidates: list[tuple[str, Mapping[str, Any]]] = []
    decrees: list[str] = []
    for resource in dataset.get("resources") or []:
        if not isinstance(resource, Mapping):
            continue
        title = str(resource.get("title") or "")
        if str(resource.get("format") or "").casefold() == "csv" and resource.get("url"):
            if "zonage" in title.casefold():
                candidates.append((str(resource.get("last_modified") or ""), resource))
            continue
        match = _DECREE.search(title)
        if match:
            reference = f"Décret n° {match.group(1)} du {match.group(2)} {match.group(3).casefold()} {match.group(4)}"
            if reference not in decrees:
                decrees.append(reference)
    if not candidates:
        raise RuntimeError("Zonage TLV dataset has no CSV resource")
    if not decrees:
        # No guess: a zoning stored under the wrong decree would be worse than no import.
        raise RuntimeError("Zonage TLV dataset documentation does not identify the decree")
    modified, resource = max(candidates, key=lambda item: item[0])
    updated_on = None
    try:
        updated_on = date.fromisoformat(modified[:10])
    except ValueError:
        pass
    # The most recent decree by date, not the last one listed; ``choose_decree`` checks it on the CSV.
    latest = max(decrees, key=lambda reference: decree_reference_date(reference) or date.min)
    return TensionResource(
        str(resource.get("title") or ""), str(resource["url"]), updated_on, latest, tuple(decrees)
    )


def choose_decree(resource: TensionResource, header_date: date | None) -> str:
    """The decree whose date is the one in the CSV header; refuses a header no decree matches."""
    candidates = resource.decree_candidates or (resource.decree_reference,)
    if header_date is None:
        return resource.decree_reference
    for reference in candidates:
        if decree_reference_date(reference) == header_date:
            return reference
    raise RuntimeError(
        f"The zoning file is dated {header_date} but the documentation names {', '.join(candidates)}: "
        "no decree matches, so none is recorded."
    )


def file_decree_date(path: Path) -> date | None:
    """Date in the header of the « Zonage TLV post décret … » column of the CSV."""
    header = decode_csv(path.read_bytes()).splitlines()[:1]
    for name in header[0].split(";") if header else []:
        if name.strip().startswith("Zonage TLV post"):
            return _header_date(name)
    return None


def decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def parse_tension_file(
    path: Path, source_url: str, decree_reference: str, updated_on: date | None = None
) -> tuple[list[dict[str, object]], TensionParseStats]:
    return parse_tension_csv(decode_csv(path.read_bytes()), source_url, decree_reference, updated_on)


def parse_tension_csv(
    text: str, source_url: str, decree_reference: str, updated_on: date | None = None
) -> tuple[list[dict[str, object]], TensionParseStats]:
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=";")
    header = [str(name).strip() for name in reader.fieldnames or []]
    decree_column = next((name for name in header if name.startswith("Zonage TLV post")), None)
    column_2013 = next((name for name in header if name.startswith("Zonage TLV 2013")), None)
    column_2023 = next((name for name in header if name.startswith("Zonage TLV 2023")), None)
    epci_columns = [name for name in header if name in ("Code EPCI", "Libellé EPCI")]
    required = (_COLUMN_CODE, "LIBGEO")
    if (
        decree_column is None
        or column_2013 is None
        or column_2023 is None
        or len(epci_columns) != 2
        or any(name not in header for name in required)
    ):
        raise RuntimeError("Zonage TLV file does not have the expected columns")
    decree_date = _header_date(decree_column)
    reference_date = decree_reference_date(decree_reference)
    if decree_date is not None and reference_date is not None and decree_date != reference_date:
        raise RuntimeError(
            f"The zoning file is dated {decree_date} but the decree recorded is {decree_reference!r}: "
            "the decree and the file do not match."
        )
    stats = TensionParseStats()
    rows: dict[str, dict[str, object]] = {}
    for raw_row in reader:
        stats.lines += 1
        row = {str(key).strip(): (value or "").strip() for key, value in raw_row.items() if key}
        epci_code, epci_name, swapped = _epci(row[epci_columns[0]], row[epci_columns[1]])
        code = row[_COLUMN_CODE]
        # The department comes from the commune code, not from the DEP column.
        department = department_from_insee(code) if _INSEE.match(code) else ""
        name = " ".join(row["LIBGEO"].split())
        zoning_2013 = _ZONING_2013.get(row[column_2013].casefold())
        zoning_2023 = _zoning(row[column_2023])
        zoning_decree = _zoning(row[decree_column])
        if (
            not _INSEE.match(code)
            or not _DEPARTMENT.match(department)
            or not name
            or zoning_2013 is None
            or zoning_2023 is None
            or zoning_decree is None
        ):
            stats.rejected += 1
            continue
        if code in rows:
            stats.duplicates += 1
            continue
        stats.epci_columns_swapped += int(swapped)
        rows[code] = {
            "commune_code": code,
            "commune_name": name,
            "department_code": department,
            "epci_code": epci_code,
            "epci_name": epci_name,
            "zoning_2013": zoning_2013,
            "zoning_2023": zoning_2023,
            "zoning_post_decree": zoning_decree,
            "decree_reference": decree_reference,
            "decree_date": decree_date,
            "source_updated_on": updated_on,
            "source_url": source_url,
        }
    return list(rows.values()), stats


def _zoning(value: str) -> str | None:
    # « 1. Zone tendue » -> « zone tendue »
    return _ZONING.get(re.sub(r"^\d+\.\s*", "", value.strip()).casefold())


def _epci(first: str, second: str) -> tuple[str | None, str | None, bool]:
    """(code, name, swapped): the code is the 9-digit value, whichever column holds it."""
    if _EPCI.match(second):
        return second, first or None, first != "" and not _EPCI.match(first)
    if _EPCI.match(first):
        return first, second or None, False
    return None, first or second or None, False


def _header_date(header: str) -> date | None:
    match = _HEADER_DATE.search(header)
    if match is None:
        return None
    try:
        return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
    except ValueError:
        return None
