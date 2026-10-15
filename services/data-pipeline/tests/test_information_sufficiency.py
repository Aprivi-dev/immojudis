"""Règle de rétention « informations suffisantes » : cas fictifs uniquement (aucune donnée réelle)."""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from src.information_sufficiency import (
    _EXTRACT_EMAIL_RE,
    NO_BLOCKLIST,
    ContactBlocklist,
    build_blocklist,
    contact_emails,
    contact_phones,
    publication_gate,
    sufficient_information,
    summarize_verdicts,
    usable_contact_emails,
)
from src.models import AuctionSale

FIXTURES = Path(__file__).parent / "fixtures" / "information_agent_contact_cases.json"
PARITY_CASES = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]


@pytest.fixture(autouse=True)
def _street_level_address(monkeypatch):
    """Most cases below check the stricter « voie / lieu-dit / parcelle » mode.

    The default (commune is enough, owner decision of 2026-10-11) has its own tests.
    """
    monkeypatch.setenv("IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS", "street")


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


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Même tableau que src/lib/information-agent-email-in-text.test.ts (findEmailsInText).
        ("maitre.dupont@cabinet-dupont.frTél : 01 02 03 04 05", "maitre.dupont@cabinet-dupont.fr"),
        ("maitre.dupont@cabinet-dupont.fr.", "maitre.dupont@cabinet-dupont.fr"),
        ("maitre.dupont@cabinet-dupont.fr/Tel 01 02 03 04 05", "maitre.dupont@cabinet-dupont.fr"),
        ("maitre.dupont@cabinet-dupont.fr0145678901", "maitre.dupont@cabinet-dupont.fr"),
        ("maitre.dupont@cabinet-dupont.fr, Paris", "maitre.dupont@cabinet-dupont.fr"),
        ("Email : maitre.dupont@cabinet-dupont.fr (cabinet)", "maitre.dupont@cabinet-dupont.fr"),
        ("MAITRE.DUPONT@CABINET-DUPONT.FR", "MAITRE.DUPONT@CABINET-DUPONT.FR"),
        ("MAITRE.DUPONT@CABINET-DUPONT.FRTél 0145678901", "MAITRE.DUPONT@CABINET-DUPONT.FR"),
        ("MAITRE.DUPONT@CABINET-DUPONT.FRTel 0145678901", "MAITRE.DUPONT@CABINET-DUPONT.FR"),
        ("Maitre.Dupont@Cabinet-Dupont.Fr", "Maitre.Dupont@Cabinet-Dupont.Fr"),
        ("Maitre.Dupont@Cabinet-Dupont.FrTél", "Maitre.Dupont@Cabinet-Dupont.Fr"),
        ("greffe@mairie.sous.domaine.cabinet.fr", "greffe@mairie.sous.domaine.cabinet.fr"),
        ("contact@avocats.paris", "contact@avocats.paris"),
        ("contact@etude-dupont.immobilier", "contact@etude-dupont.immobilier"),
        ("contact@etude-dupont.immobilierTél", "contact@etude-dupont.immobilier"),
        ("jean+vente@exemple.notaires.fr", "jean+vente@exemple.notaires.fr"),
        ("a_b%c@x.co", "a_b%c@x.co"),
    ],
)
def test_email_pattern_stops_before_the_word_glued_to_the_address(text, expected):
    # Motif brut (avant normalisation et validation zod), comme findEmailsInText côté TypeScript.
    assert _EXTRACT_EMAIL_RE.findall(text) == [expected]


def test_email_extraction_finds_several_addresses_and_rejects_non_addresses():
    assert _EXTRACT_EMAIL_RE.findall(
        "Me Dupont : dupont@cabinet.frTél 01 02 03 04 05 / Me Martin : martin@etude.paris."
    ) == ["dupont@cabinet.fr", "martin@etude.paris"]
    assert _EXTRACT_EMAIL_RE.findall("pas d'adresse ici, tél. 01 02 03 04 05") == []
    assert _EXTRACT_EMAIL_RE.findall("x@localhost") == []
    assert _EXTRACT_EMAIL_RE.findall("x@cabinet.f") == []
    assert _EXTRACT_EMAIL_RE.findall("@cabinet.fr") == []


