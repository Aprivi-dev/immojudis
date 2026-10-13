"""Doublons entre sources : identifiant d'annonce commun d'abord, puis clé de repli stricte."""

import pytest

from src.dedupe import (
    merge_duplicate_sales,
    same_shared_listing,
    shared_listing_id,
    strict_duplicate_key_match,
)
from src.normalize import normalize_sale

NANCY = "justice_tj_1_54"
DAY = "mardi 10 novembre 2026 à 14h"


def _vench_url(listing_id: int) -> str:
    return f"https://www.vench.fr/vente-{listing_id}-une-maison-ondres.html"


def _pa_url(listing_id: int) -> str:
    return (
        "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/"
        f"une-maison-a-ondres-{listing_id}.html"
    )


def _sale(
    source_name: str,
    source_url: str,
    *,
    price: str | None = "50 000 €",
    sale_date: str | None = DAY,
    city: str | None = "Ondres",
    postal_code: str | None = "40440",
    property_type: str | None = "house",
    surface_m2: str | None = None,
    address: str | None = None,
    court: str | None = NANCY,
    **extra: object,
):
    raw: dict[str, object] = {"source_name": source_name, "source_url": source_url, **extra}
    for key, value in (
        ("starting_price_eur", price),
        ("sale_date", sale_date),
        ("city", city),
        ("postal_code", postal_code),
        ("property_type", property_type),
        ("surface_m2", surface_m2),
        ("address", address),
    ):
        if value is not None:
            raw[key] = value
    sale = normalize_sale(raw)
    sale.tribunal_code = court
    return sale


@pytest.mark.parametrize("listing_id", [166526, 166431, 166115, 163035])
def test_vench_and_petites_affiches_with_the_same_listing_id_are_merged(listing_id: int) -> None:
    vench = _sale("vench", _vench_url(listing_id), city="Ondres", court=None)
    petites_affiches = _sale(
        "petites_affiches", _pa_url(listing_id), city="Ondres (40)", postal_code=None, court="other", price=None
    )

    result = merge_duplicate_sales([vench, petites_affiches])

    assert len(result) == 1
    assert result[0].dedupe_confidence == "listing_id"
    assert {_vench_url(listing_id), _pa_url(listing_id)} <= set(result[0].source_urls)


def test_four_duplicate_pairs_collapse_to_four_sales_and_other_ids_stay_apart() -> None:
    ids = [166526, 166431, 166115, 163035]
    sales = [_sale("vench", _vench_url(i), court=None) for i in ids]
    sales += [_sale("petites_affiches", _pa_url(i), court=None) for i in ids]
    sales.append(_sale("petites_affiches", _pa_url(170001), court=None))

    result = merge_duplicate_sales(sales)

    assert len(result) == 5


def test_listing_id_is_read_from_each_url_and_only_for_these_two_sources() -> None:
    assert shared_listing_id(_sale("vench", _vench_url(166526))) == "166526"
    assert shared_listing_id(_sale("petites_affiches", _pa_url(166526))) == "166526"
    assert shared_listing_id(_sale("licitor", "https://www.licitor.com/annonce/10/90/00/x/166526.html")) is None
    assert shared_listing_id(_sale("petites_affiches", "https://www.petitesaffiches.fr/encheres-immobilieres/")) is None
    assert shared_listing_id(_sale("vench", "https://www.vench.fr/avocat/exemple")) is None


def test_listing_id_never_merges_contradicting_or_same_source_sales() -> None:
    vench = _sale("vench", _vench_url(166526))
    other_day = _sale("petites_affiches", _pa_url(166526), sale_date="mercredi 11 novembre 2026 à 14h")
    other_price = _sale("petites_affiches", _pa_url(166526), price="51 000 €")
    same_source = _sale("vench", _vench_url(166526) + "?x=1")

    assert not same_shared_listing(vench, other_day)
    assert not same_shared_listing(vench, other_price)
    assert not same_shared_listing(vench, same_source)
    assert len(merge_duplicate_sales([vench, other_day])) == 2


