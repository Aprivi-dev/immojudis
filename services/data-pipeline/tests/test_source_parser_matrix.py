from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest

from src.models import AuctionSale
from src.normalize import normalize_sale
from src.sources.agrasc import parse_agrasc_html
from src.sources.avoventes import parse_avoventes_html
from src.sources.cessions_etat import parse_cessions_etat_detail_html
from src.sources.encheres_immobilieres import parse_encheres_immobilieres_html
from src.sources.encheres_publiques import parse_encheres_publiques_detail_html
from src.sources.info_encheres import parse_info_encheres_detail_html
from src.sources.licitor import parse_licitor_detail_html
from src.sources.notaires import parse_notaires_detail_json
from src.sources.petites_affiches import parse_petites_affiches_detail_html
from src.sources.vench import parse_vench_detail_html


@dataclass(frozen=True)
class ParserCalibrationCase:
    name: str
    parse: Callable[[], dict[str, Any]]
    expected: dict[str, Any]


def _first(rows: list[dict[str, Any]]) -> dict[str, Any]:
    assert rows
    return rows[0]


def _notaires_detail_case() -> dict[str, Any]:
    payload = json.dumps(
        {
            "typeTransaction": "VAE",
            "vae": {
                "reference": "VAE-MATRIX",
                "descriptions": [
                    {
                        "langue": "fr",
                        "descCourte": "Maison avec jardin",
                        "descLongue": (
                            "PAU (64000) 3 rue Test Maison de 101 m² habitables avec trois chambres, "
                            "garage et jardin. Libre de toute occupation. Me Test, notaire à Pau."
                        ),
                    }
                ],
                "miseAPrix": 180000,
                "seanceDate": "2026-09-17T09:00:00Z",
                "visite": {"visiteLibre": "le 10 septembre 2026 de 14h00 à 15h00"},
                "multimedias": [{"urlHighestResolution": "https://notaires.example.test/pau-maison.jpg"}],
            },
            "bien": {
                "typeBien": "MAI",
                "maison": {
                    "typeBien": "MAI",
                    "adresse4": "3 rue Test",
                    "codePostal": "64000",
                    "communeNom": "Pau",
                    "inseeDepartement": "64",
                    "surfaceHabitable": 101,
                    "surfaceTerrain": 489,
                    "nbPieces": 4,
                    "nbChambres": 3,
                    "situationLocative": "LIBRE",
                },
            },
            "contact": {"nom": "Office Test", "telephone": "0559000000"},
        }
    )
    return {
        "source_name": "notaires",
        "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/test-matrix",
        **parse_notaires_detail_json(payload),
    }


