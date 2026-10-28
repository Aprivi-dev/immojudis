"""Minimum d'une annonce pour entrer en base : voie ou lieu-dit, email de contact, pièce, autre source."""

import re
from pathlib import Path

import pytest

from src import listing_minimum
from src.autonomous_runner import PENDING_PUBLICATION_DECISIONS, STUCK_PUBLICATION_DECISIONS
from src.listing_minimum import assess, has_contact_email, has_listing_minimum, has_street_or_lieu_dit
from src.models import AuctionSale
from src.position_quality import _ABBREVIATIONS, _LEADING_STREET_TYPES
from src.publication_identity import resolve_publication_identities
from src.retention_tombstones import publish_batch
from src.reviewed_aliases import registry_from_rows
from src.source_health import failed_sources
from src.sources.avoventes_extraction import extract_avoventes_html_extras
from src.sources.info_encheres_extraction import _cadastre as info_encheres_cadastre
from src.sources.notaires_extraction import cadastre_location

VENCH = "https://www.vench.fr/vente-165184-une-maison-ondres.html"
PA = "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/une-maison-a-ondres-165184.html"


def sale(url: str = VENCH, source: str = "vench", **fields) -> AuctionSale:
    values = {"source_name": source, "source_url": url, "city": "Ondres", "address": "40440 Ondres"} | fields
    return AuctionSale(**values)


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE", "on")
    monkeypatch.setattr("src.publication_identity.load_reviewed_aliases", lambda _connection: registry_from_rows([]))
    listing_minimum.reset_tally()
    yield
    listing_minimum.reset_tally()


# ---------------------------------------------------------------------------------------- la règle
@pytest.mark.parametrize(
    ("address", "city", "expected"),
    [
        ("12 rue des Lilas 33000 Bordeaux", "Bordeaux", True),
        ("Rue du Château, 33000 Bordeaux", "Bordeaux", True),
        ("3 pl. du Marché 40440 Ondres", "Ondres", True),
        ("Lieu-dit Le Bourg, 40440 Ondres", "Ondres", True),
        ("Les Prés Exemple, 18150 Autreville", "Autreville", True),
        ("40440 Ondres", "Ondres", False),
        ("75006 PARIS", "Paris", False),
        ("Boulogne-Billancourt (92)", "Boulogne-Billancourt", False),
        # Une commune dont le nom contient un mot de lieu-dit n'est pas un lieu-dit.
        ("02400 CHÂTEAU-THIERRY", "Château-Thierry", False),
        ("", "Ondres", False),
        (None, None, False),
    ],
)
def test_street_or_lieu_dit_never_the_commune_alone(address, city, expected) -> None:
    assert has_street_or_lieu_dit(address, city) is expected


def test_listing_with_only_the_commune_is_refused() -> None:
    verdict = assess(sale())
    assert not verdict.ok and verdict.reason == listing_minimum.REASON and verdict.basis == ()


def test_a_street_alone_is_enough() -> None:
    verdict = assess(sale(address="12 rue des Lilas 40440 Ondres"))
    assert verdict.ok and verdict.basis == ("street",)


def test_a_lawyer_name_or_a_phone_alone_is_not_enough() -> None:
    assert not has_listing_minimum(sale(lawyer_name="SELARL Cabinet Modèle (Maître Léa MODÈLE)"))
    assert not has_listing_minimum(sale(lawyer_contact="05 00 00 00 15"))
    assert not has_listing_minimum(sale(lawyer_name="Maître X", lawyer_contact="05 00 00 00 15 · https://cabinet.example"))


def test_an_email_in_the_contact_is_enough() -> None:
    verdict = assess(sale(lawyer_contact="05 00 00 00 15 · contact@cabinet-modele.example"))
    assert verdict.ok and verdict.basis == ("email",)


def test_a_masked_or_invalid_email_is_not_an_email() -> None:
    assert not has_contact_email(sale(lawyer_contact="[email protected]"))
    assert not has_contact_email(sale(lawyer_contact="contact@cabinet"))
    assert not has_contact_email(sale(lawyer_contact="contact@"))


