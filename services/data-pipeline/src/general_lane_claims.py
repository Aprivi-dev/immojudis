"""Claims of the general enrichment lane: one in four is oldest-first.

The general lane (``claim_auction_enrichment_jobs_family``, family ``enrichment``) serves the best score: priority,
age in hours, a 24-point PDF head start and a 168-point bonus for a sale within 7 days. On 16/11/2026 it served about
115 jobs a day for about 600 in the queue, so jobs of distant sales (a PDF reading whose lease expired on 11/11, PDF
readings of 06/11) never reached its head. Since migration 20261201100000 the database also serves the same jobs by
oldest due date (family ``enrichment_oldest``). During a worker run, every ``ENRICHMENT_OLDEST_CLAIM_EVERY``-th general
claim asks for it; near sales keep three claims in four.

A database without that migration refuses the family with SQLSTATE 22023: the claim then falls back on
``ENRICHMENT_FAMILY`` for the rest of the run, so the worker and the migration can be deployed in either order.

Document readings only (family ``enrichment_pdf``, migration 20261205100000): no AI call, unlike the fact passes. The
worker claims them alone while the AI budget refuses its calls, and first in one general worker of the parallel lane.
A database without that migration refuses the family (22023): ``claim_pdf_jobs`` returns nothing and
``pdf_family_available`` is false for the rest of the run, so the worker keeps its rule of before.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextvars import ContextVar, Token

import httpx

LOGGER = logging.getLogger(__name__)

ENRICHMENT_FAMILY = "enrichment"
ENRICHMENT_OLDEST_CLAIM_FAMILY = "enrichment_oldest"
ENRICHMENT_OLDEST_CLAIM_EVERY = 4
ENRICHMENT_PDF_CLAIM_FAMILY = "enrichment_pdf"
INVALID_ARGUMENT_SQLSTATE = "22023"

# Per worker run: general claims made so far, and whether the database refused the oldest-first or the document-reading
# family. Outside a worker run (manual and direct callers), every general claim keeps the best-score order.
_WORKER_GENERAL_CLAIMS: ContextVar[dict[str, int | bool] | None] = ContextVar("worker_general_claims", default=None)

ClaimFamily = Callable[..., list[dict[str, object]]]


def start_worker_general_claims() -> Token:
    """Open the per-run claim counter; pass the token to ``end_worker_general_claims``."""
    return _WORKER_GENERAL_CLAIMS.set({"claims": 0, "oldest_refused": False, "pdf_refused": False})


def end_worker_general_claims(token: Token) -> None:
    _WORKER_GENERAL_CLAIMS.reset(token)


def claim_general_jobs(claim: ClaimFamily, *, limit: int) -> list[dict[str, object]]:
    """Claim the general lane through ``claim(family=..., limit=...)``."""
    state = _WORKER_GENERAL_CLAIMS.get()
    if state is None:
        return claim(family=ENRICHMENT_FAMILY, limit=limit)
    state["claims"] = int(state["claims"]) + 1
    if state["oldest_refused"] or int(state["claims"]) % ENRICHMENT_OLDEST_CLAIM_EVERY:
        return claim(family=ENRICHMENT_FAMILY, limit=limit)
    jobs = _claim_unless_refused(claim, state, "oldest_refused", ENRICHMENT_OLDEST_CLAIM_FAMILY, limit=limit,
                                 migration="20261201100000", instead=f"claiming {ENRICHMENT_FAMILY}")
    return claim(family=ENRICHMENT_FAMILY, limit=limit) if jobs is None else jobs


def claim_pdf_jobs(claim: ClaimFamily, *, limit: int) -> list[dict[str, object]]:
    """Claim document readings only (``enrichment_pdf``); nothing once the database refused the family in this run."""
    state = _WORKER_GENERAL_CLAIMS.get()
    if state is None:
        return claim(family=ENRICHMENT_PDF_CLAIM_FAMILY, limit=limit)
    if state["pdf_refused"]:
        return []
    jobs = _claim_unless_refused(claim, state, "pdf_refused", ENRICHMENT_PDF_CLAIM_FAMILY, limit=limit,
                                 migration="20261205100000", instead="keeping the general claims of before")
    return jobs or []


def pdf_family_available() -> bool:
    """False once the database refused ``enrichment_pdf`` during this worker run (migration not applied yet)."""
    state = _WORKER_GENERAL_CLAIMS.get()
    return state is None or not state["pdf_refused"]


def _claim_unless_refused(claim: ClaimFamily, state: dict[str, int | bool], refused_key: str, family: str, *,
                          limit: int, migration: str, instead: str) -> list[dict[str, object]] | None:
    """Claim ``family``; None (and ``state[refused_key]`` set for the rest of the run) when the database refuses it."""
    try:
        return claim(family=family, limit=limit)
    except httpx.HTTPStatusError as exc:
        if _postgrest_error_code(exc.response) != INVALID_ARGUMENT_SQLSTATE:
            raise
        state[refused_key] = True
        LOGGER.warning(
            "The database refused the %s queue family (migration %s not applied); %s for the rest of this run",
            family,
            migration,
            instead,
        )
        return None


def _postgrest_error_code(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    if isinstance(payload, dict) and payload.get("code") is not None:
        return str(payload["code"])
    return None
