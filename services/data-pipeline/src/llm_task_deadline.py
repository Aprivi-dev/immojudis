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


# Whether a new prediction must also leave the time to read its answer before the deadline. Only a scope that
# bounds a whole pass asks for it (see :func:`llm_task_deadline_scope`).
_LLM_ANSWER_TIME_REQUIRED: ContextVar[bool] = ContextVar(
    "llm_answer_time_required",
    default=False,
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
def llm_task_deadline_scope(deadline: float | None, *, require_answer_time: bool = False) -> Iterator[None]:
    """Install an absolute monotonic deadline for the current LLM task.

    ``require_answer_time`` is for a deadline that ends a whole pass of many predictions (the queue worker):
    a prediction is then not started when too little time is left to read its answer, because Replicate
    would compute and bill it for nothing. A scope that is the budget of ONE call (the document reading's
    90 s, the information agent's 25 s) must not ask for it: its call starts with the whole budget and would
    be refused every time (production, 09-10/11/2026: no document reading completed).
    """

    token: Token[float | None] = _LLM_TASK_DEADLINE.set(
        float(deadline) if deadline is not None else None
    )
    answer_token: Token[bool] = _LLM_ANSWER_TIME_REQUIRED.set(bool(require_answer_time) and deadline is not None)
    try:
        yield
    finally:
        _LLM_ANSWER_TIME_REQUIRED.reset(answer_token)
        _LLM_TASK_DEADLINE.reset(token)


def llm_answer_time_required() -> bool:
    """Whether the active scope asks that a prediction be started only with the time to read its answer."""

    return _LLM_ANSWER_TIME_REQUIRED.get()


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
    "llm_answer_time_required",
    "llm_task_bounded_timeout",
    "llm_task_deadline_remaining",
    "llm_task_deadline_scope",
]
