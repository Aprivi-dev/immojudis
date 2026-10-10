"""Règle de rétention « informations suffisantes » : cas fictifs uniquement (aucune donnée réelle)."""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from src.information_sufficiency import (
    NO_BLOCKLIST,
    ContactBlocklist,
    build_blocklist,
    contact_emails,
    publication_gate,
    sufficient_information,
    summarize_verdicts,
    usable_contact_emails,
)
from src.models import AuctionSale

FIXTURES = Path(__file__).parent / "fixtures" / "information_agent_contact_cases.json"
PARITY_CASES = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]


def make_sale(**fields) -> AuctionSale:
    base = {"source_name": "licitor", "source_url": "https://example.test/vente/1", "city": "Exempleville"}
    base.update(fields)
    return AuctionSale(**base)


@pytest.mark.parametrize("case", PARITY_CASES, ids=[case["name"] for case in PARITY_CASES])
def test_python_mirror_matches_the_typescript_contact_resolver_cases(case):
    observations = [
        {"raw_payload": {"source_blocks": blocks}}
        for blocks in case.get("observation_source_blocks", [])
        if isinstance(blocks, dict)
    ]
    raw_payload: dict = {}
    if case.get("source_blocks") is not None:
        raw_payload["source_blocks"] = case["source_blocks"]
    if case.get("source_description") is not None:
        raw_payload["source_description"] = case["source_description"]
    sale = make_sale(
        lawyer_contact=case.get("lawyer_contact"),
        description=case.get("description"),
        raw_payload=raw_payload,
        observations=observations,
    )
    assert sorted(contact_emails(sale)) == sorted(case["expected"])


def test_address_and_surface_are_enough_without_any_email():
    sale = make_sale(address="12 rue des Lilas, 59000 Exempleville", surface_m2=Decimal("64"))
    verdict = sufficient_information(sale)
    assert verdict.sufficient and verdict.address_level == "street" and verdict.has_surface


def test_missing_surface_without_email_is_insufficient():
    verdict = sufficient_information(make_sale(address="12 rue des Lilas, 59000 Exempleville"))
    assert not verdict.sufficient
    assert verdict.reasons == ("missing_surface",)
    assert verdict.reason_code == "insufficient_information:missing_surface"


def test_missing_address_and_surface_without_email_lists_both_reasons():
    verdict = sufficient_information(make_sale())
    assert verdict.reasons == ("missing_address", "missing_surface")


def test_commune_only_address_is_not_an_exploitable_address(monkeypatch):
    monkeypatch.delenv("IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS", raising=False)
    sale = make_sale(address="60000 Exempleville", postal_code="60000", surface_m2=Decimal("40"))
    verdict = sufficient_information(sale)
    assert not verdict.sufficient and verdict.reasons == ("missing_address",)
    assert verdict.address_level == "commune"


def test_commune_level_can_be_accepted_explicitly(monkeypatch):
    monkeypatch.setenv("IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS", "commune")
    sale = make_sale(address="60000 Exempleville", postal_code="60000", surface_m2=Decimal("40"))
    assert sufficient_information(sale).sufficient


def test_an_exploitable_email_keeps_the_sale_even_without_address_or_surface():
    sale = make_sale(lawyer_contact="me.exemple@cabinet-exemple.test")
    verdict = sufficient_information(sale)
    assert verdict.sufficient and verdict.contact_count == 1


def test_a_phone_number_is_not_a_contact_for_the_agent():
    assert not sufficient_information(make_sale(lawyer_contact="04 00 00 00 00")).sufficient


def test_blocked_email_is_not_exploitable_globally_or_for_one_sale():
    sale = make_sale(id="sale-1", lawyer_contact="me.exemple@cabinet-exemple.test")
    blocklist = build_blocklist(
        [{"normalized_email": "me.exemple@cabinet-exemple.test", "scope_sale_id": None, "opposition_status": "opposed",
          "bounce_status": "none"}]
    )
    assert usable_contact_emails(sale, blocklist) == set()
    assert not sufficient_information(sale, blocklist=blocklist).sufficient

    scoped = ContactBlocklist(by_sale={"sale-2": frozenset({"me.exemple@cabinet-exemple.test"})})
    assert sufficient_information(sale, blocklist=scoped).sufficient
    other = make_sale(id="sale-2", lawyer_contact="me.exemple@cabinet-exemple.test")
    assert not sufficient_information(other, blocklist=scoped).sufficient


def test_blocklist_only_keeps_opposed_or_permanently_bounced_rows():
    blocklist = build_blocklist(
        [
            {"normalized_email": "a@x-exemple.test", "scope_sale_id": None, "opposition_status": "none",
             "bounce_status": "temporary"},
            {"normalized_email": "b@x-exemple.test", "scope_sale_id": None, "opposition_status": "unknown",
             "bounce_status": "permanent"},
        ]
    )
    assert blocklist.global_emails == frozenset({"b@x-exemple.test"})