@pytest.mark.parametrize(
    "address",
    [
        "greffe@tj-bordeaux.justice.fr",
        "cabinet@avocat-conseil.fr",
        "ordre@barreau-bordeaux.example",
        "noreply@cabinet.example",
    ],
)
def test_addresses_the_information_agent_never_writes_to_do_not_count(address: str) -> None:
    assert not has_contact_email(sale(lawyer_contact=address))


def test_the_email_may_sit_in_the_lawyer_source_block() -> None:
    found = sale(raw_payload={"source_blocks": {"contact_avocat": "Tél 05 00 00 00 15 contact@cabinet-modele.example"}})
    assert has_contact_email(found)


def test_the_email_is_found_in_nested_contact_blocks_like_the_agent_does() -> None:
    nested_dict = sale(raw_payload={"source_blocks": {"contact_avocat": {"phone": "05 00 00 00 15", "email": "contact@cabinet-modele.example"}}})
    nested_list = sale(raw_payload={"source_blocks": {"contacts": [{"role": "avocat", "mail": "contact@cabinet-modele.example"}]}})
    deep = sale(raw_payload={"source_blocks": {"cabinet": {"coordonnees": [{"detail": {"email": "contact@cabinet-modele.example"}}]}}})
    assert has_contact_email(nested_dict) and has_contact_email(nested_list) and has_contact_email(deep)
    assert assess(nested_dict).basis == ("email",)


def test_a_nested_block_is_read_like_the_agent_reads_it() -> None:
    # Une chaîne directement dans une liste est ignorée par l'agent (information_sufficiency._string_leaves).
    assert not has_contact_email(sale(raw_payload={"source_blocks": {"contacts": ["contact@cabinet-modele.example"]}}))
    # Un bloc de texte de la page n'est pas un bloc de contact, imbriqué ou non.
    assert not has_contact_email(sale(raw_payload={"source_blocks": {"page_text": {"footer": "contact@site-exemple.example"}}}))
    # Une adresse que l'agent n'écrit jamais ne compte pas, même imbriquée.
    assert not has_contact_email(sale(raw_payload={"source_blocks": {"contact": {"email": "greffe@tj-bordeaux.justice.fr"}}}))


def test_one_document_is_enough() -> None:
    verdict = assess(sale(documents=[{"label": "Cahier des conditions", "url": "https://example.test/c.pdf"}]))
    assert verdict.ok and verdict.basis == ("documents",)


def test_a_cadastral_reference_is_enough_without_a_street() -> None:
    located = sale(
        source_name="cessions_etat",
        raw_payload={"cadastre_location": {"candidates": [{"parcels": ["AC 272"]}], "designation": "Parcelle AC 272"}},
    )
    assert assess(located).basis == ("cadastre",)
    in_tree = sale(raw_payload={"source_property_features": {"cadastre_location": {"candidates": [{"parcels": ["B 12"]}]}}})
    assert assess(in_tree).basis == ("cadastre",)
    published = sale(raw_payload={"source_blocks": {"reference_cadastrale": "AC 272 et AC 829"}})
    assert assess(published).basis == ("cadastre",)


@pytest.mark.parametrize(
    "address",
    ["Section AB n° 123 Autreville", "AB 123", "Cadastre AB 123 18150 Autreville"],
)
def test_an_address_that_is_a_cadastral_reference_is_enough(address: str) -> None:
    verdict = assess(sale(city="Autreville", address=address))
    assert verdict.ok and verdict.basis == ("cadastre",)


def test_every_cadastre_location_form_of_every_source_counts() -> None:
    """Cessions/notaires/Petites Affiches (candidates), Avoventes (parcels), Info-Enchères (references)."""
    notaires = cadastre_location("Parcelle cadastrée section AB n° 12", "33999", "Exempleville")
    avoventes = extract_avoventes_html_extras(
        '''<script>var geojsonFeature = [{"type":"Feature","properties":{"numero":"0695","section":"0D",
        "code_insee":"60000","nom_com":"Exempleville","idu":"600000000D0695","contenance":592}}];
        </script>'''
    )["cadastre"]
    info_encheres = info_encheres_cadastre("Un appartement. Cadastré section BY 69 : UN APPARTEMENT", "Autreville")
    assert notaires and "candidates" in notaires
    assert avoventes and "parcels" in avoventes and "candidates" not in avoventes
    assert info_encheres and "references" in info_encheres and "candidates" not in info_encheres
    for location in (notaires, avoventes, info_encheres):
        in_tree = sale(raw_payload={"source_property_features": {"cadastre_location": location}})
        at_root = sale(raw_payload={"cadastre_location": location})
        assert assess(in_tree).basis == ("cadastre",), location
        assert assess(at_root).basis == ("cadastre",), location


