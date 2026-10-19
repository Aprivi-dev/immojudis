"""P2-14 : une fusion ne perd rien et ne rapproche pas deux ventes distinctes."""
import pytest

from src.dedupe import _merge_into, dedupe_sales, merge_duplicate_sales
from src.normalize import normalize_sale

ADDRESS = "12 avenue de la Republique 33000 Bordeaux"


def _make(url, *, source="avoventes", address=ADDRESS, price="100 000 €", date="10 janvier 2027 à 9h00", **extra):
    raw = {"source_name": source, "source_url": url, "address": address, "city": "Bordeaux", "postal_code": "33000"}
    if price is not None:
        raw["starting_price_eur"] = price
    if date is not None:
        raw["sale_date"] = date
    return normalize_sale({"property_type": "maison", **raw, **extra})


# --- passe source_url : l'ancienne observation est fusionnée, pas remplacée -----------------

def test_source_url_pass_keeps_documents_and_fields_of_the_replaced_observation():
    url = "https://avoventes.fr/enchere/42"
    older = _make(
        url,
        lawyer_name="Me Dupont",
        documents=[{"url": "https://avoventes.fr/docs/cahier.pdf", "label": "Cahier des charges"}],
    )
    richer = _make(
        url,
        surface_m2="85 m²",
        rooms_count=4,
        tribunal="Tribunal judiciaire de Bordeaux",
        property_type="maison",
        documents=[{"url": "https://avoventes.fr/docs/pv.pdf", "label": "PV descriptif"}],
    )

    result = merge_duplicate_sales([older, richer])

    assert len(result) == 1
    merged = result[0]
    assert merged is richer
    assert {doc["url"] for doc in merged.documents} == {
        "https://avoventes.fr/docs/cahier.pdf",
        "https://avoventes.fr/docs/pv.pdf",
    }
    assert merged.lawyer_name == "Me Dupont"
    assert merged.surface_m2 is not None
    assert merged.dedupe_confidence == "source_url"
    assert merged.raw_payload["merged_sources"][0]["source_url"] == url


def test_source_url_pass_is_unchanged_when_the_first_observation_is_richer():
    url = "https://avoventes.fr/enchere/43"
    richer = _make(url, surface_m2="85 m²", rooms_count=4, property_type="maison", tribunal="Tribunal de Bordeaux")
    poorer = _make(url, documents=[{"url": "https://avoventes.fr/docs/extra.pdf"}])

    result = merge_duplicate_sales([richer, poorer])

    assert result == [richer]
    assert [doc["url"] for doc in richer.documents] == ["https://avoventes.fr/docs/extra.pdf"]


def test_same_object_twice_is_not_merged_into_itself():
    sale = _make("https://avoventes.fr/enchere/44")

    assert merge_duplicate_sales([sale, sale]) == [sale]


# --- passe adresse : jour civil Paris, date ET prix, ou surface --------------------------------

def _pair(first_kwargs=None, second_kwargs=None):
    first = _make("https://avoventes.fr/enchere/50", address="12 av. de la République 33000 Bordeaux", **(first_kwargs or {}))
    second = _make("https://www.licitor.com/annonce/50.html", source="licitor", **(second_kwargs or {}))
    return dedupe_sales([first, second])


def test_two_different_prices_never_merge():
    assert len(_pair({"price": "100 000 €"}, {"price": "100 500 €"})) == 2
    assert len(_pair({"price": "100 000 €", "surface_m2": "72 m²"}, {"price": "120 000 €", "surface_m2": "72 m²"})) == 2


def test_same_date_and_same_price_merge():
    result = _pair()

    assert len(result) == 1
    assert result[0].dedupe_confidence == "address"


def test_same_paris_day_with_different_clock_times_merges():
    result = _pair({"date": "10 janvier 2027 à 9h00"}, {"date": "10 janvier 2027 à 14h30"})

    assert len(result) == 1


def test_date_only_midnight_utc_matches_the_late_evening_of_the_same_paris_day():
    # 00h30 à Paris le 11 janvier = 23h30 UTC le 10 : un autre jour en UTC, le même à Paris.
    first = _make("https://avoventes.fr/enchere/51", address="12 av. de la République 33000 Bordeaux",
                  date="11 janvier 2027")
    second = _make("https://www.licitor.com/annonce/51.html", source="licitor", date="11 janvier 2027 à 0h30")
    assert first.sale_date.date() != second.sale_date.date()

    assert len(dedupe_sales([first, second])) == 1


