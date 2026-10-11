"""Lecture complète des fiches Vench, Avoventes et Info-Enchères (fixtures fictives)."""

from __future__ import annotations

import unicodedata

from src.normalize import normalize_sale
from src.sources import info_encheres, vench
from src.sources.avoventes import parse_avoventes_detail_html
from src.sources.avoventes_extraction import (
    extract_avoventes_html_extras,
    extract_avoventes_text_fields,
    refresh_avoventes_raw_sale,
)
from src.sources.info_encheres import parse_info_encheres_detail_html
from src.sources.info_encheres_extraction import gallery_images
from src.sources.listing_characteristics import (
    document_kind,
    euro_amount,
    known_detail_lacks_characteristics,
    restore_known_detail_blocks,
)
from src.sources.vench import parse_vench_detail_html, parse_vench_list_html

VENCH_FREE = """
<html><head><title>Vente</title></head><body>
<div id="page-heading"><h1>UN APPARTEMENT &bull; 60,57m² &bull; Exempleville</h1></div>
<section class="car-details">
 <div class="up-content"><h2>Ventes aux enchères publiques sur Licitation - <strong>Tribunal judiciaire de EXEMPLE</strong></h2></div>
 <p class="h4">Adresse</p>
 <p>2 rue des Exemples<br/>95100 <a href="./ville.html">Exempleville</a></p>
 <a href="#mapAnchor">Voir la carte</a>
 <div class="dateClefContener venteDate"><p class="h4">DATE DE L'AUDIENCE</p><strong>13/10/2026 à 14:00</strong></div>
 <div class="visitesContener dateClefContener"><p class="h4">DATE(S) DE VISITE</p>
   <div class="visite visite1"><strong>01/10/2026 entre 14:00 et 14:45</strong></div>
   <div class="visite visite2"><strong>05/10/2026 à 10:00</strong> <a href="#">Enregistrer</a></div></div>
 <div class="flexslider"><ul class="slides"><li data-thumb="/vignettes/v1.jpg"><img src="/vignettes/v1.jpg"></li></ul></div>
 <div class="descriptionContener">
   <p class="h4">Appartement &bull; 60,57m²</p>
   <p class="h4">Description</p>
   <div class="read-more"><p>de 60,57 m² au 4ème étage comprenant entrée, séjour, 2 chambres, salle de bain.</p></div>
   <p class="h4">Occupation</p><p>Bien occupé</p>
 </div>
 <div class="amenties"><div class="amentiesDetail"><span>Parking</span></div><div class="amentiesDetail"><span>Balcon</span></div>
   <p class="h4">Documents</p><ul class="lstDocs">
   <li><a href="https://document.vench.fr/docs/1.pdf">Procès-Verbal Descriptif.pdf</a></li>
   <li><a href="https://document.vench.fr/docs/2.pdf">EXEMPLE DIAG_.pdf</a></li></ul></div>
 <div class="infosRG"><div class="miseAPrix">Mise à prix : 90 000.00 €</div>
   <p class="h4">Consignation :</p><p>9.000 euros (Chèque de banque à l'ordre de la CARPA)</p>
   <p class="h4">Pour plus d'informations</p><p>Consulter le cahier des conditions de vente (RG: 26/00019), s’adresser au Greffe.</p></div>
 <div id="mapAnchor"><script>var lat = 48.9436262;
 var lon = 2.2548466;</script>
 <div class="carte-abonnes"><div class="titre">Carte parcellaire réservée aux abonnés</div></div></div>
 <div id="left-info">
  <div class="enquiry"><div class="head-side-bar"><p class="h4">Avocat poursuivant</p></div>
   <div class="contact-form"><p>CABINET EXEMPLE<br/>Maître Jean EXEMPLE Avocat</p></div>
   <div class="contact-form displayAPcoords"><p><span>1 rue du Palais<br/>95300 Exempleville</span>
     <br/><span class="fa fa-phone"></span> 01 23 45 67 89 <br/><a href="https://cabinet.example">https://cabinet.example</a></p></div></div>
  <div class="enquiry"><div class="head-side-bar"><p class="h4">Journal publicateur</p></div>
   <div class="contact-form"><p>Vente publiée par GAZETTE EXEMPLE le 02/09/2026<br/>1 rue de la Presse, 75000 PARIS</p></div></div>
  <div class="enquiry"><div class="head-side-bar"><p class="h4">Statistiques</p></div>
   <div class="contact-form statsVente"><ul><li>Publication : 31/08/2026</li></ul></div></div>
 </div>
</section>
<script>function showInfoBaissePrix(){ swal({text: "Cette vente dispose d'une faculté de baisse de prix "}); }</script>
</body></html>
"""

