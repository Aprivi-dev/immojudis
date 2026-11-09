"""La synthèse rédigée par le modèle (``llm_display_description``) est retirée : rien ne la produit plus.

Les textes déjà en base restent lus par le site ; le pipeline n'en écrit, n'en vérifie et n'en programme aucun.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from src.config import load_settings
from src.enrichment import extract_structured
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client as storage
from tests.test_llm_cost_cache import FakeClient, _fact_calls, _patch_contexts


def _sale(**changes) -> AuctionSale:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/no-synthesis",
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


def test_no_setting_drives_a_display_synthesis_any_more() -> None:
    settings = load_settings()
    assert not [key for key in settings if key.startswith("llm_display") or "llm_backfill" in key]
    assert "llm_extraction_mode" not in settings


def test_publication_enqueues_no_display_job(monkeypatch) -> None:
    rows: list[dict] = []
    monkeypatch.setattr(storage, "load_settings", lambda: {"llm_prompt_version": "v1"})
    monkeypatch.setattr("src.enrichment.extract_structured.needs_fact_extraction", lambda _sale: True)
    monkeypatch.setattr(storage, "_postgrest_upsert", lambda _u, _k, _t, payload, _c: rows.extend(payload))

    sale = _sale(raw_payload={"source_content_changed": True})
    storage._enqueue_due_enrichment([sale], "unused", "unused")

    assert [row["job_type"] for row in rows] == ["fact_extraction"]


@pytest.mark.parametrize(
    "description",
    [
        "Maison à Bordeaux avec jardin.",
        # A source constraint too long for a synthesis used to reject the whole pass.
        "Maison à Bordeaux. Le bien est grevé d'une servitude "
        + " ".join(["de passage au profit du fonds voisin cadastré"] * 40)
        + ".",
    ],
)
def test_fact_pass_writes_no_synthesis(monkeypatch, tmp_path: Path, description: str) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    _patch_contexts(monkeypatch, ["chunk-A"])
    sale = AuctionSale(
        source_name="test",
        source_url="https://example.test/sale",
        raw_text="Maison à Bordeaux.",
        description=description,
        city="Bordeaux",
        property_type="house",
    )
    client = FakeClient()

    stats = extract_structured.enrich_sale_with_llm(sale, client=client, output_dir=tmp_path)

    assert client.calls and _fact_calls(client) == client.calls
    assert stats.errors == 0, stats.error_messages
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True
    assert not [key for key in sale.raw_payload if key.startswith("llm_display")]
    assert "rejected_display_description" not in sale.raw_payload


def test_rejected_output_key_is_not_projected_by_public_sql() -> None:
    # Former rejected generations stay private in raw_payload: no view may expose them.
    migrations = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    assert not any(
        "rejected_display_description" in path.read_text(encoding="utf-8") for path in migrations.glob("*.sql")
    )
