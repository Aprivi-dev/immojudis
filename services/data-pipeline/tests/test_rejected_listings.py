"""Cache des annonces refusées : une fiche refusée depuis moins de 7 jours n'est pas relue (aucune base réelle)."""

from datetime import UTC, datetime, timedelta

import pytest

from src import listing_minimum, rejected_listings
from src.autonomous_runner import PENDING_PUBLICATION_DECISIONS
from src.models import AuctionSale
from src.publication_identity import resolve_publication_identities
from src.reviewed_aliases import registry_from_rows
from src.sources.common import should_fetch_detail

URL = "https://www.vench.fr/vente-165184-une-maison-ondres.html"
NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)


def card(url: str = URL, **fields) -> dict:
    return {"source_name": "vench", "source_url": url, "city": "Ondres", "starting_price_eur": "50 000 €",
            "sale_date": "2026-12-10", **fields}


@pytest.fixture(autouse=True)
def cache(monkeypatch):
    """Cache actif, chargé depuis un dictionnaire plutôt que depuis la base."""
    monkeypatch.setenv("IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE", "on")
    monkeypatch.setattr(rejected_listings, "enabled", lambda: True)
    monkeypatch.setattr(rejected_listings, "_active", lambda: True)
    entries: dict = {}
    monkeypatch.setattr(rejected_listings, "_load", lambda: entries)
    monkeypatch.setattr("src.publication_identity.load_reviewed_aliases", lambda _connection: registry_from_rows([]))
    listing_minimum.reset_tally()
    yield entries
    listing_minimum.reset_tally()


def signature() -> str:
    from src.sources.common import listing_signature

    return listing_signature(card())


def test_a_listing_never_refused_is_read(cache) -> None:
    sale = card()
    assert should_fetch_detail(sale, {}) is True
    assert "_recently_rejected" not in sale and sale["_list_signature"] == signature()


def test_a_listing_refused_less_than_7_days_ago_is_not_read_again(cache) -> None:
    cache[URL] = (datetime.now(UTC) - timedelta(days=6, hours=23), signature())
    sale = card()
    assert should_fetch_detail(sale, {}) is False
    assert sale["_recently_rejected"] and sale["_known_unchanged"]


def test_after_7_days_the_page_is_read_again(cache) -> None:
    cache[URL] = (datetime.now(UTC) - timedelta(days=7, minutes=1), signature())
    assert should_fetch_detail(card(), {}) is True


def test_a_changed_card_is_read_again_before_7_days(cache) -> None:
    cache[URL] = (datetime.now(UTC) - timedelta(days=1), signature())
    assert should_fetch_detail(card(starting_price_eur="45 000 €"), {}) is True


def test_a_fragment_does_not_hide_a_refused_listing(cache) -> None:
    cache[URL] = (datetime.now(UTC) - timedelta(days=1), None)
    assert should_fetch_detail(card(url=URL + "#photos"), {}) is False


def test_a_listing_already_in_the_database_follows_the_known_rule_not_the_cache(cache) -> None:
    cache[URL] = (datetime.now(UTC) - timedelta(days=1), signature())
    sale = card()
    assert should_fetch_detail(sale, {URL: "another-signature"}) is True
    assert "_recently_rejected" not in sale


def test_the_cache_is_a_comfort_when_it_is_off(monkeypatch, cache) -> None:
    cache[URL] = (datetime.now(UTC) - timedelta(days=1), signature())
    monkeypatch.setattr(rejected_listings, "enabled", lambda: False)
    sale = card()
    assert should_fetch_detail(sale, {}) is True and "_list_signature" not in sale


# ------------------------------------------------------------------------------ écriture et résumé
class _Cursor:
    def __init__(self, calls):
        self.calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def executemany(self, query, rows):
        self.calls.append((query, list(rows)))


class _Transaction:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Connection:
    def __init__(self):
        self.calls = []

    def transaction(self):
        return _Transaction()

    def cursor(self):
        return _Cursor(self.calls)

    def execute(self, query, params=()):
        class Result:
            def fetchall(self):
                return []

        return Result()


def refused(**payload) -> AuctionSale:
    return AuctionSale(source_name="vench", source_url=URL, city="Ondres", address="40440 Ondres",
                       raw_payload={"_list_signature": "sig", **payload})


def test_a_listing_refused_after_reading_its_page_is_remembered() -> None:
    connection = _Connection()
    assert rejected_listings.remember(connection, [refused()]) == 1
    (query, rows), = connection.calls
    assert "app_private.rejected_listings" in query and rows == [(URL, "vench", "sig")]


def test_a_skipped_listing_does_not_renew_its_delay() -> None:
    connection = _Connection()
    assert rejected_listings.remember(connection, [refused(_recently_rejected=True)]) == 0
    assert connection.calls == []


