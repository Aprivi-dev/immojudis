"""Écho de la collecte face au registre des pièces : scénarios A, B et C contre une vraie base au schéma complet.

Une pièce est posée, remplacée ou retirée par la projection du registre (seconde connexion, comme une décision
d'administrateur) pendant qu'un passage de collecte a déjà lu la vente. Le passage écrit ensuite par son vrai chemin
(``fetch_known_sale_details`` puis ``upsert_sales_to_supabase`` : verrou, résolution d'identité, écriture de toutes les
tables). Attendu : la valeur seulement relue n'est pas réécrite, aucun évènement « l'annonce a changé » n'est créé,
la valeur d'annonce mémorisée reste celle de l'annonce.

Ces tests écrivent dans la base : il leur faut une base **jetable et locale** où toutes les migrations sont rejouées
(base Supabase locale du job « Supabase migrations + pgTAP », ou PostgreSQL local amorcé comme elle) :

    PIPELINE_REGISTRY_DB_URL=postgresql://postgres@127.0.0.1:55600/replay python -m pytest -s \
        tests/test_base_echo_registry_postgres.py

Sans ``PIPELINE_REGISTRY_DB_URL`` ils sont ignorés ; toute base non locale est refusée. Le journal des décisions est
en ajout seul : chaque exécution y laisse ses lignes, sous des identifiants neufs. ``-s`` affiche la transcription.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

import pytest

from src import base_reads
from src import main as pipeline
from src.asset_normalization import normalize_asset_features
from src.config import load_settings
from src.freshness import record_source_checks
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client as storage

DB_URL_ENV = "PIPELINE_REGISTRY_DB_URL"
ROOMS = "property.rooms_count"
SURFACE = "property.surface_m2"
SALE_DATE = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0).isoformat()
SURFACE_COLUMNS = ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence")


def _db_url() -> str:
    url = os.getenv(DB_URL_ENV)
    if not url:
        pytest.skip(f"{DB_URL_ENV} absente : base au schéma complet non disponible")
    host = urlsplit(url).hostname or ""
    if host not in {"localhost", "127.0.0.1", "::1", ""} and not host.startswith("/"):
        pytest.fail(f"{DB_URL_ENV} doit désigner une base locale (hôte {host!r} refusé) : ces tests écrivent.")
    return url


def say(text: str) -> None:
    print(text)  # transcription des scénarios, affichée par ``pytest -s``


class Registry:
    """La seconde connexion : celle d'un administrateur qui décide pendant que la collecte tourne."""

    def __init__(self, url: str):
        import psycopg

        self.db = psycopg.connect(url, autocommit=True)
        self.admin = str(uuid.uuid4())
        self.case = str(uuid.uuid4())
        self.db.execute("insert into auth.users (id) values (%s)", (self.admin,))
        self.db.execute(
            """insert into public.user_profiles (user_id, email, user_role) values (%s, %s, 'admin')
               on conflict (user_id) do update set user_role = excluded.user_role""",
            (self.admin, f"registre-echo-{self.admin[:8]}@example.test"),
        )

    def close(self) -> None:
        self.db.close()

    def setting(self, field: str) -> str:
        return self.db.execute(
            "select on_listing_change from public.auction_fact_fields where field_key = %s", (field,)
        ).fetchone()[0]

    def set_setting(self, field: str, value: str) -> None:
        self.db.execute(
            "update public.auction_fact_fields set on_listing_change = %s where field_key = %s", (value, field)
        )

    def sale_id(self, url: str) -> str:
        return str(self.db.execute("select id from public.auction_sales where source_url = %s", (url,)).fetchone()[0])

    def accept(self, sale_id: str, field: str, value: int, received_at: str) -> str:
        """Une réponse d'avocat devient une observation, puis une pièce acceptée, puis elle est projetée."""
        from psycopg.types.json import Jsonb

        claim_id = str(uuid.uuid4())
        self.db.execute(
            """insert into public.auction_fact_claims (id, auction_sale_id, field_key, value_jsonb, evidence_kind,
                 evidence_locator, source_url, confidence_score, extractor_name, extractor_version, created_by)
               values (%s, %s, %s, %s, 'professional_email', %s, null, 0.9, 'information_agent', 'v1', %s)""",
            (claim_id, sale_id, field, Jsonb(value), Jsonb({"case_id": self.case}), self.admin),
        )
        self._decide(claim_id, "accepted", None, received_at)
        self.project(sale_id)
        return claim_id

    def withdraw(self, sale_id: str, *claim_ids: str) -> None:
        for claim_id in claim_ids:
            self._decide(claim_id, "withdrawn", "entry_error", None)
        self.project(sale_id)

    def _decide(self, claim_id: str, decision: str, reason: str | None, received_at: str | None) -> None:
        self.db.execute(
            """insert into public.auction_fact_claim_decisions (claim_id, sale_id, field_key, decision,
                 lot_attachment, actor_kind, actor_id, reason_code, recipient_kind, received_at)
               select claim.id, claim.auction_sale_id, claim.field_key, %s, 'single_lot', 'admin', %s, %s,
                      'source_lawyer', %s
               from public.auction_fact_claims claim where claim.id = %s""",
            (decision, self.admin, reason, received_at, claim_id),
        )

    def project(self, sale_id: str, *, apply: bool = True) -> dict[str, Any]:
        return self.db.execute("select app_private.project_sale_fields(%s, null, %s)", (sale_id, apply)).fetchone()[0]

    def row(self, sale_id: str) -> dict[str, Any]:
        columns = (*SURFACE_COLUMNS, "rooms_count", "occupancy_status", "held_fields")
        values = self.db.execute(
            f"select {', '.join(columns)} from public.auction_sales where id = %s", (sale_id,)
        ).fetchone()
        return dict(zip(columns, values, strict=True))

    def listing_memory(self, sale_id: str, field: str) -> Any:
        """La valeur d'annonce mémorisée pour un champ tenu (bloc ``listing``)."""
        held = self.row(sale_id)["held_fields"] or {}
        return (held.get(field) or {}).get("listing")

    def listing_events(self, sale_id: str) -> list[tuple[str, Any]]:
        return self.db.execute(
            """select event, incoming_value from public.auction_sale_field_hold_events
               where sale_id = %s and event like 'listing\\_changed%%' order by seq""",
            (sale_id,),
        ).fetchall()

    def describe(self, sale_id: str) -> str:
        row = self.row(sale_id)
        held = ", ".join(sorted(row["held_fields"] or {})) or "rien"
        return (
            f"pièces={row['rooms_count']} surface={row['surface_m2']}/{row['app_surface_m2']} "
            f"nature={row['app_surface_kind']} source={row['surface_source']} | champs tenus : {held}"
        )


