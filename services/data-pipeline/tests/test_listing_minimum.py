"""Minimum d'une annonce pour entrer en base : voie ou lieu-dit, email de contact, pièce, autre source."""

import pytest

from src import listing_minimum
from src.autonomous_runner import PENDING_PUBLICATION_DECISIONS, STUCK_PUBLICATION_DECISIONS
from src.listing_minimum import assess, has_contact_email, has_listing_minimum, has_street_or_lieu_dit
from src.models import AuctionSale
from src.publication_identity import resolve_publication_identities
from src.retention_tombstones import publish_batch
from src.reviewed_aliases import registry_from_rows
from src.source_health import failed_sources

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


def test_one_document_is_enough() -> None:
    verdict = assess(sale(documents=[{"label": "Cahier des conditions", "url": "https://example.test/c.pdf"}]))
    assert verdict.ok and verdict.basis == ("documents",)


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