def test_the_write_boundary_counts_a_skipped_listing_apart_and_keeps_it_out_of_the_rejections() -> None:
    skipped = refused(_recently_rejected=True, _known_unchanged=True)
    read = AuctionSale(source_name="vench", source_url=URL + "?2", city="Ondres", address="40440 Ondres")
    resolve_publication_identities(_Connection(), [skipped, read])
    summary = listing_minimum.summary()
    assert summary["skipped_recently_rejected"] == {"vench": 1} and summary["by_source"] == {"vench": 1}
    assert summary["total"] == 1


def test_a_skipped_listing_keeps_the_excluded_decision_so_the_source_inventory_is_unchanged(monkeypatch) -> None:
    recorded = []
    monkeypatch.setattr(
        "src.publication_identity.record_sale_decisions",
        lambda run_id, group, **kw: recorded.append((run_id, kw["decision"], kw["reason"])),
    )
    resolve_publication_identities(_Connection(), [refused(_recently_rejected=True).model_copy(update={"last_run_id": "run-1"})])
    assert recorded == [("run-1", "excluded", "insufficient_listing")]
    assert "excluded" not in PENDING_PUBLICATION_DECISIONS


def test_the_cache_table_is_purged_after_30_days_by_the_loader() -> None:
    import inspect

    source = inspect.getsource(rejected_listings)
    assert "purge_rejected_listings" in source


# ------------------------------------------------- clés techniques : jamais écrites en base
TECHNICAL = {"_list_signature": "sig", "_recently_rejected": True, "_known_unchanged": True}


def test_the_technical_keys_are_not_in_the_persistable_payload_and_the_original_is_untouched() -> None:
    payload = {"title": "Une maison", **TECHNICAL}

    assert rejected_listings.persistable_payload(payload) == {"title": "Une maison"}
    assert payload["_list_signature"] == "sig" and payload["_known_unchanged"] is True  # lus ensuite (refus, cache)
    clean = {"title": "x"}
    assert rejected_listings.persistable_payload(clean) is clean
    assert rejected_listings.persistable_payload(None) is None
    assert set(rejected_listings.TECHNICAL_KEYS) == set(TECHNICAL)


def test_observations_lose_the_technical_keys_of_their_payload() -> None:
    observations = [{"source_url": URL, "raw_payload": {"title": "x", **TECHNICAL}}, {"source_url": "u"}, "autre"]

    assert rejected_listings.persistable_observations(observations) == [
        {"source_url": URL, "raw_payload": {"title": "x"}},
        {"source_url": "u"},
        "autre",
    ]


def test_the_publication_never_writes_the_technical_keys(monkeypatch) -> None:
    from src.storage import supabase_client as storage

    sale = AuctionSale(
        source_name="vench", source_url=URL, city="Ondres", address="12 rue des Lilas 40440 Ondres",
        raw_payload={"title": "x", **TECHNICAL},
        observations=[{"source_name": "vench", "source_url": URL, "raw_payload": {"title": "x", **TECHNICAL}}],
    )
    written: list[dict] = []
    monkeypatch.setattr(storage, "tribunal_reference_rows", lambda _: [])
    monkeypatch.setattr(storage, "_upsert_with_rest", lambda _url, _key, rows: written.extend(rows))
    for name in ("_sync_normalized_sale_tables_with_rest", "_upsert_asset_tables_with_rest", "_enqueue_due_enrichment"):
        monkeypatch.setattr(storage, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(storage, "_write_fact_claims_rest", lambda *args, **kwargs: 0)
    monkeypatch.setattr(storage.internal_contacts, "write_safely", lambda *args, **kwargs: None)

    storage._write_sale_revisions([sale], {"supabase_url": "https://db.test", "supabase_service_role_key": "k"},
                                  refresh_last_seen=True)

    assert len(written) == 1
    assert not set(TECHNICAL) & set(written[0]["raw_payload"])
    assert not any(set(TECHNICAL) & set(item["raw_payload"]) for item in written[0].get("observations", []))
    # La vente en mémoire garde ses clés : le refus et le cache les lisent après l'écriture.
    assert sale.raw_payload["_known_unchanged"] is True


def test_the_observation_rows_never_carry_the_technical_keys(monkeypatch) -> None:
    from src.storage import supabase_client as storage

    sale = AuctionSale(
        source_name="vench", source_url=URL, city="Ondres", address="12 rue des Lilas 40440 Ondres",
        starting_price_eur=50000, raw_payload={"title": "x", **TECHNICAL},
    )
    written: list[dict] = []
    monkeypatch.setattr(storage, "load_settings", lambda: {
        "supabase_url": "https://db.test", "supabase_service_role_key": "k", "supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(storage, "_postgres_upsert", lambda _db, _table, rows, **_kw: written.extend(rows) or len(rows))

    assert storage.upsert_observations_to_supabase([sale]) == 1
    assert written and not set(TECHNICAL) & set(written[0]["raw_payload"])
    assert sale.raw_payload["_list_signature"] == "sig"
