"""Atomic request reservations and bounded telemetry for external LLM calls.

The reservation is created by a database RPC immediately before an external
POST.  A reservation is deliberately kept when the POST has an ambiguous
transport outcome: the request may have been accepted by the provider, so a
caller must not automatically send the same POST again.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

import httpx

from src.config import load_settings
from src.pipeline_usage import PipelineBudgetExhausted

LOGGER = logging.getLogger(__name__)

RESERVATION_KEY = "__llm_request_reservation_id"
_RPC_TIMEOUT_SECONDS = 15.0
_MAX_CONTEXT_VALUE_CHARS = 500
_CONTEXT_FIELDS = ("sale_id", "job_id", "source_url", "stage", "reason")


class LLMRequestError(PipelineBudgetExhausted):
    """Base class for request-budget failures."""


class LLMRequestBudgetExhausted(LLMRequestError):
    """The atomic hourly request budget rejected a new POST."""


class LLMRequestStorageUnavailable(LLMRequestError):
    """The configured budget storage could not be reached or used."""


class LLMRequestTransportAmbiguous(LLMRequestError):
    """A POST may have reached the provider and must not be blindly retried."""


class LLMRequestUnresolved(LLMRequestTransportAmbiguous):
    """A recent reservation with the same logical request key is unresolved."""


_REQUEST_CONTEXT: ContextVar[dict[str, str] | None] = ContextVar(
    "llm_request_context",
    default=None,
)


def _bounded_context_value(value: Any) -> str:
    return str(value).replace("\x00", " ").strip()[:_MAX_CONTEXT_VALUE_CHARS]


def _normalise_context(fields: dict[str, Any]) -> dict[str, str]:
    # Existing enrichment callers use auction_id for the canonical sale key;
    # persist it in the stable sale_id telemetry column as well.
    if fields.get("sale_id") is None and fields.get("auction_id") is not None:
        fields = {**fields, "sale_id": fields["auction_id"]}
    return {
        key: _bounded_context_value(value)
        for key, value in fields.items()
        if value is not None and _bounded_context_value(value)
    }


@contextmanager
def llm_request_context(**fields: Any) -> Iterator[dict[str, str]]:
    """Attach bounded sale/job/stage/reason fields to nested LLM requests.

    Context is task-local, so concurrent enrichment workers do not overwrite
    one another.  Nested contexts inherit outer values and override only the
    fields supplied by the inner context.
    """

    current = dict(_REQUEST_CONTEXT.get() or {})
    current.update(_normalise_context(fields))
    token = _REQUEST_CONTEXT.set(current)
    try:
        yield dict(current)
    finally:
        _REQUEST_CONTEXT.reset(token)


def current_llm_request_context() -> dict[str, str]:
    """Return the current task-local request context as a copy."""

    return dict(_REQUEST_CONTEXT.get() or {})


def _context_payload() -> dict[str, str | None]:
    context = _REQUEST_CONTEXT.get() or {}
    return {field: context.get(field) for field in _CONTEXT_FIELDS}


def _is_production_environment() -> bool:
    for name in ("VERCEL_ENV", "APP_ENV", "ENVIRONMENT", "NODE_ENV", "DEPLOY_ENV"):
        if (os.getenv(name) or "").strip().lower() in {"production", "prod"}:
            return True
    return False


def _storage_mode(settings: dict[str, Any]) -> str | None:
    if settings.get("supabase_db_url"):
        return "postgres"
    if settings.get("supabase_url") and settings.get("supabase_service_role_key"):
        return "rest"
    return None


def _storage_missing_message() -> str:
    return "LLM request budget storage is not configured"


def _require_storage(settings: dict[str, Any]) -> str | None:
    mode = _storage_mode(settings)
    if mode is None and _is_production_environment():
        raise LLMRequestStorageUnavailable(_storage_missing_message())
    return mode


def _rpc_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:  # pragma: no cover - defensive for non-JSON gateways.
        return f"HTTP {response.status_code}"
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("error") or payload.get("hint")
        if message:
            return str(message)[:500]
    return f"HTTP {response.status_code}"


def _reservation_id_from_response(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception as exc:  # pragma: no cover - gateway contract failure.
        raise LLMRequestStorageUnavailable("Budget RPC returned invalid JSON") from exc
    if isinstance(payload, str) and payload.strip():
        return payload.strip()
    if isinstance(payload, dict):
        for key in ("id", "reservation_id", "reserve_llm_request"):
            value = payload.get(key)
            if value:
                return str(value)
    if isinstance(payload, list) and len(payload) == 1:
        value = payload[0]
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            for key in ("id", "reservation_id"):
                if value.get(key):
                    return str(value[key])
    raise LLMRequestStorageUnavailable("Budget RPC returned no reservation id")


def _reserve_payload(
    *,
    provider: str,
    model: str,
    request_kind: str,
    attempt_number: int,
    max_calls_per_hour: int,
    request_key: str | None,
) -> dict[str, Any]:
    context = _context_payload()
    return {
        "p_provider": provider,
        "p_model": model,
        "p_request_kind": request_kind,
        "p_attempt_number": max(1, int(attempt_number)),
        "p_max_calls_per_hour": max(0, int(max_calls_per_hour)),
        "p_request_key": request_key,
        **{f"p_{field}": value for field, value in context.items()},
    }


def _reserve_via_rest(settings: dict[str, Any], payload: dict[str, Any]) -> str:
    base_url = str(settings["supabase_url"]).rstrip("/")
    api_key = str(settings["supabase_service_role_key"])
    response = httpx.post(
        f"{base_url}/rest/v1/rpc/reserve_llm_request",
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=_RPC_TIMEOUT_SECONDS,
    )
    if response.status_code >= 400:
        message = _rpc_error_message(response)
        if "unresolved" in message.lower() or "reconciliation" in message.lower():
            raise LLMRequestUnresolved(message)
        if "budget" in message.lower() or "hourly" in message.lower():
            raise LLMRequestBudgetExhausted(message)
        raise LLMRequestStorageUnavailable(f"Budget RPC failed: {message}")
    return _reservation_id_from_response(response)


def _reserve_via_postgres(settings: dict[str, Any], payload: dict[str, Any]) -> str:
    # Reuse the repository's bounded connection helper without changing its
    # storage module or introducing another database dependency.
    from src.storage.supabase_client import _postgres_connect

    parameters = tuple(payload[key] for key in (
        "p_provider",
        "p_model",
        "p_request_kind",
        "p_attempt_number",
        "p_max_calls_per_hour",
        "p_request_key",
        "p_sale_id",
        "p_job_id",
        "p_source_url",
        "p_stage",
        "p_reason",
    ))
    try:
        with _postgres_connect(str(settings["supabase_db_url"])) as connection:
            row = connection.execute(
                """
                select public.reserve_llm_request(
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                parameters,
            ).fetchone()
    except Exception as exc:
        message = str(exc)
        if "unresolved" in message.lower() or "reconciliation" in message.lower():
            raise LLMRequestUnresolved(message) from exc
        if "budget" in message.lower() or "hourly" in message.lower():
            raise LLMRequestBudgetExhausted(message) from exc
        raise LLMRequestStorageUnavailable("Budget RPC failed") from exc
    if not row or not row[0]:
        raise LLMRequestStorageUnavailable("Budget RPC returned no reservation id")
    return str(row[0])


