"""Une date de vente à plus de 12 mois de la publication ou d'aujourd'hui n'est pas présentée comme certaine."""

from datetime import UTC, datetime

from src.asset_normalization import normalize_asset_features
from src.normalize import normalize_sale
from src.sale_date_plausibility import implausible_sale_date_reason, published_on, reject_implausible_sale_date

NOW = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)


def _raw(sale_date: str, **extra: object) -> dict[str, object]:
    return {
        "source_name": "licitor",
        "source_url": "https://www.licitor.com/annonce/10/90/00/vente-aux-encheres/une-maison/test/109000.html",
        "property_type": "house",
        "city": "Bordeaux",
        "department": "33",
        "sale_date": sale_date,
        **extra,
    }


def test_published_on_reads_the_iso_publication_date() -> None:
    assert published_on({"source_blocks": {"date_publication": "2026-09-01"}}).isoformat() == "2026-09-01"
    assert published_on({"source_property_features": {"listing": {"published_on": "2026-09-02"}}}).isoformat() == (
        "2026-09-02"
    )
    assert published_on({"source_blocks": {"date_publication": "bientôt"}}) is None
    assert published_on({}) is None


def test_date_beyond_twelve_months_after_publication_is_implausible() -> None:
    raw = {"source_blocks": {"date_publication": "2026-09-01"}}
    late = datetime(2027, 9, 2, 14, 0, tzinfo=UTC)
    edge = datetime(2027, 9, 1, 14, 0, tzinfo=UTC)

    assert implausible_sale_date_reason(late, raw, now=NOW) == "publication_horizon"
    assert implausible_sale_date_reason(edge, raw, now=NOW) is None


def test_date_beyond_twelve_months_from_today_is_implausible_without_publication_date() -> None:
    assert implausible_sale_date_reason(datetime(2044, 3, 4, tzinfo=UTC), {}, now=NOW) == "today_horizon"
    assert implausible_sale_date_reason(datetime(2027, 10, 13, 11, 0, tzinfo=UTC), {}, now=NOW) is None
    assert implausible_sale_date_reason(datetime(2027, 10, 13, 13, 0, tzinfo=UTC), {}, now=NOW) == "today_horizon"


def test_past_dates_are_never_implausible() -> None:
    assert implausible_sale_date_reason(datetime(2024, 1, 5, tzinfo=UTC), {}, now=NOW) is None


def test_reject_keeps_the_evidence_and_flags_the_sale() -> None:
    raw = {"quality_flags": ["price_conflict"], "source_blocks": {"date_publication": "2026-09-01"}}
    result = reject_implausible_sale_date(raw, datetime(2044, 3, 4, 14, 0, tzinfo=UTC), now=NOW)

    assert result is None
    assert raw["sale_date_unverified"]["reason"] in {"publication_horizon", "today_horizon"}
    assert raw["sale_date_unverified"]["value"].startswith("2044-03-04")
    assert raw["sale_date_unverified"]["published_on"] == "2026-09-01"
    assert raw["quality_flags"] == ["price_conflict", "sale_date_implausible"]
    assert reject_implausible_sale_date({}, None, now=NOW) is None


def test_normalize_drops_a_date_in_2044_and_keeps_the_proof() -> None:
    sale = normalize_sale(_raw("jeudi 4 mars 2044 à 14h"))

    assert sale.sale_date is None
    assert sale.status == "unknown"
    assert sale.raw_payload["sale_date_unverified"]["value"].startswith("2044-03-04")
    assert "sale_date_implausible" in sale.quality_flags

    # La relecture sur l'existant remet à zéro les drapeaux : ils reviennent avec les preuves.
    sale.quality_flags = []
    normalize_asset_features(sale)
    assert "sale_date_implausible" in sale.quality_flags


def test_normalize_keeps_a_normal_upcoming_date() -> None:
    soon = datetime.now(UTC).replace(year=datetime.now(UTC).year, microsecond=0)
    sale = normalize_sale(_raw(f"{soon.strftime('%Y-%m-%d')}T14:00:00+00:00"))

    assert sale.sale_date is not None
    assert "sale_date_implausible" not in sale.quality_flags
    assert "sale_date_unverified" not in sale.raw_payload


def test_normalize_uses_the_publication_date_of_the_source() -> None:
    # Annonce publiée il y a deux ans : une vente datée d'aujourd'hui dépasse 12 mois après la publication.
    published = datetime.now(UTC).replace(year=datetime.now(UTC).year - 2).strftime("%Y-%m-%d")
    soon = datetime.now(UTC).strftime("%Y-%m-%d")
    sale = normalize_sale(_raw(f"{soon}T14:00:00+00:00", source_blocks={"date_publication": published}))

    assert sale.sale_date is None
    assert sale.raw_payload["sale_date_unverified"]["reason"] == "publication_horizon"