VENCH_PAYWALLED = """
<html><body>
<div id="page-heading"><h1>UN IMMEUBLE DE RAPPORT &bull; Exempleville</h1></div>
<div class="up-content"><h2>Ventes aux enchères publiques sur Liquidation judiciaire - <strong>Tribunal judiciaire de En l'étude du Notaire</strong></h2></div>
<p class="h4">Adresse</p><p>54240 <a href="#">Exempleville</a></p>
<div class="dateClefContener venteDate"><p class="h4">DATE DE L'AUDIENCE</p><strong>09/11/2026 à 14:30</strong></div>
<div class="descriptionContener"><p class="h4">Immeuble</p><p class="h4">Description</p>
 <p>Pour consulter l'intégralité des informations disponibles sur cette vente, vous devez être abonné.</p></div>
<div class="infosRG"><div class="miseAPrix">Mise à prix : 50 000.00 €</div>
 <p class="h4">Consignation :</p><p>5000,00 EUR</p><p class="h4">* faculté de baisse de prix</p><p>Oui</p></div>
<div id="left-info">
 <div class="enquiry"><div class="head-side-bar"><p class="h4">Notaire</p></div>
  <div class="contact-form"><a href="./abonnement.html">S'abonner pour consulter</a></div></div>
 <div class="enquiry"><div class="head-side-bar"><p class="h4">Journal publicateur</p></div>
  <div class="contact-form"><p>Vente publiée par JOURNAL EXEMPLE - METZ le 04/10/2026<br/>Service abonnement, 57000 METZ</p></div></div>
</div>
</body></html>
"""


def test_vench_free_detail_reads_address_visits_lawyer_and_procedure() -> None:
    sale = parse_vench_detail_html(VENCH_FREE, "https://www.vench.fr/vente-1-un-appartement-exempleville.html")

    assert sale["address"] == "2 rue des Exemples 95100 Exempleville"
    assert sale["visit_dates"] == ["01/10/2026 entre 14:00 et 14:45", "05/10/2026 à 10:00"]
    assert sale["occupancy_status"] == "occupied"
    assert sale["lawyer_name"] == "CABINET EXEMPLE (Maître Jean EXEMPLE)"
    assert sale["lawyer_contact"] == "01 23 45 67 89 · https://cabinet.example"
    assert (sale["latitude"], sale["longitude"]) == ("48.9436262", "2.2548466")
    assert {document["type"] for document in sale["documents"]} == {"pv_descriptif", "diagnostics"}

    block = sale["source_blocks"]["caracteristiques_bien"]
    assert block["source"] == "vench"
    labels = {item["label"]: item["value"] for item in block["items"]}
    assert labels["Occupation"] == "Bien occupé"
    assert labels["Numéro RG"] == "26/00019"
    assert labels["Équipements signalés"] == "Parking, Balcon"
    assert labels["Journal d'annonces légales"] == "GAZETTE EXEMPLE"
    assert block["surfaces"]["published_surface_m2"] == "60.57"
    assert block["procedure"]["method_label"] == "Ventes aux enchères publiques sur Licitation"
    assert block["procedure"]["prices"] == {"deposit_eur": "9000"}
    # La phrase du script commun à toutes les fiches n'est pas une faculté de baisse.
    assert "Faculté de baisse de prix" not in {note["label"] for note in block["procedure"]["notes"]}
    assert block["dates"] == {"published_on": "2026-08-31"}
    assert [item["kind"] for item in block["attachments"]] == ["pv_huissier", "diagnostics_techniques"]
    tree = sale["source_property_features"]
    assert tree["schema_version"] == "vench_features_v1"
    assert tree["lawyer"]["lawyer"]["address"] == "1 rue du Palais 95300 Exempleville"
    assert tree["listing"]["access"] == "public"


