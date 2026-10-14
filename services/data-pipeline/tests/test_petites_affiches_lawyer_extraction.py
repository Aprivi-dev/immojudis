"""Avocat poursuivant des fiches Petites Affiches : nom, téléphone, barreau, email publié en clair.

Les fixtures sont fictives (structure relevée le 14/10/2026, noms, téléphones et adresses inventés). Règle : l'encadré
« Avocat Poursuivant » fait foi ; à défaut, l'en-tête de l'annonce, puis la clause du poursuivant
(« ayant pour avocat Maître X »), arrêtée dès que le texte passe à la partie saisie. Jamais le créancier ou le
débiteur particulier, ni l'avocat du saisi.
"""

from __future__ import annotations

from pathlib import Path

from src.sources.petites_affiches import (
    parse_petites_affiches_detail_html,
    refresh_petites_affiches_raw_sale,
)
from src.sources.petites_affiches_extraction import extract_petites_affiches_fields

FIXTURES = Path(__file__).parent / "fixtures"
URL = "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-bien-a-exempleville-170010.html"
TESTBOURG_URL = (
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/"
    "une-maison-d-habitation-a-testbourg-170011.html"
)
LEGAL_URL = (
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/licitation/"
    "une-maison-en-pierre-a-testbourg-58001.html"
)
HEAD = "Lot / Réf.: 26/00001\nMise à Prix :\n80 000\n€\n•\nEn attente du résultat\n"
TAIL = "\nInformations sur la vente\nVente le\n01/12/2026\nà\n14:00\nLieu de vente :\nTJ DE TESTVILLE\n"
PARTIES = "CETTE VENTE A LIEU A LA REQUETE DE : "


def _fixture(name: str, url: str = URL) -> dict:
    return parse_petites_affiches_detail_html((FIXTURES / name).read_text(encoding="utf-8"), url)


def _read(text: str) -> dict:
    result = extract_petites_affiches_fields(HEAD + text + TAIL, title="UNE MAISON")
    assert result is not None
    return result


def test_box_name_written_first_name_then_maitre_then_surname() -> None:
    sale = _fixture("petites_affiches_fiche_prenom_maitre_nom.html")

    assert sale["lawyer_name"] == "Julien Maître TESTARD"
    assert sale["lawyer_contact"] == "0400000004"
    assert sale["source_blocks"]["avocat"] == "Julien Maître TESTARD"
    assert sale["source_blocks"]["contact_avocat"] == "0400000004"
    lawyer = sale["source_property_features"]["lawyer"]
    assert lawyer == {"name": "Julien Maître TESTARD", "phone": "0400000004", "origin": "encadre"}


def test_masked_email_is_neither_decoded_nor_taken_for_an_address() -> None:
    sale = _fixture("petites_affiches_fiche_prenom_maitre_nom.html")

    assert "@" not in sale["lawyer_contact"]
    assert "avocat_poursuivant_adresse" not in sale["source_blocks"]
    assert "email" not in sale["source_property_features"]["lawyer"]
    assert "[email protected]" in sale["source_blocks"]["page_text"]


def test_legal_announcement_keeps_box_identity_and_adds_the_bar_from_the_header() -> None:
    sale = _fixture("petites_affiches_fiche_annonce_legale.html", LEGAL_URL)

    assert sale["lawyer_name"] == "SELARL MODELE AVOCATS"
    assert sale["lawyer_contact"] == "0500000000"
    assert sale["source_blocks"]["avocat_poursuivant_barreau"] == "LOT"
    lawyer = sale["source_property_features"]["lawyer"]
    assert lawyer["bar"] == "LOT" and lawyer["origin"] == "encadre"
    # Le créancier particulier et le débiteur de la clause du poursuivant ne sont lus nulle part.
    assert "DUPONT" not in str(sale["lawyer_name"]) + str(sale["lawyer_contact"]) + str(lawyer)
    assert "DURAND" not in str(sale["lawyer_name"]) + str(sale["lawyer_contact"]) + str(lawyer)


def test_empty_box_falls_back_to_the_announcement_header() -> None:
    sale = _fixture("petites_affiches_fiche_entete_sans_encadre.html")

    assert sale["lawyer_name"] == "Maître Léa MODELE-TEST"
    assert sale["lawyer_contact"] == "05 00 00 00 05 · lea.modele@cabinet-test.example"
    assert sale["source_blocks"]["contact_avocat"] == sale["lawyer_contact"]
    assert sale["source_blocks"]["avocat_poursuivant_barreau"] == "TESTVILLE"
    assert sale["source_property_features"]["lawyer"] == {
        "name": "Maître Léa MODELE-TEST",
        "phone": "05 00 00 00 05",
        "email": "lea.modele@cabinet-test.example",
        "bar": "TESTVILLE",
        "origin": "entete",
    }


def test_party_and_debtor_lawyer_are_never_extracted_from_the_same_page() -> None:
    sale = _fixture("petites_affiches_fiche_entete_sans_encadre.html")
    kept = " ".join(str(value) for value in (sale["lawyer_name"], sale["lawyer_contact"]))
    kept += str(sale["source_property_features"]["lawyer"])

    for forbidden in ("DUPONT", "DURAND", "GRIS", "LYON", "04 00 00 00 06", "0500000007"):
        assert forbidden not in kept
    assert sale["source_blocks"]["lieu_vente_adresse"] == "Square Imaginaire, 31000 TESTVILLE"


