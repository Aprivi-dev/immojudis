"""Commune list from geo.api.gouv.fr (Licence Ouverte)."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import quote

from src.reference_data.download import fetch_json
from src.reference_data.names import normalize_commune_name

GEO_API_BASE = "https://geo.api.gouv.fr"
COMMUNES_SOURCE_URL = "https://geo.api.gouv.fr/decoupage-administratif/communes"
COMMUNE_FIELDS = "code,nom,codesPostaux,codeDepartement,centre"
_INSEE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")
_DEPARTMENT = re.compile(r"^([0-9]{2}|2A|2B|97[1-8])$")
_POSTAL_CODE = re.compile(r"^[0-9]{5}$")


def fetch_communes(fetch: Callable[[str], Any] = fetch_json) -> list[dict[str, object]]:
    """Every commune, one department at a time (a single call is ~6 MB)."""
    departments = fetch(f"{GEO_API_BASE}/departements?fields=code")
    rows: list[dict[str, object]] = []
    for department in departments:
        code = str(department.get("code") or "")
        if not _DEPARTMENT.match(code):
            continue
        payload = fetch(f"{GEO_API_BASE}/departements/{quote(code)}/communes?fields={COMMUNE_FIELDS}&format=json")
        rows.extend(normalize_communes(payload))
    return rows


def normalize_communes(payload: Iterable[dict[str, Any]]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for commune in payload:
        code = str(commune.get("code") or "").strip()
        name = " ".join(str(commune.get("nom") or "").split())
        department = str(commune.get("codeDepartement") or "").strip()
        if not _INSEE.match(code) or not name or not _DEPARTMENT.match(department):
            continue
        postal_codes = sorted(
            {str(value) for value in commune.get("codesPostaux") or [] if _POSTAL_CODE.match(str(value))}
        )
        latitude, longitude = _centre(commune.get("centre"))
        rows.append(
            {
                "code_insee": code,
                "name": name,
                "name_normalized": normalize_commune_name(name),
                "department_code": department,
                "postal_codes": postal_codes,
                "latitude": latitude,
                "longitude": longitude,
                "source_url": COMMUNES_SOURCE_URL,
            }
        )
    return rows


def _centre(value: Any) -> tuple[float | None, float | None]:
    if not isinstance(value, dict) or value.get("type") != "Point":
        return None, None
    coordinates = value.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) != 2:
        return None, None
    longitude, latitude = coordinates
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        return None, None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None, None
    return float(latitude), float(longitude)
