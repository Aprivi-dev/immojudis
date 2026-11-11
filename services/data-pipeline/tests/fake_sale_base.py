"""Base simulée pour les tests de la garde d'écho : une table ``auction_sales`` en mémoire.

Elle répond aux vraies requêtes de la collecte (verrou des candidats, lecture des lignes verrouillées, écriture
``insert ... on conflict (source_url) do update ... returning``) et enregistre chaque écriture. ``move`` joue un
autre écrivain qui change une ligne entre deux étapes du passage ; ``retain`` joue une base qui retient des colonnes
(un déclencheur qui remet sa valeur à chaque écriture). Les tables voisines (copies, travaux, décisions) ne sont pas
simulées : ``patch_publication`` les neutralise, elles sont hors du sujet de ces tests.
"""

from __future__ import annotations

import json
import re
import uuid
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
from typing import Any

from src.publication_identity import LOCKED_SALE_SELECT
from src.reviewed_aliases import registry_from_rows
from src.storage import supabase_client as storage

SETTINGS = {
    "supabase_url": "https://supabase.test",
    "supabase_service_role_key": "not-a-real-key",
    "supabase_db_url": "postgresql://fake-base",
}


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Unexpected value in a simulated row: {type(value).__name__}")


def as_json(value: Any) -> Any:
    """Ce que la base rend d'une valeur : du JSON, donc ni ``Decimal`` ni ``datetime``."""
    return json.loads(json.dumps(value, default=_json_default))


class _Result:
    def __init__(self, rows: list[tuple]):
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return self._rows

    def fetchone(self) -> tuple | None:
        return self._rows[0] if self._rows else None


class FakeSaleBase:
    def __init__(self, rows: list[dict[str, Any]] | None = None):
        self.rows: dict[str, dict[str, Any]] = {}
        self.statements: list[str] = []
        self.locked_reads: list[dict[str, Any]] = []
        self.writes: list[dict[str, Any]] = []
        self.retained: dict[str, dict[str, Any]] = {}
        for row in rows or []:
            self.insert(row)

    def __enter__(self) -> FakeSaleBase:
        self._before = deepcopy(self.rows)
        return self

    def __exit__(self, exc_type: Any, *_details: Any) -> None:
        # Comme une transaction : une erreur annule tout ce que le lot a écrit.
        if exc_type is not None:
            self.rows = self._before

    def insert(self, row: dict[str, Any]) -> dict[str, Any]:
        stored = {"id": str(uuid.uuid4()), **as_json(row)}
        self.rows[stored["source_url"]] = stored
        return stored

    def move(self, source_url: str, **values: Any) -> None:
        """Un autre écrivain change la ligne (comme une décision prise pendant le passage)."""
        self.rows[source_url].update(as_json(values))

    def retain(self, source_url: str, **values: Any) -> None:
        """La base retient ces colonnes : toute écriture de la ligne les laisse à ces valeurs."""
        self.retained[source_url] = as_json(values)
        self.rows[source_url].update(self.retained[source_url])

    def execute(self, query: Any, params: Any = None) -> _Result:
        text = query if isinstance(query, str) else query.as_string(None)
        self.statements.append(text)
        if text.startswith('insert into "public"."auction_sales"'):
            kept = []
            for row in as_json(params[0].obj):
                self.writes.append(deepcopy(row))
                current = self.rows.setdefault(row["source_url"], {"id": str(uuid.uuid4())})
                current.update(row)
                current.update(self.retained.get(row["source_url"], {}))
                kept.append(current)
            # ``returning`` rend la ligne telle que la base l'a gardée, pas telle qu'elle a été envoyée.
            returning = re.findall(r'"(\w+)"', text.partition(" returning ")[2])
            return _Result([tuple(row.get(column) for column in returning) for row in kept] if returning else [])
        if text.startswith("select updated_at from public.auction_sales where source_url="):
            # Garde de révision d'une écriture d'enrichissement : la date de la ligne, comme la base la rend.
            row = self.rows.get(params[0])
            stamp = row.get("updated_at") if row else None
            return _Result([(datetime.fromisoformat(stamp) if stamp else None,)] if row else [])
        if "for no key update" in text:
            return _Result([(row["id"],) for row in self.rows.values()])
        if "select to_jsonb(s)" in text:
            wanted = set(params[0])
            read = [
                {column: row.get(column) for column in LOCKED_SALE_SELECT.split(",")}
                for row in self.rows.values()
                if row["id"] in wanted
            ]
            read.sort(key=lambda row: row["id"])
            self.locked_reads.extend(deepcopy(read))
            return _Result([(row,) for row in deepcopy(read)])
        return _Result([])

    def snapshot(self) -> list[dict[str, Any]]:
        """Les lignes telles qu'une lecture des détails connus les rend."""
        return deepcopy(list(self.rows.values()))


def patch_publication(monkeypatch, base: FakeSaleBase) -> None:
    """Fait écrire ``upsert_sales_to_supabase`` dans ``base`` ; seule l'écriture de ``auction_sales`` est réelle."""
    monkeypatch.setattr(storage, "load_settings", lambda: dict(SETTINGS))
    monkeypatch.setattr(storage, "_postgres_connect", lambda _url: base)
    monkeypatch.setattr(
        storage,
        "_read_known_sales_snapshot_with_retries",
        lambda *_args, **_kwargs: ((), base.snapshot()),
    )
    patch_neighbouring_tables(monkeypatch)


def patch_neighbouring_tables(monkeypatch) -> None:
    """Neutralise le registre des alias et les écritures hors ``auction_sales`` (copies, travaux, décisions)."""
    monkeypatch.setattr("src.publication_identity.load_reviewed_aliases", lambda _connection: registry_from_rows([]))
    monkeypatch.setattr(storage, "load_reviewed_aliases", lambda _connection: registry_from_rows([]))
    monkeypatch.setattr(storage, "tribunal_reference_rows", lambda _sales: [])
    monkeypatch.setattr(storage, "_write_fact_claims_postgres", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(storage, "_sync_normalized_sale_tables_with_rest", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(storage, "_upsert_asset_tables_with_rest", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(storage, "_enqueue_due_enrichment", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(storage.internal_contacts, "write_safely", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("src.collection_evidence.record_sale_decisions", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("src.publication_identity.record_sale_decisions", lambda *_args, **_kwargs: None)