def test_vench_paywalled_detail_keeps_public_procedure_facts_and_notary_venue() -> None:
    sale = parse_vench_detail_html(VENCH_PAYWALLED, "https://www.vench.fr/vente-2-un-immeuble-exempleville.html")

    assert sale["description"] is None
    assert sale["tribunal"] is None  # vente en l'étude du notaire, pas au tribunal
    assert "lawyer_name" not in sale or sale["lawyer_name"] is None
    block = sale["source_blocks"]["caracteristiques_bien"]
    assert block["procedure"]["legal_framework"] == "Liquidation judiciaire"
    assert {note["label"] for note in block["procedure"]["notes"]} == {"Consignation", "Faculté de baisse de prix"}
    assert block["procedure"]["prices"] == {"deposit_eur": "5000"}
    assert sale["source_property_features"]["listing"]["access"] == "subscribers_only"


def test_vench_enrichment_status_and_detail_blocks_survive_card_blocks() -> None:
    class Client:
        def get(self, url: str) -> str:
            return VENCH_FREE

    card = parse_vench_list_html(
        """<div class="featured-item"><img data-src="/Design/Img/replace/3.jpg">
        <div class="down-content"><a href="./vente-1-un-appartement-exempleville.html"><h3>UN APPARTEMENT &bull; Exempleville</h3></a>
        <p>de 60,57 m² au 4ème étage comprenant entrée, séjour...</p>
        <ul><li>Mise à prix : 90 000.00 €</li><li>Date de la vente : 13/10/26</li></ul></div></div>""",
        page_url="https://www.vench.fr/prochaines-ventes-aux-encheres.html",
    )[0]
    assert card["description"] is None
    assert card["source_blocks"]["extrait_liste"].startswith("de 60,57 m²")
    assert card["raw_image_url"] is None  # vignette de remplacement du site

    vench._enrich_sale_from_detail(Client(), card, [])

    # La mention « Carte parcellaire réservée aux abonnés » ne rend pas la fiche restreinte.
    assert card["source_detail_status"] == "complete"
    assert card["source_blocks"]["caracteristiques_bien"]["source"] == "vench"
    assert card["source_blocks"]["adresse_complete"] == "2 rue des Exemples 95100 Exempleville"
    assert "listing_completeness" in card["source_blocks"]
    assert card["source_property_features"]["schema_version"] == "vench_features_v1"
    normalized = normalize_sale(card)
    assert normalized.lawyer_name == "CABINET EXEMPLE (Maître Jean EXEMPLE)"
    assert str(normalized.latitude) == "48.9436262"


def test_unchanged_listing_without_characteristics_block_is_read_once_more() -> None:
    url = "https://www.vench.fr/vente-1-x.html"
    sale = {"source_url": url, "_known_unchanged": True}
    assert known_detail_lacks_characteristics(sale, {url: {"raw_payload": {"source_blocks": {"titre": "x"}}}})
    assert not known_detail_lacks_characteristics(
        sale, {url: {"raw_payload": {"source_blocks": {"caracteristiques_bien": {"source": "vench"}}}}}
    )
    assert not known_detail_lacks_characteristics({"source_url": url}, {url: {}})
    assert not known_detail_lacks_characteristics(sale, None)


