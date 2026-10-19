"""Lecture structurée des annonces Licitor (données fictives, structure réelle du site)."""

from src.pdf_document_types import classify_document_type
from src.sources.licitor import parse_licitor_detail_html
from src.sources.licitor_extraction import (
    dedupe_licitor_images,
    extract_licitor_fields,
    parse_licitor_page,
    refresh_licitor_raw_sale,
)

URL = "https://www.licitor.com/annonce/10/99/99/vente-aux-encheres/un-appartement/paris-16eme/paris/109999.html"
PIC = "/data/pub/pic/fc/aj/10/99/99/109999.001.abcdef123456"
MEDIA = "https://www.licitor.com/data/pub/media/annonce/10/99/99/109999.000"

DETAIL_HTML = f"""
<html><head><title>Vente aux enchères : un appartement à Paris 16ème - n°109999 - Licitor</title></head><body>
<div class="Search" id="legalad-search"><h1>Annonce n°109999 : un appartement à Paris 16ème, mise à prix : 300 000 €</h1></div>
<article class="Traversing"><div id="traversing-ads"><h2><span>Annonces similaires</span></h2><ul>
<li><a href="/z.html">Paris et Ile-de-France</a></li>
<li><a href="/z2.html">Paris et Ile-de-France - Appartement</a></li>
<li><a href="/r.html">Paris</a></li>
<li><a href="/r2.html">Paris - Appartement</a></li>
</ul></div></article>
<article class="LegalAd"><div class="Container"><div class="AdContent" id="ad-109999">
<p class="PublishingDate">Annonce publiée le <time datetime="2026-09-01T00:00:00+02:00">1<sup>er</sup> septembre 2026</time></p>
<p class="Number">109999</p>
<p class="Court">Tribunal Judiciaire de Paris, Parvis Robert Badinter, à Paris 17ème</p>
<p class="Type">Vente aux enchères publiques sur saisie immobilière</p>
<p class="Date"><time datetime="2026-11-05T14:00:00">jeudi 5 novembre 2026 à 14h</time></p>
<section class="AddressBlock">
 <div class="Lot">
  <div class="FirstSousLot SousLot"><h2>Un appartement</h2>
   <p><b>de 61,40 m²</b>, au 2ème étage, comprenant :<br/>entrée, séjour, deux chambres, cuisine, salle d'eau, wc</p></div>
  <div class="SousLot"><h2>Une cave</h2><p>au sous-sol, n°12<br/><br/><b>Les biens sont occupés</b></p></div>
  <h3>Mise à prix : 300 000 €</h3>
  <p class="AdditionalText"><b>Consignation pour enchérir :</b> chèque de banque à l'ordre du Bâtonnier Séquestre
  représentant 10% du montant de la mise à prix avec un minimum de 3.000 €</p>
  <p class="AdditionalText">Précédemment adjugé à 410.000 € le 12/03/2026</p>
 </div>
 <div class="Pictures"><a href="{PIC}.jpg" rel="lightbox[001]"><img alt="un appartement" src="{PIC}.small.jpg"/></a></div>
 <div class="Location"><p class="City">Paris 16ème</p><p class="Street">10, rue de l'Exemple</p>
  <p class="Map"><a class="Button" href="https://maps.google.fr/maps?q=48.8600000,2.2800000&amp;z=13">Afficher le plan</a></p>
  <div>(exactitude non garantie)</div>
  <p class="Visits">Visites sur place lundi 26 octobre 2026 de 10h à 11h et<br/>mardi 27 octobre 2026 de 14h à 15h</p>
  <p class="Street" style="color: red;">Liens vers les documents annexes (CCV / PV descriptif) en pied d'annonce</p>
 </div>
</section>
<div class="Trusts">
 <div class="Trust"><h3>Maître Jeanne Exemple, membre de la SELARL Exemple Avocats, Avocat</h3>
  <p>1, rue du Palais - 75001 Paris<br/>Tél.: 01 00 00 00 01 - Fax : 01 00 00 00 02</p>
  <p><a href="/cdn-cgi/l/email-protection#00"><span class="__cf_email__" data-cfemail="00">[email&#160;protected]</span></a></p>
  <p><a href="https://www.exemple-avocats.test">www.exemple-avocats.test</a></p></div>
 <div class="Trust"><h3>SCP Fictive et Associés, Avocats</h3><p>2, place du Test - 92000 Nanterre</p></div>
</div>
<p class="AdditionalText">Le cahier des conditions de vente, référence Greffe n°26/00999, peut être consulté au Greffe du Juge de l'Exécution du Tribunal Judiciaire de Paris</p>
<div class="Related">
 <a class="Button" href="{MEDIA}.001.aaaaaaaaaaaa.pdf">Cahier des conditions de vente</a>
 <a class="Button" href="{MEDIA}.002.bbbbbbbbbbbb.pdf">PV descriptif</a>
 <a class="Button" href="{MEDIA}.003.cccccccccccc.pdf">Attestation de superficie</a>
 <a class="Button" href="{MEDIA}.004.dddddddddddd.mp4">Visite virtuelle</a>
</div>
<p><div class="Reference" style="float: left;">🔎︎ 1.234    ❤ 56</div>
<div class="Reference" style="float: right;">Ferrari &amp; Cie - Réf. A26/9999</div></p>
</div>
<div class="AdShare"><a class="ShareButton Print" href="{URL}?print=1">Imprimer</a></div>
<div class="PartnerOffer"><div class="PartnerOfferTitle">Prix constatés des biens immobiliers vendus aux alentours</div>
<a class="PartnerOfferCta" href="https://app-pro.la-loupe.immo/ext-partenaire/licitor/abc/">Voir le dossier complet avec</a></div>
</div></article></body></html>
"""

