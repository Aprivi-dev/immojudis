"""Seuils du retrait des ventes disparues : les constantes Python et SQL doivent rester identiques.

La fonction SQL ``app_private.withdraw_missing_source_sales`` (dernière migration qui la redéfinit) porte les seuils
appliqués ; ``src.source_absence`` et ``src.autonomous_runner`` en gardent une copie pour les journaux et le
comptage. Ce test lit le texte de la migration et compare, pour qu'une modification d'un seul côté échoue.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src import autonomous_runner, source_absence

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"


def _latest_function_definition() -> tuple[str, str]:
    """(nom du fichier, texte) de la dernière migration qui redéfinit la fonction de retrait."""
    candidates = sorted(
        path
        for path in MIGRATIONS.glob("*.sql")
        if "create or replace function app_private.withdraw_missing_source_sales(" in path.read_text(encoding="utf-8")
    )
    assert candidates, "aucune migration ne définit app_private.withdraw_missing_source_sales"
    latest = candidates[-1]
    return latest.name, latest.read_text(encoding="utf-8")


def _sql_constant(text: str, name: str) -> str:
    match = re.search(rf"\b{name}\s+constant\s+\w+\s*:=\s*(.+?);", text)
    assert match, f"constante SQL {name} introuvable"
    return match.group(1).strip()


@pytest.fixture(scope="module")
def sql_text() -> str:
    return _latest_function_definition()[1]


def test_the_sql_and_python_thresholds_are_the_same(sql_text: str) -> None:
    assert float(_sql_constant(sql_text, "c_max_share")) == source_absence.MAX_WITHDRAWN_SHARE
    assert int(_sql_constant(sql_text, "c_min_inventories")) == source_absence.MIN_ABSENT_INVENTORIES
    assert int(_sql_constant(sql_text, "c_min_withdrawals")) == source_absence.MIN_WITHDRAWALS


def test_the_sql_and_python_inventory_spacing_are_the_same(sql_text: str) -> None:
    match = re.fullmatch(r"interval '(\d+) hours'", _sql_constant(sql_text, "c_min_spacing"))
    assert match, "c_min_spacing doit s'écrire interval 'N hours'"
    sql_hours = int(match.group(1))

    assert sql_hours == source_absence.MIN_INVENTORY_SPACING_HOURS
    assert autonomous_runner.ABSENCE_MIN_INVENTORY_SPACING.total_seconds() == sql_hours * 3600


def test_the_withdrawal_floor_lets_a_small_source_lose_one_sale() -> None:
    assert [source_absence.max_withdrawals(n) for n in (0, 1, 5, 6, 7, 13, 14, 20, 26, 100)] == [
        1, 1, 1, 1, 1, 1, 2, 3, 3, 15,
    ]
    # Au-delà du plancher, le plafond reste 15 % des ventes visibles.
    assert source_absence.max_withdrawals(200) == 30


def test_the_sql_allowed_count_uses_the_same_formula(sql_text: str) -> None:
    assert "greatest(c_min_withdrawals, pg_catalog.floor(c_max_share * v_population)::integer)" in sql_text
