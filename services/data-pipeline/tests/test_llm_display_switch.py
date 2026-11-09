"""Synthèse rédigée par le modèle coupée (``LLM_DISPLAY_ENABLED=false``, réglage de production du 09/11/2026)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from src.config import llm_display_enabled, load_settings
from src.enrichment import extract_structured
from src.main import _needs_llm_display_description_refresh
from src.normalize import normalize_sale
from src.storage import supabase_client as storage

pytestmark = pytest.mark.llm_display_disabled


def _sale(**changes):
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/switch",
            "status": "upcoming",
            "sale_date": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
            "starting_price_eur": 50000,
            "description": "Appartement de trois pièces au deuxième étage, cave et parking.",
        }
    )
    sale.status = "upcoming"
    for key, value in changes.items():
        setattr(sale, key, value)
    return sale


def test_coupee_par_defaut(monkeypatch):
    monkeypatch.delenv("LLM_DISPLAY_ENABLED", raising=False)
    assert load_settings()["llm_display_enabled"] is False
    assert llm_display_enabled() is False
    monkeypatch.setenv("LLM_DISPLAY_ENABLED", "true")
    assert llm_display_enabled() is True


def test_aucune_tache_display_mise_en_file(monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr(storage, "load_settings", lambda: {"llm_prompt_version": "v1"})
    monkeypatch.setattr("src.enrichment.extract_structured.needs_fact_extraction", lambda _sale: False)
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda _u, _k, _t, payload, _c: rows.extend(payload))

    sale = _sale(raw_payload={"source_content_changed": True})
    storage._enqueue_due_enrichment([sale], "unused", "unused")

    assert [row["job_type"] for row in rows] == []


def test_aucune_synthese_attendue_ni_a_rafraichir():
    sale = _sale()
    assert _needs_llm_display_description_refresh(sale, prompt_version="v1") is False
    assert storage._has_current_llm_description({}, "v1") is True


def test_mode_display_sans_appel_au_modele(monkeypatch):
    class _Client:
        model = "fake"

        def is_available(self) -> bool:  # pragma: no cover - ne doit pas être appelé
            raise AssertionError("aucun appel attendu")

        def generate_json(self, *_args, **_kwargs):  # pragma: no cover - ne doit pas être appelé
            raise AssertionError("aucun appel attendu")

    monkeypatch.setattr(extract_structured, "require_encheres_publiques_sale_access", lambda **_kwargs: None)
    sale = _sale()
    stats = extract_structured.enrich_sale_with_llm(sale, client=_Client(), extraction_mode="display_description")

    assert stats.analyzed == 0
    assert "llm_display_description" not in sale.raw_payload