MULTI_LOT_TEXT = """Vente aux enchères : un immeuble de rapport à Testville (Nièvre) - n°110999 - Licitor
Accueil
Annonce n°110999 : un immeuble de rapport à Testville (Nièvre), mise à prix : 200 000 €
Annonces similaires
Régions du Nord-Est
Régions du Nord-Est - Immeuble résidentiel
Bourgogne
Bourgogne - Immeuble résidentiel
Annonce publiée le
1
er
octobre 2026
110999
Tribunal Judiciaire de Versailles (Yvelines)
Vente aux enchères publiques sur liquidation judiciaire en deux lots
mercredi 18 novembre 2026 à 9h30
1er lot de vente
Un immeuble de rapport
de 200,50 m² au sol, sur trois niveaux
, comprenant :
Au rez-de-chaussée : un local commercial (
60 m²
au sol) -
Loué
Mise à prix : 200 000 €
Avec faculté de baisse de la mise à prix du quart puis de moitié
Consignation pour enchérir
: chèque de banque à l'ordre du
Bâtonnier Séquestre
de
20.000 €
On ne peut enchérir que par le ministère d'un Avocat du Barreau de Versailles
2ème lot de vente
Un terrain
Cadastré section AB n°12 pour 10a 59ca
Libre
Mise à prix : 15 000 €
Testville (Nièvre)
Rue du Moulin
Afficher le plan
(exactitude non garantie)
Visite sur place jeudi 5 novembre 2026 de 10h à 12h
par la
SAS Constat Test
, Commissaires de Justice à Testville
Maître Paul Fictif, Avocat
3, rue des États - 78000 Versailles
Tél.: 01 00 00 00 03
Le cahier des conditions de vente est déposé au Greffe du Juge de l'Exécution du Tribunal Judiciaire de Versailles
Ferrari & Cie - Réf. A26/0001
Imprimer
Partenaires"""


def _detail() -> dict:
    return parse_licitor_detail_html(DETAIL_HTML, URL)