def reserve_llm_request(
    *,
    provider: str,
    model: str,
    request_kind: str,
    attempt_number: int,
    max_calls_per_hour: int,
    request_key: str | None = None,
) -> str | None:
    """Atomically reserve one external POST immediately before sending it.

    Development and unit-test runs without configured storage retain the
    historical local behavior.  Production runs fail closed when storage is
    missing; any configured storage failure also blocks the POST.
    """

    settings = load_settings()
    mode = _require_storage(settings)
    if mode is None:
        return None
    payload = _reserve_payload(
        provider=provider,
        model=model,
        request_kind=request_kind,
        attempt_number=attempt_number,
        max_calls_per_hour=max_calls_per_hour,
        request_key=request_key,
    )
    if mode == "postgres":
        return _reserve_via_postgres(settings, payload)
    return _reserve_via_rest(settings, payload)


def _finalize_payload(
    reservation_id: str,
    *,
    status: str,
    prediction_id: str | None = None,
    succeeded: bool = False,
    prompt_chars: int | None = None,
    system_prompt_chars: int | None = None,
    output_chars: int | None = None,
    input_tokens_estimate: int | None = None,
    output_tokens_estimate: int | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    return {
        "p_request_id": reservation_id,
        "p_request_status": status,
        "p_prediction_id": prediction_id,
        "p_succeeded": bool(succeeded),
        "p_prompt_chars": prompt_chars,
        "p_system_prompt_chars": system_prompt_chars,
        "p_output_chars": output_chars,
        "p_input_tokens_estimate": input_tokens_estimate,
        "p_output_tokens_estimate": output_tokens_estimate,
        "p_error_message": (error_message or "")[:1000] or None,
    }


def _finalize_via_rest(settings: dict[str, Any], payload: dict[str, Any]) -> None:
    base_url = str(settings["supabase_url"]).rstrip("/")
    api_key = str(settings["supabase_service_role_key"])
    response = httpx.post(
        f"{base_url}/rest/v1/rpc/finalize_llm_request",
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=_RPC_TIMEOUT_SECONDS,
    )
    response.raise_for_status()


def _finalize_via_postgres(settings: dict[str, Any], payload: dict[str, Any]) -> None:
    from src.storage.supabase_client import _postgres_connect

    parameters = tuple(payload[key] for key in (
        "p_request_id",
        "p_request_status",
        "p_prediction_id",
        "p_succeeded",
        "p_prompt_chars",
        "p_system_prompt_chars",
        "p_output_chars",
        "p_input_tokens_estimate",
        "p_output_tokens_estimate",
        "p_error_message",
    ))
    with _postgres_connect(str(settings["supabase_db_url"])) as connection:
        connection.execute(
            """
            select public.finalize_llm_request(
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            parameters,
        )


def record_llm_request(
    reservation_id: str | None,
    *,
    status: str,
    prediction_id: str | None = None,
    succeeded: bool = False,
    prompt_chars: int | None = None,
    system_prompt_chars: int | None = None,
    output_chars: int | None = None,
    input_tokens_estimate: int | None = None,
    output_tokens_estimate: int | None = None,
    error_message: str | None = None,
) -> None:
    """Finalize one reservation without allowing telemetry to mask a result."""

    if not reservation_id:
        return
    settings = load_settings()
    mode = _storage_mode(settings)
    if mode is None:
        return
    payload = _finalize_payload(
        str(reservation_id),
        status=status,
        prediction_id=prediction_id,
        succeeded=succeeded,
        prompt_chars=prompt_chars,
        system_prompt_chars=system_prompt_chars,
        output_chars=output_chars,
        input_tokens_estimate=input_tokens_estimate,
        output_tokens_estimate=output_tokens_estimate,
        error_message=error_message,
    )
    try:
        if mode == "postgres":
            _finalize_via_postgres(settings, payload)
        else:
            _finalize_via_rest(settings, payload)
    except Exception as exc:
        LOGGER.warning("Could not persist LLM request telemetry: %s", exc)


def finalize_llm_request(
    reservation_id: str | None,
    *,
    status: str,
    prediction_id: str | None = None,
    succeeded: bool = False,
    prompt_chars: int | None = None,
    system_prompt_chars: int | None = None,
    output_chars: int | None = None,
    input_tokens_estimate: int | None = None,
    output_tokens_estimate: int | None = None,
    error_message: str | None = None,
) -> None:
    """Named alias for callers that prefer an explicit finalization verb."""

    record_llm_request(
        reservation_id,
        status=status,
        prediction_id=prediction_id,
        succeeded=succeeded,
        prompt_chars=prompt_chars,
        system_prompt_chars=system_prompt_chars,
        output_chars=output_chars,
        input_tokens_estimate=input_tokens_estimate,
        output_tokens_estimate=output_tokens_estimate,
        error_message=error_message,
    )


def release_llm_request(reservation_id: str | None, *, reason: str) -> None:
    """Release a reservation when another local guard prevents the POST."""

    record_llm_request(reservation_id, status="released", error_message=reason)
