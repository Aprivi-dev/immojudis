from __future__ import annotations

import sys
import time

import pytest

from src.source_process import (
    WORKER_EVENT_PREFIX,
    SourceScrapeTimeout,
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
