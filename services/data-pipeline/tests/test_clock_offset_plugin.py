"""Horloge décalée de +60 jours (job hebdomadaire) : activée par variable d'environnement seulement."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from tests import clock_offset

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = PIPELINE_ROOT.parents[1] / ".github" / "workflows" / "pipeline-clock-offset.yml"
HAS_TIME_MACHINE = importlib.util.find_spec("time_machine") is not None


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("", None), ("  ", None), ("60", 60.0), (" 7.5 ", 7.5), ("0", None), ("abc", None), ("-30", -30.0)],
)
def test_the_offset_is_read_from_the_environment(value, expected) -> None:
    environ = {} if value is None else {clock_offset.ENV_VARIABLE: value}

    assert clock_offset.configured_offset_days(environ) == expected


def _run(offset: str | None, *, hide_time_machine: bool = False) -> list[str]:
    """Écarts mesurés (en jours) de time.time, de datetime.now et de date.today, puis la raison d'indisponibilité."""
    script = textwrap.dedent(
        """
        import datetime, sys, time

        if "hide" in sys.argv:
            sys.modules["time_machine"] = None  # l'import lève ImportError, comme si le paquet était absent

        before_time, before_now = time.time(), datetime.datetime.now()
        from tests import clock_offset
        from tests import conftest  # installe le décalage selon la variable d'environnement

        print(round((time.time() - before_time) / 86400))
        print(round((datetime.datetime.now() - before_now).total_seconds() / 86400))
        print((datetime.date.today() - before_now.date()).days)
        print(clock_offset.unavailable_reason())
        """
    )
    env = {**os.environ, "PYTHONPATH": str(PIPELINE_ROOT)}
    env.pop(clock_offset.ENV_VARIABLE, None)
    if offset is not None:
        env[clock_offset.ENV_VARIABLE] = offset
    command = [sys.executable, "-W", "ignore", "-c", script]
    if hide_time_machine:
        command.append("hide")
    completed = subprocess.run(command, cwd=PIPELINE_ROOT, env=env, capture_output=True, text=True, check=True)
    return completed.stdout.splitlines()


def test_without_the_variable_the_clock_is_untouched() -> None:
    time_days, now_days, today_days, reason = _run(None)

    assert (time_days, now_days, today_days, reason) == ("0", "0", "0", "None")


@pytest.mark.skipif(not HAS_TIME_MACHINE, reason="time-machine n'est pas installé (dépendance optionnelle)")
def test_time_machine_moves_every_clock_by_the_requested_days() -> None:
    time_days, now_days, today_days, reason = _run("60")

    assert (time_days, now_days, today_days, reason) == ("60", "60", "60", "None")


def test_without_time_machine_the_clock_stays_put_and_the_reason_is_reported() -> None:
    time_days, now_days, today_days, reason = _run("60", hide_time_machine=True)

    assert (time_days, now_days, today_days) == ("0", "0", "0")
    assert "time-machine" in reason


def test_the_weekly_workflow_is_scheduled_manual_and_secret_free() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "schedule:" in text and "workflow_dispatch:" in text and "pull_request" not in text
    assert 'IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS: "60"' in text
    assert "secrets." not in text and "environment:" not in text
    assert "--require-hashes" in text
    assert "python -m pytest -q" in text
    assert clock_offset.ENV_VARIABLE in (PIPELINE_ROOT / "tests" / "clock_offset.py").read_text(encoding="utf-8")


def test_the_weekly_workflow_skips_with_a_warning_when_time_machine_is_missing() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "import time_machine" in text and "::warning::" in text
    assert "if: steps.engine.outputs.available == 'true'" in text
