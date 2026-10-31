"""Lot 2b, n° 43 : test de contrat entre les colonnes écrites par le pipeline et le schéma migré.

Chaque colonne de ``src/storage/column_sets.py`` et de chaque constructeur de ligne doit exister dans la table
visée du schéma migré, avec un type compatible avec la valeur que le pipeline y écrit. Une migration qui renomme,
retire ou change le type d'une colonne que le pipeline écrit fait échouer ce test dans la CI, au lieu d'échouer en
production à la première écriture.

Le test se lance seul, dans le job « Supabase migrations + pgTAP » (base Supabase locale rejouée depuis zéro) :

    SCHEMA_CONTRACT_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres python -m pytest -m schema_contract

Sans ``SCHEMA_CONTRACT_DB_URL`` il est ignoré, et la suite courante ne le sélectionne pas (``addopts`` de
``pyproject.toml``). Il ne lit que ``information_schema`` ; il refuse toute base qui n'est pas locale.
"""

from __future__ import annotations

import os
import types
import typing
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from urllib.parse import urlsplit

import pytest

from src.asset_normalization import (
    build_auction_features_row,
    build_auction_risk_rows_from_occurrences,
    build_auction_score_factor_rows,
    build_auction_surfaces_row,
    extract_risk_occurrences_from_text,
    normalize_asset_features,
)
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.models import AuctionSale
from src.storage import column_sets
from src.storage.column_sets import (
    DEDUPLICATION_SALE_SELECT,
    JUDICIAL_SALE_COLUMNS,
    LLM_BACKFILL_SALE_SELECT,
    PROPERTY_COLUMNS,
    UPSERT_COLUMNS,
)
from src.storage.postgrest_helpers import _timestamped
from src.storage.sale_row_builders import (
    _judicial_sale_rows_for_sales,
    _property_rows_for_sales,
    _public_occurrence_row,
    _surface_derivation_rows_for_sale,
    _surface_measurement_rows_for_sale,
)
from src.urban_planning import build_urban_planning_signal_rows

DB_URL_ENV = "SCHEMA_CONTRACT_DB_URL"
REQUIRED_ENV = "SCHEMA_CONTRACT_REQUIRED"
NOW = "2026-10-31T12:00:00+00:00"

# Table visée par chaque ensemble de colonnes de ``column_sets`` : un nouvel ensemble doit être déclaré ici.
COLUMN_SETS_TABLES: dict[str, str] = {
    "UPSERT_COLUMNS": "auction_sales",
    "PROPERTY_COLUMNS": "properties",
    "JUDICIAL_SALE_COLUMNS": "judicial_sales",
}
# Colonnes ajoutées par la base ou par le client sans passer par ``column_sets``.
SELECT_EXTRA_COLUMNS = ("id", "first_seen_at", "last_seen_at", "created_at", "updated_at")

WRITTEN_TABLES = (
    "auction_sales",
    "properties",
    "judicial_sales",
    "auction_features",
    "auction_surfaces",
    "auction_surface_measurements",
    "auction_surface_derivations",
    "auction_risk_occurrences",
    "auction_risks",
    "auction_score_factors",
    "auction_urban_planning_signals",
)

_INTEGER = frozenset({"int2", "int4", "int8"})
_NUMBER = frozenset({"numeric", "float4", "float8"})
_TEXT = frozenset({"text", "varchar", "bpchar", "citext", "name"})
_TIME = frozenset({"date", "timestamptz", "timestamp", "time", "timetz"})
_JSON = frozenset({"json", "jsonb"})


# --- garde sans base : chaque ensemble de colonnes est couvert ----------------------------------------------------------


def test_every_column_set_is_declared_in_the_contract() -> None:
    declared = {name for name in vars(column_sets) if name.endswith("_COLUMNS") and name != "POSTGRES_JSON_COLUMNS"}

    assert declared == set(COLUMN_SETS_TABLES), (
        "Un ensemble de colonnes de column_sets.py n'est pas rattaché à une table dans COLUMN_SETS_TABLES."
    )


