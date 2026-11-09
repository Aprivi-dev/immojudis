"""Contrôles de rédaction des textes publics (nature de la vente, absences, occupation, remplissage).

Ils gardent le résumé du modèle avant qu'il ne remplace la description d'une vente.

Les fixtures reprennent les cas réels de l'audit du 11/10/2026 (identifiants
abrégés en commentaire).
"""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src.enrichment.display_evidence import verify_display_claims
from src.enrichment.display_facts import sale_nature
from src.models import AuctionSale


def _sale(**fields) -> AuctionSale:
    fields.setdefault("source_url", "https://example.test/sale")
    return AuctionSale(**fields)


def _issues(text: str, sale: AuctionSale, evidence: str = "") -> list[dict]:
    return verify_display_claims(text, evidence, sale.model_dump())["issues"]


def _codes(text: str, sale: AuctionSale, evidence: str = "") -> set[str]:
    return {issue["code"] for issue in _issues(text, sale, evidence)}


def _toulouse() -> AuctionSale:  # cessions_etat 174bc9a3
    return _sale(
        source_name="cessions_etat",
        sale_venue_type="state",
        sale_legal_framework="state_sale",
        sale_verification_status="cross_checked",
        property_type="building",
        city="Toulouse",
        postal_code="31000",
        surface_m2=Decimal("5256"),
        rooms_count=5,
        sale_date=datetime(2026, 11, 26, 15, tzinfo=UTC),
    )


def _seyssuel() -> AuctionSale:  # notaires 6a486c10, « VENTE AU PRIX – PAS D'ENCHERES »
    return _sale(
        source_name="notaires",
        sale_venue_type="notary",
        sale_verification_status="cross_checked",
        property_type="land",
        surface_m2=Decimal("608"),
        starting_price_eur=Decimal("150000"),
        occupancy_status="vacant",
        raw_payload={"source_description": "VENTE AU PRIX – PAS D’ENCHERES SUR CE BIEN -- Terrain à bâtir – SEYSSUEL"},
    )


def _beauvais() -> AuctionSale:  # agrasc 8d70e322, lieu « tribunal » non vérifié
    return _sale(
        source_name="agrasc",
        sale_venue_type="tribunal",
        sale_verification_status="pending",
        property_type="house",
        surface_m2=Decimal("55"),
        rooms_count=3,
        starting_price_eur=Decimal("120000"),
        sale_date=datetime(2026, 10, 28, tzinfo=UTC),
    )


def _montpellier() -> AuctionSale:  # encheres_immobilieres fef201cf, source : « Occupé »
    return _sale(
        source_name="encheres_immobilieres",
        sale_venue_type="tribunal",
        sale_verification_status="cross_checked",
        property_type="apartment",
        rooms_count=4,
        occupancy_status="occupied",
    )


def _nogent() -> AuctionSale:  # notaires f9151f97, immo-interactif
    return _sale(
        source_name="notaires",
        sale_venue_type="notary",
        property_type="house",
        surface_m2=Decimal("76.72"),
        rooms_count=5,
        bedrooms_count=3,
        starting_price_eur=Decimal("58800"),
        sale_date=datetime(2026, 10, 30, 17, 30, tzinfo=UTC),
        occupancy_status="vacant",
        raw_payload={
            "source_property_features": {"sale_conditions": {"transaction_type": "VNI"}},
            "source_energy_diagnostics": {"dpe_class": "G", "ges_class": "G"},
        },
    )


# --- nature de la vente ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sale,code",
    [
        (_toulouse(), "state"),
        (_beauvais(), "agrasc"),
        (_seyssuel(), "fixed_price"),
        (_nogent(), "notarial_interactive"),
        (_montpellier(), "judicial"),
        (
            _sale(source_name="notaires", sale_venue_type="notary", sale_legal_framework="judicial_partition"),
            "notarial_judicial",
        ),
        (_sale(source_name="petites_affiches"), "unknown"),
    ],
)
def test_sale_nature_follows_source_and_procedure(sale, code):
    assert sale_nature(sale).code == code
    assert sale_nature(sale.model_dump()).code == code


# --- absence_claim_contradicted -------------------------------------------------------------------


def test_false_absences_of_known_surface_date_and_price_are_rejected():
    sale = _toulouse()
    text = (
        "Immeuble à Toulouse. Aucune information fiable concernant la surface exacte n'est fournie. "
        "La date de vente n'est pas précisée."
    )

    issues = [issue for issue in _issues(text, sale) if issue["code"] == "absence_claim_contradicted"]

    assert {issue["fields"] for issue in issues} == {"surface", "date"}


def test_absence_of_a_truly_unknown_field_is_not_a_contradiction():
    # 174bc9a3 has no starting price: the sentence is useless but not false.
    assert "absence_claim_contradicted" not in _codes("La mise à prix n'est pas précisée.", _toulouse())


def test_absence_must_share_the_clause_of_the_denied_field():
    sale = _sale(source_name="agrasc", surface_m2=Decimal("120"), starting_price_eur=Decimal("90000"))

    assert "absence_claim_contradicted" not in _codes("Maison de 120 m², sur mise à prix, visite à confirmer.", sale)
    assert "absence_claim_contradicted" in _codes("Maison dont la surface reste à vérifier.", sale)