def test_listing_id_pair_needs_one_corroborating_fact_known_on_both_sides() -> None:
    vench = _sale("vench", _vench_url(166526))

    # Un seul fait commun suffit : le jour (prix inconnu d'un côté) ou le prix (jour inconnu).
    assert same_shared_listing(vench, _sale("petites_affiches", _pa_url(166526), price=None))
    assert same_shared_listing(vench, _sale("petites_affiches", _pa_url(166526), sale_date=None))
    assert same_shared_listing(
        vench, _sale("petites_affiches", _pa_url(166526), sale_date="mardi 10 novembre 2026 à 9h", price=None)
    )

    # Aucun fait connu des deux côtés : l'identifiant seul ne suffit pas.
    assert not same_shared_listing(vench, _sale("petites_affiches", _pa_url(166526), price=None, sale_date=None))
    assert not same_shared_listing(
        _sale("vench", _vench_url(166526), price=None), _sale("petites_affiches", _pa_url(166526), sale_date=None)
    )


def test_listing_id_collision_between_ondres_and_lyon_is_never_merged() -> None:
    ondres = _sale("vench", _vench_url(166526), city="Ondres", postal_code="40440")
    lyon = _sale("petites_affiches", _pa_url(166526), city="Lyon", postal_code="69003")

    assert not same_shared_listing(ondres, lyon)
    assert not same_shared_listing(lyon, ondres)
    result = merge_duplicate_sales([ondres, lyon])
    assert len(result) == 2
    assert all(len(sale.source_urls) <= 1 for sale in result)

    # Même jour, même prix, même identifiant : le lieu différent suffit à refuser.
    assert (ondres.sale_date, ondres.starting_price_eur) == (lyon.sale_date, lyon.starting_price_eur)


def test_listing_id_pair_needs_a_locality_known_on_both_sides() -> None:
    vench = _sale("vench", _vench_url(166526))
    no_locality = _sale("petites_affiches", _pa_url(166526), city=None, postal_code=None)
    other_locality_unknown = _sale("vench", _vench_url(166526), city=None, postal_code=None)

    assert not same_shared_listing(vench, no_locality)
    assert not same_shared_listing(other_locality_unknown, _sale("petites_affiches", _pa_url(166526)))
    assert len(merge_duplicate_sales([vench, no_locality])) == 2


def test_listing_id_pair_accepts_the_same_postal_code_or_the_same_normalized_city() -> None:
    vench = _sale("vench", _vench_url(166526), city="Ondres", postal_code="40440")

    same_postal_other_spelling = _sale("petites_affiches", _pa_url(166526), city="ONDRES-PLAGE", postal_code="40440")
    same_city_no_postal = _sale("petites_affiches", _pa_url(166526), city="ONDRES", postal_code=None)
    same_city_accents = _sale("petites_affiches", _pa_url(166526), city="Ôndrès", postal_code=None)
    other_postal_other_city = _sale("petites_affiches", _pa_url(166526), city="Tarnos", postal_code="40220")

    assert same_shared_listing(vench, same_postal_other_spelling)
    assert same_shared_listing(vench, same_city_no_postal)
    assert same_shared_listing(vench, same_city_accents)
    assert not same_shared_listing(vench, other_postal_other_city)


# --- clé de repli stricte ---------------------------------------------------------------------


def test_strict_key_merges_same_court_day_price_and_close_surface() -> None:
    licitor = _sale("licitor", "https://www.licitor.com/annonce/1.html", surface_m2="100")
    avoventes = _sale("avoventes", "https://avoventes.fr/enchere/1", surface_m2="103", property_type="apartment")

    result = merge_duplicate_sales([licitor, avoventes])

    assert len(result) == 1
    assert result[0].dedupe_confidence == "strict_key"
    assert len(result[0].source_urls) == 2


def test_strict_key_merges_same_type_and_commune_when_no_surface_is_known() -> None:
    first = _sale("licitor", "https://www.licitor.com/annonce/2.html")
    second = _sale("avoventes", "https://avoventes.fr/enchere/2", city="ONDRES")

    assert strict_duplicate_key_match(first, second)
    assert len(merge_duplicate_sales([first, second])) == 1


