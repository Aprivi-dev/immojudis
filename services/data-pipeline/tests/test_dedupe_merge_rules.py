"""P2-14 : une fusion ne perd rien et ne rapproche pas deux ventes distinctes."""
from src.dedupe import dedupe_sales, merge_duplicate_sales
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