@pytest.fixture
def registry(monkeypatch) -> Iterator[Registry]:
    url = _db_url()
    settings = {
        **load_settings(),
        "supabase_url": "http://127.0.0.1:9",  # jamais appelée : toute écriture passe par la connexion directe
        "supabase_service_role_key": "local-test-only",
        "supabase_db_url": url,
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    helper = Registry(url)
    try:
        yield helper
    finally:
        helper.close()


@pytest.fixture
def sent(monkeypatch) -> list[dict[str, Any]]:
    """Les lignes ``auction_sales`` que la collecte envoie réellement à la base."""
    rows: list[dict[str, Any]] = []
    real_write = storage._transaction_write

    def recording_write(table, payload, on_conflict=None, **kwargs):
        if table == "auction_sales":
            rows.extend(dict(row) for row in payload)
        return real_write(table, payload, on_conflict, **kwargs)

    monkeypatch.setattr(storage, "_transaction_write", recording_write)
    return rows


def _url() -> str:
    number = uuid.uuid4().int % 10**9
    return f"https://www.licitor.com/annonce/09/99/99/vente-aux-encheres/une-maison/alphaville/gironde/{number:09d}.html"


def _collect(raw: dict[str, Any], known: dict[str, dict[str, Any]]) -> AuctionSale:
    raws = [raw]
    pipeline._hydrate_known_unchanged_sales(raws, known)
    pipeline._preserve_known_enrichment_payloads(raws, known)
    record_source_checks(raws, known)
    sale = normalize_sale(raw)
    normalize_asset_features(sale)
    return sale


def _card(url: str, **values: Any) -> dict[str, Any]:
    return {
        "source_name": "licitor",
        "source_url": url,
        "sale_date": SALE_DATE,
        "starting_price_eur": 90000,
        "status": "upcoming",
        "city": "Alphaville",
        "postal_code": "33000",
        "address": "12 rue des Lilas, 33000 Alphaville",
        **values,
    }


def publish_listing(url: str) -> None:
    """Première collecte : l'annonce dit 50 m² et 2 pièces, bien occupé."""
    raw = _card(
        url, property_type="house", title="Une maison", surface_m2=50, rooms_count=2, bedrooms_count=1,
        occupancy_status="occupé", description="Une maison d'habitation de 50 m², 2 pièces, occupée.",
        raw_text="Une maison d'habitation de 50 m², 2 pièces, occupée.", source_detail_status="complete",
    )
    assert storage.upsert_sales_to_supabase([_collect(raw, {})]) == 1


def start_a_run_and_read(url: str) -> AuctionSale:
    """Début d'un passage : lecture des ventes connues, puis l'annonce est vue inchangée (fiche non relue)."""
    base_reads.reset()
    known = storage.fetch_known_sale_details()
    known.update(storage.fetch_known_sale_details(source_urls=[url], include_enrichment_payload=True))
    assert url in known
    return _collect(_card(url, _known_unchanged=True), known)


def without_the_guard(monkeypatch) -> None:
    monkeypatch.setattr(base_reads, "suppress_echo", lambda existing, incoming: incoming)


# --- A. Retrait pendant l'import --------------------------------------------------------------------------------------------


def _scenario_a(registry: Registry, label: str) -> tuple[str, AuctionSale]:
    url = _url()
    publish_listing(url)
    sale_id = registry.sale_id(url)
    say(f"{label}1 annonce publiée            : {registry.describe(sale_id)}")
    rooms = registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    surface = registry.accept(sale_id, SURFACE, 54, "2026-11-01 09:00+00")
    say(f"{label}2 deux pièces acceptées      : {registry.describe(sale_id)}")
    sale = start_a_run_and_read(url)
    say(f"{label}3 lu par la collecte         : pièces={sale.rooms_count} surface={sale.app_surface_m2}")
    assert (sale.rooms_count, sale.app_surface_m2) == (3, 54)
    registry.withdraw(sale_id, rooms, surface)
    say(f"{label}4 retrait pendant l'import   : {registry.describe(sale_id)}")
    assert storage.upsert_sales_to_supabase([sale]) == 1
    say(f"{label}5 après l'écriture collecte  : {registry.describe(sale_id)}")
    say(f"{label}6 évènements « annonce changée » : {registry.listing_events(sale_id)}")
    say(f"{label}7 simulation de projection   : changed={registry.project(sale_id, apply=False)['changed']}")
    return sale_id, sale


def test_scenario_a_a_value_withdrawn_during_the_import_does_not_come_back(registry, sent) -> None:
    say("\n=== A. Retrait pendant l'import, avec la garde d'écho ===")
    sale_id, _sale = _scenario_a(registry, "A")

    row = registry.row(sale_id)
    assert row["rooms_count"] == 2
    assert (row["surface_m2"], row["app_surface_m2"]) == (50, 50)
    assert row["surface_source"] != "fact_registry_lawyer_email"
    assert row["held_fields"] is None
    assert registry.listing_events(sale_id) == []
    assert registry.project(sale_id, apply=False)["changed"] is False
    # Ce que la collecte a envoyé : la valeur de la base au moment de l'écriture, pas celle lue avant le retrait.
    assert (sent[-1]["rooms_count"], sent[-1]["surface_m2"], sent[-1]["app_surface_m2"]) == (2, 50, 50)
    assert base_reads.suppressed_count() == 2
    say(f"A8 groupes retenus par la garde   : {base_reads.suppressed_count()} (pièces, surface)")


def test_scenario_a_without_the_guard_the_collection_sends_the_withdrawn_value(registry, sent, monkeypatch) -> None:
    """Témoin : le même scénario sans la garde. Seul l'envoi est affirmé ; l'effet en base dépend de sa retenue."""
    without_the_guard(monkeypatch)
    say("\n=== A (témoin). Même scénario sans la garde ===")
    _scenario_a(registry, "A'")

    assert (sent[-1]["rooms_count"], sent[-1]["surface_m2"], sent[-1]["app_surface_m2"]) == (3, 54, 54)


# --- B et C. Remplacement pendant l'import ---------------------------------------------------------------------------------


def _scenario_replacement(registry: Registry, label: str) -> tuple[str, str, str]:
    url = _url()
    publish_listing(url)
    sale_id = registry.sale_id(url)
    first = registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    say(f"{label}1 pièce « 3 pièces » posée   : {registry.describe(sale_id)}")
    say(f"{label}2 valeur d'annonce mémorisée : {registry.listing_memory(sale_id, ROOMS)}")
    sale = start_a_run_and_read(url)
    say(f"{label}3 lu par la collecte         : pièces={sale.rooms_count}")
    assert sale.rooms_count == 3
    second = registry.accept(sale_id, ROOMS, 4, "2026-11-02 09:00+00")
    say(f"{label}4 remplacée par « 4 pièces » : {registry.describe(sale_id)}")
    assert storage.upsert_sales_to_supabase([sale]) == 1
    say(f"{label}5 après l'écriture collecte  : {registry.describe(sale_id)}")
    say(f"{label}6 évènements « annonce changée » : {registry.listing_events(sale_id)}")
    say(f"{label}7 valeur d'annonce mémorisée : {registry.listing_memory(sale_id, ROOMS)}")
    return sale_id, first, second


def test_scenario_b_a_replaced_value_is_not_reported_as_a_listing_change(registry, sent) -> None:
    assert registry.setting(ROOMS) == "keep_and_review"
    say("\n=== B. Remplacement pendant l'import, réglage keep_and_review, avec la garde d'écho ===")
    sale_id, first, second = _scenario_replacement(registry, "B")

    assert registry.row(sale_id)["rooms_count"] == 4
    assert registry.listing_events(sale_id) == []
    assert registry.listing_memory(sale_id, ROOMS) == {"rooms_count": 2}
    assert sent[-1]["rooms_count"] == 4
    assert base_reads.suppressed_count() == 1

    registry.withdraw(sale_id, first, second)
    say(f"B8 après retrait des deux pièces  : {registry.describe(sale_id)}")
    # La fiche revient à ce que dit l'annonce : la valeur mémorisée n'a pas été faussée par l'écho.
    assert registry.row(sale_id)["rooms_count"] == 2
    assert registry.row(sale_id)["held_fields"] is None


def test_scenario_c_a_replaced_value_does_not_release_the_field(registry, sent) -> None:
    previous = registry.setting(ROOMS)
    registry.set_setting(ROOMS, "listing_wins_and_review")
    try:
        say("\n=== C. Remplacement pendant l'import, réglage listing_wins_and_review, avec la garde d'écho ===")
        sale_id, _first, _second = _scenario_replacement(registry, "C")

        assert registry.row(sale_id)["rooms_count"] == 4
        assert registry.listing_events(sale_id) == []
        assert ROOMS in (registry.row(sale_id)["held_fields"] or {})
        assert sent[-1]["rooms_count"] == 4
        state = registry.project(sale_id)["fields"][ROOMS]["state"]
        say(f"C8 reprojection                   : état={state} | {registry.describe(sale_id)}")
        # La pièce tient toujours le champ (« held » à la pose, « unchanged » quand rien n'est à réécrire) : la
        # décision de l'administrateur n'est pas défaite, la projection ne rend pas le champ à l'annonce.
        assert state in {"held", "unchanged"}
        assert registry.row(sale_id)["rooms_count"] == 4
        assert registry.row(sale_id)["held_fields"][ROOMS]["value"] == 4
    finally:
        registry.set_setting(ROOMS, previous)


@pytest.mark.parametrize("setting", ["keep_and_review", "listing_wins_and_review"])
def test_scenarios_b_and_c_without_the_guard_the_collection_sends_the_replaced_value(
    registry, sent, monkeypatch, setting
) -> None:
    """Témoin des scénarios B et C sans la garde. Seul l'envoi est affirmé ; l'effet en base est transcrit."""
    without_the_guard(monkeypatch)
    previous = registry.setting(ROOMS)
    registry.set_setting(ROOMS, setting)
    try:
        say(f"\n=== {'B' if setting == 'keep_and_review' else 'C'} (témoin). Même scénario sans la garde ({setting}) ===")
        sale_id, first, second = _scenario_replacement(registry, "T")
        assert sent[-1]["rooms_count"] == 3
        registry.withdraw(sale_id, first, second)
        say(f"T8 après retrait des deux pièces  : {registry.describe(sale_id)}")
    finally:
        registry.set_setting(ROOMS, previous)


# --- Régime permanent : rien ne bouge, la collecte écrit comme avant -----------------------------------------------------


def test_a_held_sale_is_rewritten_without_event_when_nothing_moves(registry, sent) -> None:
    say("\n=== Régime permanent : champ tenu, annonce inchangée, rien ne bouge pendant l'import ===")
    url = _url()
    publish_listing(url)
    sale_id = registry.sale_id(url)
    registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    registry.accept(sale_id, SURFACE, 54, "2026-11-01 09:00+00")
    before = registry.row(sale_id)

    for _passage in range(2):
        sale = start_a_run_and_read(url)
        # Publication anticipée, puis publication finale du même passage.
        for _publication in range(2):
            assert storage.upsert_sales_to_supabase([sale]) == 1
            assert (sent[-1]["rooms_count"], sent[-1]["app_surface_m2"]) == (3, 54)
            # Aucune valeur n'est retenue : la base rend à chaque fois ce que la collecte y avait lu.
            assert base_reads.suppressed_count() == 0

    say(f"P1 après deux passages            : {registry.describe(sale_id)}")
    assert registry.row(sale_id) == before
    assert registry.listing_events(sale_id) == []
    assert registry.project(sale_id, apply=False)["changed"] is False
