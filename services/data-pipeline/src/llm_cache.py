"""Durable, content-addressed storage for validated LLM results.

The extraction worker is responsible for validating a result before calling
this module.  This module stores only that result and never receives or
persists the prompt that produced it.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from src.config import load_settings
from src.pipeline_usage import PipelineBudgetExhausted

LOGGER = logging.getLogger(__name__)

_CACHE_TABLE = "llm_analysis_cache"
_CACHE_TIMEOUT_SECONDS = 30.0
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class LLMCacheUnavailable(PipelineBudgetExhausted):
    """The configured durable cache could not be read or written.

    This is a budget exhaustion subtype so queue workers defer the job instead
    of spending another provider request while cache state is unavailable.
    """


def load_cached_result(cache_key: str, *, stage: str) -> dict[str, Any] | None:
    """Load one validated result from the service-role cache.

    Missing Supabase credentials intentionally disable the durable cache and
    return a miss without making a network request.  Once the cache is
    configured, every transport, HTTP, or malformed-response error is raised
    as :class:`LLMCacheUnavailable` so callers fail closed.
    """

    normalized_key, normalized_stage = _validate_lookup_arguments(cache_key, stage)
    credentials = _cache_credentials()
    if credentials is None:
        return None
    supabase_url, service_role_key = credentials
    endpoint = _cache_endpoint(supabase_url)

    try:
        response = httpx.get(
            endpoint,
            params={
                "select": "result",
                "cache_key": f"eq.{normalized_key}",
                "stage": f"eq.{normalized_stage}",
                "limit": "1",
            },
            headers=_rest_headers(service_role_key),
            timeout=_CACHE_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        raise _unavailable("read", cause=exc) from exc

    if not _is_success(response):
        raise _unavailable("read", status_code=_status_code(response))

    try:
        rows = response.json()
    except Exception as exc:
        raise _unavailable("read malformed response", cause=exc) from exc
    if not isinstance(rows, list):
        raise _unavailable("read malformed response")
    if not rows:
        return None

    row = rows[0]
    result = row.get("result") if isinstance(row, dict) else None
    if not isinstance(result, dict):
        raise _unavailable("read malformed result")
    return result


def save_cached_result(
    cache_key: str,
    payload: dict[str, Any],
    *,
    stage: str,
    model: str,
) -> None:
    """Upsert one validated result into the service-role cache.

    The caller retains the validated result locally if this write fails; the
    write error is surfaced so the queue can retry persistence later.
    """

    normalized_key, normalized_stage = _validate_lookup_arguments(cache_key, stage)
    if not isinstance(payload, dict):
        raise TypeError("payload must be a dict")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model must be a non-empty string")

    credentials = _cache_credentials()
    if credentials is None:
        return
    supabase_url, service_role_key = credentials
    endpoint = _cache_endpoint(supabase_url)
    request_payload = {
        "cache_key": normalized_key,
        "stage": normalized_stage,
        "result": payload,
        "model": model,
    }

    try:
        response = httpx.post(
            endpoint,
            params={"on_conflict": "cache_key,stage"},
            headers=_rest_headers(
                service_role_key,
                prefer="resolution=merge-duplicates,return=minimal",
            ),
            json=request_payload,
            timeout=_CACHE_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        raise _unavailable("write", cause=exc) from exc

    if not _is_success(response):
        raise _unavailable("write", status_code=_status_code(response))


def _cache_credentials() -> tuple[str, str] | None:
    settings = load_settings()
    url = str(settings.get("supabase_url") or "").strip()
    service_role_key = str(settings.get("supabase_service_role_key") or "").strip()
    if not url or not service_role_key:
        return None
    return url, service_role_key


def _cache_endpoint(supabase_url: str) -> str:
    return f"{supabase_url.rstrip('/')}/rest/v1/{_CACHE_TABLE}"


def _rest_headers(service_role_key: str, *, prefer: str | None = None) -> dict[str, str]:
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _validate_lookup_arguments(cache_key: str, stage: str) -> tuple[str, str]:
    if not isinstance(cache_key, str) or not _SHA256_RE.fullmatch(cache_key):
        raise ValueError("cache_key must be a lowercase SHA-256 hex digest")
    if not isinstance(stage, str) or not stage.strip() or len(stage) > 128:
        raise ValueError("stage must be a non-empty string of at most 128 characters")
    if any(ord(character) < 32 for character in stage):
        raise ValueError("stage must not contain control characters")
    return cache_key, stage


def _is_success(response: Any) -> bool:
    status_code = _status_code(response)
    return 200 <= status_code < 300


def _status_code(response: Any) -> int:
    status_code = getattr(response, "status_code", None)
    return status_code if isinstance(status_code, int) else 0


def _unavailable(
    operation: str,
    *,
    status_code: int | None = None,
    cause: Exception | None = None,
) -> LLMCacheUnavailable:
    detail = f"HTTP {status_code}" if status_code else cause.__class__.__name__ if cause else "invalid response"
    return LLMCacheUnavailable(f"LLM durable cache {operation} unavailable ({detail})")
