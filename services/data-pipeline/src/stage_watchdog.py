"""Stage journal and watchdog for the collection process.

The cooperative budgets of the sources (``LICITOR_SOURCE_BUDGET_SECONDS``...)
are only checked between two operations. A call that never returns, such as a
psycopg query waiting on a transaction pooler, bypasses them: the scheduler
then kills the process at its hard limit with nothing in the log to say where
it was stuck. This module adds two things:

* ``track_stage`` journals the start and the end (with duration) of each step;
* ``arm`` starts a timer thread that, once the deadline passes, names the steps
  still running, dumps every thread's stack, stops the source collectors and
  ends the process with ``WATCHDOG_EXIT_CODE`` (``os._exit``, which does not
  wait for the blocked thread).
"""

from __future__ import annotations

import faulthandler
import itertools
import logging
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

LOGGER = logging.getLogger(__name__)

WATCHDOG_ENV = "PIPELINE_WATCHDOG_SECONDS"
# Same value as coreutils ``timeout``: distinct from 1 (failure) and 2 (source warning).
WATCHDOG_EXIT_CODE = 124

_LOCK = threading.Lock()
_ACTIVE: dict[int, tuple[str, float, str]] = {}
_IDS = itertools.count(1)
_ARMED: threading.Timer | None = None


@contextmanager
def track_stage(name: str) -> Iterator[None]:
    """Journal the start and the end of a step, and expose it to the watchdog."""

    stage_id = next(_IDS)
    started = time.monotonic()
    thread_name = threading.current_thread().name
    with _LOCK:
        _ACTIVE[stage_id] = (name, started, thread_name)
    LOGGER.info("Stage start name=%s", name)
    outcome = "end"
    try:
        yield
    except BaseException:
        outcome = "failed"
        raise
    finally:
        with _LOCK:
            _ACTIVE.pop(stage_id, None)
        LOGGER.info("Stage %s name=%s seconds=%.1f", outcome, name, time.monotonic() - started)


def active_stages() -> list[tuple[str, float, str]]:
    """Steps currently running, oldest first, as (name, elapsed seconds, thread)."""

    now = time.monotonic()
    with _LOCK:
        items = sorted(_ACTIVE.values(), key=lambda item: item[1])
    return [(name, now - started, thread) for name, started, thread in items]


def _fire(
    seconds: float,
    label: str,
    on_fire: Callable[[], None] | None,
    exit_process: Callable[[int], None],
) -> None:
    stages = active_stages()
    described = "; ".join(f"{name} ({elapsed:.0f}s, thread {thread})" for name, elapsed, thread in stages)
    message = (
        f"WATCHDOG: {label} still running {seconds:g}s after start; blocked step(s): "
        f"{described or 'none registered'}. Ending the process with exit code {WATCHDOG_EXIT_CODE}."
    )
    try:
        LOGGER.critical(message)
        print(message, file=sys.stderr, flush=True)
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
    except Exception:  # Never let the journal prevent the exit.
        pass
    if on_fire is not None:
        try:
            on_fire()
        except Exception:
            LOGGER.exception("Watchdog cleanup failed")
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    exit_process(WATCHDOG_EXIT_CODE)


def arm(
    seconds: float,
    *,
    label: str = "pipeline",
    on_fire: Callable[[], None] | None = None,
    exit_process: Callable[[int], None] = os._exit,
) -> threading.Timer:
    """Start the guard timer; ``disarm`` cancels it. A second call replaces the first."""

    global _ARMED
    if seconds <= 0:
        raise ValueError("The watchdog delay must be positive")
    disarm()
    timer = threading.Timer(seconds, _fire, args=(seconds, label, on_fire, exit_process))
    timer.daemon = True
    timer.name = "pipeline-watchdog"
    timer.start()
    _ARMED = timer
    LOGGER.info("Watchdog armed label=%s seconds=%g", label, seconds)
    return timer


def disarm() -> None:
    global _ARMED
    if _ARMED is not None:
        _ARMED.cancel()
        _ARMED = None


def arm_from_env(
    *,
    label: str = "pipeline",
    on_fire: Callable[[], None] | None = None,
    exit_process: Callable[[int], None] = os._exit,
) -> threading.Timer | None:
    """Arm the watchdog from ``PIPELINE_WATCHDOG_SECONDS``; absent or ``0`` means no guard."""

    raw = (os.getenv(WATCHDOG_ENV) or "").strip()
    if not raw:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        LOGGER.error("%s=%r is not a number of seconds; the watchdog is NOT armed", WATCHDOG_ENV, raw)
        return None
    if seconds <= 0:
        return None
    return arm(seconds, label=label, on_fire=on_fire, exit_process=exit_process)