@pytest.mark.parametrize(
    "location",
    [
        {"parcels": [], "designation": "Parcelle"},
        {"references": [], "designation": "Parcelle", "raw": "Cadastré"},
        {"candidates": [{"parcels": []}], "parcels": None, "references": None},
        {"parcels": "AB 12"},
        "AB 12",
    ],
)
def test_a_cadastre_location_without_a_parcel_is_not_a_location(location) -> None:
    assert not has_listing_minimum(sale(raw_payload={"cadastre_location": location}))
    assert not has_listing_minimum(sale(raw_payload={"source_property_features": {"cadastre_location": location}}))


def test_a_cadastral_block_without_a_parcel_is_not_a_location() -> None:
    assert not has_listing_minimum(sale(raw_payload={"source_blocks": {"reference_cadastrale": "Ondres"}}))
    assert not has_listing_minimum(sale(raw_payload={"cadastre_location": {"candidates": [], "designation": "Ondres"}}))


def test_another_source_is_enough_by_url_host_or_by_observation() -> None:
    merged = sale(source_urls=[VENCH, PA])
    assert assess(merged).basis == ("other_source",)
    observed = sale(
        observations=[{"source_name": "vench", "source_url": VENCH}, {"source_name": "licitor", "source_url": "x"}]
    )
    assert assess(observed).basis == ("other_source",)
    # Deux adresses de la même source n'en font pas deux.
    assert not has_listing_minimum(sale(source_urls=[VENCH, VENCH.replace("165184", "165185")]))
    assert not has_listing_minimum(sale(source_urls=[VENCH, VENCH.replace("https://www.", "https://")]))


def test_a_listing_whose_detail_page_was_not_read_is_not_judged_empty() -> None:
    unread = sale(raw_payload={"_detail_fetch_failed": True, "source_detail_status": "failed"})
    verdict = assess(unread)
    assert not verdict.ok and verdict.detail_unread and verdict.reason == listing_minimum.REASON_DETAIL_UNREAD


# -------------------------------------------------------------------- l'écriture (identité persistée)
class _Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _Connection:
    """Base simulée : les lignes déjà en base."""

    def __init__(self, rows=()):
        self.rows = list(rows)

    def execute(self, query, params=()):
        if "for no key update" in query:
            return _Result([(row["id"],) for row in self.rows])
        if "to_jsonb" in query:
            return _Result([(row,) for row in self.rows])
        return _Result([])


def stored(url: str, **fields) -> dict:
    return {
        "id": "11111111-1111-4111-8111-111111111111",
        "source_url": url,
        "source_urls": [url],
        "source_name": "vench",
        "city": "Ondres",
        "postal_code": "40440",
        "address": "40440 Ondres",
        **fields,
    }


def other_listing() -> AuctionSale:
    return sale("https://www.vench.fr/vente-2-une-maison-ondres.html", address="2 rue Haute 40440 Ondres")


def test_a_new_empty_listing_is_not_written_and_is_counted_by_source() -> None:
    empty, kept = sale(), other_listing()
    with listing_minimum.collecting() as refused:
        resolved = resolve_publication_identities(_Connection(), [empty, kept])
    assert resolved == [kept] and refused == [empty]
    counted = listing_minimum.summary()
    assert counted["total"] == 1 and counted["by_source"] == {"vench": 1} and counted["examples"] == {"vench": [VENCH]}


def test_a_refusal_is_counted_once_per_pass_even_when_written_twice() -> None:
    for _ in range(2):
        resolve_publication_identities(_Connection(), [sale()])
    assert listing_minimum.summary()["by_source"] == {"vench": 1}


def test_a_listing_already_in_the_database_is_never_refused_when_it_loses_its_minimum() -> None:
    # La ligne stockée avait un email de contact ; la fiche ne le publie plus : elle reste et se rafraîchit.
    existing = stored(VENCH, lawyer_contact="contact@cabinet-modele.example")
    with listing_minimum.collecting() as refused:
        resolved = resolve_publication_identities(_Connection([existing]), [sale()])
    assert [row.source_url for row in resolved] == [VENCH] and refused == []
    assert listing_minimum.summary()["total"] == 0


