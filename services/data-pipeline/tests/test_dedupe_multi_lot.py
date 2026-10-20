"""Ventes à plusieurs lots (Malaucène : 7 lots × Vench + Petites Affiches, tous à 20 000 €).

Chaque lot est une annonce à part, avec son numéro, chez Vench et chez Petites Affiches (qui reprend Vench). La
fusion par identifiant d'annonce commun associe chaque lot à la ligne de l'autre source de MÊME numéro, avant le
hash de contenu et l'adresse (qui rapprochent sinon n'importe quelles lignes d'un même immeuble), et deux lots
de numéros différents ne se fusionnent plus par une autre clé.
"""

from __future__ import annotations

import pytest

from src.dedupe import (
    _merge_by_shared_listing_id,
    merge_duplicate_sales,
    same_shared_listing,
    shared_listing_id,
    strict_duplicate_key_match,
)
from src.normalize import normalize_sale
from src.storage import duplicate_sweep

FIRST_ID = 166450
ADDRESS = "12 chemin du Plan, 84340 Malaucène"
DAY = "mardi 10 novembre 2026 à 14h"


def _vench_url(listing_id: int, suffix: str = "") -> str:
    return f"https://www.vench.fr/vente-{listing_id}-une-cave-malaucene.html{suffix}"


def _pa_url(listing_id: int, suffix: str = "") -> str:
    return (
        "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/"
        f"une-cave-a-malaucene-{listing_id}.html{suffix}"
    )


def _sale(source_name: str, source_url: str, *, address: str | None = ADDRESS, **extra: object):
    raw: dict[str, object] = {
        "source_name": source_name,
        "source_url": source_url,
        "city": "Malaucène",
        "postal_code": "84340",
        "property_type": "other",
        "starting_price_eur": "20 000 €",
        "sale_date": DAY,
        **extra,
    }
    if address:
        raw["address"] = address
    sale = normalize_sale(raw)
    sale.tribunal_code = "carpentras"
    return sale


def _lots(*, address: str | None = ADDRESS, count: int = 7, pa_reversed: bool = False):
    vench = [_sale("vench", _vench_url(FIRST_ID + index), address=address) for index in range(count)]
    petites_affiches = [_sale("petites_affiches", _pa_url(FIRST_ID + index), address=address) for index in range(count)]
    return vench, list(reversed(petites_affiches)) if pa_reversed else petites_affiches


def _listing_id_of_url(url: str) -> str | None:
    return shared_listing_id(_sale("vench" if "vench.fr" in url else "petites_affiches", url))


class _EmptyRegistry:
    def protected_sale_ids(self):
        return frozenset()

    def protected_source_urls(self):
        return frozenset()


@pytest.mark.parametrize("address", [ADDRESS, None])
@pytest.mark.parametrize("pa_reversed", [False, True])
def test_each_lot_pairs_with_the_row_of_its_own_listing_id(address, pa_reversed) -> None:
    vench, petites_affiches = _lots(address=address, pa_reversed=pa_reversed)

    result = merge_duplicate_sales([*vench, *petites_affiches])

    assert len(result) == 7
    for survivor in result:
        assert survivor.dedupe_confidence == "listing_id"
        assert len(survivor.source_urls) == 2
        assert len({_listing_id_of_url(url) for url in survivor.source_urls}) == 1


def test_the_sweep_plans_one_pair_per_lot_instead_of_one_oversized_group() -> None:
    vench, petites_affiches = _lots()

    plan = duplicate_sweep.build_plan([*vench, *petites_affiches], _EmptyRegistry(), max_merges=None)

    assert plan.oversized_groups == 0
    assert len(plan.groups) == 7
    assert plan.secondary_count == 7
    assert {group.reason for group in plan.groups} == {"listing_id"}
    for group in plan.groups:
        (secondary,) = group.secondaries
        assert {group.primary.source_name, secondary.source_name} == {"vench", "petites_affiches"}
        assert _listing_id_of_url(group.primary.source_url) == _listing_id_of_url(secondary.source_url)


def test_lots_with_different_listing_ids_are_not_merged_by_address_hash_or_strict_key() -> None:
    vench = _sale("vench", _vench_url(166450))
    other_lot = _sale("petites_affiches", _pa_url(166451))

    assert not strict_duplicate_key_match(vench, other_lot)
    assert len(merge_duplicate_sales([vench, other_lot])) == 2
    assert len(merge_duplicate_sales([vench, other_lot], strict_fallback=False)) == 2


def test_a_merged_lot_never_swallows_another_lot_through_the_address() -> None:
    vench, petites_affiches = _lots(count=2)
    # Une ligne d'une autre source, sans numéro d'annonce : même immeuble, même jour, même mise à prix.
    licitor = _sale("licitor", "https://www.licitor.com/annonce/77.html")

    result = merge_duplicate_sales([*vench, *petites_affiches, licitor])

    assert len(result) >= 2
    assert all(len({_listing_id_of_url(url) for url in sale.source_urls} - {None}) <= 1 for sale in result)


def test_rows_of_one_source_sharing_a_listing_id_pair_only_when_a_lot_number_tells_them_apart() -> None:
    def rows(lot_numbers: tuple[str | None, str | None]):
        extra = [{"lot_number": number} if number else {} for number in lot_numbers]
        vench = [_sale("vench", _vench_url(FIRST_ID, f"?lot={index}"), **item) for index, item in enumerate(extra, 1)]
        petites_affiches = [
            _sale("petites_affiches", _pa_url(FIRST_ID, f"?lot={index}"), **item) for index, item in enumerate(extra, 1)
        ]
        return [*vench, *petites_affiches]

    # Rien ne distingue les deux lots d'un même numéro : la fusion par numéro ne devine pas, aucune paire.
    assert len(_merge_by_shared_listing_id(rows((None, None)))) == 4
    # Avec un numéro de lot de chaque côté, chaque lot retrouve le sien.
    paired = merge_duplicate_sales(rows(("1", "2")))
    assert len(paired) == 2
    assert all(survivor.dedupe_confidence == "listing_id" and len(survivor.source_urls) == 2 for survivor in paired)
    assert all(len({url.rsplit("lot=", 1)[1] for url in survivor.source_urls}) == 1 for survivor in paired)


def test_a_listing_id_pair_with_two_different_lot_numbers_is_refused() -> None:
    vench = _sale("vench", _vench_url(166526), lot_number="1")
    petites_affiches = _sale("petites_affiches", _pa_url(166526), lot_number="2")

    assert not same_shared_listing(vench, petites_affiches)
