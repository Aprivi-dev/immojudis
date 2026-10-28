"""Miroir du résolveur de contacts de l'agent, registre de refus et porte « minimum d'une annonce » (cas fictifs)."""

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


def test_a_phone_number_is_not_a_contact():
    # L'agent d'information ne travaille que par email : un téléphone, un nom d'avocat ne gardent pas la vente.
    verdict = sufficient_information(make_sale(lawyer_contact="Maître Exemple, tél. 04 00 00 00 00", lawyer_name="Maître Exemple"))
    assert not verdict.sufficient and verdict.reason_code == "insufficient_listing"


def test_an_exploitable_email_keeps_the_sale_even_without_address_or_surface():
    verdict = sufficient_information(make_sale(lawyer_contact="me.exemple@cabinet-exemple.test"))
    assert verdict.sufficient and verdict.basis == ("email",)


def test_a_surface_or_a_commune_alone_no_longer_keeps_the_sale():
    # Ancienne règle du 12/10/2026 (adresse OU superficie OU email OU téléphone), retirée le 28/10/2026.
    assert not sufficient_information(make_sale(surface_m2=Decimal("40"), postal_code="60000")).sufficient


def test_a_street_a_document_or_another_source_keeps_the_sale():
    assert sufficient_information(make_sale(address="12 rue des Lilas, 59000 Exempleville")).basis == ("street",)
    assert sufficient_information(make_sale(documents=[{"label": "PV", "url": "https://example.test/pv.pdf"}])).basis == (
        "documents",
    )
    merged = make_sale(source_urls=["https://example.test/vente/1", "https://autre.test/1"])
    assert sufficient_information(merged).basis == ("other_source",)


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


def test_finished_sales_are_judged_like_the_others():
    for status in ("past", "adjudicated", "quarantined"):
        assert not sufficient_information(make_sale(status=status)).sufficient


def test_cessions_etat_manager_email_in_source_blocks_keeps_the_sale():
    sale = make_sale(
        source_name="cessions_etat",
        primary_source="cessions_etat",
        raw_payload={"source_blocks": {"gestionnaire_email": "gestion.exemple@service-exemple.test"}},
    )
    assert sufficient_information(sale).sufficient


def test_an_address_in_the_free_text_of_the_page_is_not_a_contact():
    sale = make_sale(raw_payload={"source_blocks": {"page_text": "Écrire à contact@site-exemple.test"}})
    assert not sufficient_information(sale).sufficient


def test_gate_can_be_switched_off(monkeypatch):
    monkeypatch.setenv("IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE", "off")
    assert publication_gate(make_sale()).sufficient
    monkeypatch.setenv("IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE", "on")
    assert not publication_gate(make_sale()).sufficient


def test_summary_counts_reasons_and_sources_without_personal_data():
    insufficient = sufficient_information(make_sale())
    summary = summarize_verdicts([("licitor", insufficient), ("vench", insufficient), ("licitor", sufficient_information(make_sale(address="3 rue Haute")))])
    assert summary == {
        "total": 2,
        "by_reason": {"insufficient_listing": 2},
        "by_source": {"licitor": 1, "vench": 1},
    }
    assert NO_BLOCKLIST.blocks("x@y.test", None) is False
