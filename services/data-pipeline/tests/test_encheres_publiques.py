from decimal import Decimal

from src.normalize import normalize_sale
from src.sources.encheres_publiques import parse_encheres_publiques_detail_html, parse_encheres_publiques_html


def test_parse_encheres_publiques_html_reads_next_apollo_state() -> None:
    html = """
    <html>
      <body>
        <a href="/encheres/immobilier/appartements/carcans-33/appartement-carcans_128128">Voir</a>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:201447": {"__typename": "Adresse", "id": "201447", "ville": "Carcans", "ville_slug": "carcans-33"},
                  "Profil:5388": {"__typename": "Profil", "id": "5388", "nom": "Tribunal Judiciaire de BORDEAUX", "categorie": "tribunal"},
                  "Evenement:21820": {"__typename": "Evenement", "id": "21820", "titre": "Vente immobilière au Tribunal judiciaire de Bordeaux le 9 Juin 2026", "ouverture_date": 1781005200},
                  "Lot:128128": {
                    "__typename": "Lot",
                    "id": "128128",
                    "nom": "Un appartement de 23,56 m² située ZAC de Maubuisson à Carcans",
                    "type": "En salle",
                    "categorie": "immobilier",
                    "sous_categorie": "appartements",
                    "adresse_defaut": {"__ref": "Adresse:201447"},
                    "ouverture_date": 1779973200,
                    "criteres_resume": "Carcans · 23.56 m²",
                    "mise_a_prix": 20000,
                    "prix_adjuge": 40000,
                    "organisateur": {"__ref": "Profil:5388"},
                    "evenement": {"__ref": "Evenement:21820"},
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sales = parse_encheres_publiques_html(
        html,
        "https://www.encheres-publiques.com/ventes/immobilier/v/bordeaux-33",
    )
    sale = normalize_sale(raw_sales[0])

    assert len(raw_sales) == 1
    assert sale.source_name == "encheres_publiques"
    assert sale.source_url == (
        "https://www.encheres-publiques.com/"
        "encheres/immobilier/appartements/carcans-33/appartement-carcans_128128"
    )
    assert sale.external_id == "128128"
    assert sale.department == "33"
    assert sale.city == "Carcans"
    assert sale.postal_code is None
    assert sale.property_type == "apartment"
    assert sale.surface_m2 == Decimal("23.56")
    assert sale.starting_price_eur == 20000
    assert sale.tribunal == "Tribunal Judiciaire de BORDEAUX"


def test_parse_encheres_publiques_detail_html_extracts_rich_lot_context() -> None:
    html = """
    <html>
      <body>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "apolloState": {
                "data": {
                  "Adresse:201952": {
                    "__typename": "Adresse",
                    "id": "201952",
                    "text": "7 Rue du Palais Gallien, 33000 Bordeaux, France",
                    "ville": "Bordeaux",
                    "ville_slug": "bordeaux-33",
                    "coords": [-0.5812147, 44.8416492]
                  },
                  "Profil:5692": {
                    "__typename": "Profil",
                    "id": "5692",
                    "nom": "OFFICE NOTARIAL DU JEU DE PAUME",
                    "categorie": "notaire",
                    "telephone": "05 56 42 41 85"
                  },
                  "Evenement:22001": {
                    "__typename": "Evenement",
                    "id": "22001",
                    "titre": "Vente notariale interactive à Bordeaux",
                    "ouverture_date": 1781005200
                  },
                  "LotVisite:51437": {
                    "__typename": "LotVisite",
                    "id": "51437",
                    "ouverture_date": 1779786000,
                    "fermeture_date": 1779791400,
                    "observations": "sur rendez-vous"
                  },
                  "PhotoLot:1": {
                    "__typename": "PhotoLot",
                    "id": "1",
                    "url": "/static/lot/photo/bordeaux.jpg"
                  },
                  "Lot:129346": {
                    "__typename": "Lot",
                    "id": "129346",
                    "nom": "Appartement T4 en duplex à rénover 103,19 m² carrez avec terrasse privative",
                    "type": "En ligne",
                    "type_de_vente": "Vente volontaire",
                    "categorie": "immobilier",
                    "sous_categorie": "appartements",
                    "adresse_physique": {"__ref": "Adresse:201952"},
                    "organisateur": {"__ref": "Profil:5692"},
                    "evenement": {"__ref": "Evenement:22001"},
                    "visites": [{"__ref": "LotVisite:51437"}],
                    "photos": [{"__ref": "PhotoLot:1"}],
                    "criteres_resume": "Bordeaux · 103.16 m² · 4 pièces · 3296 €/m²",
                    "critere_surface_habitable": 103.16,
                    "critere_nombre_de_pieces": 4,
                    "critere_nombre_de_chambres": 3,
                    "critere_diagnostic_date": "2026-04-27",
                    "critere_consommation_energetique": "C",
                    "critere_emissions_de_gaz": "C",
                    "critere_occupation_du_bien": "Libre de toute occupation",
                    "description": "Appartement de type T4 en duplex à rénover comprenant séjour, cuisine, trois chambres, terrasse privative et place de parking. PREVOIR TRAVAUX DE RENOVATION",
                    "infos_conditions_de_vente": "Vente notariale interactive (VNI)",
                    "infos_frais_de_vente": "Barème des frais de négociation à la charge de l'acquéreur.",
                    "infos_modalite_de_paiement": "Comptant le jour de l'acte authentique.",
                    "infos_renseignements_de_vente": "Texte générique : vérifier les autorisations d’urbanisme avant travaux.",
                    "mise_a_prix": 340000,
                    "termine": false
                  }
                }
              }
            }
          }
        }
        </script>
      </body>
    </html>
    """

    raw_sale = parse_encheres_publiques_detail_html(
        html,
        "https://www.encheres-publiques.com/encheres/immobilier/appartements/bordeaux-33/appartement-duplex-renover-carrez-avec-terrasse-privative_129346",
    )
    sale = normalize_sale(raw_sale)

    assert sale.description is not None
    assert "PREVOIR TRAVAUX DE RENOVATION" in sale.description
    assert sale.address == "7 Rue du Palais Gallien, 33000 Bordeaux, France"
    assert sale.postal_code == "33000"
    assert sale.city == "Bordeaux"
    assert sale.department == "33"
    assert sale.latitude == Decimal("44.8416492")
    assert sale.longitude == Decimal("-0.5812147")
    assert sale.surface_m2 == Decimal("103.16")
    assert sale.carrez_surface_m2 == Decimal("103.16")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.parking_count == 1
    assert sale.has_terrace is True
    assert sale.lawyer_name == "OFFICE NOTARIAL DU JEU DE PAUME"
    assert sale.lawyer_contact == "05 56 42 41 85"
    assert sale.occupancy_status == "vacant"
    assert sale.visit_dates
    assert "Vente notariale interactive" in (sale.raw_text or "")
    assert "Comptant le jour de l'acte authentique" in (sale.raw_text or "")
    assert "Libre de toute occupation" in (sale.raw_text or "")
    assert "autorisation" not in (sale.raw_text or "")
    assert raw_sale["source_blocks"]["renseignements_de_vente"].startswith("Texte générique")
    assert raw_sale["source_images"] == ["https://www.encheres-publiques.com/static/lot/photo/bordeaux.jpg"]
