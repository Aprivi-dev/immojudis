"""Briques communes de lecture du professionnel de la vente (Vench, Petites Affiches)."""

from __future__ import annotations

import pytest

from src.sources.professional_contact import (
    bar_name,
    clear_email,
    french_phone,
    keep_professional,
    labelled_phone,
    same_professional,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Avocat au barreau de Paris", "Paris"),
        ("Avocat au Barreau de GRASSE\n", "GRASSE"),
        ("avocat au barreau du LOT 1 boulevard Fictif 46000 CAHORS", "LOT"),
        ("inscrit au barreau d'Aix-en-Provence, Tél : 04 00 00 00 00", "Aix-en-Provence"),
        ("barreau de la Seine-Saint-Denis", "Seine-Saint-Denis"),
        ("barreau de Saint Pierre de la Réunion Tél", "Saint Pierre de la Réunion"),
        ("barreau de PARIS Tél : 01 00 00 00 00", "PARIS"),
        ("Ordre des avocats", None),
        ("aucun barreau cité", None),
        ("", None),
    ],
)
def test_bar_name(text: str, expected: str | None) -> None:
    assert bar_name(text) == expected


def test_clear_email_ignores_masked_addresses_and_image_names() -> None:
    assert clear_email("Mail : lea.modele@cabinet-test.example") == "lea.modele@cabinet-test.example"
    assert clear_email("mailto:contact@cabinet.example?subject=Vente") == "contact@cabinet.example"
    assert clear_email("[email protected]") is None
    assert clear_email("[email protected]") is None
    assert clear_email('<a data-cfemail="3c5f5352485d5f48">') is None
    assert clear_email("logo@2x.png") is None
    assert clear_email(None) is None


def test_phone_readers() -> None:
    assert french_phone("Cabinet 01 23 45 67 89 Paris") == "01 23 45 67 89"
    assert french_phone("+33 1 23 45 67 89") == "+33 1 23 45 67 89"
    assert french_phone("RG 26/00045 du 12/10/2026") is None
    assert labelled_phone("Fax : 01 00 00 00 01 Tél : 01 00 00 00 02") == "01 00 00 00 02"
    assert labelled_phone("01 00 00 00 03") is None


def test_same_professional_needs_a_distinctive_word() -> None:
    assert same_professional("Maître Anne MODELE SELARL MODELE AVOCATS", "SELARL MODELE AVOCATS")
    assert same_professional("Jérôme Maître COUTELIER-TAFANI", "Maître Jérôme COUTELIER-TAFANI Avocat")
    assert not same_professional("Maître Anne MODELE", "Maître Pierre GRIS")
    assert not same_professional("SELARL AVOCATS ASSOCIES", "SCP AVOCATS")


def test_keep_professional_drops_what_names_a_private_person() -> None:
    assert keep_professional("  SCP  TESTARD ET ASSOCIES ") == "SCP TESTARD ET ASSOCIES"
    assert keep_professional("Maître Claire VIDAL") == "Maître Claire VIDAL"
    assert keep_professional("occupé par Monsieur Jean DURAND") is None
    assert keep_professional("à la requête de Madame Nadia KHALIL") is None
    assert keep_professional("") is None
    assert keep_professional(None) is None