def test_unchanged_listing_keeps_the_stored_detail_blocks_and_features() -> None:
    url = "https://www.vench.fr/vente-1-x.html"
    known = {url: {"raw_payload": {
        "source_blocks": {"caracteristiques_bien": {"source": "vench"}, "avocat": "CABINET EXEMPLE",
                          "listing_completeness": {"stale": True}},
        "source_property_features": {"schema_version": "vench_features_v1", "lawyer": {"lawyer": {"firm": "X"}},
                                     "floor": {"value": 2}},
    }}}
    sale = {"source_url": url, "_known_unchanged": True,
            "source_blocks": {"extrait_liste": "de 60 m²...", "listing_completeness": {"fresh": True}},
            "source_property_features": {"rooms_count": {"value": 3}}}

    assert restore_known_detail_blocks(sale, known) is True
    assert sale["source_blocks"] == {
        "caracteristiques_bien": {"source": "vench"}, "avocat": "CABINET EXEMPLE", "extrait_liste": "de 60 m²...",
    }
    assert sale["source_property_features"]["schema_version"] == "vench_features_v1"
    assert sale["source_property_features"]["rooms_count"] == {"value": 3}
    assert "floor" not in sale["source_property_features"]  # faits typés : recalculés, pas recopiés
    assert restore_known_detail_blocks({"source_url": url}, known) is False


AVOVENTES_TEXT = """Avoventes.fr
retour vers la liste
MAISON À EXEMPLEVILLE
Vente aux enchères
Maison
Mise à prix :
60 000,00 €
Frais prélables :
6 504,49 €
Consignation :
6 000,00 €
(Par chèque de banque à l'ordre indiqué dans le cahier des conditions de vente)
Vente
13 octobre 2026 à 11h00
VISITES :
LE LUNDI 28 SEPTEMBRE 2026 DE 14H00 À 16H00
% Estimez vos frais d'acquisition
7
pièces
3
chambres
137.63
m² superficie
À propos du bien
UNE MAISON ANCIENNE de 106,68 m² comprenant une cuisine.
Garage
Cadastre
Terrain : 650 m²
2 salle(s) de bain
1 salle(s) d'eau
2 WC
Construction : 1975
Chauffage : Gaz
État général : À rénover
Terrasse (0 m²)
Cave  (Cave voûtée)
Piscine
Diagnostic énergétique
DPE
D
GES
E
Taxe foncière : 1 908,00 €
Charges annuelles : 100,00 €
Informations complémentaires :
Maison ancienne offrant un potentiel de rénovation.
Documents*
AFFICHE.pdf
* Pour tout autre document, veuillez vous adresser au  cabinet via le bouton "DEMANDE D'INFORMATIONS" plus bas.
CABINET EXEMPLE
1 rue du Palais  75000 PARIS
Tél. :
+33100000000
Email. :
[javascript protected email address]
Site. :
https://cabinet.example
Voir toutes les ventes de ce cabinet
"""


def test_avoventes_text_reads_tiles_features_fees_energy_and_cabinet() -> None:
    extracted = extract_avoventes_text_fields(
        AVOVENTES_TEXT,
        property_type="house",
        documents=[{"label": "AFFICHE.pdf", "url": "https://avoventes.fr/public/uploads/x/documents/a.pdf"}],
        photos=2,
    )

    fields = extracted["fields"]
    assert fields["bedrooms_count"] == 3
    assert fields["bathrooms_count"] == 3
    assert fields["published_surface_m2"] == "137.63"
    assert fields["land_surface_m2"] == "650"
    assert fields["has_terrace"] is True and fields["has_pool"] is True
    # « Garage » seul dans la description n'est pas une caractéristique de la liste.
    assert "has_garage" not in fields
    assert fields["source_energy_diagnostics"]["dpe_class"] == "D"
    assert fields["lawyer_name"] == "CABINET EXEMPLE"
    block = extracted["source_blocks"]["caracteristiques_bien"]
    values = {item["label"]: item["value"] for item in block["items"]}
    assert values["Année de construction"] == "1975"
    assert values["Chauffage"] == "Gaz"
    assert values["État général"] == "À rénover"
    assert values["WC"] == "2"
    assert values["Cave"] == "Cave voûtée"
    assert values["Terrasse"] == "Oui"
    assert block["procedure"]["prices"] == {
        "preliminary_fees_eur": "6504.49",
        "deposit_eur": "6000",
        "property_tax_eur": "1908",
    }
    assert block["procedure"]["visits"] == ["LE LUNDI 28 SEPTEMBRE 2026 DE 14H00 À 16H00"]
    assert block["energy"] == {"dpe_class": "D", "ges_class": "E"}
    assert block["media"] == {"photos": 2}
    tree = extracted["source_property_features"]
    assert tree["characteristics"]["year_built"] == 1975
    assert tree["characteristics"]["annual_charges_eur"] == "100"
    assert tree["lawyer"]["website"] == "https://cabinet.example"
    assert tree["complement"] == "Maison ancienne offrant un potentiel de rénovation."


