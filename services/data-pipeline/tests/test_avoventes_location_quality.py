"""Adresse, commune, code postal, visites et statut Avoventes (audit du 03/11/2026, extraits réels)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from src.lifecycle import mark_past_sales
from src.normalize import normalize_sale
from src.sources.avoventes import parse_avoventes_detail_html, parse_avoventes_html


def _card(slug: str, *lines: str) -> str:
    body = "".join(f"<p>{line}</p>" for line in lines)
    return f'<article data-link="/enchere/{slug}">{body}</article>'


@pytest.mark.parametrize(
    ("slug", "lines", "address", "postal", "city"),
    [
        (  # cedd7976
            "vente-sur-licitation-maison-dhabitation-a-languidic-56440",
            ("Vente aux enchères Maison", "VENTE SUR LICITATION - Maison d'habitation à LANGUIDIC (56440)",
             "176 Kermat Saint-Germain, 56440 Languidic, France", "Mise à prix : 281 000,00 €",
             "Date de la vente : lundi 23 novembre 2026 à 14h00"),
            "176 Kermat Saint-Germain, 56440 Languidic, France", "56440", "Languidic",
        ),
        (  # cf175380 : le titre servait d'adresse
            "vente-sur-saisie-immobiliere-maison-dhabitation-a-hennebont-56700",
            ("Vente aux enchères Maison", "VENTE SUR SAISIE IMMOBILIERE - Maison d'habitation à HENNEBONT (56700)",
             "13 Rue Christian le Corre, 56700 Hennebont, France", "Mise à prix : 58 000,00 €"),
            "13 Rue Christian le Corre, 56700 Hennebont, France", "56700", "Hennebont",
        ),
        (  # 2370be52
            "un-immeuble-a-usage-mixte-local-commercial-partie-habitation-loue-erdeven-56410",
            ("Vente aux enchères Local commercial",
             "Un immeuble à usage mixte (local commercial + partie habitation) loué - ERDEVEN (56410)",
             "11 Rue nationale, 56410 Erdeven, France", "Mise à prix : 235 000,00 €"),
            "11 Rue nationale, 56410 Erdeven, France", "56410", "Erdeven",
        ),
    ],
)
def test_card_reads_the_header_address_not_the_title(slug, lines, address, postal, city) -> None:
    [sale] = parse_avoventes_html(_card(slug, *lines))

    assert sale["address"] == address
    assert sale["postal_code"] == postal
    assert sale["city"] == city


def test_card_with_only_a_titled_postal_code_has_no_address() -> None:
    [sale] = parse_avoventes_html(_card(
        "maison-hennebont", "Vente aux enchères Maison",
        "VENTE SUR SAISIE IMMOBILIERE - Maison d'habitation à HENNEBONT (56700)", "Mise à prix : 58 000,00 €",
    ))

    assert sale["address"] is None
    assert sale["postal_code"] == "56700"


def _detail(description: str, *, summary: str = "<p><strong>Vente</strong><br>23 novembre 2026 à 14h00</p>") -> dict:
    html = (
        "<h1>VENTE SUR LICITATION - Maison d'habitation à LANGUIDIC (56440)</h1>"
        f"{summary}<h2>À propos du bien</h2><div>{description}</div>"
    )
    return parse_avoventes_detail_html(html, "https://avoventes.fr/enchere/synthetic")


def test_detail_ignores_the_court_address_of_the_hearing() -> None:
    # cedd7976 et 6efbc4bd : « 39 rue de la Villeneuve – Bâtiment Lizard – 56100 LORIENT LE LUNDI … »
    details = _detail(
        "VENTE SUR LICITATION Aux enchères publiques, au plus offrant et au dernier enchérisseur, "
        "Au TRIBUNAL JUDICIAIRE de LORIENT, Centre d’Affaires La Découverture 39 rue de la Villeneuve – "
        "Bâtiment Lizard – 56100 LORIENT LE LUNDI 23 NOVEMBRE 2026 à 14 H 00 Commune de LANGUIDIC (56440) "
        "176 Kermat, Saint-Germain Un terrain sur lequel est édifié une maison d’habitation de 145,35 m ²"
    )

    assert details["address"] is None
    assert details["city"] == "LANGUIDIC"
    assert details["postal_code"] == "56440"


def test_detail_keeps_the_property_street_next_to_the_judge_address() -> None:
    # cf175380 : la rue du bien et l'adresse du palais de justice ne sont plus « ambiguës ».
    details = _detail(
        "COMMUNE D’HENNEBONT (56700)\n13 rue Christian Le Corre\nUne maison d’habitation située dans un "
        "lotissement. Devant Madame le Juge de l’Exécution du Tribunal Judiciaire de LORIENT, tenant son "
        "audience au Palais de Justice de ladite ville, Centre d’Affaires La Découverte – 39 rue de la "
        "Villeneuve – Bâtiment Lizard – 56100 LORIENT."
    )

    assert details["address"] == "13 rue Christian Le Corre"
    assert details["city"] == "HENNEBONT"


def test_detail_city_drops_the_judicial_lead_in() -> None:
    # 92f2446f / 28063d89 : « VENTE AUX ENCHERES PUBLIQUES SUR LIQUIDATION JUDICIAIRE\nCOMMUNE DE FORT DE FRANCE »
    details = _detail(
        "VENTE AUX ENCHERES PUBLIQUES SUR LIQUIDATION JUDICIAIRE\nCOMMUNE DE FORT DE FRANCE (97200) – "
        "POINTE DES GRIVES\nDans un ensemble immobilier en copropriété dénommé « DOMAINE BLEU HORIZON »"
    )

    assert details["city"] == "FORT DE FRANCE"
    assert details["postal_code"] == "97200"


@pytest.mark.parametrize("summary", [
    "<p><strong>VISITES :</strong></p><p>% Estimez vos frais d'acquisition</p>",
    "<p><strong>VISITES :</strong> :</p>",
])
def test_empty_visit_field_is_not_stored(summary: str) -> None:
    # 3a3a2ed0, 434cb2e1, e2374454, 08dabcac : « VISITES : » vide stocké [":"].
    details = _detail("Un immeuble de 19 appartements.", summary=summary)

    assert details["visit_dates"] == []


def test_card_with_an_empty_visit_label_has_no_visit() -> None:
    # f341a201 (fusion Avoventes/Licitor) : « Date des visites : » sans valeur.
    [sale] = parse_avoventes_html(_card(
        "parcelles-de-terre-agricoles-a-saint-chaptes-gard", "Vente aux enchères Terrain",
        "Lieudit Pied Marcet, 30190 Saint-Chaptes, France", "Mise à prix : 10 000,00 €",
        "Date de la vente : jeudi 10 décembre 2026 à 09h30", "Date des visites :", ":",
    ))

    assert sale["visit_dates"] == []


def test_normalized_visit_dates_never_keep_punctuation_only() -> None:
    sale = normalize_sale({
        "source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/immeuble-de-19-appartements-a-brest",
        "title": "Immeuble", "visit_dates": [":"],
    })

    assert sale.visit_dates == []


def test_sale_not_requested_is_withdrawn() -> None:
    # bba0f097 : « Vente\nVente non requise » ; aucune date ailleurs dans la fiche.
    details = _detail(
        "À CHAVENAY (78450) - 21 rue Haute Sur un terrain cadastré section AA n°387",
        summary="<p><strong>Vente</strong><br>Vente non requise</p>",
    )

    assert details["status"] == "withdrawn"
    assert details["sale_date"] is None


def test_postal_code_is_not_read_from_an_attachment_name() -> None:
    # 97dc9d7c : « Document dossier-PVD 19683 DPE_1_1_1_0.pdf » donnait le code postal 19683.
    sale = normalize_sale({
        "source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/appartement-cave-a-dijon-3",
        "title": "Appartement", "address": "4 Rue Charles Dumont", "city": "DIJON",
        "raw_text": "Vente aux enchères Appartement Appartement + cave à DIJON 4/6 Rue Charles Dumont à DIJON "
        "Mise à prix : 40 000,00 € COMMUNE DE DIJON (Côte d'Or) : 4 Rue Charles Dumont Documents* "
        "AVIS SIMPLE VENTE AUX ENCHERES.pdf CCV.pdf Document dossier-PVD 19683 DPE_1_1_1_0.pdf",
    })

    assert sale.postal_code is None
    assert sale.city == "DIJON"


def test_past_sale_with_card_date_and_price_is_marked_past() -> None:
    # 319c133c : la carte donne « mardi 01 septembre 2026 à 13h30 » et « 120 000,00 € ».
    sale = normalize_sale({
        "source_name": "avoventes", "source_url": "https://avoventes.fr/enchere/pavillon-a-hautefontaine",
        "title": "Maison", "address": "35 Rue de la Carrière Suzon, 60350 Hautefontaine, France",
        "sale_date": "mardi 01 septembre 2026 à 13h30", "starting_price_eur": "120 000,00 €",
    })

    assert sale.starting_price_eur == Decimal("120000.00")
    assert sale.sale_date == datetime(2026, 9, 1, 11, 30, tzinfo=UTC)
    assert sale.status == "past"
    mark_past_sales([sale], now=datetime(2026, 11, 3, tzinfo=UTC))
    assert sale.status == "past"
