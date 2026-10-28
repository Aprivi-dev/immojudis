"""Annonce sans voie (Vench, Petites Affiches) rattachée à la même vente publiée avec son adresse."""

from __future__ import annotations

from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from src import municipality_location
from src.dedupe import (
    SWEEP_STRICT_EXCLUDED_SOURCES,
    SWEEP_STRICT_MAX_GROUP,
    _merge_into,
    merge_duplicate_sales,
    street_class,
)
from src.dedupe_streetless import STREETLESS_CONFIDENCE, core_match
from src.normalize import normalize_sale
from src.storage.duplicate_sweep import REASON_LABELS, build_plan

PARIS = ZoneInfo("Europe/Paris")
NICE = "justice_tj_1_06"
HEARING = "mardi 10 novembre 2026 à 14h"
NICE_INSEE = {"provider": "reference_communes", "accepted": True, "citycode": "06088"}
VENCH_URL = "https://www.vench.fr/vente-170001-un-appartement-nice.html"
LICITOR_URL = "https://www.licitor.com/annonce/10/20/30/vente-aux-encheres/un-appartement/nice/06/990001.html"


def _commune(code: str, name: str, department: str, postal_codes: list[str]) -> dict[str, object]:
    return {
        "code_insee": code,
        "name_normalized": name,
        "department_code": department,
        "postal_codes": postal_codes,
        "latitude": 43.7,
        "longitude": 7.26,
    }


def _use_communes(monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, object]]) -> None:
    monkeypatch.setattr(municipality_location, "_INDEX", municipality_location._Index(rows))


@pytest.fixture(autouse=True)
def _no_commune_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    """Par défaut, le référentiel des communes est vide : aucune lecture de base, aucun INSEE résolu."""
    _use_communes(monkeypatch, [])