def test_every_json_column_is_one_of_the_written_columns() -> None:
    written = set(UPSERT_COLUMNS) | set(PROPERTY_COLUMNS) | set(JUDICIAL_SALE_COLUMNS)

    assert column_sets.POSTGRES_JSON_COLUMNS <= written


def test_the_selects_are_built_from_the_upsert_columns() -> None:
    expected = {*SELECT_EXTRA_COLUMNS, *UPSERT_COLUMNS}

    assert set(LLM_BACKFILL_SALE_SELECT.split(",")) == expected
    assert set(DEDUPLICATION_SALE_SELECT.split(",")) == expected


def test_the_schema_contract_marker_is_registered(pytestconfig) -> None:
    assert any(line.startswith("schema_contract") for line in pytestconfig.getini("markers"))


# --- lignes que le pipeline construit ----------------------------------------------------------------------------------

_SAMPLE_TEXT = (
    "Maison d'habitation de 120 m² se composant d'une entrée (6 m²), séjour (30 m²), cuisine (12 m²), "
    "chambre (14 m²), salle d'eau (5 m²). Terrain de 800 m². Immeuble en copropriété, fissures en façade, "
    "présence d'amiante, bien occupé par un locataire, servitude de passage. Zone UB du plan local "
    "d'urbanisme, droit de préemption urbain, risque d'inondation. Visites sur rendez-vous."
)
_UUID_COLUMNS = frozenset({"id", "last_run_id"})


def _sample_value(name: str, annotation: object) -> object:
    """Une valeur du type que porte le modèle pour ce champ (``None`` exclu)."""
    if name in _UUID_COLUMNS:
        return str(uuid.UUID(int=1))
    origin = typing.get_origin(annotation)
    args = [arg for arg in typing.get_args(annotation) if arg is not type(None)]
    if origin in (typing.Union, types.UnionType):
        return _sample_value(name, args[0])
    if origin is list:
        return ["texte"] if args and args[0] is str else [{"clé": "valeur"}]
    if origin is dict or annotation is dict:
        return {"clé": "valeur"}
    if annotation is bool:
        return True
    if annotation is int:
        return 3
    if annotation is Decimal:
        return Decimal("12.5")
    if annotation is datetime:
        return datetime(2026, 11, 20, 14, 0, tzinfo=UTC)
    return "texte"


def _sample_sale() -> AuctionSale:
    """Une vente dont chaque champ du modèle porte une valeur du bon type (aucune normalisation)."""
    values = {
        name: _sample_value(name, field.annotation)
        for name, field in AuctionSale.model_fields.items()
        if not field.exclude
    }
    values.update(
        source_name="licitor",
        source_url="https://example.test/vente-contrat",
        property_type="house",
        raw_text=_SAMPLE_TEXT,
        description=_SAMPLE_TEXT,
        title="Maison à vendre",
        score_factors=[],
        documents=[{"label": "Cahier des conditions de vente", "url": "https://example.test/ccv.pdf", "type": "pdf"}],
        raw_payload={},
        quality_flags=[],
    )
    return AuctionSale(**values)


def _normalized_sale() -> AuctionSale:
    """La même vente, lue et normalisée comme en production (surfaces, risques, facteurs de score)."""
    sale = _sample_sale()
    extract_and_apply_deterministic_surface_reasoning(sale, _SAMPLE_TEXT)
    normalize_asset_features(sale)
    return sale