CASES = (
    ParserCalibrationCase(
        name="avoventes_list",
        parse=lambda: _first(
            parse_avoventes_html(
                """
                <article>
                  <h2>Vente aux enchères Maison</h2>
                  <a href="/enchere/maison-bordeaux-matrix">Voir la vente</a>
                  <p>12 rue Test 33000 Bordeaux</p>
                  <p>Mise à prix : 120 000 €</p>
                  <p>Date de la vente : jeudi 10 janvier 2027 à 09h00</p>
                  <p>Date des visites : 5 janvier 2027 à 10h00</p>
                  <p>Cabinet : Me Test</p>
                  <p>Maison de 84 m² habitables avec jardin.</p>
                  <a href="/docs/cahier-conditions.pdf">Cahier des conditions de vente</a>
                </article>
                """,
                page_url="https://avoventes.fr/recherche?departement=33",
                fallback_department="33",
            )
        ),
        expected={
            "source_name": "avoventes",
            "department": "33",
            "city": "Bordeaux",
            "postal_code": "33000",
            "address": "12 rue Test 33000 Bordeaux",
            "property_type": "house",
            "surface_m2": Decimal("84"),
            "habitable_surface_m2": Decimal("84"),
            "starting_price_eur": Decimal("120000"),
            "lawyer_name": "Me Test",
            "has_garden": True,
            "sale_date_date": "2027-01-10",
            "visit_dates_count": 1,
            "documents_count": 1,
            "document_types": ["pdf"],
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="licitor_detail",
        parse=lambda: parse_licitor_detail_html(
            """
            <h1>Annonce n°108625 : une maison d'habitation à Mérignac (Gironde), mise à prix : 200 000 €</h1>
            <p>Tribunal Judiciaire de Bordeaux (Gironde)</p>
            <p>Vente aux enchères publiques</p>
            <p>jeudi 11 juin 2026 à 15h</p>
            <h2>Une maison d'habitation</h2>
            <h3>Mise à prix : 200 000 €</h3>
            <p>Mérignac</p>
            <p>2, av. des Azalés</p>
            <p><a href="https://carto.example.test/plan?q=44.8401,-0.6512&z=13">Afficher le plan</a></p>
            <div class="LegalAd"><img src="/data/pub/media/annonce/10/86/25/maison.jpg" /></div>
            <p>Visite sur place mardi 26 mai 2026 de 10h à 12h</p>
            <h3>Maître Juliette André, Avocat</h3>
            <p>Tél.: 05 35 54 98 12</p>
            <p>Surface habitable : 90 m² environ, libre de toute occupation.</p>
            <a href="/download/document?id=108625&pvd=1">PV descriptif</a>
            <a href="/download/document?id=108625&piece=cahier">Cahier des conditions de vente</a>
            """,
            "https://www.licitor.com/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html",
        ),
        expected={
            "source_name": "licitor",
            "department": "33",
            "city": "Mérignac",
            "address": "2, av. des Azalés, Mérignac",
            "tribunal": "Tribunal Judiciaire de Bordeaux (Gironde)",
            "property_type": "house",
            "surface_m2": Decimal("90"),
            "habitable_surface_m2": Decimal("90"),
            "starting_price_eur": Decimal("200000"),
            "latitude": Decimal("44.8401"),
            "longitude": Decimal("-0.6512"),
            "lawyer_name": "Maître Juliette André, Avocat",
            "lawyer_contact": "Tél.: 05 35 54 98 12",
            "occupancy_status": "vacant",
            "sale_date_date": "2026-06-11",
            "visit_dates_count": 1,
            "documents_count": 2,
            "document_types": ["pdf", "pdf"],
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="info_encheres_detail",
        parse=lambda: parse_info_encheres_detail_html(
            """
            <html>
              <head><meta name="title" content="Maison à SAINT-JEAN-DE-MARSACQ (40)" /></head>
              <body>
                <div class="avocat"><div class="nom"><b>SELARL LANDAVOCATS</b><div class="tel">05.58.90.02.26</div></div></div>
                <table>
                  <tr><td><b>Référence : </b></td><td>5970</td></tr>
                  <tr><td><b>Nature du bien : </b></td><td>Maison</td></tr>
                  <tr><td><b>Adresse : </b></td><td>36 Impasse Alexandre Viro <br />40230 SAINT-JEAN-DE-MARSACQ</td></tr>
                  <tr><td><b>Mise à prix </b></td><td>200 000 €</td></tr>
                  <tr><td><b>Vente le : </b></td><td>28/05/2026</td></tr>
                  <tr><td><b>Au Tribunal Judiciaire de : </b></td><td>Dax</td></tr>
                  <tr><td><b>Date de visite : </b></td><td>le mercredi 20 mai 2026 - De 15 heures à 16 heures</td></tr>
                </table>
                <div class="cadre"><div class="titre">Description</div><div class="int2">Maison de 120 m², libre de toute occupation.</div></div>
                <img src="/images/maison.jpg" />
                <a href="https://www.info-encheres.com/upload/nptPpvd.pdf">Procès-verbal descriptif</a>
              </body>
            </html>
            """,
            "https://www.info-encheres.com/108195-d-vente-encheres-immobilieres-maison-saint-jean-de-marsacq-40-ref-5970.html",
        ),
        expected={
            "source_name": "info_encheres",
            "department": "40",
            "city": "Saint-Jean-De-Marsacq",
            "address": "36 Impasse Alexandre Viro 40230 SAINT-JEAN-DE-MARSACQ",
            "tribunal": "Tribunal Judiciaire de Dax",
            "property_type": "house",
            "surface_m2": Decimal("120"),
            "starting_price_eur": Decimal("200000"),
            "lawyer_name": "SELARL LANDAVOCATS",
            "lawyer_contact": "05.58.90.02.26",
            "occupancy_status": "vacant",
            "sale_date_date": "2026-05-28",
            "visit_dates_count": 1,
            "documents_count": 1,
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="vench_detail",
        parse=lambda: parse_vench_detail_html(
            """
            <div id="page-heading"><h1>UNE MAISON DE 80 m² &bull; Ondres</h1></div>
            <p>Ventes aux enchères publiques - Tribunal judiciaire de DAX</p>
            <p>Adresse</p><p>40440 <a>Ondres</a></p>
            <p>DATE DE L'AUDIENCE</p><strong>11/06/2026 à 10:00</strong>
            <p>Prochaine visite : 09/06/2026 à 10:30</p>
            <p>Mise à prix : 106 000 €</p>
            <div class="amentiesDetail"><span>Terrasse</span></div>
            <div class="amentiesDetail"><span>Jardin</span></div>
            <div class="descriptionContener"><p>Maison libre avec terrasse et jardin.</p></div>
            <a href="/telechargement?id=165184&piece=cahier">Cahier des conditions de vente</a>
            <img src="/images/vente.jpg" />
            """,
            "https://www.vench.fr/vente-165184-une-maison-ondres.html",
        ),
        expected={
            "source_name": "vench",
            "department": "40",
            "city": "Ondres",
            "postal_code": "40440",
            "address": "40440 Ondres",
            "tribunal": "Tribunal judiciaire de DAX",
            "property_type": "house",
            "surface_m2": Decimal("80"),
            "starting_price_eur": Decimal("106000"),
            "has_garden": True,
            "has_terrace": True,
            "occupancy_status": "vacant",
            "sale_date_date": "2026-06-11",
            "visit_dates_count": 1,
            "documents_count": 1,
            "document_types": ["cahier_conditions"],
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="encheres_publiques_detail",
        parse=lambda: parse_encheres_publiques_detail_html(
            """
            <html><body><script id="__NEXT_DATA__" type="application/json">
            {"props":{"pageProps":{"apolloState":{"data":{
              "Adresse:1":{"text":"7 Rue du Palais Gallien, 33000 Bordeaux, France","ville":"Bordeaux","ville_slug":"bordeaux-33","coords":[-0.5812147,44.8416492]},
              "Profil:1":{"nom":"OFFICE NOTARIAL DU JEU DE PAUME","categorie":"notaire","telephone":"05 56 42 41 85"},
              "Evenement:1":{"titre":"Vente notariale interactive à Bordeaux","ouverture_date":1781005200},
              "PhotoLot:1":{"url":"/static/lot/photo/bordeaux.jpg"},
              "Lot:129346":{"id":"129346","nom":"Appartement T4 103,16 m² Carrez avec terrasse","categorie":"immobilier","sous_categorie":"appartements","adresse_physique":{"__ref":"Adresse:1"},"organisateur":{"__ref":"Profil:1"},"evenement":{"__ref":"Evenement:1"},"photos":[{"__ref":"PhotoLot:1"}],"criteres_resume":"Bordeaux · 103.16 m² · 4 pièces","critere_surface_habitable":103.16,"critere_nombre_de_pieces":4,"critere_nombre_de_chambres":3,"critere_diagnostic_date":"2026-04-27","critere_consommation_energetique":"C","critere_emissions_de_gaz":"D","critere_occupation_du_bien":"Libre de toute occupation","description":"Appartement T4 comprenant trois chambres, terrasse et place de parking. Surface loi Carrez confirmée.","mise_a_prix":340000,"termine":false}
            }}}}}
            </script></body></html>
            """,
            "https://www.encheres-publiques.com/encheres/immobilier/appartements/bordeaux-33/appartement_129346",
        ),
        expected={
            "source_name": "encheres_publiques",
            "department": "33",
            "city": "Bordeaux",
            "postal_code": "33000",
            "address": "7 Rue du Palais Gallien, 33000 Bordeaux, France",
            "property_type": "apartment",
            "surface_m2": Decimal("103.16"),
            "habitable_surface_m2": Decimal("103.16"),
            "carrez_surface_m2": Decimal("103.16"),
            "rooms_count": 4,
            "bedrooms_count": 3,
            "parking_count": 1,
            "starting_price_eur": Decimal("340000"),
            "lawyer_name": "OFFICE NOTARIAL DU JEU DE PAUME",
            "lawyer_contact": "05 56 42 41 85",
            "latitude": Decimal("44.8416492"),
            "longitude": Decimal("-0.5812147"),
            "occupancy_status": "vacant",
            "sale_date_date": "2026-06-09",
            "source_energy_dpe_class": "C",
            "source_energy_ges_class": "D",
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="petites_affiches_detail",
        parse=lambda: parse_petites_affiches_detail_html(
            """
            <meta name="description" content="Appartement T2 de 51 m² libre à Bordeaux" />
            <div class="row detail default">
              <h4>Mise à Prix : <strong>80 000</strong> €</h4>
              <div class="lot-adresse"><h4>Adresse : 33000 Bordeaux</h4></div>
            </div>
            <div class="contact-container">
              <ul><li><a title="Maître Dupont"><strong>Maître Dupont</strong></a></li><li>0422140871</li></ul>
              <div class="lieu-vente"><strong><a>TJ DE BORDEAUX</a></strong></div>
            </div>
            <p>Visites</p><p>mardi 5 mai 2026 de 10h00 à 11h00</p>
            <a href="/docs/pv-descriptif.pdf">Procès-verbal descriptif</a>
            <a href="/docs/cahier-conditions.pdf">Cahier des conditions de vente</a>
            <img src="/uploads/vente-bordeaux.jpg" />
            """,
            "https://www.petitesaffiches.fr/vente.html",
        ),
        expected={
            "source_name": "petites_affiches",
            "department": "33",
            "city": "Bordeaux",
            "postal_code": "33000",
            "address": "33000 Bordeaux",
            "tribunal": "TJ DE BORDEAUX",
            "property_type": "apartment",
            "surface_m2": Decimal("51"),
            "starting_price_eur": Decimal("80000"),
            "lawyer_name": "Maître Dupont",
            "lawyer_contact": "0422140871",
            "visit_dates_count": 1,
            "documents_count": 2,
            "document_types": ["pdf", "pdf"],
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="cessions_etat_detail",
        parse=lambda: {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon",
            "property_type": "Bureaux / Commerces",
            "city": "Cancon",
            "department": "47",
            **parse_cessions_etat_detail_html(
                """
                <article>
                  <div class="field--name-body">
                    Ancien logement domanial. Surface en m² : 134.
                    Terrain d'une superficie totale de 420 m². Prix : 210 000 €.
                  </div>
                  <p>Adresse : 47290 Cancon</p>
                  <p>Date limite : 24 septembre 2026 à 12h00</p>
                  <p>Visites : sur rendez-vous auprès du service local</p>
                  <a href="/documents/cahier.pdf">Cahier des charges</a>
                  <img src="/sites/default/files/cancon.jpg" />
                </article>
                """,
                "https://cessions.immobilier-etat.gouv.fr/biens/immeuble-vendre-cancon",
            ),
        },
        expected={
            "source_name": "cessions_etat",
            "department": "47",
            "city": "Cancon",
            "postal_code": "47290",
            "property_type": "commercial",
            "surface_m2": Decimal("134"),
            "land_surface_m2": Decimal("420"),
            "starting_price_eur": Decimal("210000"),
            "sale_date_date": "2026-09-24",
            "visit_dates_count": 1,
            "documents_count": 1,
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="agrasc_card",
        parse=lambda: _first(
            parse_agrasc_html(
                """
                <div class="fr-card card-vente-immo external-link">
                  <h3 class="fr-card__title"><a href="https://example.test/vente">Maison</a></h3>
                  <p class="fr-card__detail">Agen (47)</p>
                  <p class="fr-card__desc">Maison avec jardin sur terrain de 483 m², libre de toute occupation.</p>
                  <p class="fr-badge fr-badge--sm">89 m²</p>
                  <p class="fr-badge fr-badge--info">MAP : 91 466 €</p>
                  <p class="fr-card__detail">16 juin 2026</p>
                  <img src="/maison.jpg" />
                </div>
                """
            )
        ),
        expected={
            "source_name": "agrasc",
            "department": "47",
            "city": "Agen",
            "property_type": "house",
            "surface_m2": Decimal("89"),
            "land_surface_m2": Decimal("483"),
            "starting_price_eur": Decimal("91466"),
            "has_garden": True,
            "occupancy_status": "vacant",
            "sale_date_date": "2026-06-16",
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="encheres_immobilieres_payload",
        parse=lambda: _first(
            parse_encheres_immobilieres_html(
                '<script>self.__next_f.push([1,"'
                + json.dumps(
                    {
                        "id": 9001,
                        "titre": "APPARTEMENT 2P de 51,66 m2 a PAU (64)",
                        "prix": 60000,
                        "typeVente": "judiciaire",
                        "adresse": "1 rue Test",
                        "codePostal": "64000",
                        "departement": "64",
                        "ville": "PAU",
                        "latitude": 43.3,
                        "longitude": -0.37,
                        "description": "Appartement occupe avec une place de parking",
                        "url": "9001-appartement-pau-64",
                        "dateVente": "$D2026-07-09T09:00:00.000Z",
                        "complement": "<p>Appartement occupe avec une place de parking</p>",
                        "complementVisite": "Sur rendez-vous",
                        "prixAdjudication": 72000,
                        "entete": "Cabinet Test",
                        "ccv": "RG 1",
                        "avocat": {"nom": "Cabinet Test", "tel": "0559000000"},
                        "photos": [{"url": "/uploads/ventes/9001/photo.jpg"}],
                        "lots": [],
                    },
                    ensure_ascii=False,
                ).replace('"', '\\"')
                + '"])</script>'
            )
        ),
        expected={
            "source_name": "encheres_immobilieres",
            "department": "64",
            "city": "PAU",
            "postal_code": "64000",
            "address": "1 rue Test, 64000, PAU",
            "property_type": "apartment",
            "surface_m2": Decimal("51.66"),
            "rooms_count": 2,
            "parking_count": 1,
            "starting_price_eur": Decimal("60000"),
            "adjudication_price_eur": Decimal("72000"),
            "status": "adjudicated",
            "lawyer_name": "Cabinet Test",
            "lawyer_contact": "0559000000",
            "latitude": Decimal("43.3"),
            "longitude": Decimal("-0.37"),
            "occupancy_status": "occupied",
            "sale_date_date": "2026-07-09",
            "visit_dates_count": 1,
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
    ParserCalibrationCase(
        name="notaires_detail",
        parse=_notaires_detail_case,
        expected={
            "source_name": "notaires",
            "department": "64",
            "city": "Pau",
            "postal_code": "64000",
            "address": "3 rue Test, 64000 Pau",
            "property_type": "house",
            "surface_m2": Decimal("101"),
            "habitable_surface_m2": Decimal("101"),
            "land_surface_m2": Decimal("489"),
            "rooms_count": 4,
            "bedrooms_count": 3,
            "starting_price_eur": Decimal("180000"),
            "lawyer_name": "Me Test",
            "lawyer_contact": "0559000000",
            "occupancy_status": "vacant",
            "sale_date_date": "2026-09-17",
            "visit_dates_count": 1,
            "has_garage": True,
            "has_garden": True,
            "source_images_count": 1,
            "has_source_blocks": True,
        },
    ),
)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_source_parser_matrix_extracts_expected_normalized_fields(case: ParserCalibrationCase) -> None:
    raw = case.parse()
    sale = normalize_sale(raw)

    for key, expected in case.expected.items():
        assert _actual_value(sale, key) == expected, key


def _actual_value(sale: AuctionSale, key: str) -> Any:
    if key == "documents_count":
        return len(sale.documents)
    if key == "document_types":
        return [str(document.get("type") or "") for document in sale.documents]
    if key == "visit_dates_count":
        return len(sale.visit_dates)
    if key == "sale_date_date":
        return sale.sale_date.date().isoformat() if sale.sale_date else None
    if key == "source_images_count":
        images = sale.raw_payload.get("source_images")
        return len(images) if isinstance(images, list) else 0
    if key == "source_energy_dpe_class":
        diagnostics = sale.raw_payload.get("source_energy_diagnostics")
        return diagnostics.get("dpe_class") if isinstance(diagnostics, dict) else None
    if key == "source_energy_ges_class":
        diagnostics = sale.raw_payload.get("source_energy_diagnostics")
        return diagnostics.get("ges_class") if isinstance(diagnostics, dict) else None
    if key == "has_source_blocks":
        return bool(sale.raw_payload.get("source_blocks"))
    value = getattr(sale, key)
    if isinstance(value, datetime):
        return value
    return value
