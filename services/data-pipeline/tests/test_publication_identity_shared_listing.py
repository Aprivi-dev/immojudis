"""Identité persistée d'une annonce Vench / Petites Affiches : fusion en mémoire de deux lignes déjà stockées."""

import os

import pytest

from src.dedupe import merge_duplicate_sales
from src.normalize import normalize_sale
from src.publication_identity import _candidate_lock_query, resolve_publication_identities
from src.reviewed_aliases import registry_from_rows
from src.storage.supabase_client import _postgres_connect

VENCH_URL = "https://www.vench.fr/vente-166526-une-maison-ondres.html"
PA_URL = (
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/"
    "une-maison-a-ondres-166526.html"
)


@pytest.fixture(autouse=True)
def isolate_reviewed_alias_registry(monkeypatch):
    monkeypatch.setattr("src.publication_identity.load_reviewed_aliases", lambda _connection: registry_from_rows([]))


@pytest.fixture
def db():
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as connection:
        try:
            connection.execute(
                """create table auction_sales(id uuid default gen_random_uuid(),source_url text primary key,
                source_urls jsonb,source_name text,postal_code text,content_hash text,
                address text,city text,starting_price_eur numeric,sale_date timestamptz,
                raw_payload jsonb default '{}',status text default 'active',
                quality_flags jsonb default '[]',updated_at timestamptz)"""
            )
            yield connection
        finally:
            connection.rollback()


def _incoming(source_name: str, url: str, **extra):
    return normalize_sale(
        {
            "source_name": source_name,
            "source_url": url,
            "city": "Ondres",
            "postal_code": "40440",
            "property_type": "house",
            "starting_price_eur": 50000,
            "sale_date": "2026-11-10T14:00:00+01:00",
            **extra,
        }
    )


def _insert(db, source_name: str, url: str, *, city="Ondres", postal_code="40440", price=50000) -> str:
    return str(
        db.execute(
            """insert into auction_sales(source_url,source_urls,source_name,postal_code,city,
            starting_price_eur,sale_date) values (%s,%s::jsonb,%s,%s,%s,%s,'2026-11-10T14:00:00+01:00')
            returning id""",
            (url, f'["{url}"]', source_name, postal_code, city, price),
        ).fetchone()[0]
    )


def _statuses(db) -> dict[str, str]:
    def text(value):
        return value.decode() if isinstance(value, bytes) else value

    rows = db.execute("select source_url,status from auction_sales").fetchall()
    return {text(url): text(status) for url, status in rows}


def test_two_persisted_rows_merged_in_one_run_are_not_quarantined(db) -> None:
    vench_id = _insert(db, "vench", VENCH_URL)
    _insert(db, "petites_affiches", PA_URL)
    merged = merge_duplicate_sales([_incoming("vench", VENCH_URL), _incoming("petites_affiches", PA_URL)])
    assert len(merged) == 1 and set(merged[0].source_urls) == {VENCH_URL, PA_URL}

    result = resolve_publication_identities(db, merged)

    # Les deux annonces ne disparaissent pas : la ligne de priorité la plus haute (Vench) reçoit la
    # fusion, l'autre reste visible jusqu'au balayage de réconciliation.
    assert [row.source_url for row in result] == [VENCH_URL]
    assert result[0].id == vench_id
    assert {VENCH_URL, PA_URL} <= set(result[0].source_urls)
    assert "property_identity_conflict" not in result[0].quality_flags
    assert result[0].status != "quarantined"
    assert _statuses(db) == {VENCH_URL: "active", PA_URL: "active"}


def test_primary_row_does_not_depend_on_arrival_order(db) -> None:
    _insert(db, "petites_affiches", PA_URL)
    vench_id = _insert(db, "vench", VENCH_URL)
    merged = merge_duplicate_sales([_incoming("petites_affiches", PA_URL), _incoming("vench", VENCH_URL)])

    result = resolve_publication_identities(db, merged)

    assert [(row.source_url, row.id) for row in result] == [(VENCH_URL, vench_id)]


def test_rows_claimed_together_without_a_shared_listing_link_stay_ambiguous(db) -> None:
    _insert(db, "licitor", "https://example.test/a")
    _insert(db, "avoventes", "https://example.test/b")
    incoming = _incoming("licitor", "https://example.test/a")
    incoming.source_urls = ["https://example.test/a", "https://example.test/b"]

    assert resolve_publication_identities(db, [incoming]) == []
    assert set(_statuses(db).values()) == {"quarantined"}


def test_persisted_rows_with_the_same_listing_id_in_two_places_are_still_held(db) -> None:
    _insert(db, "vench", VENCH_URL)
    _insert(db, "petites_affiches", PA_URL, city="Lyon", postal_code="69003")
    incoming = _incoming("vench", VENCH_URL)
    incoming.source_urls = [VENCH_URL, PA_URL]

    assert resolve_publication_identities(db, [incoming]) == []
    assert set(_statuses(db).values()) == {"quarantined"}


def test_listing_id_lookup_finds_the_other_source_row_without_postal_code(db) -> None:
    pa_id = _insert(db, "petites_affiches", PA_URL, city="Ondres (40)", postal_code=None)
    # Un numéro voisin n'est jamais chargé par le motif (aucun verrou, aucune fusion).
    _insert(db, "petites_affiches", PA_URL.replace("166526", "1665261"), city="Ondres (40)", postal_code=None)

    result = resolve_publication_identities(db, [_incoming("vench", VENCH_URL)])

    assert [(row.source_url, row.id) for row in result] == [(PA_URL, pa_id)]
    assert VENCH_URL in result[0].source_urls


def test_listing_id_lookup_does_not_lock_unrelated_sources(db) -> None:
    # Même numéro dans l'URL d'une autre source : hors périmètre du motif Vench / Petites Affiches.
    _insert(db, "licitor", "https://www.licitor.com/annonce/10/90/00/x/166526.html", city="Lyon", postal_code="69003")
    rows = db.execute(*_candidate_lock_query([VENCH_URL], [], [], [], ["166526"])).fetchall()

    assert rows == []


def test_candidate_lock_query_isolates_the_unindexable_listing_pattern() -> None:
    without_listing, params = _candidate_lock_query(["u"], ["40440"], ["h"], [], [])
    assert " like " not in without_listing and len(params) == 5

    sql, params = _candidate_lock_query(["u"], ["40440"], ["h"], [], ["166526"])
    # Le motif à joker initial vit dans sa propre branche, filtrée par source et limitée.
    assert sql.count(" like any(") == 2 and "union (select" in sql and "limit %s" in sql
    assert sql.index("union") > sql.index("a.content_hash") and sql.rstrip().endswith("for no key update")
    assert params[-1] == 10
    assert ["%/vente-166526-%"] in params and ["%-166526.html%"] in params
    assert "vench" in params and "petites_affiches" in params
