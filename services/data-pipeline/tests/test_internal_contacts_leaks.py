"""Les adresses internes ne sortent d'aucun chemin qui sérialise la vente brute (fixtures fictives)."""

from __future__ import annotations

import json
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from src import source_checkpoint, source_process
from src.models import INTERNAL_CONTACTS_KEY
from src.normalize import INTERNAL_CONTACTS_KEY as NORMALIZE_KEY

EMAIL = "maitre@exemple.test"


class _Transaction:
    def __enter__(self) -> _Transaction:
        return self

    def __exit__(self, *_: object) -> bool:
        return False


class _Db:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def transaction(self) -> _Transaction:
        return _Transaction()

    def execute(self, statement: str, params: object = None) -> SimpleNamespace:
        self.calls.append((statement, params))
        return SimpleNamespace(fetchall=lambda: [])


def test_the_key_is_shared_between_the_model_the_normalizer_and_the_checkpoint() -> None:
    assert INTERNAL_CONTACTS_KEY == NORMALIZE_KEY == "internal_contacts"


def test_checkpoint_append_never_writes_the_internal_addresses(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _Db()
    monkeypatch.setenv("PIPELINE_AUTONOMOUS_RUN_ID", "run-1")
    monkeypatch.setattr(source_checkpoint, "load_settings", lambda: {"supabase_db_url": "postgresql://local"})
    monkeypatch.setattr(source_checkpoint, "_checkpoint_connect", lambda *_: nullcontext(db))
    monkeypatch.setattr("src.collection_evidence.record_items", lambda *args, **kwargs: None)
    source_checkpoint._context.cache_clear()
    source_checkpoint._connections.clear()
    sale = {
        "source_url": "https://www.licitor.com/annonce/1.html",
        "source_name": "licitor",
        "title": "Un appartement",
        "_checkpoint_signature": "sig",
        INTERNAL_CONTACTS_KEY: [{"email": EMAIL, "name": "Maître Exemple", "role": "lawyer"}],
    }
    try:
        rows = source_checkpoint.CheckpointSales()
        rows.append(sale)
    finally:
        source_checkpoint._context.cache_clear()
        source_checkpoint._connections.clear()

    written = [params for statement, params in db.calls if statement.lstrip().lower().startswith("insert into public.auction_collection_checkpoints")]
    assert len(written) == 1
    payload = written[0][3].obj  # Jsonb
    assert INTERNAL_CONTACTS_KEY not in payload and EMAIL not in json.dumps(payload)
    assert payload["title"] == "Un appartement"
    # La vente gardée en mémoire (publication) conserve ses adresses.
    assert rows[0][INTERNAL_CONTACTS_KEY][0]["email"] == EMAIL


@pytest.mark.parametrize(
    "output",
    [
        json.dumps({"ok": True, "result": {"sales": [{"internal_contacts": [{"email": EMAIL}]}]}}),
        f"Traceback ... ValueError: boom for {EMAIL} while parsing",
    ],
)
def test_worker_failure_messages_never_cite_a_sale_payload_or_an_address(output: str) -> None:
    detail = source_process._worker_detail(output, "fallback")

    assert EMAIL not in detail
    assert source_process._worker_detail("", "fallback") == "fallback"
    assert source_process._worker_detail(None, "fallback") == "fallback"


def test_worker_diagnostics_without_address_stay_readable() -> None:
    assert source_process._worker_detail("timeout while reading page 3", "x") == "timeout while reading page 3"