def test_parking_does_not_need_a_surface():
    sale = make_sale(property_type="parking", address="3 place du Marché, 59000 Exempleville")
    assert sufficient_information(sale).sufficient


def test_land_surface_counts_as_surface_for_land_but_not_for_a_house():
    land = make_sale(property_type="land", land_surface_m2=Decimal("1200"), address="Chemin des Vignes, 59000 X")
    assert sufficient_information(land).sufficient
    house = make_sale(property_type="house", land_surface_m2=Decimal("1200"), address="3 rue des Lilas, 59000 X")
    assert sufficient_information(house).reasons == ("missing_surface",)


@pytest.mark.parametrize("status", ["past", "adjudicated", "cancelled", "withdrawn", "quarantined"])
def test_finished_or_quarantined_sales_are_never_judged(status):
    verdict = sufficient_information(make_sale(status=status))
    assert verdict.sufficient and verdict.exemption == f"status:{status}"


def test_cessions_etat_cadastral_reference_is_an_exploitable_designation():
    sale = make_sale(
        source_name="cessions_etat",
        primary_source="cessions_etat",
        surface_m2=Decimal("1157"),
        raw_payload={"source_blocks": {"reference_cadastrale": "AC 272 et AC 829"}},
    )
    verdict = sufficient_information(sale)
    assert verdict.sufficient and verdict.address_level == "parcel" and verdict.address_basis == "cadastral_reference"


def test_cessions_etat_street_in_title_is_an_exploitable_designation():
    sale = make_sale(
        source_name="cessions_etat",
        primary_source="cessions_etat",
        title="Ensemble immobilier Rue De La Fabrique à Exempleville",
        surface_m2=Decimal("3824"),
    )
    verdict = sufficient_information(sale)
    assert verdict.sufficient and verdict.address_basis == "description"


def test_cessions_etat_commune_and_surface_only_is_insufficient_without_email():
    sale = make_sale(source_name="cessions_etat", primary_source="cessions_etat", surface_m2=Decimal("80"),
                     description="Maison forestière sur un terrain arboré entièrement clos.")
    assert sufficient_information(sale).reasons == ("missing_address",)


def test_cessions_etat_manager_email_in_source_blocks_keeps_the_sale():
    sale = make_sale(
        source_name="cessions_etat",
        primary_source="cessions_etat",
        raw_payload={"source_blocks": {"gestionnaire_email": "gestion.exemple@service-exemple.test"}},
    )
    assert sufficient_information(sale).sufficient


def test_court_address_in_free_text_of_a_source_with_mixed_blocks_is_not_a_property_address():
    # petites_affiches : « Lieu de Vente » est l'adresse du tribunal, pas celle du bien.
    sale = make_sale(
        source_name="petites_affiches",
        primary_source="petites_affiches",
        address="Exempleville",
        surface_m2=Decimal("50"),
        description="Avocat Poursuivant Maître Exemple Lieu de Vente TJ D EXEMPLE 9 Rue du Palais, 91012 EXEMPLE",
    )
    verdict = sufficient_information(sale)
    assert not verdict.sufficient and verdict.address_level == "commune"


def test_lawyer_street_in_description_of_encheres_immobilieres_is_not_a_property_address():
    sale = make_sale(
        source_name="encheres_immobilieres",
        primary_source="encheres_immobilieres",
        surface_m2=Decimal("50"),
        description="Réf. annonce : 1 Me Exemple Avocat 49 Bis boulevard Gambetta 13150 TARASCON",
    )
    assert not sufficient_information(sale).sufficient


def test_email_found_in_a_secondary_observation_counts():
    sale = make_sale(
        observations=[{"raw_payload": {"source_blocks": {"contact_avocat": "avocat@cabinet-secondaire.test"}}}]
    )
    assert sufficient_information(sale).sufficient


def test_gate_can_be_switched_off(monkeypatch):
    monkeypatch.setenv("IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE", "off")
    assert publication_gate(make_sale()).sufficient
    monkeypatch.setenv("IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE", "on")
    assert not publication_gate(make_sale()).sufficient


def test_summary_counts_reasons_and_sources_without_personal_data():
    insufficient = sufficient_information(make_sale())
    summary = summarize_verdicts(
        [("licitor", insufficient), ("vench", insufficient), ("licitor", sufficient_information(make_sale(status="past")))]
    )
    assert summary == {
        "total": 2,
        "by_reason": {"insufficient_information:missing_address+missing_surface": 2},
        "by_source": {"licitor": 1, "vench": 1},
    }
    assert NO_BLOCKLIST.blocks("x@y.test", None) is False