def test_detail_keeps_attachments_with_urls_and_puts_the_video_apart() -> None:
    raw = _detail()

    assert [document["label"] for document in raw["documents"]] == [
        "Cahier des conditions de vente",
        "PV descriptif",
        "Attestation de superficie",
    ]
    assert all(document["url"].startswith(MEDIA) and document["type"] == "pdf" for document in raw["documents"])
    assert raw["source_virtual_tours"] == [f"{MEDIA}.004.dddddddddddd.mp4"]
    attachments = raw["source_property_features"]["media"]["attachments"]
    assert [item["kind"] for item in attachments] == ["cahier_conditions_vente", "pv_huissier", "diagnostics_techniques"]
    display = raw["source_blocks"]["caracteristiques_bien"]
    assert display["media"] == {"photos": 1, "virtual_tours": 1}
    assert {item["kind_label"] for item in display["attachments"]} == {
        "Cahier des conditions de vente", "Procès-verbal descriptif", "Diagnostics techniques",
    }


def test_detail_keeps_full_size_photo_once() -> None:
    raw = _detail()

    assert raw["source_images"] == [f"https://www.licitor.com{PIC}.jpg"]
    assert raw["raw_image_url"] == f"https://www.licitor.com{PIC}.jpg"


def test_detail_reads_procedure_conditions_lawyers_and_visits() -> None:
    raw = _detail()
    features = raw["source_property_features"]

    assert raw["visit_dates"] == [
        "Visites sur place lundi 26 octobre 2026 de 10h à 11h et mardi 27 octobre 2026 de 14h à 15h"
    ]
    assert raw["lawyer_name"] == "Maître Jeanne Exemple, membre de la SELARL Exemple Avocats, Avocat"
    assert raw["lawyer_contact"] == (
        "1, rue du Palais - 75001 Paris | Tél.: 01 00 00 00 01 | Fax : 01 00 00 00 02 | www.exemple-avocats.test"
    )
    assert "protected" not in raw["lawyer_contact"]
    assert [lawyer["name"] for lawyer in features["lawyers"]] == [
        "Maître Jeanne Exemple, membre de la SELARL Exemple Avocats, Avocat",
        "SCP Fictive et Associés, Avocats",
    ]
    # data-cfemail="00" n'est pas décodable : la donnée est ignorée et le texte masqué retiré
    # (le décodage valide est testé dans test_licitor_cloudflare_email.py).
    assert "email" not in features["lawyers"][0] and "protected" not in str(raw)
    assert features["procedure"]["codes"] == ["saisie_immobiliere"]
    assert features["procedure"]["greffe_reference"] == "26/00999"
    assert features["procedure"]["venue"] == "Parvis Robert Badinter, à Paris 17ème"
    assert features["procedure"]["sale_at"] == "2026-11-05T14:00:00+01:00"
    assert features["listing"]["published_on"] == "2026-09-01"
    assert features["listing"]["category"] == "Appartement"
    assert features["listing"]["regie_reference"] == "A26/9999"
    lot = features["lots"][0]
    assert lot["starting_price_eur"] == 300000
    assert lot["surface_m2"] == "61.40"
    assert lot["deposit"]["percent_of_starting_price"] == 10
    assert lot["deposit"]["minimum_eur"] == 3000
    assert lot["prior_adjudication"]["price_eur"] == 410000
    assert lot["prior_adjudication"]["date"] == "12/03/2026"
    blocks = raw["source_blocks"]
    assert blocks["reference_greffe"] == "26/00999"
    assert blocks["procedure_vente"] == "Saisie immobilière"
    # Ni compteur de vues ni encart partenaire dans les blocs (empreinte du contenu source).
    assert "1.234" not in str(blocks["caracteristiques_bien"])
    assert "Prix constatés" not in str(blocks["caracteristiques_bien"])


def test_detail_description_keeps_the_titles_of_the_following_sub_lots() -> None:
    raw = _detail()

    assert "Une cave au sous-sol, n°12" in raw["description"]
    # « Les biens sont occupés » : le pluriel rendait l'occupation ambiguë, la phrase est pourtant univoque.
    assert raw["occupancy_status"] == "occupied"