@pytest.fixture
def communes(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_communes(
        monkeypatch,
        [
            _commune("06088", "nice", "06", ["06000", "06100", "06200", "06300"]),
            _commune("06029", "cannes", "06", ["06400"]),
            # Deux communes de même nom dans un même département : le nom seul ne désigne rien.
            _commune("27001", "sainte croix", "27", ["27100"]),
            _commune("27002", "sainte croix", "27", ["27200"]),
        ],
    )


def _merge(sales, **options: object):
    """Passage du balayage : la clé stricte ignore Vench et Petites Affiches, seule la règle sans voie agit."""
    options = {"strict_excluded_sources": SWEEP_STRICT_EXCLUDED_SOURCES, **options}
    return merge_duplicate_sales(sales, **options)


def _sale(source_name: str, source_url: str, **overrides: object):
    raw: dict[str, object] = {
        "source_name": source_name,
        "source_url": source_url,
        "city": "Nice",
        "property_type": "apartment",
        "starting_price_eur": "60 000 €",
        "sale_date": HEARING,
        **overrides,
    }
    court = raw.pop("court", NICE)
    sale = normalize_sale({key: value for key, value in raw.items() if value is not None})
    sale.tribunal_code = court
    return sale


def vench(**overrides: object):
    """Vench : seulement la commune, pas de code postal ni de voie, centre de commune comme position."""
    fields = {
        "address": "Nice",
        "department": "06",
        "geocode": NICE_INSEE,
        "latitude": 43.7102,
        "longitude": 7.262,
        **overrides,
    }
    return _sale("vench", VENCH_URL, **fields)


def licitor(**overrides: object):
    fields = {
        "address": "12 rue Gioffredo, 06000 Nice",
        "postal_code": "06000",
        "lawyer_name": "Maître Claire Durand",
        "lawyer_contact": "contact@durand-avocats.example",
        "geocode": {"provider": "ban_geoplateforme", "accepted": True, "citycode": "06088", "type": "housenumber"},
        "latitude": 43.6998,
        "longitude": 7.2711,
        **overrides,
    }
    return _sale("licitor", LICITOR_URL, **fields)


def test_a_vench_listing_with_only_the_city_is_attached_to_the_licitor_sale_with_the_address() -> None:
    result = _merge([vench(), licitor()])

    assert len(result) == 1
    merged = result[0]
    assert merged.source_url == LICITOR_URL
    assert merged.dedupe_confidence == STREETLESS_CONFIDENCE
    assert merged.primary_source == "licitor"
    assert {VENCH_URL, LICITOR_URL} <= set(merged.source_urls)


def test_the_sale_with_the_address_keeps_its_address_position_and_fields() -> None:
    street_sale = licitor()
    result = _merge([vench(address="06000 Nice", title="UN APPARTEMENT", lawyer_name="Maître Autre"), street_sale])

    merged = result[0]
    assert merged.address == "12 rue Gioffredo, 06000 Nice"
    assert (merged.latitude, merged.longitude) == (Decimal("43.6998"), Decimal("7.2711"))
    assert merged.lawyer_name == "Maître Claire Durand"
    assert merged.lawyer_contact == "contact@durand-avocats.example"
    assert merged.raw_payload["geocode"]["type"] == "housenumber"


def test_the_listing_without_a_street_only_brings_what_is_missing() -> None:
    anchor = licitor(lawyer_name=None, lawyer_contact=None, latitude=None, longitude=None)
    streetless = vench(
        lawyer_name="Maître Claire Durand",
        sale_date="mardi 10 novembre 2026 à 14h",
        starting_price_eur="60 400 €",
        quality_flags=["address_missing"],
    )

    merged = _merge([streetless, anchor])[0]

    assert merged.lawyer_name == "Maître Claire Durand"
    # Aucune position ni valeur calculée ne vient de l'annonce pauvre : le centre de commune n'est pas l'adresse.
    assert (merged.latitude, merged.longitude) == (None, None)
    assert "address_missing" not in merged.quality_flags
    # La mise à prix de la vente qui a l'adresse est conservée, l'écart est tracé.
    assert merged.starting_price_eur == Decimal("60000")
    assert any(
        conflict["field"] == "starting_price_eur" and conflict["selected_source"] == LICITOR_URL
        for conflict in merged.raw_payload["source_conflicts"]
    )


def test_the_hearing_time_missing_from_the_sale_with_the_address_is_taken() -> None:
    anchor = licitor(sale_date="10/11/2026")
    streetless = vench(sale_date="mardi 10 novembre 2026 à 14h")

    merged = _merge([streetless, anchor])[0]

    assert merged.sale_date.astimezone(PARIS).hour == 14


def test_the_order_of_the_observations_does_not_matter() -> None:
    forward = _merge([vench(), licitor()])
    backward = _merge([licitor(), vench()])

    assert [sale.source_url for sale in forward] == [sale.source_url for sale in backward] == [LICITOR_URL]


def test_two_possible_sales_attach_nothing() -> None:
    other = _sale(
        "avoventes",
        "https://avoventes.fr/enchere/77",
        address="3 rue de France, 06000 Nice",
        postal_code="06000",
        # À 0,5 % de la mise à prix de Vench, mais pas égale à celle de Licitor : la clé stricte ne les réunit pas.
        starting_price_eur="60 300 €",
        geocode={"provider": "ban_geoplateforme", "accepted": True, "citycode": "06088"},
    )

    result = _merge([vench(), licitor(), other])

    assert len(result) == 3
    assert all(len(sale.source_urls) == 1 for sale in result)


def test_two_listings_without_a_street_for_one_sale_attach_nothing() -> None:
    second = _sale(
        "petites_affiches",
        "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-appartement-a-nice-170002.html",
        address="Nice (06)",
        department="06",
        geocode=NICE_INSEE,
    )

    assert len(_merge([vench(), second, licitor()])) == 3


def test_a_different_starting_price_attaches_nothing() -> None:
    assert len(_merge([vench(starting_price_eur="61 000 €"), licitor()])) == 2


def test_a_starting_price_within_one_percent_is_accepted() -> None:
    assert len(_merge([vench(starting_price_eur="60 600 €"), licitor()])) == 1
    assert len(_merge([vench(starting_price_eur="60 700 €"), licitor()])) == 2


def test_another_court_attaches_nothing() -> None:
    assert len(_merge([vench(court="justice_tj_1_83"), licitor()])) == 2


def test_two_unknown_courts_attach_nothing() -> None:
    assert len(_merge([vench(court=None), licitor(court=None)])) == 2


def test_two_known_and_different_courts_attach_nothing_even_with_the_same_insee() -> None:
    assert len(_merge([vench(court="justice_tj_1_83"), licitor()])) == 2


def test_an_unknown_court_on_one_side_is_accepted_when_everything_else_matches_strictly() -> None:
    assert len(_merge([vench(court=None), licitor()])) == 1
    assert len(_merge([vench(), licitor(court=None)])) == 1
    assert len(_merge([vench(), licitor(court="other")])) == 1


def test_an_unknown_court_needs_the_price_to_the_euro() -> None:
    assert len(_merge([vench(court=None, starting_price_eur="60 001 €"), licitor()])) == 2
    # Avec les deux tribunaux connus, l'écart de 1 % reste accepté.
    assert len(_merge([vench(starting_price_eur="60 001 €"), licitor()])) == 1


def test_an_unknown_court_needs_the_same_insee_not_just_the_name_and_postal_code() -> None:
    no_insee = vench(court=None, geocode=None, postal_code="06000", address="06000 Nice")
    assert len(_merge([no_insee, licitor(geocode=None)])) == 2
    cannes = {"provider": "reference_communes", "accepted": True, "citycode": "06029"}
    assert len(_merge([vench(court=None, city="Cannes", geocode=cannes), licitor()])) == 2


def test_an_unknown_court_needs_a_compatible_type_and_the_same_day() -> None:
    assert len(_merge([vench(court=None, property_type="house"), licitor()])) == 2
    assert len(_merge([vench(court=None, sale_date="mercredi 11 novembre 2026 à 14h"), licitor()])) == 2


def test_an_unknown_court_does_not_hide_a_second_possible_sale() -> None:
    other = _sale(
        "avoventes",
        "https://avoventes.fr/enchere/78",
        address="3 rue de France, 06100 Nice",
        postal_code="06100",
        court=None,
        starting_price_eur="60 000 €",
        geocode={"provider": "ban_geoplateforme", "accepted": True, "citycode": "06088"},
    )

    # Deux ventes avec adresse concordent avec l'annonce : ambiguïté, rien n'est rattaché à Vench.
    result = _merge([vench(), licitor(), other])
    assert len(result) == 3
    assert all(len(sale.source_urls) == 1 for sale in result)


def test_the_listing_without_a_court_still_imports_nothing_but_what_is_missing() -> None:
    merged = _merge([vench(court=None, quality_flags=["address_missing"]), licitor()])[0]

    assert merged.address == "12 rue Gioffredo, 06000 Nice"
    assert (merged.latitude, merged.longitude) == (Decimal("43.6998"), Decimal("7.2711"))
    assert merged.tribunal_code == NICE
    assert "address_missing" not in merged.quality_flags


def test_another_hearing_day_attaches_nothing() -> None:
    assert len(_merge([vench(sale_date="mercredi 11 novembre 2026 à 14h"), licitor()])) == 2
    assert len(_merge([vench(sale_date=None), licitor()])) == 2


def test_the_same_day_at_another_time_still_attaches() -> None:
    assert len(_merge([vench(sale_date="mardi 10 novembre 2026 à 9h"), licitor()])) == 1


def test_an_incompatible_property_type_attaches_nothing() -> None:
    assert len(_merge([vench(property_type="house"), licitor()])) == 2
    assert len(_merge([vench(property_type="parking"), licitor(property_type="other")])) == 2


def test_a_vague_property_type_does_not_contradict() -> None:
    assert len(_merge([vench(property_type="other"), licitor()])) == 1


def test_another_commune_attaches_nothing() -> None:
    cannes = {"provider": "reference_communes", "accepted": True, "citycode": "06029"}
    streetless = vench(city="Cannes", geocode=cannes)

    assert not core_match(streetless, licitor())
    assert len(_merge([streetless, licitor()])) == 2


def test_the_commune_is_proved_by_the_insee_code_or_by_the_name_with_the_postal_code() -> None:
    # Ni INSEE ni code postal côté Vench : rien ne prouve la commune, même avec un nom identique.
    assert len(_merge([vench(geocode=None), licitor()])) == 2
    # Nom et code postal identiques, sans géocodage ni d'un côté ni de l'autre.
    named = vench(geocode=None, postal_code="06000", address="06000 Nice")
    assert len(_merge([named, licitor(geocode=None)])) == 1
    # Même nom mais autre code postal.
    assert len(_merge([vench(geocode=None, postal_code="06100", address="06100 Nice"), licitor(geocode=None)])) == 2


def test_a_paris_arrondissement_is_matched_by_its_name_and_postal_code() -> None:
    paris = {"city": "Paris 8ème", "postal_code": "75008", "court": "justice_tj_1_75", "geocode": None}
    streetless = vench(address="75008 Paris 8ème", **paris)
    anchor = licitor(address="31 rue de Miromesnil, 75008 Paris", **{**paris, "city": "Paris"})

    assert len(_merge([streetless, anchor])) == 1


def test_a_listing_that_names_a_place_is_not_a_listing_without_a_street() -> None:
    assert street_class(vench()) == "none"
    assert street_class(vench(address="06000 Nice", postal_code="06000")) == "none"
    assert street_class(vench(address="Nice (06)")) == "none"
    assert street_class(vench(address="Lieu-dit Les Granges, Nice")) == "street"
    assert street_class(vench(address="Les Granges, Nice")) == "other"
    assert street_class(licitor()) == "street"
    # Un lieu-dit sans mot de voie est écarté : on n'en perdrait l'information.
    assert len(_merge([vench(address="Les Granges, Nice"), licitor()])) == 2


def test_two_sales_with_a_street_are_left_to_the_other_rules() -> None:
    other_street = vench(address="5 boulevard Carabacel, 06000 Nice", postal_code="06000")

    result = _merge([other_street, licitor()])

    assert len(result) == 2
    assert all(sale.dedupe_confidence != STREETLESS_CONFIDENCE for sale in result)


def test_a_sale_of_the_same_source_is_never_attached() -> None:
    same_source = _sale("licitor", LICITOR_URL + "?autre", address="Nice", department="06", geocode=NICE_INSEE)

    assert len(_merge([same_source, licitor()])) == 2


def test_a_multi_lot_sale_is_never_attached() -> None:
    assert len(_merge([vench(), licitor(quality_flags=["multi_lot_sale"])])) == 2


def test_two_surfaces_far_apart_attach_nothing() -> None:
    assert len(_merge([vench(surface_m2="30"), licitor(surface_m2="60")])) == 2
    assert len(_merge([vench(surface_m2="58"), licitor(surface_m2="60")])) == 1


def test_a_petites_affiches_listing_with_another_listing_number_than_the_anchor_is_not_attached() -> None:
    anchor = _sale(
        "petites_affiches",
        "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-appartement-a-nice-170002.html",
        address="12 rue Gioffredo, 06000 Nice",
        postal_code="06000",
        geocode=NICE_INSEE,
    )

    assert len(_merge([vench(), anchor])) == 2


def test_the_rule_can_be_switched_off() -> None:
    assert len(_merge([vench(), licitor()], streetless_fallback=False)) == 2


def test_the_strict_key_ignores_vench_in_the_sweep_and_the_new_rule_takes_over() -> None:
    sales = [vench(), licitor()]

    assert len(merge_duplicate_sales(sales, streetless_fallback=False, strict_excluded_sources=SWEEP_STRICT_EXCLUDED_SOURCES)) == 2
    assert len(merge_duplicate_sales(sales, strict_excluded_sources=SWEEP_STRICT_EXCLUDED_SOURCES)) == 1


class _EmptyRegistry:
    def protected_sale_ids(self):
        return frozenset()

    def protected_source_urls(self):
        return frozenset()


def test_the_sweep_plan_removes_the_listing_without_a_street_and_keeps_the_sale_with_the_address() -> None:
    plan = build_plan([vench(), licitor()], _EmptyRegistry(), max_merges=None)

    assert len(plan.groups) == 1
    group = plan.groups[0]
    assert group.reason == STREETLESS_CONFIDENCE
    assert group.primary.source_url == LICITOR_URL
    assert [secondary.source_url for secondary in group.secondaries] == [VENCH_URL]
    assert STREETLESS_CONFIDENCE in REASON_LABELS
    assert SWEEP_STRICT_MAX_GROUP == 5


@pytest.mark.parametrize("confidence", ["persisted_identity", "source_url"])
def test_a_later_collection_of_the_listing_without_a_street_does_not_erase_the_address_or_the_position(
    confidence: str,
) -> None:
    merged = _merge([vench(), licitor()])[0]
    recollected = vench(address="06000 Nice", postal_code="06000", city="NICE")
    recollected.raw_payload["source_checks"] = {VENCH_URL: {"checked_at": "2999-01-01T00:00:00Z"}}

    result = _merge_into(merged.model_copy(deep=True), recollected, confidence=confidence)

    assert result.address == "12 rue Gioffredo, 06000 Nice"
    assert result.city == "Nice"
    assert (result.latitude, result.longitude) == (Decimal("43.6998"), Decimal("7.2711"))


def test_the_insee_missing_on_one_side_is_resolved_from_the_name_and_the_postal_code(communes: None) -> None:
    # Vench : nom et département seulement (nom unique dans le département) ; Licitor : nom et code postal.
    streetless = vench(geocode=None)
    anchor = licitor(geocode=None)

    assert streetless.postal_code is None and anchor.postal_code == "06000"
    assert len(_merge([streetless, anchor])) == 1


def test_an_ambiguous_commune_is_never_resolved(communes: None) -> None:
    streetless = vench(city="Sainte-Croix", department="27", geocode=None, address="Sainte-Croix")
    anchor = licitor(city="Sainte-Croix", postal_code="27100", address="1 rue Neuve, 27100 Sainte-Croix", geocode=None)

    # Le code postal tranche côté Licitor (27001), mais « Sainte-Croix » seul dans l'Eure en désigne deux.
    assert len(_merge([streetless, anchor])) == 2


def test_a_resolved_insee_that_differs_attaches_nothing(communes: None) -> None:
    streetless = vench(city="Cannes", department="06", geocode=None, address="Cannes")

    assert len(_merge([streetless, licitor(geocode=None)])) == 2


def test_the_resolution_does_not_replace_the_name_and_postal_code_proof(communes: None) -> None:
    named = vench(geocode=None, postal_code="06000", address="06000 Nice")
    assert len(_merge([named, licitor(geocode=None)])) == 1


def test_an_unknown_court_with_a_resolved_insee_is_accepted(communes: None) -> None:
    assert len(_merge([vench(court=None, geocode=None), licitor(geocode=None)])) == 1
