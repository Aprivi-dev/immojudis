"""Transaction de publication simulée : les tables du catalogue ne s'écrivent que dans celle-ci.

``direct_publication`` laisse ``upsert_sales_to_supabase`` ouvrir sa transaction sur une fausse connexion ;
``inside_publication`` fait tourner les écrivains comme dans cette transaction ; ``capture_enqueued_jobs`` en est
le cas des tâches d'enrichissement mises en file.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import nullcontext
from contextvars import ContextVar
from types import SimpleNamespace
from typing import Any

from src.storage import supabase_client as storage


class NoRows:
    """Connexion qui ne rend aucune ligne : aucune tâche à reprendre dans la file, aucune pièce persistée."""

    def execute(self, statement: Any, params: Any = None) -> SimpleNamespace:
        return SimpleNamespace(fetchall=lambda: [], fetchone=lambda: None)


DIRECT_SETTINGS = {
    "supabase_url": "https://supabase.test",
    "supabase_service_role_key": "not-a-real-key",
    "supabase_db_url": "postgresql://fake-publication",
}

OnWrite = Callable[[str, list[dict[str, Any]], str | None], object]


def _record_writes(monkeypatch, on_write: OnWrite | None) -> None:
    def write(table: str, payload: list[dict[str, Any]], on_conflict: str | None = None, **_kwargs: Any) -> list:
        if on_write is not None:
            on_write(table, payload, on_conflict)
        return []

    monkeypatch.setattr(storage, "_transaction_write", write)


def direct_publication(monkeypatch, on_write: OnWrite | None = None) -> None:
    """``upsert_sales_to_supabase`` ouvre sa transaction sur une fausse connexion directe (identités inchangées)."""
    monkeypatch.setattr(storage, "load_settings", lambda: dict(DIRECT_SETTINGS))
    monkeypatch.setattr("src.publication_identity.resolve_publication_identities", lambda _connection, sales: sales)
    monkeypatch.setattr(storage, "_postgres_connect", lambda *_args, **_kwargs: nullcontext(NoRows()))
    _record_writes(monkeypatch, on_write)


def inside_publication(monkeypatch, connection: Any = None, on_write: OnWrite | None = None) -> None:
    """Les écrivains tournent comme dans la transaction de ``upsert_sales_to_supabase``, sur ``connection``.

    ``on_write(table, lignes, conflit)`` voit chaque écriture de table faite dans la transaction.
    """
    monkeypatch.setattr(
        storage, "_PUBLICATION_CONNECTION", ContextVar("test_publication", default=connection or NoRows())
    )
    _record_writes(monkeypatch, on_write)


def capture_enqueued_jobs(monkeypatch, rows: list[dict[str, Any]]) -> None:
    """``rows`` reçoit les tâches insérées par ``_enqueue_due_enrichment``."""
    inside_publication(monkeypatch, on_write=lambda _table, payload, _conflict: rows.extend(payload))
