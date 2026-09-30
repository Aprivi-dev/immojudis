"""Cooperative task-local deadlines for LLM enrichment work.

The queue worker shares a Replicate client between sequential enrichment jobs.
Keeping the cutoff in a context variable prevents one job's deadline from
leaking into the next job while allowing every provider operation in the
current task to observe the same monotonic boundary.
"""
from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

from src.pipeline_usage import QueueJobDeferred

_LLM_TASK_DEADLINE: ContextVar[float | None] = ContextVar(
    "llm_task_deadline",
    default=None,
)


class LLMTaskDeadlineExceeded(QueueJobDeferred):
    """Raised when an LLM operation may no longer start safely."""

    def __init__(
        self,
        operation: str,
        *,
        deadline: float | None = None,
        remaining: float | None = None,
    ) -> None:
        self.operation = operation
        self.deadline = _LLM_TASK_DEADLINE.get() if deadline is None else deadline
        self.remaining = remaining
        super().__init__(f"LLM task deadline reached during {operation}")


@contextmanager
def llm_task_deadline_scope(deadline: float | None) -> Iterator[None]:
    """Install an absolute monotonic deadline for the current LLM task."""

    token: Token[float | None] = _LLM_TASK_DEADLINE.set(
        float(deadline) if deadline is not None else None
    )
    try:
        yield
    finally:
        _LLM_TASK_DEADLINE.reset(token)


def llm_task_deadline_remaining() -> float | None:
    """Return seconds remaining, or ``None`` outside an active task scope."""

    deadline = _LLM_TASK_DEADLINE.get()
    if deadline is None:
        return None
    return deadline - time.monotonic()


def ensure_llm_task_deadline(operation: str) -> float | None:
    """Return remaining seconds or raise before an operation starts."""

    deadline = _LLM_TASK_DEADLINE.get()
    if deadline is None:
        return None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise LLMTaskDeadlineExceeded(
            operation,
            deadline=deadline,
            remaining=remaining,
        )
    return remaining


def llm_task_bounded_timeout(timeout: float, operation: str) -> float:
    """Bound a provider timeout by the active task deadline."""

    requested = max(0.001, float(timeout))
    remaining = ensure_llm_task_deadline(operation)
    if remaining is None:
        return requested
    return min(requested, remaining)


__all__ = [
    "LLMTaskDeadlineExceeded",
    "ensure_llm_task_deadline",
    "llm_task_bounded_timeout",
    "llm_task_deadline_remaining",
    "llm_task_deadline_scope",
]