def test_an_empty_listing_with_nothing_to_attach_to_is_refused_even_next_to_another_source() -> None:
    other = stored(PA, source_name="petites_affiches", address="2 rue Haute 40440 Ondres")
    other["id"] = "22222222-2222-4222-8222-222222222222"
    incoming = sale()
    with listing_minimum.collecting() as refused:
        resolved = resolve_publication_identities(_Connection([other]), [incoming])
    assert refused == [incoming] and resolved == []


def test_refusals_are_recorded_as_excluded_in_the_publication_transaction(monkeypatch) -> None:
    recorded = []
    monkeypatch.setattr(
        "src.publication_identity.record_sale_decisions",
        lambda run_id, group, **kw: recorded.append(
            (run_id, [item.source_url for item in group], kw["decision"], kw["reason"])
        ),
    )
    resolve_publication_identities(_Connection(), [sale(last_run_id="run-1")])
    assert recorded == [("run-1", [VENCH], "excluded", "insufficient_listing")]


def test_publish_batch_forgets_refused_listings_and_does_not_publish_them() -> None:
    empty, kept = sale(), other_listing()
    run_list = [empty, kept]
    connection = _Connection()
    written = []

    def publish(group):
        resolved = resolve_publication_identities(connection, group)
        written.extend(item.source_url for item in resolved)
        return len(resolved)

    result = publish_batch([empty, kept], publish, "run-1", lambda *a, **k: None, {}, run_list)
    assert written == [kept.source_url] and result.count == 1 and result.sales == [kept]
    assert run_list == [kept]  # pas enrichie, pas republiée en fin de passage


# ------------------------------------------------------------------------- santé des sources
def test_the_decision_given_to_a_refusal_never_blocks_publication_or_counts_as_a_failure() -> None:
    assert "excluded" not in PENDING_PUBLICATION_DECISIONS
    assert "excluded" not in STUCK_PUBLICATION_DECISIONS


def test_a_source_whose_listings_are_all_refused_is_not_reported_broken() -> None:
    # Le refus intervient après la collecte : le nombre d'annonces collectées de la source ne change pas.
    assert failed_sources(["vench"], {"vench": 326}, {"vench": []}) == {}


# ------------------------------------------------------- parité avec la règle SQL (suppression définitive)
MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "supabase/migrations/20261108202000_listing_minimum_and_empty_listing_cleanup.sql"
)


def _sql_leading_street_types() -> set[str]:
    text = MIGRATION.read_text(encoding="utf-8")
    block = text[text.index("v_leading constant text :="):]
    block = block[: block.index(";")]
    return set("".join(re.findall(r"'([^']*)'", block)).split("|"))


def test_the_sql_street_types_cover_everything_the_python_rule_reads() -> None:
    """La suppression SQL est définitive : elle garde au moins tout ce que garde le Python.

    Le Python ramène les abréviations au mot entier (``position_quality._ABBREVIATIONS``) avant de chercher le
    type de voie : « Bvd Foch » est une voie. Chaque mot que le Python accepte en tête doit figurer dans la liste SQL.
    """
    accepted = set(_LEADING_STREET_TYPES) | {
        abbreviation for abbreviation, full in _ABBREVIATIONS.items() if full in _LEADING_STREET_TYPES
    }
    assert accepted - _sql_leading_street_types() == set()


@pytest.mark.parametrize(
    "address",
    ["12 Bvd Foch 75001 Paris", "5 Esp. de la Paix 40440 Ondres", "Crs Gambetta 33000 Bordeaux", "3 Boul. Gambetta 33000 Bordeaux"],
)
def test_the_python_rule_reads_the_abbreviations_the_sql_rule_must_keep(address: str) -> None:
    assert has_street_or_lieu_dit(address, "Ville")


def test_the_sql_rule_reads_the_three_cadastre_location_forms() -> None:
    text = MIGRATION.read_text(encoding="utf-8")
    for path in ("$.candidates[*].parcels[*]", "$.parcels[*]", "$.references[*]"):
        assert path in text
    assert tuple(listing_minimum._FLAT_PARCEL_KEYS) == ("parcels", "references")
