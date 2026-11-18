"""« Description et faits attendent la lecture des pièces de leur vente » : trois copies, comparées ici.

1. La revendication (``claim_auction_enrichment_jobs_family``, garde posée par 20261111050000, redéfinition complète
   dans 20261201100000 puis dans 20261205100000) ne prend pas la tâche.
2. L'observateur de la file (``waits_for_pdf`` de sa dernière définition, 20261201100000) ne la compte pas comme
   immobile.
3. Le worker (``storage.supabase_client.eligible_pdf_job_due_at``) reporte une passe de faits jusqu'à l'échéance de
   la tâche pdf. Ce test lit sa règle par ``has_eligible_pdf_job_for_sale``, qui n'est plus appelée que par les tests
   et rend seulement « une telle tâche existe » d'après ``eligible_pdf_job_due_at``.

Aucune fonction SQL ne les partage (seconde relecture du lot D, 14/11/2026) : ce test les fait changer ensemble.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from src.storage import supabase_client

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
# La dernière définition complète de la revendication (20261111050000 à 20261111070000 la retouchaient sur place ; le
# SQL assemblé est interdit depuis le lot R2b, d'où la redéfinition complète). 20261205100000 ajoute la famille
# enrichment_pdf et garde la règle.
CLAIM_MIGRATION = "20261205100000_enrichment_pdf_claim_family.sql"
# La dernière définition de observe_autonomous_pipeline (elle remplace celle de 20261119101000).
OBSERVER_MIGRATION = "20261201100000_operational_alerts_recalibration.sql"
CLAIM_FUNCTION = "claim_auction_enrichment_jobs_family"

# The guard, comments and line breaks removed: the job types it holds back and what a pdf job of the same sale must
# be to hold them.
_RULE = re.compile(
    r"(?P<alias>\w+)\.job_type (?:not )?in \((?P<types>[^)]*)\) (?:or not|and) exists \( select 1"
    r" from public\.auction_enrichment_jobs pdf where pdf\.source_url = (?P=alias)\.source_url (?P<pdf>and .*?) \)"
)
HELD_JOB_TYPES = "'display_description', 'fact_extraction'"
PDF_STILL_ADVANCES = (
    "and pdf.job_type = 'pdf' and pdf.status in ('queued', 'running', 'failed')"
    " and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)"
)


def _normalized(sql: str) -> str:
    return " ".join(re.sub(r"--[^\n]*", " ", sql).split()).lower()


def _rules(sql: str) -> list[tuple[str, str]]:
    return [(match["types"], match["pdf"]) for match in _RULE.finditer(_normalized(sql))]


def _definition(migration: str, function: str) -> str:
    """Text of one ``create or replace function`` of a migration, up to the end of its body."""
    text = (MIGRATIONS / migration).read_text(encoding="utf-8")
    start = text.lower().index(f"create or replace function public.{function}(")
    tag = re.search(r"\bas (\$[a-z_]*\$)", text[start:], re.IGNORECASE)
    assert tag is not None, (migration, function)
    body_start = start + tag.end()
    return text[start : text.index(tag[1], body_start) + len(tag[1])]


def test_the_claim_and_the_observer_hold_back_the_same_jobs_behind_the_same_pdf_jobs() -> None:
    expected = [(HELD_JOB_TYPES, PDF_STILL_ADVANCES)]

    assert _rules(_definition(CLAIM_MIGRATION, CLAIM_FUNCTION)) == expected
    assert _rules(_definition(OBSERVER_MIGRATION, "observe_autonomous_pipeline")) == expected


def test_the_observer_compared_is_its_latest_definition() -> None:
    later = [
        path.name
        for path in sorted(MIGRATIONS.glob("*.sql"))
        if path.name > OBSERVER_MIGRATION
        and "function public.observe_autonomous_pipeline" in path.read_text(encoding="utf-8").lower()
    ]
    assert later == [], "point OBSERVER_MIGRATION at the latest definition of observe_autonomous_pipeline"


def test_no_later_migration_changes_the_claim_rule_alone() -> None:
    later = [
        path
        for path in sorted(MIGRATIONS.glob("*.sql"))
        if path.name > CLAIM_MIGRATION and CLAIM_FUNCTION in path.read_text(encoding="utf-8")
    ]
    for path in later:
        text = path.read_text(encoding="utf-8")
        assert f"create or replace function public.{CLAIM_FUNCTION}" not in text.lower(), path.name
        assert _rules(text) in ([], [(HELD_JOB_TYPES, PDF_STILL_ADVANCES)]), path.name
        assert "pdf.attempt_count" not in text or _rules(text), path.name


@pytest.mark.parametrize(
    ("rows", "holds"),
    [
        ([{"status": "queued", "attempt_count": 0, "max_attempts": 4}], True),
        ([{"status": "failed", "attempt_count": 3, "max_attempts": 4}], True),
        ([{"status": "running", "attempt_count": 4, "max_attempts": 4}], True),  # lease running: always
        ([{"status": "failed", "attempt_count": 4, "max_attempts": 4}], False),  # exhausted: releases the sale
        ([], False),
    ],
)
def test_the_worker_reads_the_same_pdf_jobs_with_the_same_rule(monkeypatch, rows: list[dict], holds: bool) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "test-only"},
    )
    seen: list[dict[str, str]] = []

    def fake_get(url, **kwargs):
        seen.append(kwargs["params"])
        return httpx.Response(200, json=rows, request=httpx.Request("GET", url))

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    assert supabase_client.has_eligible_pdf_job_for_sale("https://example.test/sale") is holds
    # Same pdf jobs as the SQL copies: « pdf.job_type = 'pdf' and pdf.status in ('queued', 'running', 'failed') ».
    statuses = re.search(r"pdf\.status in \(([^)]*)\)", PDF_STILL_ADVANCES)[1].replace("'", "").replace(" ", "")
    assert (seen[0]["job_type"], seen[0]["status"]) == ("eq.pdf", f"in.({statuses})")
