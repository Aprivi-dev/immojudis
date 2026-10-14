"""Avocat poursuivant des fiches Petites Affiches : nom, téléphone, barreau, email publié en clair.

Les fixtures sont fictives (structure relevée le 14/10/2026, noms, téléphones et adresses inventés). Règle : l'encadré
« Avocat Poursuivant » fait foi ; à défaut, l'en-tête de l'annonce, puis la clause du poursuivant
(« ayant pour avocat Maître X »), arrêtée dès que le texte passe à la partie saisie. Jamais le créancier ou le
débiteur particulier, ni l'avocat du saisi.
"""

from __future__ import annotations

from pathlib import Path

from src.extraction_profiles import attach_source_property_features
from src.sources.petites_affiches import (
    parse_petites_affiches_detail_html,
    refresh_petites_affiches_raw_sale,
)
from src.sources.petites_affiches_extraction import (
    PetitesAffichesPage,
    _contact_box,
    _poursuivant,
    extract_petites_affiches_fields,
)

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


def test_lawyer_name_stops_at_the_end_of_the_sentence() -> None:
    fields = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "la SA BANQUE EXEMPLE, ayant pour avocat Maître Jean MODELE. Mise à prix : 80 000 euros."
    )

    assert fields["fields"]["lawyer_name"] == "Maître Jean MODELE"
    header = _read("Maître Jean MODELE. Mise à prix\nAvocat\nVENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT")
    assert header["fields"]["lawyer_name"] == "Maître Jean MODELE"
    # Une initiale isolée reste dans le nom.
    initial = _read("VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT " + PARTIES + "la SA BANQUE EXEMPLE, ayant pour avocat Maître Jean M. MODELE, avocat")
    assert initial["fields"]["lawyer_name"] == "Maître Jean M. MODELE"


def test_lawyer_of_the_owners_is_not_the_claimants_lawyer() -> None:
    for owner in (
        "Le bien appartient aux époux TESTARD",
        "Le bien est la propriété de la succession TESTARD",
        "Le bien est occupé par le locataire M. TESTARD",
        "Le bien appartient aux consorts TESTARD",
        "Le bien est loué au propriétaire occupant TESTARD",
    ):
        fields = _read(
            "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
            + PARTIES
            + f"la SA BANQUE EXEMPLE. {owner}, ayant pour avocat Maître Pierre GRIS, avocat au barreau de Lyon, "
            "Tél : 04 00 00 00 09"
        )
        assert not fields["fields"]["lawyer_name"], owner
        assert not fields["fields"]["lawyer_contact"], owner


def test_third_party_email_and_fax_are_not_the_lawyers_contact() -> None:
    fields = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "la SA BANQUE EXEMPLE, ayant pour avocat Maître Claire VIDAL, avocat au barreau de Marseille, "
        "Fax : 04 00 00 00 11, Tél : 04 00 00 00 08. Le prêt a été consenti par la BANQUE EXEMPLE, "
        "contact : service@banque-exemple.example, tél. 04 00 00 00 12"
    )

    assert fields["fields"]["lawyer_name"] == "Maître Claire VIDAL"
    assert fields["fields"]["lawyer_contact"] == "04 00 00 00 08"
    assert fields["source_property_features"]["contact"] == {"phone": "04 00 00 00 08"}

    fax_only = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "la SA BANQUE EXEMPLE, ayant pour avocat Maître Claire VIDAL, Fax : 04 00 00 00 11. Voir service@banque-exemple.example"
    )
    assert fax_only["fields"]["lawyer_name"] == "Maître Claire VIDAL"
    assert not fax_only["fields"]["lawyer_contact"]


def test_header_fax_and_third_party_email() -> None:
    fields = _read(
        "Maître Anne MODELE SELARL MODELE AVOCATS Avocat au barreau de PARIS Fax : 01 00 00 00 11 "
        "Tél : 01 00 00 00 10 Mail : anne@cabinet-test.example. Banque : agence@banque-exemple.example\n"
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT"
    )
    assert fields["fields"]["lawyer_contact"] == "01 00 00 00 10 · anne@cabinet-test.example"

    fax_only = _read(
        "Maître Anne MODELE SELARL MODELE AVOCATS Avocat au barreau de PARIS Fax : 01 00 00 00 11\n"
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT"
    )
    assert fax_only["fields"]["lawyer_name"] == "Maître Anne MODELE SELARL MODELE AVOCATS"
    assert not fax_only["fields"]["lawyer_contact"]


