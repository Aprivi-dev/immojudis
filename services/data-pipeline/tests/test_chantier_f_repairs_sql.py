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
DOUBLED_TRIBUNALS = REPAIRS / "20261025100001_repair_doubled_tribunal_names.sql"
OUTSIDE_DEPARTMENT = REPAIRS / "20261101110100_clear_points_outside_their_department.sql"

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
  tribunal text,
  tribunal_code text,
  quality_flags jsonb default '[]'::jsonb,
  raw_payload jsonb default '{}'::jsonb
);
create table public.auction_cadastre_parcels (
  id uuid primary key default gen_random_uuid(),
  source_url text,
  match_kind text
);
create table public.tribunals (
  code text primary key,
  canonical_name text not null unique,
  aliases jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);
create table public.judicial_sales (
  source_url text primary key,
  tribunal text,
  tribunal_code text
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


# --- W2, point 65 : points hors de leur département -----------------------------------------------------


def _seed_outside_department(db) -> None:
    _insert_sale(  # Avoventes, Grasse : point dans le Yorkshire
        db, "g1", city="Grasse", department="06", latitude=54.27, longitude=-0.40,
        quality_flags=["multi_lot_sale", "missing_gps"],
        raw_payload={"latitude": 54.27, "longitude": -0.40, "geo_precision": "address"},
    )
    _insert_sale(  # preuve de géocodage au même point : retirée avec lui
        db, "g2", city="Bordeaux", department="33", latitude=48.85, longitude=2.35,
        raw_payload={"geocode": {"provider": "ban_geoplateforme", "accepted": True, "latitude": 48.85, "longitude": 2.35}},
    )
    _insert_sale(db, "g3", city="Grasse", department="06", latitude=43.66, longitude=6.92)  # dans son département
    _insert_sale(db, "g4", city="Cayenne", department="973", latitude=4.94, longitude=-52.33)  # outre-mer, dans sa boîte
    _insert_sale(db, "g5", city="Mamoudzou", department="976", latitude=48.85, longitude=2.35)  # outre-mer, hors boîte
    _insert_sale(db, "g6", city="Saint-Martin", department="978", latitude=18.07, longitude=-63.08)  # sans boîte
    _insert_sale(db, "g7", city="Grasse", department="06")  # sans point
    _insert_sale(db, "g8", city="Grasse", latitude=54.27, longitude=-0.40)  # sans département


def test_points_outside_department_repair_counts_by_default_and_repairs_on_demand(repair_database) -> None:
    import psycopg

    with psycopg.connect(repair_database, autocommit=True) as db:
        _seed_outside_department(db)
        before = _snapshot(db)

        output = _psql(repair_database, OUTSIDE_DEPARTMENT)
        assert "MODE COMPTAGE SEULEMENT" in output
        assert _snapshot(db) == before

        _psql(repair_database, OUTSIDE_DEPARTMENT, apply=True)

        g1 = _sale(db, "g1")
        assert g1["latitude"] is None and g1["longitude"] is None
        assert g1["quality_flags"] == ["multi_lot_sale", "implausible_coordinates", "missing_gps"]
        assert "geo_precision" not in g1["raw_payload"] and "latitude" not in g1["raw_payload"]
        assert g1["raw_payload"]["rejected_source_coordinates"] == {
            "latitude": 54.27, "longitude": -0.4, "reason": "outside_department", "department": "06",
        }
        g2 = _sale(db, "g2")
        assert g2["latitude"] is None and "geocode" not in g2["raw_payload"]
        assert float(_sale(db, "g3")["latitude"]) == 43.66
        assert float(_sale(db, "g4")["latitude"]) == 4.94
        assert _sale(db, "g5")["latitude"] is None
        assert float(_sale(db, "g6")["latitude"]) == 18.07
        assert _sale(db, "g7")["quality_flags"] == []
        assert float(_sale(db, "g8")["latitude"]) == 54.27

        after_first = _snapshot(db)
        _psql(repair_database, OUTSIDE_DEPARTMENT, apply=True)
        assert _snapshot(db) == after_first


def test_outside_department_repair_defaults_to_counting_only_and_is_not_a_migration() -> None:
    text = OUTSIDE_DEPARTMENT.read_text(encoding="utf-8")

    assert OUTSIDE_DEPARTMENT.parent == REPAIRS
    assert not list((REPAIRS.parent / "migrations").glob("20261101110100*"))
    assert "\\set apply off" in text and "set transaction read only" in text
    assert text.rstrip().splitlines()[-1].startswith("--")
    assert not re.search(r"^\s*(?:update|insert|delete)\b[^\n]*public\.", text.split("\\if :apply\n  create table")[0], re.M)


def test_outside_department_repair_boxes_are_the_pipeline_boxes() -> None:
    from src.department_bounds import DEPARTMENT_BOUNDS

    text = OUTSIDE_DEPARTMENT.read_text(encoding="utf-8")
    pairs = re.findall(
        r"\('([0-9A-Z]{2,3})', (-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+)\)", text.split("values\n", 1)[1]
    )
    in_sql = {code: tuple(float(value) for value in values) for code, *values in pairs}

    assert in_sql == DEPARTMENT_BOUNDS


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


# --- point 26 : noms canoniques de tribunaux au prefixe double -------------------------------------


def _seed_tribunals(db) -> None:
    from psycopg.types.json import Jsonb

    for code, name, aliases in (
        ("mans", "TJ Tribunal judiciaire du Mans", ["Tribunal judiciaire du Mans", "TJ Tribunal judiciaire du Mans"]),
        ("havre", "TJ Tribunal judiciaire du Havre", ["Tribunal judiciaire du Havre"]),
        ("sables", "TJ Tribunal judiciaire des Sables-d'Olonne", None),
        ("roche", "TJ Tribunal judiciaire de La Roche-sur-Yon", []),
        ("roche2", "TJ Tribunal judiciaire de la Roche-Posay", []),
        ("isle", "TJ Tribunal judiciaire de l'Isle", []),
        ("pau", "TJ Pau", ["Tribunal judiciaire de Pau"]),
        # « TJ Le Creusot » existe deja sous un autre code : le doublon est un conflit, laisse intact.
        ("creusot", "TJ Tribunal judiciaire du Creusot", []),
        ("creusot2", "TJ Le Creusot", []),
    ):
        db.execute(
            "insert into public.tribunals(code, canonical_name, aliases) values (%s, %s, %s)",
            (code, name, Jsonb(aliases) if aliases is not None else None),
        )
    mans_proof = {"tribunal_assignment": {"court_code": "mans", "court_name": "TJ Tribunal judiciaire du Mans"}}
    _insert_sale(db, "s-mans", tribunal="TJ Tribunal judiciaire du Mans", tribunal_code="mans", raw_payload=mans_proof)
    _insert_sale(
        db, "s-havre", tribunal="TJ Tribunal judiciaire du Havre", tribunal_code="havre",
        raw_payload={"tribunal_label_assignment": {"court_name": "TJ Tribunal judiciaire du Havre"}},
    )
    _insert_sale(db, "s-pau", tribunal="TJ Pau", tribunal_code="pau")
    _insert_sale(db, "s-creusot", tribunal="TJ Tribunal judiciaire du Creusot", tribunal_code="creusot")
    db.execute(
        "insert into public.judicial_sales(source_url, tribunal, tribunal_code) values "
        "('s-mans', 'TJ Tribunal judiciaire du Mans', 'mans')"
    )


def test_doubled_tribunal_names_count_by_default_and_repair_on_demand(repair_database) -> None:
    import psycopg

    with psycopg.connect(repair_database, autocommit=True) as db:
        _seed_tribunals(db)
        before = _snapshot(db)
        names_before = db.execute("select * from public.tribunals order by code").fetchall()

        output = _psql(repair_database, DOUBLED_TRIBUNALS)
        assert "MODE COMPTAGE SEULEMENT" in output
        assert _snapshot(db) == before
        assert db.execute("select * from public.tribunals order by code").fetchall() == names_before

        _psql(repair_database, DOUBLED_TRIBUNALS, apply=True)

        names = dict(db.execute("select code, canonical_name from public.tribunals").fetchall())
        assert names["mans"] == "TJ Le Mans"
        assert names["havre"] == "TJ Le Havre"
        assert names["sables"] == "TJ Les Sables-d'Olonne"
        assert names["roche"] == "TJ La Roche-sur-Yon"
        assert names["isle"] == "TJ l'Isle"
        assert names["roche2"] == "TJ la Roche-Posay"
        # Meme casse que le code Python (court_competence._short_court_name) pour chaque nom repare.
        from src.court_competence import _short_court_name

        for code, official in (
            ("mans", "Tribunal judiciaire du Mans"),
            ("havre", "Tribunal judiciaire du Havre"),
            ("sables", "Tribunal judiciaire des Sables-d'Olonne"),
            ("roche", "Tribunal judiciaire de La Roche-sur-Yon"),
            ("roche2", "Tribunal judiciaire de la Roche-Posay"),
            ("isle", "Tribunal judiciaire de l'Isle"),
        ):
            assert names[code] == _short_court_name(official)
        assert names["pau"] == "TJ Pau"
        assert names["creusot"] == "TJ Tribunal judiciaire du Creusot"  # conflit : intact
        aliases = db.execute("select aliases from public.tribunals where code = 'mans'").fetchone()[0]
        assert "TJ Le Mans" in aliases and "TJ Tribunal judiciaire du Mans" not in aliases
        assert "Tribunal judiciaire du Mans" in aliases
        assert db.execute("select aliases from public.tribunals where code = 'sables'").fetchone()[0] == [
            "TJ Les Sables-d'Olonne"
        ]
        # Les trois valeurs que le rapprochement des tribunaux exige egales le restent.
        mans = _sale(db, "s-mans")
        assert mans["tribunal"] == "TJ Le Mans"
        assert mans["raw_payload"]["tribunal_assignment"]["court_name"] == "TJ Le Mans"
        assert _sale(db, "s-havre")["raw_payload"]["tribunal_label_assignment"]["court_name"] == "TJ Le Havre"
        assert _sale(db, "s-pau")["tribunal"] == "TJ Pau"
        assert _sale(db, "s-creusot")["tribunal"] == "TJ Tribunal judiciaire du Creusot"
        assert db.execute("select tribunal from public.judicial_sales").fetchone() == ("TJ Le Mans",)
        assert db.execute("select count(*) from app_private.tribunal_name_repair_backup_20261025").fetchone() == (6,)

        after_first = _snapshot(db)
        names_after = db.execute("select * from public.tribunals order by code").fetchall()
        _psql(repair_database, DOUBLED_TRIBUNALS, apply=True)
        assert _snapshot(db) == after_first
        assert db.execute("select * from public.tribunals order by code").fetchall() == names_after


def test_repair_files_do_not_live_in_the_migrations_folder() -> None:
    migrations = REPAIRS.parent / "migrations"
    assert not list(migrations.glob("20261020130*"))
    assert not list(migrations.glob("20261025100001*"))
    assert {LOCATION, PHANTOM, LICITOR, DOUBLED_TRIBUNALS} <= set(REPAIRS.glob("*.sql"))


def test_doubled_tribunal_repair_defaults_to_counting_only() -> None:
    text = DOUBLED_TRIBUNALS.read_text(encoding="utf-8")

    assert "\\set apply off" in text and "set transaction read only" in text
    assert text.rstrip().count("rollback") >= 1
    assert not re.search(r"^\s*(?:update|insert|delete)\b[^\n]*public\.", text.split("\\if :apply")[0], re.M)


def test_doubled_tribunal_repair_has_no_branch_python_never_produces() -> None:
    # court_competence._short_court_name ne retire que « de » / « d' » et ne transforme que « du » / « des » :
    # une branche « de la » / « de l' » en SQL donnerait une casse que Python ne produit pas.
    text = DOUBLED_TRIBUNALS.read_text(encoding="utf-8")
    plan = text[text.index("create temporary table tribunal_name_plan") : text.index("alter table tribunal_name_plan")]

    assert "when 'de la'" not in plan and "when 'de l'''" not in plan
    assert "(?:(d'')|(du|des|de) +)" in plan
