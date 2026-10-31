"""The Dependabot auto-merge script recognises single and grouped patch-only pull requests."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest
from test_workflow_security import WORKFLOWS, parse_jobs

WORKFLOW = WORKFLOWS / "dependabot-auto-merge.yml"


def _script() -> str:
    jobs = parse_jobs(WORKFLOW.read_text(encoding="utf-8"))
    steps = [step for job in jobs for step in job.steps if "gh pr merge" in step.run]
    assert len(steps) == 1
    # The workflow parser keeps the YAML block indicator ("|") that opens the script.
    return steps[0].run.removeprefix("|")


DEV_BRANCH = "dependabot/npm_and_yarn/development-dependencies-1a2b3c4d5e"
ACTIONS_BRANCH = "dependabot/github_actions/actions/checkout-7.0.1"


def _merge_requested(
    tmp_path: Path, title: str, body: str = "", branch: str = DEV_BRANCH
) -> bool:
    fake_gh = tmp_path / "gh"
    log = tmp_path / "gh.log"
    fake_gh.write_text(f'#!/bin/sh\necho "$@" >> "{log}"\n', encoding="utf-8")
    fake_gh.chmod(fake_gh.stat().st_mode | stat.S_IEXEC)
    script = tmp_path / "step.sh"
    script.write_text(_script(), encoding="utf-8")
    env = {
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "PR_URL": "https://github.com/o/r/pull/1",
        "PR_BRANCH": branch,
        "PR_TITLE": title,
        "PR_BODY": body,
    }
    subprocess.run(["bash", str(script)], env=env, check=True, capture_output=True, text=True)
    return log.exists() and "pr merge --auto --squash https://github.com/o/r/pull/1" in log.read_text()


GROUP_HEADER = "Bumps the development-dependencies group with 3 updates:\r\n\r\n| Package | From | To |\r\n| --- | --- | --- |\r\n"


def _row(name: str, old: str, new: str) -> str:
    return f"| [{name}](https://github.com/x/{name}) | `{old}` | `{new}` |\r\n"


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Bump vitest from 4.1.2 to 4.1.5", True),
        ("Bump vitest from 4.1.2 to 4.2.0", False),
        ("Bump vitest from 4.1.2 to 5.0.0", False),
        ("Bump actions/checkout from v7.0.0 to v7.0.1 in the actions group", True),
        ("Chore: something unrelated", False),
    ],
)
def test_single_bump_titles(tmp_path, title, expected) -> None:
    assert _merge_requested(tmp_path, title) is expected


@pytest.mark.parametrize(
    ("branch", "expected"),
    [
        (DEV_BRANCH, True),
        (ACTIONS_BRANCH, True),
        # Runtime dependencies (next, supabase, stripe…) are reviewed by hand, even for a patch.
        ("dependabot/npm_and_yarn/production-dependencies-1a2b3c4d5e", False),
        ("dependabot/npm_and_yarn/next-16.2.1", False),
        # The Python pipeline needs a manual refresh of its hashed lock files.
        ("dependabot/pip/services/data-pipeline/python-dependencies-1a2b3c4d5e", False),
        ("some-human-branch", False),
        ("", False),
    ],
)
def test_only_development_tooling_is_merged(tmp_path, branch, expected) -> None:
    assert _merge_requested(tmp_path, "Bump vitest from 4.1.2 to 4.1.5", branch=branch) is expected


def test_grouped_production_patch_bumps_are_left_for_review(tmp_path) -> None:
    body = GROUP_HEADER + _row("next", "16.2.1", "16.2.2") + _row("zod", "4.0.2", "4.0.9")

    assert (
        _merge_requested(
            tmp_path,
            "Bump the production-dependencies group with 2 updates",
            body,
            branch="dependabot/npm_and_yarn/production-dependencies-1a2b3c4d5e",
        )
        is False
    )


def test_grouped_pull_request_with_only_patch_bumps_is_merged(tmp_path) -> None:
    body = GROUP_HEADER + _row("eslint", "9.1.0", "9.1.1") + _row("zod", "4.0.2", "4.0.9") + _row("vite", "7.3.1", "7.3.2")

    assert _merge_requested(tmp_path, "Bump the development-dependencies group with 3 updates", body) is True


def test_grouped_pull_request_with_one_minor_bump_is_left_alone(tmp_path) -> None:
    body = GROUP_HEADER + _row("eslint", "9.1.0", "9.1.1") + _row("zod", "4.0.2", "4.1.0")

    assert _merge_requested(tmp_path, "Bump the development-dependencies group with 2 updates", body) is False


def test_grouped_pull_request_with_an_unreadable_row_is_left_alone(tmp_path) -> None:
    body = GROUP_HEADER + _row("eslint", "9.1.0", "9.1.1") + _row("odd", "2026.10", "2026.11")

    assert (
        _merge_requested(tmp_path, "Bump the development-dependencies group with 2 updates", body)
        is False
    )


def test_grouped_pull_request_without_a_table_is_left_alone(tmp_path) -> None:
    assert _merge_requested(tmp_path, "Bump the python-dependencies group with 2 updates", "No table here") is False