def test_multi_lot_page_text_is_read_lot_by_lot() -> None:
    page = parse_licitor_page(MULTI_LOT_TEXT)

    assert [lot.label for lot in page.lots] == ["1er lot de vente", "2ème lot de vente"]
    assert [lot.price_eur for lot in page.lots] == [200000, 15000]
    assert page.lots[0].paragraphs[0] == "de 200,50 m² au sol, sur trois niveaux, comprenant :"
    assert page.lots[0].city is None and page.lots[1].city == "Testville"
    assert page.lots[1].visits == ["Visite sur place jeudi 5 novembre 2026 de 10h à 12h par la SAS Constat Test, Commissaires de Justice à Testville"]
    assert page.announced_lots == 2
    assert [code for code, _ in page.procedures()] == ["liquidation_judiciaire"]
    assert [lawyer.name for lawyer in page.lawyers] == ["Maître Paul Fictif, Avocat"]
    assert page.published_on.isoformat() == "2026-10-01"

    extracted = extract_licitor_fields(MULTI_LOT_TEXT)
    lots = extracted["source_property_features"]["lots"]
    assert lots[0]["deposit"]["amount_eur"] == 20000
    assert lots[0]["price_reduction"] == "Avec faculté de baisse de la mise à prix du quart puis de moitié"
    assert lots[0]["bidding_restriction"].startswith("On ne peut enchérir")
    assert lots[0]["occupancy_status"] == "rented"
    assert lots[1]["occupancy_status"] == "vacant"
    assert lots[1]["cadastre"]["designation"] == "Parcelle AB 12 à Testville"
    items = {item["key"]: item["value"] for item in extracted["source_blocks"]["caracteristiques_bien"]["items"]}
    assert items["lot_2"] == "Un terrain — mise à prix 15 000 €"
    assert extracted["source_blocks"]["lots_detail"].count("\n") == 1


def test_refresh_replays_stored_page_text_and_fixes_old_readings() -> None:
    raw = {
        "source_name": "licitor",
        "source_url": URL,
        "occupancy_status": "unknown",
        "visit_dates": ["Visite virtuelle"],
        "lawyer_contact": "3, rue des États | [email protected] | Le cahier des conditions de vente",
        "source_images": [f"https://www.licitor.com{PIC}.jpg", f"https://www.licitor.com{PIC}.small.jpg"],
        "source_blocks": {"page_text": MULTI_LOT_TEXT.replace("Visite sur place", "Aucune visite sur place : visite virtuelle")},
    }

    assert refresh_licitor_raw_sale(raw) is True
    assert raw["visit_dates"] == []
    assert raw["lawyer_contact"] == "3, rue des États - 78000 Versailles | Tél.: 01 00 00 00 03"
    assert raw["occupancy_status"] == "rented"
    assert raw["source_images"] == [f"https://www.licitor.com{PIC}.jpg"]
    assert raw["source_blocks"]["visite_note"].startswith("Aucune visite sur place")
    assert raw["source_blocks"]["caracteristiques_bien"]["source"] == "licitor"


def test_refresh_never_overrides_a_known_occupancy_and_ignores_other_pages() -> None:
    raw = {"source_name": "licitor", "occupancy_status": "vacant", "source_blocks": {"page_text": MULTI_LOT_TEXT}}
    assert refresh_licitor_raw_sale(raw) is True
    assert raw["occupancy_status"] == "vacant"

    listing_card = {"source_name": "licitor", "source_blocks": {"page_text": "33\nBordeaux\nUne maison\nMise à prix :\n90 000 €"}}
    assert refresh_licitor_raw_sale(listing_card) is False
    assert refresh_licitor_raw_sale({"source_name": "vench", "source_blocks": {"page_text": MULTI_LOT_TEXT}}) is False


