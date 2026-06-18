from src.dedupe import compute_content_hash, dedupe_sales
from src.normalize import normalize_sale


def _sale(source_url: str, address: str = "1 rue Test 33000 Bordeaux"):
    return normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": source_url,
            "address": address,
            "city": "Bordeaux",
            "starting_price_eur": "100 000 €",
            "sale_date": "10 janvier 2027 à 9h00",
        }
    )


def test_compute_content_hash_is_stable_for_same_content() -> None:
    first = _sale("https://avoventes.fr/enchere/1")
    second = _sale("https://avoventes.fr/enchere/2")
    assert compute_content_hash(first) == compute_content_hash(second)


def test_dedupe_sales_uses_source_url_then_content_hash() -> None:
    sales = [
        _sale("https://avoventes.fr/enchere/1"),
        _sale("https://avoventes.fr/enchere/1"),
        _sale("https://avoventes.fr/enchere/2"),
        _sale("https://avoventes.fr/enchere/3", "2 rue Test 33000 Bordeaux"),
    ]
    assert len(dedupe_sales(sales)) == 2


def test_dedupe_sales_collapses_cross_source_duplicates() -> None:
    avoventes = _sale("https://avoventes.fr/enchere/1")
    licitor = _sale("https://www.licitor.com/annonce/1.html")
    licitor.source_name = "licitor"

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1
    assert result[0].source_url == "https://avoventes.fr/enchere/1"
    assert "https://www.licitor.com/annonce/1.html" in result[0].source_urls
    assert result[0].dedupe_confidence == "content_hash"


def _make(
    source_url: str,
    *,
    source_name: str = "avoventes",
    address: str = "12 avenue de la Republique 33000 Bordeaux",
    city: str | None = "Bordeaux",
    postal_code: str | None = "33000",
    starting_price: str | None = "100 000 €",
    sale_date: str | None = "10 janvier 2027 à 9h00",
):
    raw: dict[str, object] = {
        "source_name": source_name,
        "source_url": source_url,
        "address": address,
    }
    if city is not None:
        raw["city"] = city
    if postal_code is not None:
        raw["postal_code"] = postal_code
    if starting_price is not None:
        raw["starting_price_eur"] = starting_price
    if sale_date is not None:
        raw["sale_date"] = sale_date
    return normalize_sale(raw)


def test_dedupe_merges_same_address_across_sources_when_price_differs() -> None:
    # Même adresse précise + même date, mais prix légèrement différent selon la
    # source (frais inclus/exclus) → content_hash diffère, l'adresse rapproche.
    avoventes = _make("https://avoventes.fr/enchere/9", starting_price="100 000 €")
    licitor = _make(
        "https://www.licitor.com/annonce/9.html",
        source_name="licitor",
        starting_price="105 000 €",
    )

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1
    assert result[0].dedupe_confidence == "address"
    assert "https://www.licitor.com/annonce/9.html" in result[0].source_urls


def test_dedupe_merges_same_address_when_one_is_missing_date_and_price() -> None:
    avoventes = _make("https://avoventes.fr/enchere/10")
    licitor = _make(
        "https://www.licitor.com/annonce/10.html",
        source_name="licitor",
        starting_price=None,
        sale_date=None,
    )

    result = dedupe_sales([avoventes, licitor])

    assert len(result) == 1


def test_dedupe_keeps_distinct_lots_at_same_address() -> None:
    # Même immeuble, deux lots distincts : date ET prix diffèrent → on garde les deux.
    lot_a = _make(
        "https://avoventes.fr/enchere/11",
        starting_price="100 000 €",
        sale_date="10 janvier 2027 à 9h00",
    )
    lot_b = _make(
        "https://www.licitor.com/annonce/11.html",
        source_name="licitor",
        starting_price="260 000 €",
        sale_date="15 mars 2027 à 9h00",
    )

    result = dedupe_sales([lot_a, lot_b])

    assert len(result) == 2


def test_dedupe_does_not_merge_city_only_addresses() -> None:
    # Adresse sans numéro de voie (commune seule) : on ne fusionne pas.
    first = _make(
        "https://avoventes.fr/enchere/12",
        address="Bordeaux",
        postal_code=None,
        starting_price="100 000 €",
        sale_date="10 janvier 2027 à 9h00",
    )
    second = _make(
        "https://www.licitor.com/annonce/12.html",
        source_name="licitor",
        address="Bordeaux",
        postal_code=None,
        starting_price="260 000 €",
        sale_date="15 mars 2027 à 9h00",
    )

    result = dedupe_sales([first, second])

    assert len(result) == 2
