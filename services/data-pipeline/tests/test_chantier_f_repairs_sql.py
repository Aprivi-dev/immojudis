"""Réparations du chantier F (supabase/repairs/) : comptage par défaut, application sur demande.

Chaque fichier est exécuté avec psql contre une base jetable (PIPELINE_TEST_DB_URL) : le mode par
défaut n'écrit rien, le mode ``-v apply=1`` répare, et une seconde application ne trouve plus rien.
"""

import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

REPAIRS = Path(__file__).resolve().parents[3] / "supabase" / "repairs"
LOCATION = REPAIRS / "20261020130001_repair_sale_department_and_coordinates.sql"
PHANTOM = REPAIRS / "20261020130002_clear_info_encheres_phantom_point.sql"
LICITOR = REPAIRS / "20261020130003_quarantine_licitor_multi_lot_annonces.sql"

SCHEMA = """
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create schema app_private;
create table public.auction_sales (
  id uuid not null default gen_random_uuid(),
  source_url text primary key,
  source_name text,
  status text,
  city text,
  postal_code text,
  department text,
  latitude numeric,
  longitude numeric,
  starting_price_eur numeric,
  quality_flags jsonb default '[]'::jsonb,
  raw_payload jsonb default '{}'::jsonb
);
create table public.auction_cadastre_parcels (
  id uuid primary key default gen_random_uuid(),
  source_url text,
  match_kind text
);
"""


def _geocode(citycode, latitude, longitude, type_="municipality", accepted=True):
    return {
        "geocode": {
            "provider": "ban_geoplateforme",
            "accepted": accepted,
            "type": type_,
            "citycode": citycode,
            "latitude": latitude,
            "longitude": longitude,
        }
    }


@pytest.fixture
def repair_database():
    base = os.getenv("PIPELINE_TEST_DB_URL")
    if not base:
        pytest.skip("Requires disposable PostgreSQL")
    if not shutil.which("psql"):
        pytest.skip("Requires the psql client")
    import psycopg

    name = f"repairs_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f"create database \"{name}\" template template0 encoding 'UTF8'")
    url = re.sub(r"/[^/?]+(\?|$)", rf"/{name}\1", base, count=1)
    try:
        with psycopg.connect(url, autocommit=True) as setup:
            setup.execute(SCHEMA)
        yield url
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')