def written_rows() -> dict[str, list[dict[str, object]]]:
    """Les lignes que le pipeline écrit, par table : les colonnes de ``column_sets`` et les constructeurs de ligne."""
    raw = _sample_sale()
    data = raw.to_storage_dict(exclude_none=False)
    sale = _normalized_sale()
    occurrences = [
        _public_occurrence_row(item)
        for item in extract_risk_occurrences_from_text(_SAMPLE_TEXT, sale.source_url, source_kind="sale_text")
    ]
    rows: dict[str, list[dict[str, object]]] = {
        "auction_sales": [{column: data.get(column) for column in UPSERT_COLUMNS}],
        "properties": [_timestamped(row, NOW) for row in _property_rows_for_sales([_sample_sale()], NOW)],
        "judicial_sales": [_timestamped(row, NOW) for row in _judicial_sale_rows_for_sales([_sample_sale()], NOW)],
        "auction_features": [_timestamped(build_auction_features_row(sale), NOW)],
        "auction_surfaces": [_timestamped(build_auction_surfaces_row(sale), NOW)],
        "auction_surface_measurements": [_timestamped(row, NOW) for row in _surface_measurement_rows_for_sale(sale)],
        "auction_surface_derivations": [_timestamped(row, NOW) for row in _surface_derivation_rows_for_sale(sale)],
        "auction_risk_occurrences": [_timestamped(row, NOW) for row in occurrences],
        "auction_risks": [
            _timestamped(row, NOW) for row in build_auction_risk_rows_from_occurrences(sale.source_url, occurrences)
        ],
        "auction_score_factors": [
            _timestamped(row, NOW) for row in build_auction_score_factor_rows(sale, occurrences)
        ],
        "auction_urban_planning_signals": [
            _timestamped(row, NOW) for row in build_urban_planning_signal_rows(sale, pdf_texts=[])
        ],
    }
    return rows


def test_the_row_builders_produce_rows_for_every_table_of_the_contract() -> None:
    rows = written_rows()

    assert set(rows) == set(WRITTEN_TABLES)
    empty = sorted(table for table, table_rows in rows.items() if not table_rows)
    assert empty == [], f"Le jeu d'essai ne produit aucune ligne pour : {empty}"


def test_the_sample_sale_gives_a_value_to_every_written_column() -> None:
    # Sans valeur, le type d'une colonne ne serait pas vérifié : un nouveau champ doit avoir un jeu d'essai.
    for table in ("auction_sales", "properties", "judicial_sales"):
        row = written_rows()[table][0]
        assert [column for column, value in row.items() if value is None] == [], table


# --- compatibilité de type ---------------------------------------------------------------------------------------------


def incompatibility(value: object, udt_name: str) -> str | None:
    """Pourquoi ``value`` ne peut pas être écrite dans une colonne de type ``udt_name`` (``None`` : compatible)."""
    if value is None:
        return None
    if udt_name in _JSON:
        return None
    if isinstance(value, bool):
        return None if udt_name == "bool" or udt_name in _TEXT else "booléen dans une colonne qui n'est pas booléenne"
    if isinstance(value, int):
        return None if udt_name in _INTEGER | _NUMBER else "entier dans une colonne non numérique"
    if isinstance(value, (float, Decimal)):
        if udt_name in _NUMBER:
            return None
        if udt_name in _INTEGER and float(value).is_integer():
            return None
        return "nombre décimal dans une colonne qui n'est pas numérique"
    if isinstance(value, (datetime, date)):
        return None if udt_name in _TIME | _TEXT else "date dans une colonne qui n'est pas une date"
    if isinstance(value, str):
        if udt_name in _TEXT:
            return None
        if udt_name == "uuid":
            try:
                uuid.UUID(value)
            except ValueError:
                return "texte qui n'est pas un UUID"
            return None
        if udt_name in _TIME:
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return "texte qui n'est pas une date ISO"
            return None
        if udt_name in _NUMBER | _INTEGER:
            try:
                Decimal(value)
            except ArithmeticError:
                return "texte qui n'est pas un nombre"
            return None
        return f"texte dans une colonne de type {udt_name}"
    if isinstance(value, (list, tuple)):
        return None if udt_name.startswith("_") else "liste dans une colonne qui n'est ni JSON ni un tableau"
    if isinstance(value, dict):
        return "objet dans une colonne qui n'est pas JSON"
    return f"valeur {type(value).__name__} non prévue"


