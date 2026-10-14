"""Avocat poursuivant des fiches Vench : nom, téléphone, email publié en clair.

Les fixtures reprennent la structure des fiches publiques relevées le 14/10/2026 ; noms, téléphones, adresses et
adresses masquées sont inventés. Sur Vench, l'avocat poursuivant n'est publié que sur les fiches en accès libre :
les fiches réservées aux abonnés n'en portent aucun, et rien n'est contourné.
"""

from __future__ import annotations

from pathlib import Path

from src.sources.professional_contact import keep_professional
from src.sources.vench import parse_vench_detail_html

FIXTURES = Path(__file__).parent / "fixtures"


def _parse(name: str) -> dict:
    return parse_vench_detail_html(
        (FIXTURES / name).read_text(encoding="utf-8"),
        "https://www.vench.fr/vente-170001-un-bien-exempleville.html",
    )


def test_cabinet_and_titled_lawyer_with_phone_and_website() -> None:
    sale = _parse("vench_fiche_avocat_cabinet.html")

    assert sale["lawyer_name"] == "SCP TESTARD ET ASSOCIES (Maître Camille TESTARD)"
    assert sale["lawyer_contact"] == "01 00 00 00 01 · https://cabinet-testard.example"
    assert sale["source_blocks"]["avocat"] == sale["lawyer_name"]
    assert sale["source_blocks"]["contact_avocat"] == sale["lawyer_contact"]
    assert sale["source_property_features"]["lawyer"]["lawyer"]["address"] == "14 allée des Essais 93000 Exempleville"


def test_cloudflare_masked_addresses_are_left_as_they_are_and_never_decoded() -> None:
    sale = _parse("vench_fiche_avocat_cabinet.html")

    assert "@" not in sale["lawyer_contact"]
    assert "protected" not in sale["lawyer_contact"]
    assert "email" not in sale["source_property_features"]["lawyer"]["lawyer"]
    # Le texte de page garde la mention masquée, telle quelle.
    assert "[email protected]" in sale["source_blocks"]["page_text"]
    # Ni l'adresse du partenaire ni une adresse masquée ne devient le contact du professionnel de la vente.
    assert "PARTENAIRE" not in sale["lawyer_name"]


def test_lawyer_written_without_maitre_keeps_the_firm_and_the_person() -> None:
    sale = _parse("vench_fiche_avocat_sans_maitre.html")

    assert sale["lawyer_name"] == "A.B.C.D. EXEMPLE Avocats (Alix MODELE-TEST)"
    assert sale["lawyer_contact"] == "01.00.00.00.02"


def test_poursuivant_wins_over_the_postulant_lawyer() -> None:
    sale = _parse("vench_fiche_avocat_sans_maitre.html")

    assert "FICTIF" not in sale["lawyer_name"]
    assert "POSTULANT" not in sale["lawyer_name"]
    # Le postulant reste connu dans l'arbre de faits, sans devenir le contact de la vente.
    tree = sale["source_property_features"]["lawyer"]
    assert tree["co_lawyer"]["person"] == "Maître Rémi FICTIF"
    assert tree["lawyer"]["firm"] == "A.B.C.D. EXEMPLE Avocats"


def test_email_published_in_clear_is_read_after_the_phone() -> None:
    # Variante construite : le site masque ses adresses, mais une adresse en clair (lien « mailto: ») est lue.
    html = (FIXTURES / "vench_fiche_avocat_sans_maitre.html").read_text(encoding="utf-8").replace(
        "01.00.00.00.02 ",
        '01.00.00.00.02 <br/><span class="fa fa-envelope"></span> '
        '<a href="mailto:contact@cabinet-modele.example">contact@cabinet-modele.example</a>',
    )
    sale = parse_vench_detail_html(html, "https://www.vench.fr/vente-170002-une-maison-exempleville.html")

    assert sale["lawyer_contact"] == "01.00.00.00.02 · contact@cabinet-modele.example"
    assert sale["source_blocks"]["contact_avocat"] == sale["lawyer_contact"]
    assert sale["source_property_features"]["lawyer"]["lawyer"]["email"] == "contact@cabinet-modele.example"
    assert "contact@cabinet-modele.example" not in sale["source_property_features"]["lawyer"]["lawyer"]["address"]


def test_paywalled_page_has_no_lawyer_and_the_bar_in_the_consignation_is_not_one() -> None:
    sale = _parse("vench_fiche_abonnes.html")

    assert sale.get("lawyer_name") is None
    assert sale.get("lawyer_contact") is None
    assert "avocat" not in sale["source_blocks"]
    assert "contact_avocat" not in sale["source_blocks"]
    assert sale["source_property_features"]["listing"]["access"] == "subscribers_only"


def test_page_without_any_lawyer_block() -> None:
    sale = parse_vench_detail_html(
        '<div id="page-heading"><h1>UN TERRAIN &bull; Testville</h1></div>'
        '<p>Mise à prix : 10 000 €</p><p>Contact : Maître Pierre GRIS, avocat du saisi, 04 00 00 00 00</p>',
        "https://www.vench.fr/vente-170003-un-terrain-testville.html",
    )

    # Un avocat cité dans le texte libre n'est pas l'encadré « Avocat poursuivant » : rien n'est extrait.
    assert sale.get("lawyer_name") is None
    assert sale.get("lawyer_contact") is None


def test_notary_block_is_a_professional_and_a_private_person_is_not_kept() -> None:
    html = """
    <div id="left-info"><div class="enquiry"><div class="head-side-bar"><p class="h4">Notaire</p></div>
      <div class="contact-form"><p>OFFICE NOTARIAL EXEMPLE<br/>Maître Hélène MODELE Notaire</p></div>
      <div class="contact-form displayAPcoords"><p><span>2 place du Test<br/>31000 Testville</span><br/>
        <span class="fa fa-phone"></span> 05 00 00 00 03</p></div></div></div>
    """
    sale = parse_vench_detail_html(html, "https://www.vench.fr/vente-170004-une-maison-testville.html")

    assert sale["lawyer_name"] == "OFFICE NOTARIAL EXEMPLE (Maître Hélène MODELE Notaire)"
    assert sale["lawyer_contact"] == "05 00 00 00 03"

    # Garde-fou : un libellé qui nomme une partie (créancier, débiteur, occupant) n'est jamais conservé.
    assert keep_professional("Maître Hélène MODELE") == "Maître Hélène MODELE"
    assert keep_professional("débiteur Monsieur Jean DURAND") is None
    assert keep_professional("occupé par Madame Marie MARTIN") is None
