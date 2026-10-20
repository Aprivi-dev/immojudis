"""Horloge décalée de +60 jours (job hebdomadaire) : activée par variable d'environnement seulement."""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from tests import clock_offset

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = PIPELINE_ROOT.parents[1] / ".github" / "workflows" / "pipeline-clock-offset.yml"


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("", None), ("  ", None), ("60", 60.0), (" 7.5 ", 7.5), ("0", None), ("abc", None), ("-30", -30.0)],
)
def test_the_offset_is_read_from_the_environment(value, expected) -> None:
    environ = {} if value is None else {clock_offset.ENV_VARIABLE: value}

    assert clock_offset.configured_offset_days(environ) == expected


def _run(offset: str | None) -> list[str]:
    """Écarts mesurés (en jours) de time.time, datetime.now et date.today, puis deux contrôles d'instance."""
    script = textwrap.dedent(
        """
        import datetime, time

        before_time, before_now = time.time(), datetime.datetime.now()
        from tests import conftest  # installe le décalage selon la variable d'environnement

        print((time.time() - before_time) / 86400)
        print((datetime.datetime.now() - before_now).total_seconds() / 86400)
        print((datetime.date.today() - before_now.date()).days)
        print(isinstance(before_now, datetime.datetime), isinstance(datetime.datetime.fromisoformat("2026-01-01"), datetime.date))
        """
    )
    env = {"PATH": "", "PYTHONPATH": str(PIPELINE_ROOT)}
    if offset is not None:
        env[clock_offset.ENV_VARIABLE] = offset
    completed = subprocess.run(
        [sys.executable, "-W", "ignore", "-c", script],
        cwd=PIPELINE_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.splitlines()


def test_without_the_variable_the_clock_is_untouched() -> None:
    time_days, now_days, today_days, instances = _run(None)

    assert abs(float(time_days)) < 0.001 and abs(float(now_days)) < 0.001 and int(today_days) == 0
    assert instances == "True True"


def test_with_the_variable_time_now_and_today_move_60_days_and_real_values_stay_instances() -> None:
    time_days, now_days, today_days, instances = _run("60")

    assert abs(float(time_days) - 60) < 0.001
    assert abs(float(now_days) - 60) < 0.001
    assert int(today_days) == 60
    # Une valeur réelle (créée avant le décalage, ou lue par une bibliothèque) reste une instance de la classe décalée.
    assert instances == "True True"


def test_the_weekly_workflow_is_scheduled_manual_and_secret_free() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "schedule:" in text and "workflow_dispatch:" in text and "pull_request" not in text
    assert 'IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS: "60"' in text
    assert "secrets." not in text and "environment:" not in text
    assert "--require-hashes" in text
    assert "python -m pytest -q" in text
    assert clock_offset.ENV_VARIABLE in (PIPELINE_ROOT / "tests" / "clock_offset.py").read_text(encoding="utf-8")
