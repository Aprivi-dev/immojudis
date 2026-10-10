"""Lecture de l'adresse d'un bien : fixtures fictives qui reproduisent la structure observée en production."""

from src.listing_location import (
    classify_address,
    extract_adresse_du_bien,
    extract_designation,
    extract_property_street,
    recover_listing_address,
    reject_monetary_address,
)
from src.normalize import normalize_sale
from src.sources import avoventes
from src.sources import encheres_immobilieres as ei

# Structure réelle de la page détail : les libellés (« Mise à prix », « Adresse du bien ») sont rendus
# AVANT leurs valeurs (prix, puis voie, « , », code postal, commune). La ligne qui suit « Adresse du bien »
# est donc le prix. Toutes les valeurs ci-dessous sont fictives.
DETAIL_LINES = [
    "UNE MAISON D'HABITATION à EXEMPLEVILLE (59)",
    "Mise à prix",
    "Adresse du bien",
    "30 000 €",
    "12 rue des Lilas",
    ",",
    "59000",
    "EXEMPLEVILLE",
    "Date de mise en vente",
    "Adresse de la vente",
    "jeudi 17 septembre 2026 à 09h00",
    "Tribunal Judiciaire d'Exempleville",
    "-",
    "3 Place du Palais",
    ",",
    "59000",
    "EXEMPLEVILLE",
    "Descriptif du bien",
    "Réf. annonce :",
    "9001",
    "Me Exemple Avocat 7 rue du Cabinet 59000 EXEMPLEVILLE",
]


def _detail_html(lines: list[str]) -> str:
    return "<article><h1>" + lines[0] + "</h1>" + "".join(f"<p>{line}</p>" for line in lines[1:]) + "</article>"


def test_address_is_the_street_before_the_comma_not_the_price_after_the_label():
    assert extract_adresse_du_bien(DETAIL_LINES) == "12 rue des Lilas, 59000 EXEMPLEVILLE"


def test_procedure_qualifiers_between_the_price_and_the_street_are_skipped():
    lines = DETAIL_LINES.copy()
    lines[4:4] = ["avec faculté de baisse"]
    assert extract_adresse_du_bien(lines) == "12 rue des Lilas, 59000 EXEMPLEVILLE"
    lines = DETAIL_LINES.copy()
    lines[4:4] = ["Sur", "licitation"]
    assert extract_adresse_du_bien(lines) == "12 rue des Lilas, 59000 EXEMPLEVILLE"


def test_unnumbered_street_and_lieu_dit_are_kept():
    lines = DETAIL_LINES.copy()
    lines[4] = "rue Marc Exemple"
    assert extract_adresse_du_bien(lines) == "rue Marc Exemple, 59000 EXEMPLEVILLE"
    lines[4] = "Lieu-dit Les Vignes"
    assert extract_adresse_du_bien(lines) == "Lieu-dit Les Vignes, 59000 EXEMPLEVILLE"


def test_no_street_gives_nothing_rather_than_the_court_or_the_lawyer():
    lines = DETAIL_LINES.copy()
    del lines[4]  # le prix est suivi directement de « , » : pas de voie
    assert extract_adresse_du_bien(lines) is None
    lines = DETAIL_LINES.copy()
    lines[4] = "licitation"  # une mention de procédure n'est pas une voie
    assert extract_adresse_du_bien(lines) is None


def test_older_single_line_layout_is_still_read():
    lines = ["Adresse du bien", "2 rue du Detail, 33000 BORDEAUX", "MISE À PRIX", "80 000 €"]
    assert extract_adresse_du_bien(lines) == "2 rue du Detail, 33000 BORDEAUX"


def test_detail_parser_reads_the_property_address_from_the_real_layout():
    detail = ei.parse_encheres_immobilieres_detail_html(
        _detail_html(DETAIL_LINES), f"{ei.BASE_URL}/ventes/9001-maison-exempleville-59"
    )
    assert detail["address"] == "12 rue des Lilas, 59000 EXEMPLEVILLE"
    assert detail["postal_code"] == "59000"
    assert "Palais" not in detail["address"] and "Cabinet" not in detail["address"]


def test_detail_parser_without_a_street_does_not_fall_back_to_lawyer_or_court_text():
    lines = DETAIL_LINES.copy()
    del lines[4]
    detail = ei.parse_encheres_immobilieres_detail_html(
        _detail_html(lines), f"{ei.BASE_URL}/ventes/9001-maison-exempleville-59"
    )
    assert detail["address"] is None


def _stored_encheres_immobilieres_payload(page_lines: list[str]) -> dict:
    """Ligne déjà en base : le bloc `adresse` contenait le prix, l'adresse de la colonne était vide."""
    return {
        "source_name": "encheres_immobilieres",
        "source_url": "https://encheresimmobilieres.fr/ventes/9001-maison-exempleville-59",
        "title": "Maison",
        "city": "Exempleville",
        "postal_code": "59000",
        "address": None,
        "source_blocks": {"adresse": "30 000 €", "page_text": "\n".join(page_lines)},
    }


def test_recompute_recovers_the_address_of_an_already_stored_sale():
    sale = normalize_sale(_stored_encheres_immobilieres_payload(DETAIL_LINES))
    assert sale.address == "12 rue des Lilas, 59000 EXEMPLEVILLE"


def test_a_price_in_the_address_field_is_rejected_and_recorded():
    raw = {"address": "500 000 €", "latitude": 1, "longitude": 2, "quality_flags": []}
    cleaned, address = reject_monetary_address(raw, "500 000 €")
    assert address is None
    assert cleaned["invalid_address_evidence"]["reason"] == "monetary_value_is_not_address"
    assert "address_unverified" in cleaned["quality_flags"] and cleaned["latitude"] is None
    assert raw["latitude"] == 1  # l'entrée n'est pas modifiée


