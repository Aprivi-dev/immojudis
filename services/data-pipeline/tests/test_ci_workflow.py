"""Structure of .github/workflows/ci.yml: bounded jobs, and main is never cancelled."""

from __future__ import annotations

import re

from test_workflow_security import WORKFLOWS

CI = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")


def _jobs() -> dict[str, str]:
    body = CI.split("\njobs:\n", 1)[1]
    parts = re.split(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", body)
    return dict(zip(parts[1::2], parts[2::2], strict=True))


def test_every_ci_job_has_a_timeout() -> None:
    jobs = _jobs()
    assert len(jobs) >= 10
    assert [name for name, text in jobs.items() if not re.search(r"(?m)^    timeout-minutes: \d+$", text)] == []


def test_a_newer_push_never_cancels_the_run_of_main() -> None:
    assert "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}" in CI
    assert "cancel-in-progress: true" not in CI


def test_the_docling_audit_exceptions_carry_a_review_date() -> None:
    assert re.search(r'pillow_12_review_by="\d{4}-\d{2}-\d{2}"', CI)
    assert "GHSA-78g4-xqwv-q3g8" in CI


def test_the_hashed_lockfiles_are_audited_without_exception() -> None:
    audit = CI.split("for lockfile in ", 1)[1].split("done", 1)[0]
    for lockfile in ("requirements.lock", "requirements-dev.lock", "requirements-valuation.lock"):
        assert lockfile in audit.splitlines()[0]
    assert "--ignore-vuln" not in audit
