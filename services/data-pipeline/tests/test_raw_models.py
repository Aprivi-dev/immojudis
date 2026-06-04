from src.raw_models import validate_raw_sales


def test_validate_raw_sales_keeps_valid_source_payload() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "licitor",
        [
            {
                "source_name": "licitor",
                "source_url": "https://www.licitor.com/annonce/test/123.html",
                "title": "Appartement",
                "raw_text": "Mise à prix : 100 000 €",
            }
        ],
        errors,
    )

    assert len(valid) == 1
    assert errors == []


def test_validate_raw_sales_reports_missing_source_url_at_source_boundary() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "vench",
        [{"source_name": "vench", "title": "Maison"}],
        errors,
    )

    assert valid == []
    assert "source_url" in errors[0]