def test_lawyer_cited_in_the_claimants_clause_is_read_with_bar_and_phone() -> None:
    fields = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "la SA BANQUE EXEMPLE, ayant pour avocat Maître Claire VIDAL, avocat au barreau de Marseille, "
        "Tél : 04 00 00 00 08, contre Monsieur Jean DURAND, saisi, ayant pour avocat Maître Pierre GRIS"
    )

    assert fields["fields"]["lawyer_name"] == "Maître Claire VIDAL"
    assert fields["fields"]["lawyer_contact"] == "04 00 00 00 08"
    assert fields["source_blocks"]["avocat_poursuivant_barreau"] == "Marseille"
    assert fields["source_property_features"]["lawyer"]["origin"] == "annonce"


def test_private_claimant_is_not_extracted_only_its_lawyer() -> None:
    fields = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "Madame Nadia KHALIL, née le 3 janvier 1970 à Marseille, demeurant 8 av. de la Gare 13001 Marseille, "
        "ayant pour avocat Maître Claire VIDAL, avocat au barreau de Marseille."
    )
    kept = str(fields["fields"]) + str(fields["source_property_features"].get("lawyer"))

    assert fields["fields"]["lawyer_name"] == "Maître Claire VIDAL"
    for forbidden in ("KHALIL", "Nadia", "av. de la Gare"):
        assert forbidden not in kept


def test_debtors_lawyer_alone_gives_nothing() -> None:
    fields = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "la SA BANQUE EXEMPLE. Contre Monsieur Jean DURAND, débiteur saisi, ayant pour avocat Maître Pierre GRIS, "
        "avocat au barreau de Lyon, Tél : 04 00 00 00 09"
    )

    assert "lawyer_name" not in {key for key, value in fields["fields"].items() if value}
    assert not fields["fields"]["lawyer_contact"]
    assert "avocat_poursuivant_barreau" not in fields["source_blocks"]
    assert "lawyer" not in fields["source_property_features"]


def test_lawyer_named_after_a_private_person_title_is_not_a_professional() -> None:
    # Le nom lu après « ayant pour avocat » doit porter la marque d'un professionnel (Maître, SELARL, cabinet…).
    fields = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT " + PARTIES + "la SCI EXEMPLE, ayant pour avocat Monsieur Paul MARTIN"
    )

    assert not fields["fields"]["lawyer_name"]


def test_header_forms_of_the_firm_and_the_bar() -> None:
    cases = {
        "Maître Anne MODELE SELARL MODELE AVOCATS Avocat au barreau de PARIS 1 boulevard Fictif 75001 PARIS "
        "Tél : 01 00 00 00 10": ("Maître Anne MODELE SELARL MODELE AVOCATS", "PARIS", "01 00 00 00 10"),
        "SCP EXEMPLE ET ASSOCIES, Avocats associés au Barreau d'Aix-en-Provence Tél. 04.00.00.00.11": (
            "SCP EXEMPLE ET ASSOCIES",
            "Aix-en-Provence",
            "04.00.00.00.11",
        ),
        "Me Hugo TEST Avocat au Barreau de la Seine-Saint-Denis": ("Me Hugo TEST", "Seine-Saint-Denis", None),
    }
    for header, (name, bar, phone) in cases.items():
        fields = _read(header + "\nVENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT")
        assert fields["fields"]["lawyer_name"] == name, header
        assert fields["source_blocks"]["avocat_poursuivant_barreau"] == bar, header
        assert (fields["fields"]["lawyer_contact"] or None) == phone, header


def test_header_masked_mail_stays_masked() -> None:
    fields = _read(
        "Maître Anne MODELE SELARL MODELE AVOCATS Avocat au barreau de PARIS Tél : 01 00 00 00 10 Mail :\n"
        "[email protected]\nVENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT"
    )

    assert fields["fields"]["lawyer_contact"] == "01 00 00 00 10"
    assert "email" not in fields["source_property_features"]["lawyer"]


def test_page_without_any_lawyer() -> None:
    fields = _read("VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT À la requête de la SA BANQUE EXEMPLE.")

    assert not fields["fields"]["lawyer_name"]
    assert not fields["fields"]["lawyer_contact"]
    for key in ("avocat", "contact_avocat", "avocat_poursuivant_barreau"):
        assert key not in fields["source_blocks"]
    assert "lawyer" not in fields["source_property_features"]


def test_refresh_replays_stored_text_and_fills_the_lawyer_without_network() -> None:
    html = (FIXTURES / "petites_affiches_fiche_entete_sans_encadre.html").read_text(encoding="utf-8")
    detail = parse_petites_affiches_detail_html(html, TESTBOURG_URL)
    raw_sale = {
        "source_name": "petites_affiches",
        "source_url": TESTBOURG_URL,
        "title": detail["title"],
        "city": detail["city"],
        "lawyer_name": None,
        "lawyer_contact": None,
        "source_blocks": {"page_text": detail["source_blocks"]["page_text"], "titre_detail": detail["title"]},
    }

    assert refresh_petites_affiches_raw_sale(raw_sale) is True
    assert raw_sale["lawyer_name"] == "Maître Léa MODELE-TEST"
    assert raw_sale["lawyer_contact"] == "05 00 00 00 05 · lea.modele@cabinet-test.example"
    assert raw_sale["source_blocks"]["avocat_poursuivant_barreau"] == "TESTVILLE"
