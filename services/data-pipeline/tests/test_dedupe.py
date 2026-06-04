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
