from __future__ import annotations

import json
import sys
import time

import pytest

from src import source_process
from src.source_process import (
    WORKER_EVENT_PREFIX,
    SourceScrapeTimeout,
    SourceScrapeWorkerError,
    _communicate_with_timeout,
    run_source_in_subprocess,
)


def test_command_timeout_terminates_a_blocked_child_process() -> None:
    started = time.perf_counter()
    with pytest.raises(SourceScrapeTimeout, match="vench collector exceeded"):
        _communicate_with_timeout(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            input_text="",
            timeout_seconds=0.1,
            cwd=".",
            env={},
            label="vench",
        )

    assert time.perf_counter() - started < 5


def test_source_timeout_rejects_non_positive_budget() -> None:
    with pytest.raises(ValueError, match="finite positive"):
        run_source_in_subprocess("vench", timeout_seconds=0)


def test_source_events_are_forwarded_while_child_is_running() -> None:
    batches: list[list[dict[str, str]]] = []
    result = _communicate_with_timeout(
        [
            sys.executable,
            "-c",
            (
                "import json,sys; "
                "print(sys.argv[1] + json.dumps({'sales':[{'source_url':'event-1'}]}), flush=True); "
                "print('result', flush=True)"
            ),
            WORKER_EVENT_PREFIX,
        ],
        input_text="",
        timeout_seconds=2,
        cwd=".",
        env={},
        label="vench",
        on_batch=lambda batch: batches.append(batch),
    )

    assert result[2] == 0
    assert result[0] == "result\n"
    assert batches == [[{"source_url": "event-1"}]]


def test_source_worker_command_enables_faulthandler(monkeypatch) -> None:
    calls: dict[str, object] = {}
    response = json.dumps({"ok": True, "result": {"sales": [], "errors": [], "coverage": {}}})

    def fake_communicate(command, **kwargs):
        calls["command"] = command
        calls["kwargs"] = kwargs
        return response, "", 0, 0.1

    monkeypatch.setattr(source_process, "_communicate_with_timeout", fake_communicate)

    result = run_source_in_subprocess("petites_affiches", timeout_seconds=1800)

    assert result[0].sales == []
    assert calls["command"] == [
        sys.executable,
        "-X",
        "faulthandler",
        "-m",
        "src.scrape_worker",
        "petites_affiches",
    ]


def test_nonzero_child_after_batch_keeps_batch_and_exposes_diagnostic() -> None:
    batches: list[list[dict[str, str]]] = []
    result = _communicate_with_timeout(
        [
            sys.executable,
            "-X",
            "faulthandler",
            "-c",
            (
                "import json,sys; "
                "print(sys.argv[1] + json.dumps({'sales':[{'source_url':'event-1'}]}), flush=True); "
                "print('child diagnostic', file=sys.stderr, flush=True); "
                "sys.exit(23)"
            ),
            WORKER_EVENT_PREFIX,
        ],
        input_text="",
        timeout_seconds=2,
        cwd=".",
        env={},
        label="petites_affiches",
        on_batch=lambda batch: batches.append(batch),
    )

    assert result[2] == 23
    assert "child diagnostic" in result[1]
    assert batches == [[{"source_url": "event-1"}]]


def test_run_source_surfaces_nonzero_child_after_preserving_progressive_batch(monkeypatch) -> None:
    batches: list[list[dict[str, str]]] = []

    def fake_communicate(_command, *, on_batch, **_kwargs):
        on_batch([{"source_url": "event-1"}])
        return "", "child diagnostic", 23, 0.1

    monkeypatch.setattr(source_process, "_communicate_with_timeout", fake_communicate)

    with pytest.raises(SourceScrapeWorkerError, match="child diagnostic"):
        run_source_in_subprocess(
            "petites_affiches",
            timeout_seconds=1800,
            on_batch=batches.append,
        )

    assert batches == [[{"source_url": "event-1"}]]
