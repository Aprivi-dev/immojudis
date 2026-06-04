from src.comparison import compare_source_sales
from src.normalize import normalize_sale


def _sale(source_name: str, source_url: str, address: str = "1 rue Test 33000 Bordeaux"):
    return normalize_sale(
        {
            "source_name": source_name,
            "source_url": source_url,
            "address": address,
            "city": "Bordeaux",
            "department": "33",
            "property_type": "Maison",
            "starting_price_eur": "100 000 €",
            "sale_date": "10 janvier 2027 à 9h00",
        }
    )


def test_compare_source_sales_matches_same_sale_across_sources() -> None:
    report = compare_source_sales(
        [_sale("avoventes", "https://avoventes.fr/enchere/1")],
        [_sale("licitor", "https://www.licitor.com/annonce/1.html")],
    )

    assert report["summary"]["matched_count"] == 1
    assert report["summary"]["avoventes_only_count"] == 0
    assert report["summary"]["licitor_only_count"] == 0


def test_compare_source_sales_uses_loose_key_for_address_variants() -> None:
    report = compare_source_sales(
        [_sale("avoventes", "https://avoventes.fr/enchere/1", "1 rue Test 33000 Bordeaux")],
        [_sale("licitor", "https://www.licitor.com/annonce/1.html", "1, rue du Test")],
    )

    assert report["summary"]["matched_count"] == 1
    assert report["matched"][0]["match_type"] == "loose_key"