@pytest.mark.parametrize(
    ("value", "udt", "compatible"),
    [
        (True, "bool", True),
        (True, "int4", False),
        (3, "int4", True),
        (3, "text", False),
        (12.5, "numeric", True),
        (12.5, "int4", False),
        (12.0, "int4", True),
        (Decimal("1.5"), "float8", True),
        ("texte", "text", True),
        ("texte", "int4", False),
        ("2026-10-31T12:00:00+00:00", "timestamptz", True),
        ("pas une date", "date", False),
        (str(uuid.UUID(int=1)), "uuid", True),
        ("pas un uuid", "uuid", False),
        (["a"], "jsonb", True),
        (["a"], "_text", True),
        (["a"], "text", False),
        ({"a": 1}, "jsonb", True),
        ({"a": 1}, "text", False),
        (None, "int4", True),
    ],
)
def test_the_type_rules(value: object, udt: str, compatible: bool) -> None:
    assert (incompatibility(value, udt) is None) is compatible


# --- contre le schéma migré --------------------------------------------------------------------------------------------


def _connect():
    url = os.getenv(DB_URL_ENV)
    if not url:
        if os.getenv(REQUIRED_ENV) == "1":
            pytest.fail(f"{DB_URL_ENV} est absente alors que {REQUIRED_ENV}=1 : le contrat n'a pas été vérifié.")
        pytest.skip(f"{DB_URL_ENV} absente : base migrée non disponible")
    host = urlsplit(url).hostname or ""
    if host not in {"localhost", "127.0.0.1", "::1", ""} and not host.startswith("/"):
        pytest.fail(f"{DB_URL_ENV} doit désigner une base locale (hôte {host!r} refusé) : le contrat ne touche jamais la production.")
    import psycopg

    return psycopg.connect(url, autocommit=True, options="-c default_transaction_read_only=on")


@pytest.fixture(scope="module")
def schema() -> dict[str, dict[str, tuple[str, str]]]:
    """``{table: {colonne: (type, nullable)}}`` du schéma ``public`` migré."""
    with _connect() as connection:
        rows = connection.execute(
            "select table_name::text, column_name::text, udt_name::text, is_nullable::text "
            "from information_schema.columns where table_schema = 'public'"
        ).fetchall()
    tables: dict[str, dict[str, tuple[str, str]]] = {}
    for table, column, udt_name, nullable in rows:
        tables.setdefault(table, {})[column] = (udt_name, nullable)
    return tables


@pytest.mark.schema_contract
@pytest.mark.parametrize(("constant", "table"), sorted(COLUMN_SETS_TABLES.items()))
def test_every_column_of_column_sets_exists_in_the_migrated_table(schema, constant: str, table: str) -> None:
    assert table in schema, f"La table public.{table} n'existe pas dans le schéma migré."
    missing = [column for column in getattr(column_sets, constant) if column not in schema[table]]

    assert missing == [], f"{constant} : colonnes absentes de public.{table} : {missing}"


@pytest.mark.schema_contract
def test_the_select_projections_only_name_existing_columns(schema) -> None:
    for name, projection in (
        ("LLM_BACKFILL_SALE_SELECT", LLM_BACKFILL_SALE_SELECT),
        ("DEDUPLICATION_SALE_SELECT", DEDUPLICATION_SALE_SELECT),
    ):
        missing = [column for column in projection.split(",") if column not in schema["auction_sales"]]
        assert missing == [], f"{name} : colonnes absentes de public.auction_sales : {missing}"


@pytest.mark.schema_contract
@pytest.mark.parametrize("table", WRITTEN_TABLES)
def test_every_row_builder_writes_existing_columns_of_a_compatible_type(schema, table: str) -> None:
    assert table in schema, f"La table public.{table} n'existe pas dans le schéma migré."
    rows = written_rows()[table]
    assert rows, f"Aucune ligne construite pour public.{table}"

    problems: list[str] = []
    for row in rows:
        for column, value in row.items():
            if column not in schema[table]:
                problems.append(f"{table}.{column} : colonne absente du schéma migré")
                continue
            reason = incompatibility(value, schema[table][column][0])
            if reason:
                problems.append(f"{table}.{column} ({schema[table][column][0]}) : {reason}")
    assert sorted(set(problems)) == []
