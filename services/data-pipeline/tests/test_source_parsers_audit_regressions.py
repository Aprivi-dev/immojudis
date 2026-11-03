"""Régressions de l'audit des ventes visibles du 03/11/2026 (extraits réels des pages et des fiches)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src import municipality_location
from src.commune_insee import POSTAL_CODE_INFERENCE_FIELD, record_sale_commune
from src.lifecycle import mark_past_sales
from src.normalize import normalize_sale
from src.recompute_scoring import _sale_from_storage_row
from src.sources import info_encheres
from src.sources.encheres_publiques_extraction import fill_text_schedule, text_event_sale_date
from src.sources.notaires import parse_notaires_detail_json
from src.sources.notaires_text_terms import text_sale_date, text_starting_price
from src.tribunal_labels import clean_city_label

# --- Villes -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Bernis Bernis", "Bernis"),  # licitor
        ("Mantes-la-Jolie (78)", "Mantes-la-Jolie"),  # vench
        ("JUDICIAIRE COMMUNE DE FORT DE FRANCE", "FORT DE FRANCE"),  # avoventes 92f2446f, 28063d89
        ("COMMUNE D’HENNEBONT", "HENNEBONT"),  # avoventes cf175380
        ("Saint-Denis (97400)", "Saint-Denis"),
        ("Aix en Provence", "Aix en Provence"),
        ("Lons-le-Saunier", "Lons-le-Saunier"),
    ],
)
def test_city_label_cleaning(value: str, expected: str) -> None:
    assert clean_city_label(value) == expected


# --- Licitor : code postal déduit de la commune -------------------------------------------------------------

COMMUNES = [
    {"code_insee": "30243", "name_normalized": "saint chaptes", "department_code": "30",
     "postal_codes": ["30190"], "latitude": 43.97, "longitude": 4.27},
    {"code_insee": "31555", "name_normalized": "toulouse", "department_code": "31",
     "postal_codes": ["31000", "31100", "31200"], "latitude": 43.6, "longitude": 1.44},
]


@pytest.fixture
def communes(monkeypatch):
    monkeypatch.setattr(municipality_location, "load_communes", lambda: COMMUNES)
    municipality_location.reset_cache()
    yield
    municipality_location.reset_cache()


def _licitor(city: str, department: str):
    return normalize_sale({
        "source_name": "licitor",
        "source_url": "https://www.licitor.com/annonce/11/03/57/vente-aux-encheres/terrain/saint-chaptes/gard/110357.html",
        "title": "Diverses parcelles de terre agricoles",
        "address": "Lieudit Pied Marcet",
        "city": city,
        "department": department,
    })


def test_licitor_postal_code_comes_from_an_unambiguous_commune(communes) -> None:
    sale = _licitor("Saint-Chaptes", "30")
    assert sale.postal_code is None

    record_sale_commune(sale)

    assert sale.postal_code == "30190"
    assert sale.raw_payload[POSTAL_CODE_INFERENCE_FIELD]["insee"] == "30243"


def test_commune_with_several_postal_codes_gives_none(communes) -> None:
    sale = _licitor("Toulouse", "31")
    record_sale_commune(sale)

    assert sale.postal_code is None
    assert POSTAL_CODE_INFERENCE_FIELD not in sale.raw_payload


def _geocoded(sale, **overrides):
    evidence = {
        "provider": "ban_geoplateforme", "accepted": True, "type": "housenumber", "city": "Toulouse",
        "citycode": "31555", "postcode": "31200", "score": 0.93, "label": "12 Rue Bayard 31200 Toulouse",
        "latitude": 43.61, "longitude": 1.45,
    }
    evidence.update(overrides)
    sale.raw_payload["geocode"] = evidence
    return sale


def test_postal_code_of_a_multi_code_commune_comes_from_the_geocoded_address(communes) -> None:
    # Licitor Toulouse : la commune a plusieurs codes postaux, l'adresse géocodée (BAN, numéro) en donne un.
    sale = _geocoded(_licitor("Toulouse", "31"))
    record_sale_commune(sale)

    assert sale.postal_code == "31200"
    assert sale.raw_payload[POSTAL_CODE_INFERENCE_FIELD]["source"] == "geocode_address"


@pytest.mark.parametrize(
    "overrides",
    [
        {"type": "municipality"},  # centre de commune : aucun code postal d'adresse
        {"type": "locality"},  # lieu-dit
        {"postcode": "31999"},  # code absent des codes de la commune
        {"accepted": False},  # géocodage écarté
        {"postcode": None},
    ],
)
def test_geocoded_postal_code_is_used_only_when_it_is_certain(communes, overrides) -> None:
    sale = _geocoded(_licitor("Toulouse", "31"), **overrides)
    record_sale_commune(sale)

    assert sale.postal_code is None
    assert POSTAL_CODE_INFERENCE_FIELD not in sale.raw_payload


def test_unique_commune_code_still_wins_over_the_geocoded_one(communes) -> None:
    sale = _geocoded(_licitor("Saint-Chaptes", "30"), city="Saint-Chaptes", citycode="30243", postcode="30190")
    record_sale_commune(sale)

    assert sale.postal_code == "30190"
    assert sale.raw_payload[POSTAL_CODE_INFERENCE_FIELD]["source"] == "reference_communes"


# --- Info-Enchères : heure des audiences --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("67 rue Servient 69003 LYON - 6ème étage. Les audiences de vente débutent à 13 h 30 Salle n° 5",
         "26/11/2026 à 13h30"),
        ("Internet : www.adk-avocats.fr Les audiences de vente débutent à 13 H 30 Salle 5", "26/11/2026 à 13h30"),
        ("Avocats, 1 rue des Moulins à 09000 FOIX Les audiences de vente déutent à 14h", "26/11/2026 à 14h00"),
    ],
)
def test_info_encheres_hearing_time(text: str, expected: str) -> None:
    assert info_encheres._sale_date_with_audience_time("26/11/2026", text) == expected


# --- Notaires : prix et échéance lus dans la description ---------------------------------------------------

VNI_DESCRIPTION = (
    "Conditions de la vente : Le bien est présenté en Immo-interactif à la hausse : - 1ère offre possible : à partir "
    "de 887 250,00 euros (honoraires de négociation inclus) - Offres suivantes : multiples de 5 000 euros. - "
    "Réception des offres du 08/09/2026 17:00 au 09/09/2026 17:00 sur le site Immobilier.notaires."
)


def test_notaires_first_offer_price_and_offer_window() -> None:
    assert text_starting_price(VNI_DESCRIPTION) == ("887250", "first_offer_possible")
    assert text_starting_price("1ère offre possible : à partir de 120 000,00 euros (honoraires") == (
        "120000", "first_offer_possible",
    )
    assert text_sale_date(VNI_DESCRIPTION) == "2026-09-09T15:00:00+00:00"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("6 rue Mably – 33000 BORDEAUX Mercredi 28 octobre 2026 à 14H30 (Dépôt de consignation à 14H00) BORDEAUX",
         datetime(2026, 10, 28, 13, 30, tzinfo=UTC)),
        ("La réception des offres débutera le mercredi 26 août 2026 à 13h00 et se terminera le jeudi 27 août 2026 "
         "à 13h00.", datetime(2026, 8, 27, 11, 0, tzinfo=UTC)),
        # 43ba4038 : clôture écrite avant l'ouverture ; l'échéance est la borne la plus tardive.
        ("- Réception des offres du 26 /08/2026 11:00 au 27/06/2026 11:00 sur le site",
         datetime(2026, 8, 26, 9, 0, tzinfo=UTC)),
        ("Visites sur rendez-vous : le mercredi 8 Juillet 2026 à partir de 12h30.", None),
    ],
)
def test_notaires_text_sale_dates(text: str, expected: datetime | None) -> None:
    value = text_sale_date(text)
    if expected is None:
        assert value is None
        return
    from src.normalize import parse_french_datetime

    assert parse_french_datetime(value) == expected


def test_notaires_detail_without_api_price_or_date_reads_its_description() -> None:
    payload = json.dumps({
        "typeTransaction": "VNI",
        "vni": {
            "descriptions": [{"langue": "fr", "descCourte": "Maison", "descLongue": VNI_DESCRIPTION}],
            "codePostal": "50840",
            "ville": "Fermanville",
        },
        "bien": {"typeBien": "MAI"},
    })
    detail = parse_notaires_detail_json(payload)

    assert detail["starting_price_eur"] == "887250"
    assert detail["starting_price_nature"] == "first_offer_possible"
    assert detail["sale_date"] == "2026-09-09T15:00:00+00:00"
    assert detail["source_sale_schedule"]["closes_at"] == "2026-09-09T15:00:00+00:00"

    sale = normalize_sale({**detail, "source_name": "notaires",
                           "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/290ddc8b"})
    mark_past_sales([sale], now=datetime(2026, 11, 3, tzinfo=UTC))
    assert sale.starting_price_eur == Decimal("887250")
    assert sale.status == "past"


def test_notaires_relisted_sale_is_not_implausible_against_its_first_publication() -> None:
    # 4570abe8 / eb562648 : publiée en 2025 (ou 2024), remise en vente le 09/10/2026 pour le 28/10/2026.
    sale = normalize_sale({
        "source_name": "notaires",
        "source_url": "https://www.immobilier.notaires.fr/fr/annonce-immo/4570abe8",
        "title": "Maison",
        "status": "upcoming",
        "sale_date": "2026-10-28T13:30:00Z",
        "source_blocks": {"date_publication": "2025-09-25", "source_updated_at": "2026-10-09T08:39:33Z"},
        "source_property_features": {"listing": {"published_on": "2025-09-25", "updated_on": "2026-10-09"}},
    })

    assert sale.sale_date == datetime(2026, 10, 28, 13, 30, tzinfo=UTC)
    assert "sale_date_implausible" not in sale.quality_flags
    mark_past_sales([sale], now=datetime(2026, 11, 3, tzinfo=UTC))
    assert sale.status == "past"


# --- Enchères Publiques : date, prix et visites du texte ----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Mise a prix: 20 000\nVille: Paris\nVente immobilière au Tribunal judiciaire de Paris le 9 Juillet 2026",
         "9 Juillet 2026"),
        ("Vente immobilière par l'Office du Parc le 16 Septembre 2026", "16 Septembre 2026"),
        ("Mise a prix: 70 000 Ville: Peypin Vente immobilière par Carbonnier Notaires du 1er au 2 Septembre 2026",
         "2 Septembre 2026"),
        ("Mise a prix: 70 000 Ville: Peypin", None),
    ],
)
def test_encheres_publiques_event_date(text: str, expected: str | None) -> None:
    assert text_event_sale_date(text) == expected


def test_encheres_publiques_stored_text_fills_price_date_and_visits() -> None:
    raw = {
        "source_name": "encheres_publiques",
        "source_url": "https://www.encheres-publiques.com/evenements/x/lots/70849fd2",
        "title": "Un studio",
        "raw_text": (
            "Un studio de 19,74 m² situé rue Victor Hugo à Levallois-Perret Levallois-Perret · 19.74 m² · 6079 €/m² "
            "Mise a prix: 120 000 Ville: Levallois-Perret Vente immobilière au Tribunal judiciaire de Nanterre le "
            "3 Septembre 2026 Tribunal Judiciaire de NANTERRE Occupation: Loué Visites: 31/08/2026 11:30 - 12:30 "
            "Conditions de vente: Les enchères à la barre"
        ),
    }
    fill_text_schedule(raw)
    sale = normalize_sale(raw)

    assert sale.starting_price_eur == Decimal("120000")
    assert sale.sale_date is not None and sale.sale_date.date().isoformat() == "2026-09-03"
    assert sale.visit_dates == ["31/08/2026 11:30 - 12:30"]


# --- Recalcul : une colonne vide ne masque pas la valeur de la source ----------------------------------------


def test_recompute_restores_source_date_and_price_hidden_by_empty_columns() -> None:
    # 319c133c : raw_payload garde « mardi 01 septembre 2026 à 13h30 » et « 120 000,00 € », colonnes vides.
    row = {
        "id": "319c133c-0000-0000-0000-000000000000",
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/pavillon-a-hautefontaine",
        "status": "upcoming",
        "sale_date": None,
        "starting_price_eur": None,
        "visit_dates": [],
        "raw_payload": {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/pavillon-a-hautefontaine",
            "title": "Maison",
            "sale_date": "mardi 01 septembre 2026 à 13h30",
            "starting_price_eur": "120 000,00 €",
            "visit_dates": ["LE LUNDI 24 AOUT 2026 DE 10H00 A 11H00"],
        },
    }
    sale = _sale_from_storage_row(row)

    assert sale.sale_date == datetime(2026, 9, 1, 11, 30, tzinfo=UTC)
    assert sale.starting_price_eur == Decimal("120000.00")
    assert sale.visit_dates == ["LE LUNDI 24 AOUT 2026 DE 10H00 A 11H00"]
    mark_past_sales([sale], now=datetime(2026, 11, 3, tzinfo=UTC))
    assert sale.status == "past"
