"""Lot 2b, n° 33 : le libellé de tribunal de la source est comparé à celui du code INSEE avant d'être remplacé."""

from __future__ import annotations

import pytest

from src.court_competence import CompetentCourtAssignment, OfficialCourt
from src.normalize import normalize_sale
from src.tribunal import fill_tribunal

BOURG = CompetentCourtAssignment(
    insee_code="01187",
    commune_name="HAUT VALROMEY",
    court_code="justice_tj_1_39",
    court_name="TJ Bourg-en-Bresse",
    official_court_name="Tribunal judiciaire de Bourg-en-Bresse",
    court_origin_code="1",
    court_srj_code="39",
    court_department="01",
    court_city="Bourg-en-Bresse",
    reference_sha256="b" * 64,
)


def _official(code: str, name: str, city: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=code,
        court_name=name,
        official_court_name=f"Tribunal judiciaire de {city}",
        court_origin_code="1",
        court_srj_code="1",
        court_department="01",
        court_city=city,
    )


REGISTRY = {
    "TJ Lyon": _official("justice_tj_69_123", "TJ Lyon", "Lyon"),
    "TJ Bourg-en-Bresse": _official("justice_tj_1_39", "TJ Bourg-en-Bresse", "Bourg-en-Bresse"),
}


@pytest.fixture(autouse=True)
def registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_competent_court", lambda _sale: BOURG)
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", lambda label: REGISTRY.get(str(label)))


def _sale(tribunal: str | None, **extra):
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/conflit",
            "department": "01",
            "city": "Haut-Valromey",
            "tribunal": tribunal,
            **extra,
        }
    )
    sale.raw_payload["geocode"] = {"provider": "ban_geoplateforme", "accepted": True, "citycode": "01187"}
    return sale


def test_a_disagreeing_source_label_is_kept_and_flagged_while_the_insee_court_stays_displayed() -> None:
    sale = _sale("TJ Lyon")

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bourg-en-Bresse"
    assert sale.tribunal_code == "justice_tj_1_39"
    assert sale.raw_payload["tribunal_source_label"] == "TJ Lyon"
    assert "tribunal_inconsistent" in sale.quality_flags
    assert sale.raw_payload["tribunal_label_conflict"] == {
        "source_label": "TJ Lyon",
        "source_court_code": "justice_tj_69_123",
        "source_court_name": "TJ Lyon",
        "competent_court_code": "justice_tj_1_39",
        "competent_court_name": "TJ Bourg-en-Bresse",
    }


def test_the_source_label_survives_a_second_pass_over_the_stored_sale() -> None:
    sale = _sale("TJ Lyon")
    fill_tribunal(sale)

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bourg-en-Bresse"
    assert sale.raw_payload["tribunal_source_label"] == "TJ Lyon"
    assert "tribunal_inconsistent" in sale.quality_flags


def test_an_agreeing_source_label_raises_no_flag() -> None:
    sale = _sale("TJ Bourg-en-Bresse")
    sale.quality_flags.append("tribunal_inconsistent")

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bourg-en-Bresse"
    assert "tribunal_inconsistent" not in sale.quality_flags
    assert "tribunal_source_label" not in sale.raw_payload
    assert "tribunal_label_conflict" not in sale.raw_payload


def test_a_label_that_names_no_court_is_kept_without_a_flag() -> None:
    sale = _sale("Bourg")

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bourg-en-Bresse"
    assert sale.raw_payload["tribunal_source_label"] == "Bourg"
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_a_sale_without_source_label_has_nothing_to_compare() -> None:
    sale = _sale(None)

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bourg-en-Bresse"
    assert "tribunal_source_label" not in sale.raw_payload
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_the_flag_is_lifted_when_the_source_later_agrees() -> None:
    sale = _sale("TJ Lyon")
    fill_tribunal(sale)
    sale.tribunal = "TJ Bourg-en-Bresse"
    sale.raw_payload.pop("tribunal_assignment")

    fill_tribunal(sale)

    assert "tribunal_inconsistent" not in sale.quality_flags
    assert "tribunal_label_conflict" not in sale.raw_payload
