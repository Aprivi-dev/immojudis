"""« Description et faits attendent la lecture des pièces de leur vente » : trois copies, comparées ici.

1. La revendication (``claim_auction_enrichment_jobs_family``, 20261111050000 ; 20261111060000 et 20261111070000
   ne changent que l'ordre de tri) ne prend pas la tâche.
2. L'observateur de la file (``waits_for_pdf`` de 20261119101000) ne la compte pas comme immobile.
3. Le worker (``storage.supabase_client.has_eligible_pdf_job_for_sale``) reporte une passe de faits.

Aucune fonction SQL ne les partage (seconde relecture du lot D, 14/11/2026) : ce test les fait changer ensemble.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from src.storage import supabase_client

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
CLAIM_MIGRATION = "20261111050000_enrichment_claim_pdf_first.sql"
OBSERVER_MIGRATION = "20261119101000_enrichment_stalled_counts_immobile_jobs.sql"
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


def _claim_patch() -> str:
    text = (MIGRATIONS / CLAIM_MIGRATION).read_text(encoding="utf-8")
    return text[text.index("$new$") : text.rindex("$new$")]


def test_the_claim_and_the_observer_hold_back_the_same_jobs_behind_the_same_pdf_jobs() -> None:
    expected = [(HELD_JOB_TYPES, PDF_STILL_ADVANCES)]

    assert _rules(_claim_patch()) == expected
    assert _rules((MIGRATIONS / OBSERVER_MIGRATION).read_text(encoding="utf-8")) == expected


def test_no_later_migration_changes_the_claim_rule_alone() -> None:
    later = [
        path
        for path in sorted(MIGRATIONS.glob("*.sql"))
        if path.name > CLAIM_MIGRATION and CLAIM_FUNCTION in path.read_text(encoding="utf-8")
    ]
    assert later, "the head-start patches of 11/11 mention the claim"
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