def test_bailiff_contact_is_not_taken_for_a_lawyer() -> None:
    text = MULTI_LOT_TEXT.replace(
        "Maître Paul Fictif, Avocat\n3, rue des États - 78000 Versailles\nTél.: 01 00 00 00 03\n",
        "SELARL Huissiers Test, Commissaires de Justice Associés\n8, rue du Test - 75017 Paris\n",
    )
    extracted = extract_licitor_fields(text)

    assert extracted["fields"]["lawyer_name"] is None
    assert extracted["source_property_features"]["lawyers"][0]["role"] == "commissaire_de_justice"


def test_deposit_amount_variants() -> None:
    text = MULTI_LOT_TEXT.replace(
        "Consignation pour enchérir\n: chèque de banque à l'ordre du\nBâtonnier Séquestre\nde\n20.000 €",
        "(Consignation : 3.000 €)",
    )
    lots = extract_licitor_fields(text)["source_property_features"]["lots"]
    assert lots[0]["deposit"]["amount_eur"] == 3000


def test_dedupe_licitor_images_keeps_thumbnail_only_without_full_size() -> None:
    assert dedupe_licitor_images(["a/1.small.jpg", "a/1.jpg", "a/2.small.jpg"]) == ["a/1.jpg", "a/2.small.jpg"]
    assert dedupe_licitor_images(None) == []


def test_recompute_replays_the_stored_licitor_page_without_network() -> None:
    from src.recompute_scoring import _recomputed_sale_from_storage_row

    url = "https://www.licitor.com/annonce/11/09/99/vente-aux-encheres/un-immeuble-de-rapport/testville/nievre/110999.html"
    row = {
        "id": "00000000-0000-4000-8000-000000000002",
        "source_name": "licitor",
        "source_url": url,
        "status": "upcoming",
        "visit_dates": ["Visite virtuelle"],
        "raw_payload": {"source_name": "licitor", "source_url": url, "source_blocks": {"page_text": MULTI_LOT_TEXT}},
    }
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.visit_dates == [
        "Visite sur place jeudi 5 novembre 2026 de 10h à 12h par la SAS Constat Test, Commissaires de Justice à Testville"
    ]
    assert sale.lawyer_name == "Maître Paul Fictif, Avocat"
    assert sale.raw_payload["source_property_features"]["lot_count"] == 2
    assert sale.raw_payload["source_blocks"]["caracteristiques_bien"]["procedure"]["method_label"] == "Liquidation judiciaire"
    completeness = sale.raw_payload["source_blocks"]["listing_completeness"]
    assert completeness["source_property_features"]["schema_version"] == "licitor_features_v1"


def test_surface_certificates_and_urbanism_documents_are_classified() -> None:
    url = "https://www.licitor.com/data/pub/media/annonce/11/02/02/110202.000.001.pdf"
    assert classify_document_type("Attestation de superficie", url) == "diagnostics_techniques"
    assert classify_document_type("Certificat de surface habitable", url) == "diagnostics_techniques"
    assert classify_document_type("Certificat d'urbanisme", url) == "cadastre"
    assert classify_document_type("Urbanisme", url) == "cadastre"
    assert classify_document_type("Articles et mise à prix", url) == "annonce_vente"


def test_stable_raw_text_drops_daily_edition_date_and_price_panel() -> None:
    from src.sources.licitor import _stable_raw_text

    page = (
        "Annonce n°\nÉdition du\nlundi 12 octobre 2026\nNouveau !\nUne maison\nMise à prix : 380 000 €\n"
        "Prix constatés des biens immobiliers vendus aux alentours\nPrix min.\n2 493 €/m²\nPrix moyen\n"
        "3 199 €/m²\nPrix max.\n4 228 €/m²\nVoir le dossier complet avec"
    )
    next_day = page.replace("lundi 12 octobre", "mardi 13 octobre").replace("3 199", "3 204")

    assert _stable_raw_text(page) == _stable_raw_text(next_day)
    assert "Mise à prix : 380 000 €" in _stable_raw_text(page)
    assert "octobre 2026" not in _stable_raw_text(page)
    assert "Voir le dossier complet avec" in _stable_raw_text(page)
