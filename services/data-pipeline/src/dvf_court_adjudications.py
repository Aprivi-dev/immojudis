"""Adjudications publiées dans DVF, rattachées à leur tribunal judiciaire.

DVF (DGFiP, licence ouverte) enregistre chaque vente aux enchères publiques comme
une mutation de nature « Adjudication », avec son prix final, sa commune et ses
locaux, mais sans la mise à prix. Le module lit les fichiers « DVF géolocalisées »
par département, garde une ligne par mutation et la rattache au tribunal
compétent pour la commune (référentiel Justice, ``court_competence``).

La table ``public.dvf_court_adjudications`` alimente les volumes et les prix
finaux officiels des scénarios d'enchères (migration 20261019100000).
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import logging
import re
import sys
import urllib.request
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from src.dvf_download import validate_dvf_resource_url

LOGGER = logging.getLogger(__name__)

GEO_DVF_BASE_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv"
ADJUDICATION_NATURE = "Adjudication"
DOWNLOAD_TIMEOUT_SECONDS = 180
# A judicial sale of a whole building can carry dozens of lots; beyond that the
# mutation is a portfolio transfer whose price says nothing about one property.
MAX_LOCALS_PER_MUTATION = 40
MAIN_LOCAL_TYPES = {"1": "house", "2": "apartment", "4": "commercial"}
DEPENDENCY_LOCAL_TYPE = "3"
# Paris, Lyon and Marseille: DVF gives the arrondissement, the Justice registry
# may only list the city.
_CITY_OF_ARRONDISSEMENT = (
    (re.compile(r"^751(?:0[1-9]|1\d|20)$"), "75056"),
    (re.compile(r"^6938[1-9]$"), "69123"),
    (re.compile(r"^132(?:0[1-9]|1[0-6])$"), "13055"),
)
_DEPARTMENT_FILE_RE = re.compile(r'href="(?:[^"]*/)?((?:\d{2,3}|2[AB]))\.csv\.gz"')


@dataclass
class MutationAccumulator:
    mutation_id: str
    mutation_date: date
    price_eur: Decimal | None
    insee_code: str
    department: str
    locals: dict[tuple[str, str, str, str], Decimal | None] = field(default_factory=dict)
    land: dict[tuple[str, str], Decimal] = field(default_factory=dict)


@dataclass(frozen=True)
class DvfAdjudication:
    mutation_id: str
    mutation_date: date
    insee_code: str
    department: str
    property_type: str
    built_surface_m2: Decimal | None
    land_surface_m2: Decimal | None
    local_count: int
    price_eur: Decimal

    def row(self, court_code: str | None, source_year: int) -> tuple[object, ...]:
        return (
            self.mutation_id,
            self.mutation_date,
            self.insee_code,
            self.department,
            court_code,
            self.property_type,
            self.built_surface_m2,
            self.land_surface_m2,
            self.local_count,
            self.price_eur,
            source_year,
        )


def _decimal(value: object) -> Decimal | None:
    text = str(value or "").strip().replace(",", ".")
    if not text:
        return None
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    return number if number > 0 else None


def _date(value: object) -> date | None:
    try:
        return date.fromisoformat(str(value or "").strip())
    except ValueError:
        return None


def iter_adjudications(rows: Iterable[Mapping[str, str]]) -> Iterator[DvfAdjudication]:
    """One adjudication per DVF mutation; rows repeat per parcel, local and culture."""
    pending: dict[str, MutationAccumulator] = {}
    for row in rows:
        if (row.get("nature_mutation") or "").strip() != ADJUDICATION_NATURE:
            continue
        mutation_id = (row.get("id_mutation") or "").strip()
        mutation_date = _date(row.get("date_mutation"))
        insee_code = (row.get("code_commune") or "").strip().upper()
        if not mutation_id or mutation_date is None or not insee_code:
            continue
        accumulator = pending.get(mutation_id)
        if accumulator is None:
            accumulator = MutationAccumulator(
                mutation_id=mutation_id,
                mutation_date=mutation_date,
                price_eur=_decimal(row.get("valeur_fonciere")),
                insee_code=insee_code,
                department=(row.get("code_departement") or insee_code[:2]).strip().upper(),
            )
            pending[mutation_id] = accumulator
        parcel = (row.get("id_parcelle") or "").strip()
        local_type = (row.get("code_type_local") or "").strip()
        if local_type:
            surface = _decimal(row.get("surface_reelle_bati"))
            # A local reappears once per culture of its parcel: same parcel, lot, type and surface.
            local_key = (parcel, (row.get("lot1_numero") or "").strip(), local_type, str(surface or ""))
            accumulator.locals.setdefault(local_key, surface)
        land = _decimal(row.get("surface_terrain"))
        if land is not None:
            accumulator.land.setdefault((parcel, (row.get("code_nature_culture") or "").strip()), land)
    for accumulator in pending.values():
        adjudication = _finalise(accumulator)
        if adjudication is not None:
            yield adjudication


def _finalise(accumulator: MutationAccumulator) -> DvfAdjudication | None:
    if accumulator.price_eur is None or len(accumulator.locals) > MAX_LOCALS_PER_MUTATION:
        return None
    main = [(key, surface) for key, surface in accumulator.locals.items() if key[2] in MAIN_LOCAL_TYPES]
    kinds = {MAIN_LOCAL_TYPES[key[2]] for key, _ in main}
    land = sum(accumulator.land.values(), Decimal(0)) or None
    if len(kinds) == 1:
        property_type = next(iter(kinds))
    elif kinds:
        property_type = "mixed"
    elif any(key[2] == DEPENDENCY_LOCAL_TYPE for key in accumulator.locals):
        property_type = "parking"
    elif land is not None:
        property_type = "land"
    else:
        property_type = "other"
    surfaces = [surface for _, surface in main if surface is not None]
    built = sum(surfaces, Decimal(0)) if surfaces and len(surfaces) == len(main) else None
    return DvfAdjudication(
        mutation_id=accumulator.mutation_id,
        mutation_date=accumulator.mutation_date,
        insee_code=accumulator.insee_code,
        department=accumulator.department,
        property_type=property_type,
        built_surface_m2=built,
        land_surface_m2=land,
        local_count=len(main),
        price_eur=accumulator.price_eur,
    )


def court_code_for(insee_code: str, resolve: Callable[[str], Any]) -> str | None:
    assignment = resolve(insee_code)
    if assignment is None:
        for pattern, city in _CITY_OF_ARRONDISSEMENT:
            if pattern.fullmatch(insee_code):
                assignment = resolve(city)
                break
    return getattr(assignment, "court_code", None) if assignment is not None else None


def department_files(year: int, html: str) -> list[str]:
    del year
    return sorted(set(_DEPARTMENT_FILE_RE.findall(html)))


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(validate_dvf_resource_url(url), headers={"User-Agent": "immojudis-dvf/1"})
    with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:  # noqa: S310 - allow-listed https
        return response.read()


def read_department(year: int, department: str, fetch: Callable[[str], bytes] = _fetch) -> list[DvfAdjudication]:
    payload = fetch(f"{GEO_DVF_BASE_URL}/{year}/departements/{department}.csv.gz")
    with gzip.open(io.BytesIO(payload), mode="rt", encoding="utf-8", newline="") as handle:
        return list(iter_adjudications(csv.DictReader(handle)))


UPSERT_SQL = """
insert into public.dvf_court_adjudications (
  mutation_id, mutation_date, insee_code, department, court_code, property_type,
  built_surface_m2, land_surface_m2, local_count, price_eur, source_year
) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
on conflict (mutation_id) do update set
  mutation_date = excluded.mutation_date,
  insee_code = excluded.insee_code,
  department = excluded.department,
  court_code = excluded.court_code,
  property_type = excluded.property_type,
  built_surface_m2 = excluded.built_surface_m2,
  land_surface_m2 = excluded.land_surface_m2,
  local_count = excluded.local_count,
  price_eur = excluded.price_eur,
  source_year = excluded.source_year,
  imported_at = statement_timestamp()
