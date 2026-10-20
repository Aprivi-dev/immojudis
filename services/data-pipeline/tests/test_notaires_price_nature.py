"""Notaires : « première offre possible » (vente interactive) n'est pas une mise à prix.

Le montant reste dans ``starting_price_eur`` ; ``starting_price_nature`` dit ce qu'il est, pour que l'interface
n'écrive pas « Mise à prix » devant une première offre possible (voir ``src.sources.notaires_price_nature``).
"""

import json

from src.normalize import normalize_sale
from src.sources import notaires
from src.sources.notaires_price_nature import FIRST_OFFER_NATURE, starting_price_nature
from tests.test_notaires_extraction import VAE_URL, vae_payload, vni_payload

VNI_URL = "https://www.immobilier.notaires.fr/fr/annonce-immobiliere-vente/exempleville/appartement/9000002"


def test_a_vni_detail_publishes_a_first_offer_not_a_starting_price() -> None:
    detail = notaires.parse_notaires_detail_json(vni_payload(), fallback={"source_url": VNI_URL, "source_blocks": {}})

    assert detail["starting_price_eur"] == 200000
    assert detail["starting_price_nature"] == FIRST_OFFER_NATURE


def test_a_vae_detail_keeps_its_starting_price() -> None:
    detail = notaires.parse_notaires_detail_json(vae_payload(), fallback={"source_url": VAE_URL, "source_blocks": {}})

    assert detail["starting_price_nature"] == "mise_a_prix"


def test_the_nature_follows_the_amount_into_the_stored_payload() -> None:
    detail = notaires.parse_notaires_detail_json(vni_payload(), fallback={"source_url": VNI_URL, "source_blocks": {}})
    sale = normalize_sale({"source_name": "notaires", "source_url": VNI_URL, **detail})

    assert sale.raw_payload["starting_price_nature"] == FIRST_OFFER_NATURE
    assert sale.starting_price_eur is not None


def test_a_list_card_with_only_a_first_offer_is_flagged() -> None:
    row = {
        "typeTransaction": "VNI",
        "annonceId": 1,
        "urlDetailAnnonceFr": VNI_URL,
        "communeNom": "Exempleville",
        "inseeDepartement": "33",
        "premiereOffrePossible": 150000,
    }
    card = notaires.parse_notaires_json(json.dumps({"annonceResumeDto": [row]}))[0]

    assert card["starting_price_eur"] == 150000
    assert card["starting_price_nature"] == FIRST_OFFER_NATURE


def test_the_helper_prefers_the_announced_price_and_says_nothing_without_a_price() -> None:
    assert starting_price_nature(100000, 90000) == {"starting_price_nature": "mise_a_prix"}
    assert starting_price_nature(None, None, 80000) == {"starting_price_nature": FIRST_OFFER_NATURE}
    assert starting_price_nature(0, None, None) == {}
    assert starting_price_nature(100000, None, primary_nature="displayed_price") == {
        "starting_price_nature": "displayed_price"
    }
