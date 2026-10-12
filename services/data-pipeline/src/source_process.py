"""Run a source collector in a killable process.

Source collection normally runs concurrently.  A thread timeout cannot stop a
BeautifulSoup parse that is stuck in native or Python code, and a
``ThreadPoolExecutor`` context manager waits for that thread before returning.
This module keeps the source contract small and uses a short JSON protocol so
the parent can terminate the whole source process without losing the other
collectors.  The child interpreter enables Python's fatal-signal handler so a
native crash leaves a bounded stack trace in stderr for diagnosis; it does not
log source payloads or local variables.
"""

from __future__ import annotations

import json
import logging
import math
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from src.sources.common import ScrapeResult

LOGGER = logging.getLogger(__name__)
WORKER_MODULE = "src.scrape_worker"
WORKER_CWD = str(Path(__file__).resolve().parent.parent)
WORKER_EVENT_PREFIX = "__IMMOJUDIS_SOURCE_EVENT__"


class SourceScrapeTimeout(TimeoutError):
    """Raised when an isolated collector exceeds its wall-clock budget."""


class SourceScrapeWorkerError(RuntimeError):
    """Raised when an isolated collector cannot return a valid result."""


def run_source_in_subprocess(
    source: str,
    *,
    known: dict[str, str] | None = None,
    known_details: dict[str, dict[str, Any]] | None = None,
    max_pages: int | None = None,
    fetch_detail_heavy: bool = True,
    timeout_seconds: float,
    python_executable: str | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    on_batch: Callable[[list[dict[str, Any]]], None] | None = None,
) -> tuple[ScrapeResult, float]:
    """Collect one source in an independently terminable process.

    ``known`` and ``known_details`` are sent as JSON because the source
    closures built by :mod:`src.main` are not portable across process start
    methods.  A malformed or incomplete child response is an error: callers
    must fail closed instead of publishing an ambiguous partial source.
    """

    budget = float(timeout_seconds)
    if not math.isfinite(budget) or budget <= 0:
        raise ValueError("source scrape timeout must be a finite positive number")

    payload = {
        "known": known or {},
        # Only Vench currently consumes this map.  Omitting it for other
        # sources keeps the worker command small when the database is large.
        "known_details": known_details or {},
        "max_pages": max_pages,
        "fetch_detail_heavy": bool(fetch_detail_heavy),
        "publish_batches": on_batch is not None,
    }
    command = [
        python_executable or sys.executable,
        "-X",
        "faulthandler",
        "-m",
        WORKER_MODULE,
        source,
    ]
    child_env = os.environ.copy()
    if env:
        child_env.update(env)

    input_text = json.dumps(payload, default=str, ensure_ascii=False)
    stdout, stderr, returncode, _elapsed = _communicate_with_timeout(
        command,
        input_text=input_text,
        timeout_seconds=budget,
        cwd=cwd or WORKER_CWD,
        env=child_env,
        label=source,
        on_batch=on_batch,
    )
    if returncode != 0:
        detail = (stderr or stdout or "worker exited without a diagnostic").strip()
        raise SourceScrapeWorkerError(
            f"{source} collector worker exited {returncode}: {detail[-1200:]}"
        )

    try:
        message = json.loads((stdout or "").strip())
    except json.JSONDecodeError as exc:
        detail = (stderr or stdout or "empty worker response").strip()
        raise SourceScrapeWorkerError(
            f"{source} collector returned invalid JSON: {detail[-1200:]}"
        ) from exc
    if not isinstance(message, dict) or message.get("ok") is not True:
        detail = message.get("error") if isinstance(message, dict) else message
        raise SourceScrapeWorkerError(f"{source} collector failed: {str(detail)[:1200]}")
    result = message.get("result")
    if not isinstance(result, dict):
        raise SourceScrapeWorkerError(f"{source} collector returned no result")
    sales = result.get("sales")
    errors = result.get("errors")
    coverage = result.get("coverage")
    if not isinstance(sales, list) or not isinstance(errors, list) or not isinstance(coverage, dict):
        raise SourceScrapeWorkerError(f"{source} collector returned an invalid result shape")
    return ScrapeResult(sales, [str(error) for error in errors], coverage), _elapsed


def _communicate_with_timeout(
    command: list[str],
    *,
    input_text: str,
    timeout_seconds: float,
    cwd: str,
    env: dict[str, str],
    label: str,
    on_batch: Callable[[list[dict[str, Any]]], None] | None = None,
) -> tuple[str, str, int, float]:
    """Run a command while retaining the ability to kill its full process group."""

    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=(os.name == "posix"),
    )
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    event_errors: list[BaseException] = []

    def _read_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            if not line.startswith(WORKER_EVENT_PREFIX):
                stdout_chunks.append(line)
                continue
            if on_batch is None:
                event_errors.append(SourceScrapeWorkerError(f"{label} emitted an unexpected event"))
                continue
            try:
                event = json.loads(line[len(WORKER_EVENT_PREFIX) :])
                batch = event.get("sales") if isinstance(event, dict) else None
                if not isinstance(batch, list) or not all(isinstance(item, dict) for item in batch):
                    raise ValueError("source event has an invalid batch")
                on_batch(batch)
            except BaseException as exc:  # Keep the child from becoming an ambiguous success.
                event_errors.append(exc)

    def _read_stderr() -> None:
        assert process.stderr is not None
        stderr_chunks.append(process.stderr.read())

    stdout_thread = threading.Thread(target=_read_stdout, name=f"{label}-source-stdout", daemon=True)
    stderr_thread = threading.Thread(target=_read_stderr, name=f"{label}-source-stderr", daemon=True)
    def _write_stdin() -> None:
        if process.stdin is None:
            return
        try:
            process.stdin.write(input_text)
            process.stdin.close()
        except BrokenPipeError:
            pass

    stdin_thread = threading.Thread(target=_write_stdin, name=f"{label}-source-stdin", daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    stdin_thread.start()
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _kill_process_tree(process)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        # Preserve the parent collector's semantics: any batch whose callback
        # already started is allowed to finish before the source is reported
        # interrupted. The callback has its own bounded database transports.
        stdout_thread.join()
        stderr_thread.join()
        stdin_thread.join()
        elapsed = time.perf_counter() - started
        raise SourceScrapeTimeout(
            f"{label} collector exceeded {timeout_seconds:g}s and was terminated "
            f"after {elapsed:.2f}s"
        ) from exc
    # A callback can take longer than five seconds when its bounded database
    # request retries. Waiting for it keeps progressive publication atomic with
    # the source future, as it was before process isolation.
    stdout_thread.join()
    stderr_thread.join()
    stdin_thread.join()
    elapsed = time.perf_counter() - started
    if stdout_thread.is_alive() or stderr_thread.is_alive():
        _kill_process_tree(process)
        raise SourceScrapeWorkerError(f"{label} collector output reader did not terminate")
    if event_errors:
        raise SourceScrapeWorkerError(f"{label} source batch callback failed: {event_errors[0]}")
    return "".join(stdout_chunks), "".join(stderr_chunks), int(process.returncode or 0), round(elapsed, 2)


def _kill_process_tree(process: subprocess.Popen[str]) -> None:
    """Terminate a source and any descendants without touching the parent."""

    if process.poll() is not None:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError):
            pass
    try:
        process.kill()
    except ProcessLookupError:
        pass