"""


def import_years(
    db_url: str,
    years: Iterable[int],
    *,
    resolve: Callable[[str], Any],
    fetch: Callable[[str], bytes] = _fetch,
    departments: Iterable[str] | None = None,
) -> dict[str, int]:
    from src.storage.supabase_client import connect

    counts = {"departments": 0, "adjudications": 0, "with_court": 0, "failed_departments": 0}
    with connect(db_url) as connection:
        for year in years:
            listing = (
                list(departments)
                if departments
                else department_files(
                    year, fetch(f"{GEO_DVF_BASE_URL}/{year}/departements/").decode("utf-8", "replace")
                )
            )
            for department in listing:
                try:
                    adjudications = read_department(year, department, fetch)
                except Exception as exc:  # one missing file must not lose the others
                    LOGGER.warning("DVF %s/%s unreadable: %s", year, department, exc)
                    counts["failed_departments"] += 1
                    continue
                rows = []
                for adjudication in adjudications:
                    court_code = court_code_for(adjudication.insee_code, resolve)
                    counts["with_court"] += court_code is not None
                    rows.append(adjudication.row(court_code, year))
                if rows:
                    with connection.cursor() as cursor:
                        cursor.executemany(UPSERT_SQL, rows)
                    connection.commit()
                counts["departments"] += 1
                counts["adjudications"] += len(rows)
    return counts


def default_years(today: date | None = None) -> list[int]:
    """The three last full years and the current one, as far as DVF publishes them."""
    current = (today or date.today()).year
    return [current - 4, current - 3, current - 2, current - 1]


def main(argv: list[str] | None = None) -> int:
    from src.config import load_settings
    from src.court_competence import _configured_reference

    parser = argparse.ArgumentParser(description="Adjudications DVF rattachées au tribunal compétent")
    parser.add_argument("--years", type=str, default="", help="ex. 2023,2024,2025")
    parser.add_argument("--departments", type=str, default="", help="ex. 33,93 (tous par défaut)")
    args = parser.parse_args(argv)
    years = [int(value) for value in args.years.split(",") if value.strip()] or default_years()
    reference = _configured_reference()
    if reference is None:
        raise RuntimeError("Le référentiel Justice des tribunaux compétents est introuvable")
    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is required for the DVF adjudication import")
    departments = [value.strip() for value in args.departments.split(",") if value.strip()] or None
    counts = import_years(db_url, years, resolve=reference.resolve, departments=departments)
    print(json.dumps({"years": years, **counts}, ensure_ascii=False))
    return 0 if counts["departments"] else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