def test_bailiff_notary_or_registry_is_not_a_lawyer() -> None:
    for header in (
        "Maître Pierre MARTIN Huissier de Justice 1 rue Fictive Tél : 01 00 00 00 12",
        "Maître Pierre MARTIN Commissaire de justice Tél : 01 00 00 00 12",
        "Maître Pierre MARTIN Notaire Tél : 01 00 00 00 12",
        "Greffe du tribunal Maître Pierre MARTIN Tél : 01 00 00 00 12",
    ):
        fields = _read(header + "\nVENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT")
        assert not fields["fields"]["lawyer_name"], header
        assert not fields["fields"]["lawyer_contact"], header
    clause = _read(
        "VENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT "
        + PARTIES
        + "la SA BANQUE EXEMPLE, ayant pour avocat Maître Pierre MARTIN Huissier de Justice, Tél : 01 00 00 00 12"
    )
    assert not clause["fields"]["lawyer_name"]


def test_other_sources_complete_only_the_same_family_name() -> None:
    page = PetitesAffichesPage(lawyer_name="Maître Pierre MARTIN")
    _poursuivant(page, "Maître Pierre LEROY Avocat au barreau de Lille Tél : 03 00 00 00 13 Mail : leroy@cabinet-test.example")
    assert (page.lawyer_name, page.lawyer_phone, page.lawyer_email, page.lawyer_bar) == ("Maître Pierre MARTIN", None, None, None)

    page = PetitesAffichesPage(lawyer_name="Maître Pierre MARTIN")
    _poursuivant(page, "Me Pierre MARTIN Avocat au barreau de Lille Tél : 03 00 00 00 14")
    assert (page.lawyer_phone, page.lawyer_bar) == ("03 00 00 00 14", "Lille")


def test_contact_box_reads_a_labelled_email_and_drops_rpva() -> None:
    assert _contact_box(["Maître Léa MODELE", "Email : lea.modele@cabinet-test.example", "04 00 00 00 20"]) == (
        "Maître Léa MODELE",
        None,
        "04 00 00 00 20",
        "lea.modele@cabinet-test.example",
    )
    assert _contact_box(["Maître Léa MODELE", "Mail : lea.modele@cabinet-test.example"])[3] == (
        "lea.modele@cabinet-test.example"
    )
    assert _contact_box(["Maître Léa MODELE", "lea.modele@cabinet-test.example"])[3] == "lea.modele@cabinet-test.example"
    # Une adresse RPVA n'est ni un contact, ni un nom, ni une adresse postale.
    assert _contact_box(["Maître Léa MODELE", "Email : lea@avocat-conseil.fr", "1 rue Fictive 75001 PARIS"]) == (
        "Maître Léa MODELE",
        "1 rue Fictive 75001 PARIS",
        None,
        None,
    )


def test_phone_and_email_are_separate_channels_and_the_column_stays_readable() -> None:
    fields = _read(
        "Maître Léa MODELE-TEST Avocat au barreau de TESTVILLE Tél : 05 00 00 00 05 "
        "Mail : lea.modele@cabinet-test.example\nVENTE AUX ENCHERES PUBLIQUES UN APPARTEMENT"
    )

    # Colonne ``lawyer_contact`` : « téléphone · email », que le front et la normalisation relisent tels quels.
    assert fields["fields"]["lawyer_contact"] == "05 00 00 00 05 · lea.modele@cabinet-test.example"
    features = fields["source_property_features"]
    assert features["contact"] == {"phone": "05 00 00 00 05", "email": "lea.modele@cabinet-test.example"}

    sale = attach_source_property_features(
        {
            "source_url": URL,
            "description": "Tribunal judiciaire de Testville. Vente aux enchères.",
            **fields["fields"],
            "source_property_features": features,
        }
    )
    observation = sale["source_field_observations"]["lawyer_contact"]
    assert observation["state"] == "observed"
    assert observation["value"] == {"phone": "05 00 00 00 05", "email": "lea.modele@cabinet-test.example"}
    assert "conflicts" not in observation