def _psql(url: str, path: Path, *, apply: bool = False) -> str:
    command = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    if apply:
        command += ["-v", "apply=1"]
    result = subprocess.run([*command, "-f", str(path), url], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout + result.stderr


def _insert_sale(db, source_url, **values):
    from psycopg.types.json import Jsonb

    row = {"source_name": "petites_affiches", "status": "upcoming", "quality_flags": [], "raw_payload": {}, **values}
    row["quality_flags"] = Jsonb(row["quality_flags"])
    row["raw_payload"] = Jsonb(row["raw_payload"])
    columns = ", ".join(["source_url", *row])
    placeholders = ", ".join(["%s"] * (len(row) + 1))
    db.execute(f"insert into public.auction_sales({columns}) values ({placeholders})", (source_url, *row.values()))


def _snapshot(db) -> list[tuple]:
    sales = db.execute("select * from public.auction_sales order by source_url").fetchall()
    parcels = db.execute("select source_url, match_kind from public.auction_cadastre_parcels order by 1, 2").fetchall()
    backups = db.execute(
        "select table_name from information_schema.tables where table_schema = 'app_private' order by 1"
    ).fetchall()
    return [*sales, *parcels, *backups]


def _sale(db, source_url) -> dict:
    cursor = db.execute("select * from public.auction_sales where source_url = %s", (source_url,))
    columns = [column.name for column in cursor.description]
    return dict(zip(columns, cursor.fetchone(), strict=True))


# --- point 11 : département et coordonnées --------------------------------------------------------


def _seed_location(db) -> None:
    _insert_sale(  # code postal + point accepté : département et coordonnées, drapeau périmé retiré
        db, "a", city="Bordeaux", postal_code="33000", quality_flags=["missing_gps"],
        raw_payload=_geocode("33063", 44.84, -0.58),
    )
    _insert_sale(db, "b", city="Marseille", raw_payload=_geocode("13055", 43.29, 5.37))  # INSEE seul
    _insert_sale(  # le tribunal n'est jamais une source de département
        db, "c", city="Dax", raw_payload={"tribunal_label_assignment": {"court_code": "dax", "court_department": "40"}},
    )
    _insert_sale(  # département 75 mais point accepté pour Lyon : pas de recopie
        db, "d", city="Paris", postal_code="75001", department="75", raw_payload=_geocode("69123", 45.76, 4.83),
    )
    _insert_sale(db, "e", city="X", raw_payload=_geocode("33063", "n/a", -0.58))  # valeur non numérique
    _insert_sale(  # vente terminée : hors périmètre
        db, "f", status="sold", city="Bordeaux", postal_code="33000", raw_payload=_geocode("33063", 44.84, -0.58),
    )
    _insert_sale(  # drapeau périmé sur une vente active qui a déjà ses coordonnées
        db, "g", city="Pau", postal_code="64000", department="64", latitude=43.3, longitude=-0.37,
        quality_flags=["missing_gps"],
    )
    _insert_sale(  # même drapeau sur une vente terminée : intact
        db, "h", status="sold", city="Pau", postal_code="64000", department="64", latitude=43.3, longitude=-0.37,
        quality_flags=["missing_gps"],
    )
    _insert_sale(  # 33 mais point hors du rectangle de la Gironde
        db, "i", city="Bordeaux", postal_code="33000", raw_payload=_geocode("33063", 48.85, 2.35),
    )


def test_location_repair_counts_by_default_and_repairs_on_demand(repair_database) -> None:
    import psycopg

    with psycopg.connect(repair_database, autocommit=True) as db:
        _seed_location(db)
        before = _snapshot(db)

        output = _psql(repair_database, LOCATION)
        assert "MODE COMPTAGE SEULEMENT" in output
        assert _snapshot(db) == before

        _psql(repair_database, LOCATION, apply=True)

        a = _sale(db, "a")
        assert (a["department"], float(a["latitude"]), float(a["longitude"])) == ("33", 44.84, -0.58)
        assert a["raw_payload"]["department_inference"] == {"source": "postal_code", "value": "33"}
        assert a["raw_payload"]["geo_precision"] == "municipality"
        assert "missing_gps" not in a["quality_flags"]

        b = _sale(db, "b")
        assert (b["department"], float(b["latitude"])) == ("13", 43.29)
        assert b["raw_payload"]["department_inference"]["source"] == "geocode_citycode"

        c = _sale(db, "c")
        assert c["department"] is None and "department_inference" not in c["raw_payload"]
        assert "department_from_tribunal" not in c["quality_flags"]

        d = _sale(db, "d")
        assert d["department"] == "75" and d["latitude"] is None

        e = _sale(db, "e")
        assert e["latitude"] is None

        assert _sale(db, "f")["department"] is None and _sale(db, "f")["latitude"] is None
        assert _sale(db, "g")["quality_flags"] == []
        assert _sale(db, "h")["quality_flags"] == ["missing_gps"]
        i = _sale(db, "i")
        assert i["department"] == "33" and i["latitude"] is None

        backed_up = db.execute("select count(*) from app_private.location_repair_backup_20261020").fetchone()[0]
        assert backed_up >= 3

        after_first = _snapshot(db)
        _psql(repair_database, LOCATION, apply=True)
        assert _snapshot(db) == after_first


# --- point 15 : point fantôme ----------------------------------------------------------------------


def _seed_phantom(db) -> None:
    point = {"latitude": 44.40655, "longitude": 6.061187}
    _insert_sale(db, "p1", source_name="info_encheres", **point, raw_payload={**point, **_geocode("04070", 44.40655, 6.061187)})
    _insert_sale(  # preuve de géocodage non numérique : ignorée, ligne tout de même nettoyée
        db, "p2", source_name="info_encheres", status="quarantined", **point,
        raw_payload={**point, **_geocode("04070", "abc", 6.061187)},
    )
    _insert_sale(db, "p3", source_name="info_encheres", latitude=44.84, longitude=-0.58, raw_payload={})  # ailleurs
    _insert_sale(db, "p4", source_name="vench", **point)  # autre source au même point
    db.execute(
        "insert into public.auction_cadastre_parcels(source_url, match_kind) values "
        "('p1', 'point_intersection'), ('p1', 'address'), ('p3', 'point_intersection')"
    )


def test_phantom_point_repair_counts_by_default_and_ignores_non_numeric_geocode_values(repair_database) -> None:
    import psycopg

    with psycopg.connect(repair_database, autocommit=True) as db:
        _seed_phantom(db)
        before = _snapshot(db)

        output = _psql(repair_database, PHANTOM)
        assert "MODE COMPTAGE SEULEMENT" in output
        assert _snapshot(db) == before

        _psql(repair_database, PHANTOM, apply=True)

        p1 = _sale(db, "p1")
        assert p1["latitude"] is None and p1["longitude"] is None
        assert "missing_gps" in p1["quality_flags"]
        assert "geocode" not in p1["raw_payload"] and "latitude" not in p1["raw_payload"]
        p2 = _sale(db, "p2")
        assert p2["latitude"] is None and "geocode" in p2["raw_payload"]
        assert float(_sale(db, "p3")["latitude"]) == 44.84
        assert float(_sale(db, "p4")["latitude"]) == 44.40655
        parcels = db.execute("select source_url, match_kind from public.auction_cadastre_parcels order by 1, 2").fetchall()
        assert parcels == [("p1", "address"), ("p3", "point_intersection")]
        assert db.execute("select count(*) from app_private.info_encheres_phantom_parcels_backup_20261020").fetchone()[0] == 1

        after_first = _snapshot(db)
        _psql(repair_database, PHANTOM, apply=True)
        assert _snapshot(db) == after_first


# --- point 16 : Licitor multi-lots ------------------------------------------------------------------


def test_licitor_quarantine_counts_by_default_and_applies_on_demand(repair_database) -> None:
    import psycopg

    with psycopg.connect(repair_database, autocommit=True) as db:
        listed = "https://www.licitor.com/annonce/10/90/00/x/109863.html"
        _insert_sale(db, listed, source_name="licitor", status="upcoming")
        _insert_sale(db, "https://www.licitor.com/annonce/10/90/00/x/999999.html", source_name="licitor")
        _insert_sale(db, "https://www.vench.fr/x/109863.html", source_name="vench")
        before = _snapshot(db)

        output = _psql(repair_database, LICITOR)
        assert "MODE COMPTAGE SEULEMENT" in output
        assert _snapshot(db) == before

        _psql(repair_database, LICITOR, apply=True)

        row = _sale(db, listed)
        assert row["status"] == "quarantined"
        assert "property_identity_conflict" in row["quality_flags"]
        assert row["raw_payload"]["publication_identity_conflict"]["reason"] == "licitor_multi_lot_first_lot_values"
        statuses = db.execute("select status from public.auction_sales where source_url <> %s", (listed,)).fetchall()
        assert statuses == [("upcoming",), ("upcoming",)]

        after_first = _snapshot(db)
        _psql(repair_database, LICITOR, apply=True)
        assert _snapshot(db) == after_first


def test_repair_files_do_not_live_in_the_migrations_folder() -> None:
    migrations = REPAIRS.parent / "migrations"
    assert not list(migrations.glob("20261020130*"))
    assert len(list(REPAIRS.glob("*.sql"))) == 3
