"""Le rapport SQL (lecture seule) doit donner le même verdict que la règle Python sur des ventes fictives."""

import json
import os
import re
import uuid
from pathlib import Path

import pytest

from src.information_sufficiency import ContactBlocklist, sufficient_information
from src.recompute_scoring import _sale_from_storage_row

SQL = (Path(__file__).resolve().parents[1] / "sql" / "insufficient_information_report.sql").read_text(encoding="utf-8")

SCHEMA = """
create table public.auction_sales (
  id uuid primary key, source_name text, primary_source text, status text, property_type text, city text,
  postal_code text, address text, title text, description text, lawyer_contact text,
  surface_m2 numeric, habitable_surface_m2 numeric, carrez_surface_m2 numeric, app_surface_m2 numeric,
  land_surface_m2 numeric, raw_payload jsonb not null default '{}', observations jsonb not null default '[]');
create table public.information_agent_contacts (
  scope_sale_id uuid, normalized_email text, opposition_status text default 'unknown', bounce_status text default 'none');
"""

BLOCKED = "refuse.exemple@cabinet-exemple.test"
PAGE_TEXT = "\n".join([
    "Mise à prix", "Adresse du bien", "30 000 €", "Sur", "licitation", "12 rue des Lilas", ",", "59000", "EXEMPLEVILLE",
    "Date de mise en vente", "Adresse de la vente", "Tribunal", "-", "3 Place du Palais", ",", "59000", "EXEMPLEVILLE",
])


def sale_row(name: str, **fields) -> dict:
    base = {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, name)), "source_name": "licitor", "primary_source": "licitor",
        "status": "upcoming", "property_type": "apartment", "city": "Exempleville", "postal_code": "59000",
        "address": None, "title": "Appartement", "description": None, "lawyer_contact": None,
        "surface_m2": None, "land_surface_m2": None, "raw_payload": {}, "observations": [],
        "source_url": f"https://example.test/{name}",
    }
    base.update(fields)
    return base


CASES = {
    "kept_street_and_surface": (sale_row("a", address="12 rue des Lilas, 59000 Exempleville", surface_m2=60), "kept"),
    "missing_surface": (sale_row("b", address="12 rue des Lilas, 59000 Exempleville"), "insufficient"),
    "missing_address": (sale_row("c", surface_m2=60), "insufficient"),
    "email_only": (sale_row("d", lawyer_contact="me.exemple@cabinet-exemple.test"), "kept"),
    "blocked_email": (sale_row("e", lawyer_contact=BLOCKED), "insufficient"),
    "past_is_exempt": (sale_row("f", status="past"), "exempt"),
    "parking_without_surface": (sale_row("g", property_type="parking", address="3 place du Marché, 59000 X"), "kept"),
    "land_with_lieu_dit": (sale_row("h", property_type="land", land_surface_m2=1200,
                                    address="Lieudit Les Vignes, 59000 Exempleville"), "kept"),
    "state_sale_parcel": (sale_row("i", source_name="cessions_etat", primary_source="cessions_etat", surface_m2=80,
                                   raw_payload={"source_blocks": {"reference_cadastrale": "AC 272"}}), "kept"),
    "block_address_recovered": (sale_row("j", source_name="encheres_immobilieres", primary_source="encheres_immobilieres",
                                         surface_m2=50, raw_payload={"source_blocks": {"page_text": PAGE_TEXT,
                                                                                         "adresse": "30 000 €"}}), "kept"),
    "commune_only": (sale_row("k", source_name="vench", primary_source="vench", address="59000 Exempleville",
                              surface_m2=40), "insufficient"),
    "named_place": (sale_row("m", city="Autreville", address="Le Bourg Exemple, 59000 Autreville", surface_m2=60), "kept"),
    "law_firm_as_address": (sale_row("n", address="SELARL Exemple et Associés, Commissaires de Justice, 12 rue du Cabinet",
                                     surface_m2=60), "insufficient"),
    "email_in_observation": (sale_row("l", observations=[{"raw_payload": {"source_blocks": {
        "contact_avocat": "avocat@cabinet-secondaire.test"}}}]), "kept"),
}


@pytest.fixture
def scratch_database():
    base = os.getenv("PIPELINE_TEST_DB_URL")
    if not base:
        pytest.skip("Requires disposable PostgreSQL")
    import psycopg

    name = f"report_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f'create database "{name}"')
    url = re.sub(r"/[^/?]+(\?|$)", rf"/{name}\1", base, count=1)
    try:
        with psycopg.connect(url) as setup:
            setup.execute(SCHEMA)
        yield url
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')


def python_outcome(stored: dict) -> str:
    blocklist = ContactBlocklist(global_emails=frozenset({BLOCKED}))
    sale = _sale_from_storage_row(dict(stored))
    sale.status = stored["status"]
    verdict = sufficient_information(sale, blocklist=blocklist)
    return "exempt" if verdict.exemption else ("kept" if verdict.sufficient else "insufficient")


def test_sql_report_and_python_rule_agree_on_every_fictitious_sale(scratch_database):
    import psycopg
    from psycopg.types.json import Jsonb

    with psycopg.connect(scratch_database) as db:
        for stored, _expected in CASES.values():
            db.execute(
                """insert into public.auction_sales(id, source_name, primary_source, status, property_type, city,
                   postal_code, address, title, description, lawyer_contact, surface_m2, land_surface_m2, raw_payload,
                   observations) values (%(id)s, %(source_name)s, %(primary_source)s, %(status)s, %(property_type)s,
                   %(city)s, %(postal_code)s, %(address)s, %(title)s, %(description)s, %(lawyer_contact)s,
                   %(surface_m2)s, %(land_surface_m2)s, %(raw_payload)s, %(observations)s)""",
                {**stored, "raw_payload": Jsonb(stored["raw_payload"]), "observations": Jsonb(stored["observations"])},
            )
        db.execute("insert into public.information_agent_contacts(normalized_email, opposition_status) values (%s, 'opposed')",
                   (BLOCKED,))
        rows = db.execute(SQL).fetchall()
    # une ligne par source : on retrouve le verdict de chaque vente par ses identifiants
    insufficient_ids = {str(sale_id) for row in rows for sale_id in (row[-1] or [])}
    assert insufficient_ids, "le rapport doit lister des identifiants"
    for name, (stored, expected) in CASES.items():
        python_says = python_outcome(stored)
        assert python_says == expected, f"{name}: Python={python_says}"
        in_sql_report = stored["id"] in insufficient_ids
        assert in_sql_report == (expected == "insufficient"), f"{name}: rapport SQL={in_sql_report}"


def test_sql_report_is_a_single_read_only_select():
    statements = [part for part in SQL.split(";") if part.strip() and not part.strip().startswith("--")]
    assert len(statements) == 1
    lowered = re.sub(r"--[^\n]*", "", SQL).lower()
    assert not re.search(r"\b(insert|update|delete|drop|alter|truncate|create)\b", lowered)
    assert json.dumps(SQL)  # le fichier est du texte simple