def test_a_glued_lawyer_contact_gives_the_address_without_the_next_word_initial():
    sale = make_sale(lawyer_contact="maitre.dupont@cabinet-dupont.frTél : 01 02 03 04 05")

    assert set(contact_emails(sale)) == {"maitre.dupont@cabinet-dupont.fr"}


def test_address_and_surface_are_enough_without_any_email():
    sale = make_sale(address="12 rue des Lilas, 59000 Exempleville", surface_m2=Decimal("64"))
    verdict = sufficient_information(sale)
    assert verdict.sufficient and verdict.address_level == "street" and verdict.has_surface


def test_an_address_alone_keeps_the_sale():
    # Owner rule of 12/10/2026: only a sale missing surface, address AND contact is left out.
    verdict = sufficient_information(make_sale(address="12 rue des Lilas, 59000 Exempleville"))
    assert verdict.sufficient and not verdict.has_surface


def test_a_surface_alone_keeps_the_sale():
    assert sufficient_information(make_sale(surface_m2=Decimal("40"))).sufficient


def test_missing_address_surface_and_contact_lists_the_three_reasons():
    verdict = sufficient_information(make_sale())
    assert not verdict.sufficient
    assert verdict.reasons == ("missing_address", "missing_surface", "missing_contact")
    assert verdict.reason_code == "insufficient_information:missing_address+missing_surface+missing_contact"


def test_commune_only_address_is_not_an_address_in_street_mode():
    sale = make_sale(address="60000 Exempleville", postal_code="60000")
    verdict = sufficient_information(sale)
    assert not verdict.sufficient and verdict.address_level == "commune"


def test_commune_is_enough_by_default(monkeypatch):
    monkeypatch.delenv("IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS", raising=False)
    assert sufficient_information(make_sale(address="60000 Exempleville", postal_code="60000")).sufficient
    verdict = sufficient_information(make_sale(city=None))
    assert not verdict.sufficient and verdict.reasons[0] == "missing_address"


def test_commune_level_can_be_accepted_explicitly(monkeypatch):
    monkeypatch.setenv("IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS", "commune")
    sale = make_sale(address="60000 Exempleville", postal_code="60000", surface_m2=Decimal("40"))
    assert sufficient_information(sale).sufficient


def test_an_exploitable_email_keeps_the_sale_even_without_address_or_surface():
    sale = make_sale(lawyer_contact="me.exemple@cabinet-exemple.test")
    verdict = sufficient_information(sale)
    assert verdict.sufficient and verdict.contact_count == 1


def test_a_phone_number_is_a_contact():
    verdict = sufficient_information(make_sale(lawyer_contact="Maître Exemple, tél. 04 00 00 00 00"))
    assert verdict.sufficient and verdict.phone_count == 1 and verdict.contact_count == 0


def test_phone_numbers_are_read_in_the_usual_french_forms():
    sale = make_sale(
        lawyer_contact="Tél : +33 6 12 34 56 78 / 01.23.45.67.89",
        description="Mise à prix : 30 000 €. RCS Exemple 542 061 015. Visite le 12/10/2026.",
        raw_payload={"source_blocks": {"contact": "05-56-00-00-00"}},
    )
    assert contact_phones(sale) == {"0612345678", "0123456789", "0556000000"}


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
    assert sufficient_information(house).has_surface is False


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


def test_cessions_etat_commune_only_is_not_an_exploitable_designation():
    sale = make_sale(source_name="cessions_etat", primary_source="cessions_etat", surface_m2=Decimal("80"),
                     description="Maison forestière sur un terrain arboré entièrement clos.")
    verdict = sufficient_information(sale)
    assert verdict.address_level == "commune" and verdict.sufficient


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
    assert verdict.address_level == "commune"


def test_lawyer_street_in_description_of_encheres_immobilieres_is_not_a_property_address():
    sale = make_sale(
        source_name="encheres_immobilieres",
        primary_source="encheres_immobilieres",
        surface_m2=Decimal("50"),
        description="Réf. annonce : 1 Me Exemple Avocat 49 Bis boulevard Gambetta 13150 TARASCON",
    )
    assert sufficient_information(sale).address_level == "commune"


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
        "by_reason": {"insufficient_information:missing_address+missing_surface+missing_contact": 2},
        "by_source": {"licitor": 1, "vench": 1},
    }
    assert NO_BLOCKLIST.blocks("x@y.test", None) is False
