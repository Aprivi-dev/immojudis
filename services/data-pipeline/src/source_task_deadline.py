"""Task-local cooperative deadline helpers for source-detail work.

The queue worker shares provider clients between sequential source-detail jobs.
Keeping the deadline in a context variable, rather than on a client instance,
prevents one job's deadline from leaking into the next job.  Callers outside a
source-detail scope observe no deadline and retain their existing behaviour.
"""
from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

_SOURCE_TASK_DEADLINE: ContextVar[float | None] = ContextVar(
    "source_task_deadline",
    default=None,
)


class SourceTaskDeadlineExceeded(RuntimeError):
    """Raised when a source-detail operation may no longer start safely."""

    def __init__(
        self,
        operation: str,
        *,
        deadline: float | None = None,
        remaining: float | None = None,
    ) -> None:
        self.operation = operation
        self.deadline = deadline
        self.remaining = remaining
        super().__init__(f"Source-detail task deadline reached during {operation}")


@contextmanager
def source_task_deadline_scope(deadline: float | None) -> Iterator[None]:
    """Install a source-detail deadline for the current synchronous task."""

    token: Token[float | None] = _SOURCE_TASK_DEADLINE.set(
        float(deadline) if deadline is not None else None
    )
    try:
        yield
    finally:
        _SOURCE_TASK_DEADLINE.reset(token)


def source_task_deadline_remaining() -> float | None:
    """Return seconds remaining, or ``None`` when no source deadline is active."""

    deadline = _SOURCE_TASK_DEADLINE.get()
    if deadline is None:
        return None
    return deadline - time.monotonic()


def ensure_source_task_deadline(operation: str) -> float | None:
    """Return remaining seconds or raise before an operation starts."""

    deadline = _SOURCE_TASK_DEADLINE.get()
    if deadline is None:
        return None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SourceTaskDeadlineExceeded(
            operation,
            deadline=deadline,
            remaining=remaining,
        )
    return remaining


def source_task_bounded_timeout(timeout: float, operation: str) -> float:
    """Bound an HTTP timeout by the active source-detail deadline."""

    requested = max(0.001, float(timeout))
    remaining = ensure_source_task_deadline(operation)
    if remaining is None:
        return requested
    return min(requested, remaining)


__all__ = [
    "SourceTaskDeadlineExceeded",
    "ensure_source_task_deadline",
    "source_task_bounded_timeout",
    "source_task_deadline_remaining",
    "source_task_deadline_scope",
]