def test_a_precise_address_is_never_overwritten_by_recovery():
    raw = _stored_encheres_immobilieres_payload(DETAIL_LINES)
    assert recover_listing_address(raw, "5 avenue du Test, 59000 Exempleville") == "5 avenue du Test, 59000 Exempleville"


def test_sources_without_a_reliable_location_block_stay_empty():
    # petites_affiches : « Lieu de Vente » est l'adresse du tribunal, « Avocat Poursuivant » le cabinet.
    raw = {
        "source_name": "petites_affiches",
        "source_blocks": {
            "page_text": "Avocat Poursuivant Maître Exemple 0100000000 Lieu de Vente TJ D EXEMPLE 9 Rue des Mazières, 91012 EVRY"
        },
        "description": "UNE MAISON D'HABITATION à Exempleville",
    }
    assert recover_listing_address(raw, "Exempleville") == "Exempleville"


def test_classification_levels():
    assert classify_address("23 bis, rue Exemple") == "street"
    assert classify_address("Lieudit Les Escaputeous , 06510 GATTIÈRES") == "lieu_dit"
    assert classify_address("Section AB n° 12") == "parcel"
    assert classify_address("60260 Exempleville") == "commune"
    assert classify_address("LOTS MULTIPLES") is None
    assert classify_address("500 000 €") is None


def test_free_text_street_needs_a_property_marker_and_a_proper_name():
    assert extract_property_street("À EXEMPLEVILLE (78450) - 21 rue Haute Sur un terrain cadastré") == "21 rue Haute"
    assert (
        extract_property_street("Terrain situé après le n°17, avenue du Maréchal Exemple à Exempleville")
        == "17, avenue du Maréchal Exemple"
    )
    assert extract_property_street("entrées privatives sur rue et visibilité importante") is None
    assert extract_property_street("Avocat 49 bis boulevard Exemple 13150 TARASCON") is None


def test_designation_levels_for_state_sales():
    assert extract_designation("Ensemble immobilier Rue De La Manufacture à Exempleville") == "street"
    assert extract_designation("cadastrée Section BR n° 345 bâtiment A") == "parcel"
    assert extract_designation("lieudit « La Garenne » sur la commune") == "lieu_dit"
    assert extract_designation("Maison forestière sur un terrain arboré entièrement clos.") is None


# ---------------------------------------------------------------- avoventes
def test_avoventes_street_is_trimmed_before_the_surface_and_sentence_starts():
    cases = {
        "UN APPARTEMENT à EXEMPLEVILLE (92230) 13 rue du Puits Exemple de 70,20 m² (hors terrasses). Au 4ème étage":
            "13 rue du Puits Exemple",
        "À EXEMPLEVILLE (78450) - 21 rue Haute Sur un terrain cadastré section AA n°387, lieudit":
            "21 rue Haute",
        "immeubles situés 119, Route de Exemple, et Le Bourg, cadastrés sections C n° 571":
            "119 Route de Exemple",
        "UN APPARTEMENT à EXEMPLEVILLE (92160) « Villa Exemple » - 126-132 avenue de la Division Test de 69,1 m²":
            "126-132 avenue de la Division Test",
    }
    for description, expected in cases.items():
        assert avoventes._extract_property_location(description, None)["address"] == expected


AVOVENTES_DETAIL = """
<html><body><section>
  <h1>UN APPARTEMENT à EXEMPLEVILLE (92)</h1>
  <span>Vente aux enchères</span><p>Mise à prix : 20 000,00 €</p>
  <h2>À propos du bien</h2>
  <div class="property-description">
    UN APPARTEMENT à EXEMPLEVILLE (92230) 13 rue du Puits Exemple de 70,20 m² (hors terrasses).
    Au 4ème étage comprenant : entrée, séjour.
  </div>
</section></body></html>
"""


def test_avoventes_detail_street_replaces_the_commune_only_address_of_the_list_card():
    class Client:
        def get(self, url):
            return AVOVENTES_DETAIL

    url = "https://avoventes.fr/enchere/un-appartement-a-exempleville-92"
    card = {"source_url": url, "address": "92230 Exempleville, France", "city": "Exempleville"}
    avoventes._enrich_sale_from_detail(Client(), card, [])
    assert card["address"] == "13 rue du Puits Exemple"

    precise = {"source_url": url, "address": "5 avenue du Test, 92230 Exempleville"}
    avoventes._enrich_sale_from_detail(Client(), precise, [])
    assert precise["address"] == "5 avenue du Test, 92230 Exempleville"


def test_recompute_upgrades_an_avoventes_commune_address_with_the_street_of_the_description():
    raw = {
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/1",
        "address": "92230 Exempleville, France",
        "city": "Exempleville",
        "postal_code": "92230",
        "title": "Appartement",
        "source_blocks": {
            "description": "UN APPARTEMENT à EXEMPLEVILLE (92230) 13 rue du Puits Exemple de 70,20 m² (hors terrasses)."
        },
    }
    sale = normalize_sale(raw)
    assert sale.address == "13 rue du Puits Exemple, 92230 EXEMPLEVILLE"


def test_recompute_keeps_the_commune_address_when_the_description_has_no_numbered_street():
    raw = {
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/2",
        "address": "89400 Exempleville, France",
        "source_blocks": {"description": "Dans un ensemble immobilier sis à EXEMPLEVILLE (89400), place du Test"},
    }
    assert normalize_sale(raw).address == "89400 Exempleville, France"