def test_avoventes_text_reads_price_conditions_multiline_visits_and_bare_website() -> None:
    text = (
        AVOVENTES_TEXT.replace(
            "Mise à prix :\n60 000,00 €\n",
            "Mise à prix :\n60 000,00 €\navec faculté de baisse d’un quart en cas d'enchères désertes\n",
        )
        .replace(
            "LE LUNDI 28 SEPTEMBRE 2026 DE 14H00 À 16H00\n",
            "La visite aura lieu le 13 NOVEMBRE 2026 de 11 H à 12 H\nSelarl EXEMPLE (RDV SUR PLACE)\n",
        )
        .replace("https://cabinet.example", "www.cabinet.example")
    )
    extracted = extract_avoventes_text_fields(text, property_type="house")

    procedure = extracted["source_blocks"]["caracteristiques_bien"]["procedure"]
    assert procedure["notes"][0] == {
        "label": "Conditions de la mise à prix",
        "value": "avec faculté de baisse d’un quart en cas d'enchères désertes",
    }
    assert procedure["visits"] == ["La visite aura lieu le 13 NOVEMBRE 2026 de 11 H à 12 H Selarl EXEMPLE (RDV SUR PLACE)"]
    assert extracted["source_property_features"]["lawyer"]["website"] == "https://www.cabinet.example"


def test_avoventes_text_keeps_counts_off_canonical_fields_for_a_mixed_lot() -> None:
    text = AVOVENTES_TEXT.replace("Terrain : 650 m²", "Terrain : 0.57 m²")
    extracted = extract_avoventes_text_fields(text, property_type="mixed")

    assert "bedrooms_count" not in extracted["fields"]
    assert "bathrooms_count" not in extracted["fields"]
    assert "land_surface_m2" not in extracted["fields"]  # 0,57 m² : unité manifestement erronée
    assert extracted["source_property_features"]["characteristics"]["bedrooms_count"] == 3


def test_avoventes_html_extras_read_marker_and_cadastral_parcels() -> None:
    html = """<script>var marker = L.marker([49.2353505, 2.7287036]).addTo(map);
    var geojsonFeature = [{"type":"Feature","properties":{"numero":"0695","section":"0D","code_insee":"60000",
    "nom_com":"Exempleville","idu":"600000000D0695","contenance":592}}];
    </script>"""

    extras = extract_avoventes_html_extras(html)

    assert (extras["latitude"], extras["longitude"]) == ("49.2353505", "2.7287036")
    assert extras["cadastre"]["designation"] == "Parcelle D 695 à Exempleville"
    assert extras["cadastre"]["insee_code"] == "60000"
    assert extras["cadastre"]["contenance_m2"] == 592


def test_avoventes_detail_page_attaches_characteristics_and_coordinates() -> None:
    body = "".join(f"<p>{line}</p>" for line in AVOVENTES_TEXT.splitlines())
    html = f"""<html><body>{body}
    <ul id="lightSliderDetails"><li><p data-src="/public/uploads/cabinet/1/images/resized_a.jpg"></p></li></ul>
    <script>var markerC = L.marker([48.5, 2.3]).addTo(cadastre);</script></body></html>"""

    details = parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/maison-a-exempleville")

    structured = details["structured"]
    assert structured["source_blocks"]["caracteristiques_bien"]["media"] == {"photos": 1}
    assert structured["fields"]["latitude"] == "48.5"