# --- procedure_mismatch ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sale,text",
    [
        (_toulouse(), "Se reporter au gestionnaire pour la procédure judiciaire à venir."),  # 5f3944e5
        (_beauvais(), "La vente judiciaire est prévue le 28/10/2026."),  # 8d70e322
        (_nogent(), "Vente organisée devant le tribunal."),
        (_seyssuel(), "Vente au prix sans enchères, avec une mise à prix de 150 000 euros."),  # 6a486c10
    ],
)
def test_wrong_sale_nature_vocabulary_is_rejected(sale, text):
    assert "procedure_mismatch" in _codes(text, sale)


@pytest.mark.parametrize(
    "sale,text",
    [
        (_montpellier(), "Vente judiciaire au tribunal, sur mise à prix."),
        (_seyssuel(), "Terrain vendu au prix de 150 000 € sans enchères."),
        (_beauvais(), "Bien confisqué, ce n'est pas une vente au tribunal."),
        (
            _sale(source_name="notaires", sale_venue_type="notary", sale_legal_framework="judicial_partition"),
            "Licitation judiciaire devant notaire.",
        ),
        (_toulouse(), "Cession de l'État. Source : « bien affecté au tribunal administratif »"),
        (_sale(source_name="petites_affiches"), "Vente judiciaire."),
    ],
)
def test_matching_or_negated_or_quoted_vocabulary_is_accepted(sale, text):
    assert "procedure_mismatch" not in _codes(text, sale)


# --- occupancy_qualifier_unsupported --------------------------------------------------------------


def test_invented_owner_or_tenant_qualifier_is_rejected():
    sale = _montpellier()
    evidence = "Appartement de quatre pièces. Occupé."

    assert "occupancy_qualifier_unsupported" in _codes(
        "Appartement actuellement occupé par le propriétaire.", sale, evidence
    )
    assert "occupancy_qualifier_unsupported" in _codes("Appartement loué, bail en cours.", sale, evidence)
    assert "occupancy_qualifier_unsupported" not in _codes("Appartement de quatre pièces, occupé.", sale, evidence)


def test_occupancy_qualifier_with_matching_source_terms_is_accepted():
    sale = _montpellier()

    assert not _codes("Appartement occupé par ses propriétaires.", sale, "Bien occupé par les propriétaires.")
    assert not _codes("Appartement loué, bail en cours.", sale, "Bien loué selon bail du 1er mars 2020.")
    assert "occupancy_qualifier_unsupported" not in _codes(
        "Maison libre de tout bail.",
        _sale(source_name="licitor", occupancy_status="vacant"),
        "Libre.",
    )
    # The State owning the property is not an occupancy qualifier.
    assert "occupancy_qualifier_unsupported" not in _codes("L'État, propriétaire, cède ce bâtiment.", _toulouse())


# --- liste noire ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Les enchères doivent être portées par un avocat.",  # vench c3f328b2
        "Les frais préalables seront connus une semaine avant la vente.",  # avoventes bc8fec6b
        "Les modalités de surenchère et de consignation sont à confirmer.",  # vench 3852a95d
        "La description repose sur une annonce non officielle dont le contenu n'est pas certifié.",  # licitor 45f7494a
        "Il convient de se rapprocher du gestionnaire.",  # cessions_etat 5f3944e5
        "L'absence de plan et de visite virtuelle limite la vérification visuelle.",
        "S'adresser à Maître Sandrine FUSTER.",  # info_encheres c137bbaa
    ],
)
def test_generic_filler_is_rejected(text):
    assert "filler_claim" in _codes(text, _montpellier())


def test_factual_text_is_not_filler():
    text = "Appartement de 4 pièces à Montpellier, vendu aux enchères, occupé."
    assert not _codes(text, _montpellier(), "Appartement de 4 pièces. Occupé.")


# --- pièces : faux positif « une pièce » ----------------------------------------------------------


def test_a_single_room_mention_is_not_a_room_count():  # notaires f9151f97
    sale = _nogent()

    assert "unsupported_rooms" not in _codes("Maison de 5 pièces avec une pièce pouvant faire office de bureau.", sale)
    assert "unsupported_rooms" in _codes("Studio d'une pièce.", sale)
    assert "unsupported_rooms" in _codes("Maison de 6 pièces.", sale)
    assert "unsupported_rooms" in _codes("Maison comprenant deux pièces.", sale)


# --- montants « prix » et « 1ère offre » ----------------------------------------------------------


def test_amounts_labelled_prix_or_first_offer_are_accepted_without_starting_price():
    sale = _sale(source_name="notaires", sale_venue_type="notary")  # 2335f176 / 40b7ecbb

    assert "unsupported_money" not in _codes("Prix de 260 000 euros.", sale, "VNI Prix : 260.000")
    assert "unsupported_money" not in _codes(
        "Première offre possible de 230 000 €.",
        sale,
        "1ère offre possible : à partir de 230 000,00 euros",
    )
    assert "unsupported_money" in _codes("Prix de 260 000 euros.", sale, "Maison de 119 m².")


def test_structured_first_offer_supports_the_amount():
    sale = _sale(
        source_name="notaires",
        raw_payload={"source_property_features": {"sale_conditions": {"first_offer_eur": 54500}}},
    )

    assert "unsupported_money" not in _codes("Première offre possible : 54 500 €.", sale)