def test_resale_on_another_date_is_not_merged_even_with_same_price_and_surface():
    result = _pair(
        {"date": "10 janvier 2027 à 9h00", "surface_m2": "72 m²"},
        {"date": "14 mars 2027 à 9h00", "surface_m2": "72 m²"},
    )

    assert len(result) == 2


def test_resale_is_not_merged_when_only_the_date_differs_by_one_day():
    assert len(_pair({"date": "10 janvier 2027 à 9h00"}, {"date": "11 janvier 2027 à 9h00"})) == 2


def test_identical_surface_is_enough_when_date_or_price_is_missing():
    result = _pair({"surface_m2": "72 m²"}, {"price": None, "date": None, "surface_m2": "72,0 m²"})

    assert len(result) == 1


def test_missing_date_or_price_without_surface_is_not_enough():
    assert len(_pair({}, {"price": None})) == 2
    assert len(_pair({}, {"date": None})) == 2


def test_different_surfaces_do_not_merge_on_surface_alone():
    assert len(_pair({"surface_m2": "72 m²"}, {"price": None, "date": None, "surface_m2": "80 m²"})) == 2


# --- heure conservée à la fusion (point 7) -----------------------------------------------------

def _grenoble_pair():
    """Vench horodaté (24/11/2026 14 h) et Petites Affiches en date seule (minuit UTC), même annonce."""
    timed = _make("https://www.vench.example/vente-777-maison-grenoble.html", source="vench", date="24 novembre 2026 à 14h")
    date_only = _make(
        "https://www.petitesaffiches.example/maison-grenoble-777.html",
        source="petites_affiches",
        date="24 novembre 2026",
    )
    return timed, date_only


def _sale_date_conflicts(sale):
    return [item for item in sale.raw_payload.get("source_conflicts", []) if item["field"] == "sale_date"]


@pytest.mark.parametrize("target_is_timed", [True, False])
def test_merge_keeps_the_timed_sale_date_whichever_side_is_the_survivor(target_is_timed):
    timed, date_only = _grenoble_pair()
    expected = timed.sale_date
    assert date_only.sale_date.hour == 0 and expected.hour != 0

    target, source = (timed, date_only) if target_is_timed else (date_only, timed)
    # Même si l'autre côté a la meilleure « autorité » de champ (contrôle plus récent), l'heure l'emporte.
    source.raw_payload["source_checks"] = {source.source_url: {"checked_at": "2026-10-19T08:00:00+00:00"}}
    _merge_into(target, source, confidence="listing_id")

    assert target.sale_date == expected
    # Une simple différence de précision n'est pas un désaccord entre sources.
    assert not _sale_date_conflicts(target)


def test_merge_keeps_the_existing_rule_when_the_days_differ_or_both_hours_are_known():
    vench = _make("https://www.vench.example/vente-1-a.html", source="vench", date="24 novembre 2026 à 14h")
    next_day = _make("https://www.petitesaffiches.example/a-1.html", source="petites_affiches", date="25 novembre 2026")
    _merge_into(vench, next_day, confidence="listing_id")
    assert len(_sale_date_conflicts(vench)) == 1

    morning = _make("https://www.vench.example/vente-2-a.html", source="vench", date="24 novembre 2026 à 9h")
    afternoon = _make(
        "https://www.petitesaffiches.example/a-2.html", source="petites_affiches", date="24 novembre 2026 à 14h"
    )
    _merge_into(morning, afternoon, confidence="listing_id")
    assert len(_sale_date_conflicts(morning)) == 1


def test_two_date_only_values_of_one_day_are_left_alone():
    first = _make("https://www.vench.example/vente-3-a.html", source="vench", date="24 novembre 2026")
    second = _make("https://www.petitesaffiches.example/a-3.html", source="petites_affiches", date="24 novembre 2026")
    before = first.sale_date
    _merge_into(first, second, confidence="listing_id")

    assert first.sale_date == before
    assert not _sale_date_conflicts(first)


def test_a_full_merge_of_the_grenoble_pair_keeps_the_hour():
    timed, date_only = _grenoble_pair()
    expected = timed.sale_date

    result = merge_duplicate_sales([date_only, timed], strict_fallback=False)

    assert [sale.sale_date for sale in result] == [expected]