def test_refresh_avoventes_raw_sale_replays_stored_page_text() -> None:
    raw = {
        "source_name": "avoventes",
        "property_type": "house",
        "surface_m2": None,
        "source_images": ["https://avoventes.fr/public/uploads/x/images/resized_a.jpg"],
        "source_blocks": {"page_text": AVOVENTES_TEXT},
        "source_property_features": {
            "coordinates": {"latitude": "48.5", "longitude": "2.3"},
            "cadastre_location": {"designation": "Parcelle D 695 à Exempleville", "insee_code": "60000"},
        },
    }

    assert refresh_avoventes_raw_sale(raw) is True
    assert raw["surface_m2"] is None  # la tuile reste une « superficie publiée » d'affichage
    assert raw["source_blocks"]["superficie_publiee"] == "137.63"
    assert raw["bedrooms_count"] == 3
    assert raw["latitude"] == "48.5"
    block = raw["source_blocks"]["caracteristiques_bien"]
    assert block["location"] == {"designation": "Parcelle D 695 à Exempleville", "insee_code": "60000"}
    assert refresh_avoventes_raw_sale({"source_name": "vench", "source_blocks": {"page_text": AVOVENTES_TEXT}}) is False


INFO_ENCHERES_DETAIL = """
<html><head><meta name="title" content="Maison à EXEMPLEVILLE"></head><body>
<table>
<tr><td>Référence :</td><td>9999</td></tr>
<tr><td>Nature du bien :</td><td>Maison avec garage</td></tr>
<tr><td>Adresse :</td><td>5 Chemin des Exemples 31140 EXEMPLEVILLE</td></tr>
<tr><td>Superficie :</td><td>52.87 m²</td></tr>
<tr><td>Mise à prix</td><td>90 000 € avec faculté de baisse d'un quart puis de moitié</td></tr>
<tr><td>Vente le :</td><td>08/10/2026</td></tr>
<tr><td>Au Tribunal Judiciaire de :</td><td>EXEMPLE<br>6 RUE DU PALAIS - 31000 EXEMPLE</td></tr>
<tr><td>Date de visite :</td><td>Le 29 septembre 2026 de 11h à 12h</td></tr>
</table>
<div class="avocat"><div class="nom"><b>SELARL EXEMPLE</b><span class="tel">05.00.00.00.00</span></div></div>
<a href="https://www.info-encheres.com/upload/abcCCV.pdf">cahier des conditions de la vente</a>
<a href="https://www.info-encheres.com/upload/abcDDT.pdf">•  Diagnostics techniques</a>
<a href="https://www.info-encheres.com/upload/CU1.pdf">•  Renseignements d'urbanisme</a>
<a href="javascript:;" id="fancybox-manual-c"><img src="pix/photo.png"></a>
<h2>Description</h2>
<div class="int2">Vente aux enchères publiques sur licitation : UNE MAISON, CADASTRE_PLACEHOLDER d'une contenance de 03 a 14 ca.
Libre de toute occupation. Seuls les Avocats au Barreau de EXEMPLE peuvent soutenir les enchères.
Au Greffe (n° RG 26/00134). Les audiences de vente débutent à 14h Salle Pastel.</div>
<script>$("#fancybox-manual-c").click(function() { $.fancybox.open([
 { href :  'https://www.info-encheres.com/upload/aaPhoto_1.jpg', title : ''	} , { href :  'https://www.info-encheres.com/upload/bbPhoto_2.jpg', title : ''	}
]); });
var lat = 43.67;
var lon = 1.43;</script>
</body></html>
"""


def _info_detail_html() -> str:
    # Accents décomposés (« e » + accent combinant) comme sur certaines fiches.
    return INFO_ENCHERES_DETAIL.replace("CADASTRE_PLACEHOLDER", unicodedata.normalize("NFD", "Cadastré Section AB N° 171"))