def test_strict_key_accepts_the_insee_code_when_no_court_is_known() -> None:
    geocode = {"provider": "ban_geoplateforme", "accepted": True, "citycode": "40209"}
    first = _sale("licitor", "https://www.licitor.com/annonce/3.html", court=None, geocode=geocode)
    second = _sale("avoventes", "https://avoventes.fr/enchere/3", court=None, geocode=geocode)

    assert strict_duplicate_key_match(first, second)


@pytest.mark.parametrize(
    ("first_kwargs", "second_kwargs"),
    [
        # Chaque ligne n'a qu'un désaccord avec une paire qui serait fusionnée.
        ({"surface_m2": "100"}, {"surface_m2": "102", "price": "50 001 €"}),
        ({"surface_m2": "100"}, {"surface_m2": "102", "sale_date": "mercredi 11 novembre 2026 à 14h"}),
        ({"surface_m2": "100"}, {"surface_m2": "102", "court": "justice_tj_1_93"}),
        ({"surface_m2": "100"}, {"surface_m2": "102", "court": None}),
        ({"surface_m2": "100"}, {"surface_m2": "102", "price": None}),
        ({"surface_m2": "100"}, {"surface_m2": "102", "sale_date": None}),
        ({"surface_m2": "100"}, {"surface_m2": "106"}),
        ({}, {"property_type": "apartment"}),
        ({}, {"property_type": None}),
        ({"property_type": "other"}, {"property_type": "other"}),
        ({}, {"city": "Bayonne", "postal_code": "64100"}),
        ({"address": "3 rue Pasteur"}, {"address": "12 rue Victor Hugo"}),
    ],
)
def test_strict_key_rejects_any_single_disagreement(first_kwargs: dict, second_kwargs: dict) -> None:
    first = _sale("licitor", "https://www.licitor.com/annonce/4.html", **first_kwargs)
    second = _sale("avoventes", "https://avoventes.fr/enchere/4", **second_kwargs)

    assert not strict_duplicate_key_match(first, second)
    assert len(merge_duplicate_sales([first, second])) == 2


def test_two_distinct_lots_of_one_source_with_same_city_day_and_price_are_never_merged() -> None:
    lot_a = _sale("licitor", "https://www.licitor.com/annonce/5.html", surface_m2="40")
    lot_b = _sale("licitor", "https://www.licitor.com/annonce/6.html", surface_m2="40")

    assert not strict_duplicate_key_match(lot_a, lot_b)
    assert len(merge_duplicate_sales([lot_a, lot_b])) == 2


def test_two_distinct_lots_in_each_of_two_sources_stay_separate() -> None:
    # Deux lots de même prix le même jour : on ne sait pas lequel est lequel, donc aucune fusion.
    licitor_a = _sale("licitor", "https://www.licitor.com/annonce/7.html", surface_m2="40")
    licitor_b = _sale("licitor", "https://www.licitor.com/annonce/8.html", surface_m2="41")
    avoventes = _sale("avoventes", "https://avoventes.fr/enchere/7", surface_m2="40")

    assert len(merge_duplicate_sales([licitor_a, licitor_b, avoventes])) == 3


def test_strict_key_never_applies_to_a_multi_lot_announcement_or_different_lot_numbers() -> None:
    multi = _sale("licitor", "https://www.licitor.com/annonce/9.html", surface_m2="40", quality_flags=["multi_lot_sale"])
    single = _sale("avoventes", "https://avoventes.fr/enchere/9", surface_m2="40")
    assert not strict_duplicate_key_match(multi, single)

    with_lots = _sale("licitor", "https://www.licitor.com/annonce/10.html", surface_m2="40", source_lots=[{}, {}])
    assert not strict_duplicate_key_match(with_lots, single)

    first = _sale("licitor", "https://www.licitor.com/annonce/11.html", surface_m2="40", lot_number="1")
    second = _sale("avoventes", "https://avoventes.fr/enchere/11", surface_m2="40", lot_number="2")
    assert not strict_duplicate_key_match(first, second)
