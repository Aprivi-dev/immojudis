from __future__ import annotations

from collections.abc import Callable


def finish_job(
    job: dict[str, object],
    *,
    finish_impl: Callable[..., bool],
    **kwargs: object,
) -> bool:
    """Finish only the claimed attempt and report whether CAS matched it."""
    # A worker whose lease expired must not finish a later worker's attempt.
    if job.get("attempt_count") is not None:
        kwargs["attempt_count"] = int(job["attempt_count"])
    if job.get("locked_at") is not None:
        kwargs["locked_at"] = job["locked_at"]
    return finish_impl(str(job.get("id") or ""), **kwargs)