def test_info_encheres_detail_reads_gallery_cadastre_and_procedure_notes() -> None:
    sale = parse_info_encheres_detail_html(_info_detail_html(), "https://www.info-encheres.com/1-d-vente-31-ref-9999.html")

    assert sale["source_images"] == [
        "https://www.info-encheres.com/upload/aaPhoto_1.jpg",
        "https://www.info-encheres.com/upload/bbPhoto_2.jpg",
    ]
    block = sale["source_blocks"]["caracteristiques_bien"]
    values = {item["label"]: item["value"] for item in block["items"]}
    assert values["Numéro RG"] == "26/00134"
    assert values["Barreau autorisé à enchérir"] == "EXEMPLE"
    assert values["Contenance cadastrale"] == "03 a 14 ca"
    assert values["Adresse du tribunal"] == "6 RUE DU PALAIS - 31000 EXEMPLE"
    assert block["location"]["designation"].startswith("Parcelle AB 171")
    assert block["media"] == {"photos": 2}
    assert block["procedure"]["legal_framework"] == "Licitation"
    notes = {note["label"]: note["value"] for note in block["procedure"]["notes"]}
    assert notes["Conditions de la mise à prix"] == "avec faculté de baisse d'un quart puis de moitié"
    assert notes["Audience"].startswith("Les audiences de vente débutent à 14h")
    assert [item["kind"] for item in block["attachments"]] == [
        "cahier_conditions_vente",
        "diagnostics_techniques",
        "urbanisme",
    ]


def test_info_encheres_enrichment_merges_detail_blocks_into_card_blocks() -> None:
    class Client:
        def get(self, url: str) -> str:
            return _info_detail_html()

    sale = {
        "source_name": "info_encheres",
        "source_url": "https://www.info-encheres.com/1-d-vente-31-ref-9999.html",
        "raw_text": "Reference: 9999",
        "source_blocks": {"listing_completeness": {}},
    }
    info_encheres._enrich_sale_from_detail(Client(), sale, [])

    assert sale["source_blocks"]["caracteristiques_bien"]["source"] == "info_encheres"
    assert sale["source_blocks"]["detail_reference"] == "9999"
    assert sale["source_property_features"]["schema_version"] == "info_encheres_features_v1"
    assert len(sale["source_images"]) == 2


def test_info_encheres_drops_the_site_fallback_coordinates_and_stops_cadastre_at_the_lot() -> None:
    html = (
        _info_detail_html()
        .replace("var lat = 43.67;", "var lat = 44.40655;")
        .replace("var lon = 1.43;", "var lon = 6.061187;")
        .replace(
            unicodedata.normalize("NFD", "Cadastré Section AB N° 171") + " d'une contenance de 03 a 14 ca",
            "cadastré BY69 : UN APPARTEMENT de 89 m², Superficie 2 a 04 ca",
        )
    )
    sale = parse_info_encheres_detail_html(html, "https://www.info-encheres.com/1-d-vente-31-ref-9999.html")

    assert sale["latitude"] is None and sale["longitude"] is None
    assert sale["source_property_features"]["cadastre_location"]["references"] == ["BY 69"]


def test_gallery_images_ignore_site_assets() -> None:
    html = "{ href : 'https://www.info-encheres.com/pix/logo.png' } { href : 'https://www.info-encheres.com/upload/a.jpg' }"
    assert gallery_images(html) == ["https://www.info-encheres.com/upload/a.jpg"]


def test_euro_amount_and_document_kind() -> None:
    assert euro_amount("6 504,49 €") == "6504.49"
    assert euro_amount("9.000 euros (chèque)") == "9000"
    assert euro_amount("5000,00 EUR") == "5000"
    assert euro_amount("9.000 euros et 12.000 euros") is None
    assert euro_amount("Ces frais seront connus une semaine avant la vente") is None
    assert document_kind("DDT.pdf")[0] == "diagnostics_techniques"
    assert document_kind("DIRE URBANISME + ANNEXES.pdf")[0] == "dire"
    assert document_kind("• Renseignements du Syndic")[0] == "copropriete"
    assert document_kind("superficie et plan bat 3.pdf")[0] == "plans"
    assert document_kind("Affiche légale.pdf") == ("annonce_vente", "Avis de vente / affiche")
