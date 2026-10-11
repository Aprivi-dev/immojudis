"""Lecture structurée des fiches « Cessions immobilières de l'État ».

Les fixtures HTML sont fictives (noms, téléphones et adresses inventés) mais
reproduisent la structure des fiches publiées en octobre 2026 ; le texte de
référence vient des 237 fiches stockées en production (relu en lecture seule).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from src.normalize import normalize_sale
from src.sources.cessions_etat import parse_cessions_etat_detail_html
from src.sources.cessions_etat_extraction import (
    apply_cessions_fields,
    extract_cessions_fields,
    observed_at_for,
    refresh_cessions_raw_sale,
)
from src.sources.cessions_etat_labels import attachment_kind, parse_bool, parse_count, parse_surface
from src.sources.cessions_etat_page import direction_email, parse_cessions_page, parse_map_popup
from src.sources.cessions_etat_procedure import analyse_procedure, find_dates, select_schedule

FIXTURES = Path(__file__).parent / "fixtures"
TERRAIN_URL = "https://cessions.immobilier-etat.gouv.fr/biens/parcelles-de-terre-exempleville-17990"
MAISON_URL = "https://cessions.immobilier-etat.gouv.fr/biens/maison-forestiere-sampleville"
OBSERVED = datetime(2026, 10, 10, 22, 3, tzinfo=UTC)


def _terrain() -> dict:
    return parse_cessions_etat_detail_html((FIXTURES / "cessions_etat_fiche_terrain.html").read_text(), TERRAIN_URL)


def _maison() -> dict:
    return parse_cessions_etat_detail_html((FIXTURES / "cessions_etat_fiche_maison.html").read_text(), MAISON_URL)


def _page_text(*lines: str) -> str:
    return "\n".join(lines)


EXPIRED_PAGE = _page_text(
    "Terrain à Testville | cessions.immobilier-etat.gouv.fr",
    "Ajouter aux favoris",
    "Expiré",
    "Testville",
    "Terrain à Testville",
    "Référence :",
    "250000001",
    "Gestionnaire de l’annonce",
    "SERVICE LOCAL DU DOMAINE",
    "Contacter",
    "Fermer",
    "Contacter",
    "SERVICE LOCAL DU DOMAINE",
    "01 00 00 00 00",
    "sld.exemple@dgfip.finances.gouv.fr",
    "Testville - 33",
    "Fonciers",
    "1 200 m²",
    "Publié le :",
    "02/02/2025",
    "|",
    "Modifié le :",
    "10/03/2025",
    "Galerie",
    "Photos (1)",
    "Plans (0)",
    "Vidéos (0)",
    "Mise en scène (0)",
    "Visite Virtuelle (0)",
    "LE BIEN",
    "Descriptif du bien",
    "Parcelle de 1 200 m².",
    "Procédure de vente",
    "par Appel d'offres",
    "Commentaire : Date limite de dépôt des plis le 23/06/2025 à 12h.",
    "Caractéristiques détaillées du bien",
    "Référence cadastrale",
    "ZD212",
    "Terrains agricoles",
    "Surface en m²",
    "1200",
    "Carte de l’environnement du bien",
)


def test_land_page_reads_nature_characteristics_and_pending_procedure() -> None:
    detail = _terrain()

    assert detail["property_type"] == "land"
    assert detail["surface_m2"] == "16246"
    assert detail["land_surface_m2"] == "16246"
    assert detail["status"] == "upcoming"
    assert "sale_date" not in detail, "a footer date or a countdown is never a sale date"
    listing = detail["state_listing"]
    assert listing["reason"] == "procedure_pending"
    expected_end = (datetime.now(ZoneInfo("Europe/Paris")) + timedelta(days=30)).date().isoformat()
    assert listing["listing_end_estimate"] == expected_end

    features = detail["source_property_features"]
    characteristics = features["characteristics"]
    assert characteristics["buildability"] == {"present": False, "text": "non constructible"}
    assert characteristics["vegetation"] is True
    assert characteristics["buildings_to_demolish"] is False
    assert characteristics["easements"] == "servitude de passage au profit de la parcelle voisine"
    assert characteristics["zone_classification"] == "Espace Naturel Sensible"
    assert characteristics["soil_type"] == "argileux"
    assert characteristics["access_conditions"] == "accès direct sur voirie"
    assert characteristics["plu_information"] == "zone N"
    assert characteristics["cidol_eligible"] is False
    assert characteristics["first_listed_year"] == 2026
    assert features["nature"] == [{"label": "Terrains nus", "code": "terrain_nu", "property_type": "land"}]
    assert features["procedure"]["pending"] is True
    assert features["media"]["photos_count"] == 3
    assert features["media"]["plans_count"] == 1
    assert [item["kind"] for item in features["media"]["attachments"]] == [
        "cahier_des_charges",
        "diagnostic",
        "certificat_urbanisme",
        "plan_cadastral",
    ]
    assert features["dates"] == {"published_on": "2026-09-04", "modified_on": "2026-09-17"}
    assert detail["occupancy_status"] == "libre"


def test_land_page_location_contact_and_display_block() -> None:
    detail = _terrain()

    assert detail["address"] == "Les Pres du Moulin, Exempleville"
    assert detail["source_blocks"]["code_insee_carte"] == "17990"
    location = detail["cadastre_location"]
    assert location["insee_code"] == "17990"
    assert location["candidates"][0]["parcels"] == ["AM 346", "AM 349", "AM 352", "AM 359"]
    assert len(location["candidates"]) == 1, "the two tiles naming the same parcels make one candidate"
    assert location["designation"] == "Parcelles AM 346, 349, 352, 359 à Exempleville"
    # The functional mailbox of the managing service beats a personal address.
    assert detail["source_blocks"]["gestionnaire_email"] == "drfip99.pole-gestion-domaniale@dgfip.finances.gouv.fr"

    display = detail["source_blocks"]["caracteristiques_bien"]
    assert display["nature"][0]["display"] == "Terrain nu"
    assert display["procedure"]["pending"] is True
    assert display["manager"] == {
        "service": "PRIE99 - SERVICE DE GESTION DOMANIALE",
        "email": "drfip99.pole-gestion-domaniale@dgfip.finances.gouv.fr",
    }
    assert {item["label"] for item in display["items"]} >= {"Constructibilité", "Type de sol", "Code INSEE"}
    assert "Camille" not in json.dumps(display, ensure_ascii=False), "no personal name in the displayed block"
    json.dumps(detail, ensure_ascii=False)  # the payload stays serialisable


def test_detail_enrichment_replaces_the_card_schedule_and_status() -> None:
    from src.sources import cessions_etat

    html = (FIXTURES / "cessions_etat_fiche_terrain.html").read_text()

    class Client:
        def get(self, url: str) -> str:
            assert url == TERRAIN_URL
            return html

    card = {
        "source_name": "cessions_etat",
        "source_url": TERRAIN_URL,
        "status": "unknown",
        "property_type": "Fonciers",
        "surface_m2": "16246",
        "latitude": "45.7",
        "longitude": "-0.7",
        "source_blocks": {"titre": "Parcelles De Terre à Exempleville (17990)"},
    }
    errors: list[str] = []
    cessions_etat._enrich_sale_from_detail(Client(), card, errors)

    assert errors == []
    assert card["status"] == "upcoming"
    assert card["state_listing"]["reason"] == "procedure_pending"
    assert card["source_page_observed_at"]
    assert card["address"] == "Les Pres du Moulin, Exempleville"
    assert card["cadastre_location"]["designation"].startswith("Parcelles AM 346")
    assert card["property_type"] == "land"
    assert normalize_sale(dict(card)).status == "upcoming"


def test_house_page_reads_adjudication_prices_surfaces_and_energy() -> None:
    detail = _maison()

    assert detail["property_type"] == "house"
    assert detail["sale_date"] == "2026-11-05T14:30:00+01:00"
    assert detail["sale_date_kind"] == "adjudication"
    assert "status" not in detail and "state_listing" not in detail
    assert detail["starting_price_eur"] == "189525"
    assert detail["surface_m2"] == "116.85", "the rounded tile is refined by the description's decimal"
    assert detail["land_surface_m2"] == "2882"
    assert detail["rooms_count"] == 6
    assert detail["bedrooms_count"] == 4
    assert detail["dpe_class"] == "G"
    assert detail["ges_class"] == "F"
    assert any("15/10/2026" in visit for visit in detail["visit_dates"])
    assert detail["address"] == "12 Route de la Foret, Sampleville"

    procedure = detail["source_property_features"]["procedure"]
    assert procedure["method"] == "Adjudication"
    assert procedure["method_code"] == "adjudication"
    assert procedure["prices"]["deposit_eur"] == "18950"
    assert procedure["prices"]["property_tax_eur"] == "1236"
    surfaces = detail["source_property_features"]["surface"]
    assert surfaces["outbuildings_surface_m2"] == "48"
    assert detail["source_property_features"]["characteristics"]["year_built"] == 1950

    sale = normalize_sale(dict(detail))
    assert sale.property_type == "house"
    assert sale.land_surface_m2 is not None and int(sale.land_surface_m2) == 2882
    assert sale.sale_date == datetime(2026, 11, 5, 13, 30, tzinfo=UTC)


def test_expired_page_is_past_and_keeps_its_dates_out_of_sale_date() -> None:
    extracted = extract_cessions_fields(EXPIRED_PAGE, observed_at=OBSERVED)
    assert extracted is not None
    fields = extracted["fields"]

    assert fields["status"] == "past"
    assert fields["sale_date"] is None
    assert fields["state_listing"] is None
    assert extracted["source_property_features"]["procedure"]["deadlines"][0]["at"].startswith("2025-06-23")


def test_countdown_is_listing_end_not_sale_date() -> None:
    page = EXPIRED_PAGE.replace("Expiré", "Fini dans 47 jours").replace(
        "Commentaire : Date limite de dépôt des plis le 23/06/2025 à 12h.", ""
    )
    fields = extract_cessions_fields(page, observed_at=OBSERVED)["fields"]

    assert fields["sale_date"] is None
    assert fields["status"] == "upcoming"
    assert fields["state_listing"]["reason"] == "deadline_not_published"
    assert fields["state_listing"]["listing_end_estimate"] == "2026-11-27"


def test_online_auction_window_becomes_a_sale_schedule() -> None:
    page = EXPIRED_PAGE.replace("Expiré", "Fini dans 47 jours").replace(
        "par Appel d'offres\nCommentaire : Date limite de dépôt des plis le 23/06/2025 à 12h.",
        "par Vente par enchères en ligne\nCommentaire : Vente aux enchères sur le site internet Agorastore, "
        "du 8 décembre 2026 à 14h au 10 décembre 2026 à 16h.",
    )
    fields = extract_cessions_fields(page, observed_at=OBSERVED)["fields"]

    assert fields["sale_date"] == "2026-12-10T16:00:00+01:00"
    assert fields["sale_date_kind"] == "sale_window_close"
    assert fields["source_sale_schedule"] == {
        "opens_at": "2026-12-08T14:00:00+01:00",
        "closes_at": "2026-12-10T16:00:00+01:00",
        "schedule_type": "sale_window",
    }


def test_pending_procedure_ignores_stale_dates_of_the_description() -> None:
    result = analyse_procedure(
        ["Procédure à venir. Ajoutez le bien à vos favoris pour être informé lorsqu’elle sera connue"],
        "Réception des offres sur le site d'Agorastore du 22/09/2026 à 14h00 au 24/09/2026 à 16h00.",
    )
    assert result["pending"] is True
    assert result["windows"][0]["scope"] == "description"
    assert select_schedule(result) is None


def test_yearless_dates_take_the_year_of_the_modification_date() -> None:
    from datetime import date

    found = find_dates("Date limite de dépôt des plis : le mardi 23 juin à 12h.", date(2026, 5, 2))
    assert found[0].moment == datetime(2026, 6, 23, 12, 0)
    assert found[0].year_inferred is True


def test_replay_overrides_stale_columns_from_stored_page_text() -> None:
    raw = {
        "source_name": "cessions_etat",
        "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/terrain-testville",
        "status": "unknown",
        "property_type": "house",
        "surface_m2": "999",
        "source_blocks": {"page_text": EXPIRED_PAGE.replace("Expiré", "Fini dans 10 jours")},
        "source_checks": {
            "https://cessions.immobilier-etat.gouv.fr/biens/terrain-testville": {
                "checked_at": OBSERVED.isoformat(),
                "detail_status": "complete",
            }
        },
        "cadastre_location": {"signature": "stale", "resolution": {"status": "resolved"}},
    }
    assert observed_at_for(raw) == OBSERVED
    assert refresh_cessions_raw_sale(raw) is True

    assert raw["property_type"] == "land"
    assert raw["surface_m2"] == "1200"
    # The stored deadline of 2025 belongs to the procedure block: it is the sale date.
    assert raw["sale_date"].startswith("2025-06-23")
    assert "status" not in raw
    assert "resolution" not in raw["cadastre_location"], "a resolution for other references is not reused"
    sale = normalize_sale(raw)
    assert sale.status == "past"


def test_replay_keeps_a_resolution_for_the_same_references() -> None:
    first = extract_cessions_fields(EXPIRED_PAGE, observed_at=OBSERVED)
    resolution = {"status": "resolved", "version": "cadastre_reference_v1", "latitude": 44.1, "longitude": -0.5}
    raw = {"cadastre_location": {**first["cadastre_location"], "resolution": resolution}}
    apply_cessions_fields(raw, extract_cessions_fields(EXPIRED_PAGE, observed_at=OBSERVED))
    assert raw["cadastre_location"]["resolution"] == resolution


def test_house_nature_with_building_description_is_a_building() -> None:
    page = EXPIRED_PAGE.replace("Parcelle de 1 200 m².", "Ancien immeuble de bureaux en R+2 sur sous-sol.").replace(
        "Terrains agricoles", "Maisons"
    )
    assert extract_cessions_fields(page, observed_at=OBSERVED)["fields"]["property_type"] == "building"


def test_land_tile_of_a_house_is_not_its_built_surface() -> None:
    page = EXPIRED_PAGE.replace(
        "Parcelle de 1 200 m².",
        "A vendre une maison forestière de 127 m². A l'extérieur : un grand terrain de 3000 m².",
    ).replace("Terrains agricoles\nSurface en m²\n1200", "Maisons forestières\nSurface en m²\n3003")
    fields = extract_cessions_fields(page, observed_at=OBSERVED)["fields"]
    assert fields["surface_m2"] == "127"


def test_multiple_built_natures_sum_their_surfaces() -> None:
    page = EXPIRED_PAGE.replace(
        "Terrains agricoles\nSurface en m²\n1200",
        "Locaux industriels\nSurface en m²\n1962\nEntrepôts\nSurface en m²\n1638",
    )
    fields = extract_cessions_fields(page, observed_at=OBSERVED)["fields"]
    assert fields["property_type"] == "commercial"
    assert fields["surface_m2"] == "3600"


def test_unknown_labels_and_old_label_variants() -> None:
    page = parse_cessions_page(
        EXPIRED_PAGE.replace(
            "Surface en m²\n1200",
            "Nb de chambres\n2\nPrésence d'un parking / box\noui\nUn libellé nouveau\nsa valeur\nSurface en m²\n1200",
        )
    )
    keys = {item.label: item.key for item in page.characteristics}
    assert keys["Chambres"] == "bedrooms_count"
    assert keys["Parking ou box"] == "parking_box"
    assert keys["Un libellé nouveau"] is None
    assert page.value("surface_m2") == "1200"


def test_label_value_helpers() -> None:
    assert str(parse_surface("1 ha 62 a 46 ca")) == "16246"
    assert str(parse_surface("48 m2 environ")) == "48"
    assert str(parse_surface("27 044")) == "27044"
    assert parse_surface("78 et 124 m²") is None
    assert parse_bool("non constructible") is False
    assert parse_bool("Oui") is True
    assert parse_bool("voir certificat d urbanisme") is None
    assert parse_count("12") == 12 and parse_count("R+1 partiel") is None
    assert attachment_kind("5_Certificat_durbanisme_260720000.pdf")[0] == "certificat_urbanisme"
    assert attachment_kind("9_Offre_de_prix_personne_morale_1.pdf")[0] == "formulaire_offre"
    assert attachment_kind("4_Extrait_du_plan_cadastral_260720000.pdf")[0] == "plan_cadastral"


def test_recompute_replays_the_stored_page_text_without_network() -> None:
    from src.recompute_scoring import _recomputed_sale_from_storage_row

    url = "https://cessions.immobilier-etat.gouv.fr/biens/terrain-testville"
    page = EXPIRED_PAGE.replace("Expiré", "Fini dans 10 jours").replace(
        "Commentaire : Date limite de dépôt des plis le 23/06/2025 à 12h.", ""
    )
    row = {
        "id": "00000000-0000-4000-8000-000000000001",
        "source_name": "cessions_etat",
        "source_url": url,
        "status": "unknown",
        "property_type": "house",
        "sale_date": None,
        "raw_payload": {
            "source_name": "cessions_etat",
            "source_url": url,
            "source_blocks": {"page_text": page},
            "source_checks": {url: {"checked_at": OBSERVED.isoformat(), "detail_status": "complete"}},
        },
    }
    sale = _recomputed_sale_from_storage_row(row)

    assert sale.property_type == "land"
    assert sale.status == "upcoming"
    assert sale.sale_date is None
    assert sale.raw_payload["state_listing"]["listing_end_estimate"] == "2026-10-21"
    assert sale.raw_payload["source_blocks"]["caracteristiques_bien"]["nature"][0]["code"] == "terrain_agricole"


def test_map_popup_and_direction_email() -> None:
    assert parse_map_popup("66 R LAFAURIE DE MONBADON, Bordeaux, 33063") == {
        "address": "66 Rue Lafaurie de Monbadon, Bordeaux",
        "insee_code": "33063",
        "city": "Bordeaux",
    }
    assert parse_map_popup("(rue non renseignée), LES PRES CHABRIERS, Saint-junien, 87154")["address"] == (
        "Les Pres Chabriers, Saint-Junien"
    )
    assert parse_map_popup("Pessines, 17275") == {"insee_code": "17275", "city": "Pessines"}
    assert direction_email(
        [{"name": "A", "email": "a.b@dgfip.finances.gouv.fr"}, {"name": "S", "email": "ddfip99.pgp@dgfip.finances.gouv.fr"}]
    ) == "ddfip99.pgp@dgfip.finances.gouv.fr"
