"""La colonne catalogue_quarantined et le pipeline lisent les mêmes clés de quarantaine."""

import re
from pathlib import Path

from src.admission import _QUARANTINE_PAYLOAD_KEYS

MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "20261028110200_catalogue_quarantine_payload_keys.sql"
)


def test_the_database_rule_lists_exactly_the_pipeline_quarantine_keys() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    rule = sql[sql.index("create or replace function app_private.catalogue_quarantine_from_payload") :]
    array = re.search(r"unnest\(array\[(.*?)\]\)", rule, re.S)

    assert array is not None
    assert tuple(re.findall(r"'([a-z_]+)'", array.group(1))) == _QUARANTINE_PAYLOAD_KEYS


def test_both_projection_triggers_use_the_rule_and_stay_security_invoker() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert sql.count("app_private.catalogue_quarantine_from_payload(new.raw_payload)") == 2
    # La migration ne rend aucune fonction plus puissante qu'avant.
    assert "security definer" not in sql.lower()
