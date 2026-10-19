"""Département déduit du nom de commune quand il n'en désigne qu'une en France (``reference_communes``)."""

from __future__ import annotations

import logging

import pytest

from src import commune_department_lookup
from src.commune_department_lookup import load_unique_commune_departments, unique_department_for_commune
from src.normalize import normalize_sale
from src.tribunal import fill_tribunal, infer_missing_department

# Noms portés par une seule commune (le résultat de la requête ``having count(*) = 1``).
UNIQUE_NAMES = {
    "saint medard en jalles": "33",
    "saint etienne": "42",
    "talence": "33",
}


@pytest.fixture
def unique_communes(monkeypatch):
    monkeypatch.setattr(commune_department_lookup, "load_unique_commune_departments", lambda: dict(UNIQUE_NAMES))
    commune_department_lookup.reset_cache()


def _sale(**extra: object):
    return normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://www.petitesaffiches.fr/annonce-12345",
            "title": "Maison",
            **extra,
        }
    )


def test_a_city_alone_gets_the_department_of_its_unique_commune(unique_communes) -> None:
    sale = _sale(city="Saint-Médard-en-Jalles")
    assert sale.department is None

    infer_missing_department(sale)

    assert sale.department == "33"
    assert sale.raw_payload["department_inference"] == {"source": "reference_communes", "value": "33"}


def test_the_name_is_normalised_like_the_reference_table(unique_communes) -> None:
    assert unique_department_for_commune("ST ETIENNE") == "42"
    assert unique_department_for_commune("Saint-Étienne") == "42"
    assert unique_department_for_commune("TALENCE") == "33"


def test_an_ambiguous_or_unknown_name_gives_nothing(unique_communes) -> None:
    # « Saint-Martin » désigne des dizaines de communes : absente de l'index des noms uniques.
    sale = _sale(city="Saint-Martin")

    fill_tribunal(sale)

    assert sale.department is None
    assert "department_inference" not in sale.raw_payload
    assert unique_department_for_commune("Commune inconnue") is None
    assert unique_department_for_commune(None) is None
    assert unique_department_for_commune("") is None


def test_the_postal_code_and_the_known_department_win_over_the_commune_name(unique_communes) -> None:
    by_postal_code = _sale(city="Talence", postal_code="47000", address="1 rue X 47000 Talence")
    by_postal_code.department = None
    infer_missing_department(by_postal_code)
    assert by_postal_code.department == "47"
    assert by_postal_code.raw_payload["department_inference"]["source"] == "postal_code"

    known = _sale(city="Talence", department="40")
    infer_missing_department(known)
    assert known.department == "40"
    assert "department_inference" not in known.raw_payload


def test_the_geocode_wins_over_the_commune_name(unique_communes) -> None:
    sale = _sale(city="Talence")
    sale.raw_payload["geocode"] = {"provider": "ban_geoplateforme", "accepted": True, "citycode": "13055"}

    infer_missing_department(sale)

    assert sale.department == "13"
    assert sale.raw_payload["department_inference"]["source"] == "geocode_citycode"


def test_fill_tribunal_applies_the_fallback(unique_communes) -> None:
    sale = _sale(city="Talence")

    fill_tribunal(sale)

    assert sale.department == "33"


def test_without_a_database_nothing_is_inferred(monkeypatch) -> None:
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    monkeypatch.setattr(commune_department_lookup, "load_settings", lambda: {"supabase_db_url": None})

    assert load_unique_commune_departments() == {}


def test_the_index_is_read_once_from_the_table_in_read_only_mode(monkeypatch) -> None:
    executed: list[str] = []

    class Result:
        def fetchall(self):
            return [("talence", "33"), ("saint etienne", "42"), ("", "01"), ("vide", None)]

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, statement):
            executed.append(" ".join(statement.split()))
            return Result()

    calls: list[str] = []
    monkeypatch.setattr(commune_department_lookup, "load_settings", lambda: {"supabase_db_url": "postgres://test"})
    monkeypatch.setattr("src.storage.supabase_client.connect", lambda url: calls.append(url) or Connection())

    index = load_unique_commune_departments()

    assert index == {"talence": "33", "saint etienne": "42"}
    assert calls == ["postgres://test"]
    assert executed[0] == "set transaction read only"
    assert "from public.reference_communes" in executed[1]
    assert "having count(*) = 1" in executed[1]

    # Même chemin que celui du pipeline : un seul chargement par processus.
    monkeypatch.setattr(commune_department_lookup, "load_unique_commune_departments", load_unique_commune_departments)
    commune_department_lookup.reset_cache()
    assert unique_department_for_commune("Talence") == "33"
    assert unique_department_for_commune("Saint-Étienne") == "42"
    assert calls == ["postgres://test", "postgres://test"]


def test_an_unreachable_table_never_blocks_a_collection(monkeypatch, caplog) -> None:
    def failing() -> dict[str, str]:
        raise OSError("connection refused")

    monkeypatch.setattr(commune_department_lookup, "load_unique_commune_departments", failing)
    commune_department_lookup.reset_cache()
    sale = _sale(city="Talence")

    with caplog.at_level(logging.WARNING, logger="src.commune_department_lookup"):
        fill_tribunal(sale)
        fill_tribunal(sale)

    assert sale.department is None
    assert caplog.text.count("reference_communes unavailable") == 1
