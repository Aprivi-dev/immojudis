from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

import httpx

from src.config import load_settings
from src.llm_requests import (
    RESERVATION_KEY,
    LLMRequestTransportAmbiguous,
    current_llm_request_context,
    record_llm_request,
    release_llm_request,
    reserve_llm_request,
)
from src.pipeline_usage import record_prediction, reserve_prediction

LOGGER = logging.getLogger(__name__)
RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
_LAST_REPLICATE_REQUEST_AT = 0.0
_REPLICATE_REQUEST_LOCK = threading.Lock()
_REQUEST_METADATA: ContextVar[dict[str, Any] | None] = ContextVar("replicate_request_metadata", default=None)


class LLMClientUnavailable(RuntimeError):
    pass


@dataclass
class ReplicateClient:
    api_token: str | None = None
    model: str | None = None
    timeout_seconds: float | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    wait_seconds: int | None = None
    cancel_after: str | None = None
    max_retries: int | None = None
    retry_backoff_seconds: float | None = None
    retry_max_sleep_seconds: float | None = None
    min_interval_seconds: float | None = None
    thinking_budget: int | None = None
    dynamic_thinking: bool | None = None
    thinking_level: str | None = None
    fact_max_tokens: int | None = None

    def __post_init__(self) -> None:
        settings = load_settings()
        self.api_token = self.api_token or settings["replicate_api_token"]
        self.model = self.model or str(settings["replicate_model"])
        self.timeout_seconds = self.timeout_seconds or float(settings["replicate_timeout_seconds"])
        self.max_tokens = self.max_tokens or int(settings["replicate_max_tokens"])
        self.temperature = self.temperature if self.temperature is not None else float(settings["replicate_temperature"])
        self.wait_seconds = self.wait_seconds or int(settings["replicate_wait_seconds"])
        self.cancel_after = self.cancel_after or str(settings["replicate_cancel_after"])
        self.max_retries = self.max_retries if self.max_retries is not None else int(settings["replicate_max_retries"])
        self.retry_backoff_seconds = (
            self.retry_backoff_seconds
            if self.retry_backoff_seconds is not None
            else float(settings["replicate_retry_backoff_seconds"])
        )
        self.retry_max_sleep_seconds = (
            self.retry_max_sleep_seconds
            if self.retry_max_sleep_seconds is not None
            else float(settings["replicate_retry_max_sleep_seconds"])
        )
        self.min_interval_seconds = (
            self.min_interval_seconds
            if self.min_interval_seconds is not None
            else float(settings["replicate_min_interval_seconds"])
        )
        self.thinking_budget = self.thinking_budget if self.thinking_budget is not None else int(settings["replicate_thinking_budget"])
        self.dynamic_thinking = (
            self.dynamic_thinking
            if self.dynamic_thinking is not None
            else bool(settings["replicate_dynamic_thinking"])
        )
        self.thinking_level = self.thinking_level or str(settings.get("replicate_thinking_level") or "low")
        self.fact_max_tokens = (
            self.fact_max_tokens
            if self.fact_max_tokens is not None
            else int(settings.get("replicate_fact_max_tokens") or self.max_tokens or 512)
        )

    def is_available(self) -> bool:
        return bool(self.api_token and self.model)

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        if not self.api_token:
            raise LLMClientUnavailable("REPLICATE_API_TOKEN is missing")
        last_error: Exception | None = None
        prompt = _user_prompt_for_model(str(self.model), system_prompt, user_prompt)
        attempts = 1 if _is_display_description_prompt(system_prompt) else 2
        for attempt in range(attempts):
            prediction: dict[str, Any] | None = None
            raw_response: str | None = None
            try:
                prediction = self._create_prediction(prompt, system_prompt=system_prompt)
                output = self._wait_for_output(prediction)
                raw_response = _stringify_output(output)
                parsed = parse_json_response(raw_response)
                self._record_usage(
                    prediction,
                    request_kind="display_description" if _is_display_description_prompt(system_prompt) else "fact_extraction",
                    attempt_number=attempt + 1,
                    prompt_chars=len(prompt),
                    system_prompt_chars=len(system_prompt),
                    output_chars=len(raw_response),
                    succeeded=True,
                )
                return parsed
            except Exception as exc:
                # Budget/storage failures and transport failures occur before a
                # new prediction is available.  They must not be recorded as a
                # paid model attempt or counted against the hourly budget.
                if prediction is not None:
                    self._record_usage(
                        prediction,
                        request_kind="display_description" if _is_display_description_prompt(system_prompt) else "fact_extraction",
                        attempt_number=attempt + 1,
                        prompt_chars=len(prompt),
                        system_prompt_chars=len(system_prompt),
                        output_chars=len(raw_response or ""),
                        succeeded=False,
                        error_message=str(exc),
                        exception=exc,
                    )
                if not isinstance(exc, ValueError):
                    raise
                fallback = (
                    _display_description_payload_from_text(system_prompt, raw_response or "")
                    if raw_response is not None
                    else None
                )
                if fallback is not None:
                    return fallback
                last_error = exc
                if attempt + 1 >= attempts:
                    break
                prompt = _user_prompt_for_model(
                    str(self.model),
                    system_prompt,
                    f"{user_prompt}\n\nTa réponse précédente n'était pas du JSON valide. "
                    "Réponds uniquement avec un objet JSON valide. Le premier caractère doit être { "
                    "et le dernier caractère doit être }. Aucun markdown, aucun commentaire.",
                )
        retry_label = "after retry" if attempts > 1 else "without retry"
        raise ValueError(f"Replicate returned invalid JSON {retry_label}: {last_error}")

    def _record_usage(
        self,
        prediction: dict[str, Any],
        *,
        request_kind: str,
        attempt_number: int,
        prompt_chars: int,
        system_prompt_chars: int,
        output_chars: int,
        succeeded: bool,
        error_message: str | None = None,
        exception: Exception | None = None,
    ) -> None:
        # Import lazily to avoid coupling the HTTP client to storage at import time.
        reservation_id = prediction.get(RESERVATION_KEY)
        # For real HTTP requests the reservation row is the telemetry row.  A
        # mocked _create_prediction in local tests has no reservation and keeps
        # the old best-effort event path for backwards compatibility.
        if reservation_id:
            input_chars = (
                prompt_chars + system_prompt_chars
                if _is_gemini_model(str(self.model or "")) or _is_qwen_model(str(self.model or ""))
                else prompt_chars
            )
            record_llm_request(
                str(reservation_id),
                status=(
                    "succeeded"
                    if succeeded
                    else _request_failure_status(
                        prediction,
                        exception=exception,
                        output_chars=output_chars,
                    )
                ),
                prediction_id=prediction.get("id"),
                succeeded=succeeded,
                prompt_chars=prompt_chars,
                system_prompt_chars=system_prompt_chars,
                output_chars=output_chars,
                input_tokens_estimate=max(0, round(input_chars / 4)),
                output_tokens_estimate=max(0, round(output_chars / 4)),
                error_message=error_message,
            )
            return

        from src.storage.supabase_client import record_llm_usage_event

        context = current_llm_request_context()
        event = {
            "provider": "replicate",
            "model": str(self.model or ""),
            "prediction_id": prediction.get("id"),
            "request_kind": request_kind,
            "attempt_number": attempt_number,
            "prompt_chars": prompt_chars,
            "system_prompt_chars": system_prompt_chars,
            "output_chars": output_chars,
            "input_tokens_estimate": max(
                0,
                round(
                    (
                        prompt_chars + system_prompt_chars
                        if _is_gemini_model(str(self.model or "")) or _is_qwen_model(str(self.model or ""))
                        else prompt_chars
                    )
                    / 4
                ),
            ),
            "output_tokens_estimate": max(0, round(output_chars / 4)),
            "succeeded": succeeded,
            "error_message": (error_message or "")[:1000] or None,
            **{key: context[key] for key in ("sale_id", "job_id", "source_url", "stage", "reason") if key in context},
        }
        record_llm_usage_event(event)

    def _create_prediction(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        owner, model_name = _split_replicate_model(str(self.model))
        model_reference = str(self.model)
        versioned_model = _replicate_model_version(model_reference)
        endpoint = (
            "https://api.replicate.com/v1/predictions"
            if versioned_model
            else f"https://api.replicate.com/v1/models/{owner}/{model_name}/predictions"
        )
        headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
            "Prefer": f"wait={min(int(self.wait_seconds or 60), 60)}",
            "Cancel-After": str(self.cancel_after),
        }
        payload = {"input": self._input_payload(prompt, system_prompt=system_prompt)}
        if versioned_model:
            # Community models are called through the versioned predictions
            # endpoint. Pinning the version also protects the scan output from
            # an upstream model image changing without notice.
            payload["version"] = model_reference
        metadata_token = _REQUEST_METADATA.set(
            {
                "request_kind": "display_description"
                if _is_display_description_prompt(system_prompt or "")
                else "fact_extraction",
                "prompt_chars": len(prompt),
                "system_prompt_chars": len(system_prompt or ""),
            }
        )
        try:
            response = self._post_with_retries(endpoint, headers=headers, payload=payload)
        finally:
            _REQUEST_METADATA.reset(metadata_token)
        try:
            prediction = response.json()
        except Exception as exc:
            record_llm_request(
                getattr(response, "_llm_request_reservation_id", None),
                status="ambiguous",
                prompt_chars=len(prompt),
                system_prompt_chars=len(system_prompt or ""),
                error_message=str(exc),
            )
            raise LLMRequestTransportAmbiguous(
                "Replicate returned an unreadable successful response; provider reconciliation is required"
            ) from exc
        if not _prediction_payload_is_complete(prediction):
            error = RuntimeError("Replicate prediction response is missing its id, status or polling URL")
            record_llm_request(
                getattr(response, "_llm_request_reservation_id", None),
                status="ambiguous",
                prompt_chars=len(prompt),
                system_prompt_chars=len(system_prompt or ""),
                error_message=str(error),
            )
            raise LLMRequestTransportAmbiguous(
                "Replicate returned an incomplete successful response; provider reconciliation is required"
            ) from error
        reservation_id = getattr(response, "_llm_request_reservation_id", None)
        if reservation_id:
            prediction[RESERVATION_KEY] = reservation_id
        return prediction

    def _post_with_retries(self, endpoint: str, headers: dict[str, str], payload: dict[str, Any]) -> httpx.Response:
        attempts = max(1, int(self.max_retries or 1))
        last_response: httpx.Response | None = None
        settings = load_settings()
        metadata = _REQUEST_METADATA.get() or {}
        request_kind = str(metadata.get("request_kind") or "fact_extraction")
        prompt_chars = int(metadata.get("prompt_chars") or 0)
        system_prompt_chars = int(metadata.get("system_prompt_chars") or 0)
        for attempt in range(1, attempts + 1):
            self._respect_min_interval()
            reservation_id = reserve_llm_request(
                provider="replicate",
                model=str(self.model),
                request_kind=request_kind,
                attempt_number=attempt,
                max_calls_per_hour=int(settings.get("replicate_max_calls_per_hour") or 0),
                request_key=_request_key_for_payload(str(self.model), payload),
            )
            reservation = None
            try:
                # Keep the autonomous run budget in place.  If it rejects this
                # request, release the hourly reservation because no POST was
                # sent and therefore no external call was consumed.
                reservation = reserve_prediction(str(self.model))
            except Exception as exc:
                release_llm_request(reservation_id, reason=f"autonomous reservation rejected: {exc}")
                raise
            try:
                response = httpx.post(
                    endpoint,
                    headers=headers,
                    json=payload,
                    timeout=float(self.timeout_seconds or 180),
                )
                self._mark_request_finished()
            except httpx.TransportError as exc:
                self._mark_request_finished()
                record_llm_request(
                    reservation_id,
                    status="ambiguous",
                    prompt_chars=prompt_chars,
                    system_prompt_chars=system_prompt_chars,
                    error_message=str(exc),
                )
                raise LLMRequestTransportAmbiguous(
                    "Replicate POST transport outcome is ambiguous; manual/provider reconciliation is required"
                ) from exc

            response._llm_request_reservation_id = reservation_id
            if response.status_code == 429:
                record_llm_request(
                    reservation_id,
                    status="rate_limited",
                    prompt_chars=prompt_chars,
                    system_prompt_chars=system_prompt_chars,
                    error_message=_response_error_message(response),
                )
                last_response = response
                sleep_seconds = _retry_sleep_seconds(
                    attempt=attempt,
                    response=response,
                    backoff_seconds=float(self.retry_backoff_seconds or 20),
                    max_sleep_seconds=float(self.retry_max_sleep_seconds or 180),
                )
                LOGGER.warning(
                    "Replicate returned 429; retrying in %.1fs (%s/%s)",
                    sleep_seconds,
                    attempt,
                    attempts,
                )
            else:
                if response.status_code >= 400:
                    record_llm_request(
                        reservation_id,
                        status=_response_request_status(response.status_code),
                        prompt_chars=prompt_chars,
                        system_prompt_chars=system_prompt_chars,
                        error_message=_response_error_message(response),
                    )
                    response.raise_for_status()
                try:
                    response_payload = response.json()
                except Exception as exc:
                    record_llm_request(
                        reservation_id,
                        status="ambiguous",
                        prompt_chars=prompt_chars,
                        system_prompt_chars=system_prompt_chars,
                        error_message=str(exc),
                    )
                    raise LLMRequestTransportAmbiguous(
                        "Replicate returned an unreadable successful response; provider reconciliation is required"
                    ) from exc
                if not _prediction_payload_is_complete(response_payload):
                    error = RuntimeError("Replicate prediction response is missing its id, status or polling URL")
                    record_llm_request(
                        reservation_id,
                        status="ambiguous",
                        prompt_chars=prompt_chars,
                        system_prompt_chars=system_prompt_chars,
                        error_message=str(error),
                    )
                    raise LLMRequestTransportAmbiguous(
                        "Replicate returned an incomplete successful response; provider reconciliation is required"
                    ) from error
                record_llm_request(
                    reservation_id,
                    status="reserved",
                    prediction_id=str(response_payload.get("id")),
                    prompt_chars=prompt_chars,
                    system_prompt_chars=system_prompt_chars,
                )
                record_prediction(response_payload, reservation=reservation)
                return response
            if attempt < attempts:
                time.sleep(sleep_seconds)
        if last_response is not None:
            last_response.raise_for_status()
        raise RuntimeError("Replicate request failed without response")

    def _respect_min_interval(self) -> None:
        global _LAST_REPLICATE_REQUEST_AT
        min_interval = float(self.min_interval_seconds or 0)
        if min_interval <= 0:
            return
        with _REPLICATE_REQUEST_LOCK:
            now = time.monotonic()
            wait_for = _LAST_REPLICATE_REQUEST_AT + min_interval - now
            if wait_for > 0:
                time.sleep(wait_for)
                now = time.monotonic()
            _LAST_REPLICATE_REQUEST_AT = now

    def _mark_request_finished(self) -> None:
        # The limiter spaces prediction starts, not completions. With Replicate's
        # synchronous wait header, updating the timestamp here would add model
        # latency on top of the configured interval for every backfill item.
        return

    def _input_payload(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        max_tokens = self._max_tokens_for_prompt(system_prompt)
        if _is_gemini_model(str(self.model)):
            payload = {
                "prompt": prompt,
                "system_instruction": system_prompt or "",
                "temperature": float(self.temperature if self.temperature is not None else 0),
                "top_p": 1,
                "max_output_tokens": int(max_tokens or 8192),
            }
            if _is_gemini_3_model(str(self.model)):
                payload["thinking_level"] = (
                    self.thinking_level if self.thinking_level in {"none", "low", "high"} else "low"
                )
            else:
                payload["thinking_budget"] = int(self.thinking_budget or 0)
                payload["dynamic_thinking"] = bool(self.dynamic_thinking)
            return payload
        if _is_qwen2_7b_instruct_model(str(self.model)):
            return {
                "prompt": prompt,
                "system_prompt": system_prompt or "",
                "model_type": "Qwen2-7B-Instruct",
                "max_new_tokens": min(int(max_tokens or 512), 32768),
                # This Cog model validates temperature with a minimum of 0.1.
                "temperature": max(
                    0.1,
                    float(self.temperature if self.temperature is not None else 0.1),
                ),
                "top_k": 1,
                "top_p": 1,
                "repetition_penalty": 1,
            }
        if _is_qwen_model(str(self.model)):
            return {
                "prompt": prompt,
                "system_prompt": system_prompt or "",
                "max_tokens": int(max_tokens or 8192),
                "temperature": float(self.temperature if self.temperature is not None else 0),
                "top_p": 0.8,
                "presence_penalty": 0,
                "frequency_penalty": 0,
            }
        return {
            "prompt": prompt,
            "max_tokens": int(max_tokens or 4096),
            "temperature": float(self.temperature if self.temperature is not None else 0.1),
            "top_p": 1,
            "presence_penalty": 0,
            "frequency_penalty": 0,
        }

    def _max_tokens_for_prompt(self, system_prompt: str | None) -> int:
        if system_prompt and _is_fact_extraction_prompt(system_prompt):
            return int(self.fact_max_tokens or self.max_tokens or 512)
        return int(self.max_tokens or 512)

    def _wait_for_output(self, prediction: dict[str, Any]) -> Any:
        record_prediction(prediction)
        status = prediction.get("status")
        if status == "succeeded":
            return prediction.get("output")
        if status in {"failed", "canceled", "aborted"}:
            raise RuntimeError(f"Replicate prediction {status}: {prediction.get('error')}")

        get_url = prediction.get("urls", {}).get("get")
        if not get_url:
            raise RuntimeError("Replicate prediction did not include a polling URL")
        timeout_at = time.monotonic() + float(self.timeout_seconds or 180)
        with httpx.Client(timeout=20) as client:
            while status not in {"succeeded", "failed", "canceled", "aborted"}:
                if time.monotonic() > timeout_at:
                    raise LLMRequestTransportAmbiguous(
                        "Replicate prediction polling timed out; provider reconciliation is required"
                    )
                time.sleep(2)
                try:
                    response = client.get(get_url, headers={"Authorization": f"Bearer {self.api_token}"})
                    response.raise_for_status()
                    polled_prediction = response.json()
                except LLMRequestTransportAmbiguous:
                    raise
                except (httpx.HTTPError, TimeoutError, ValueError) as exc:
                    raise LLMRequestTransportAmbiguous(
                        "Replicate prediction polling outcome is ambiguous; provider reconciliation is required"
                    ) from exc
                if not isinstance(polled_prediction, dict):
                    raise LLMRequestTransportAmbiguous(
                        "Replicate prediction polling response is incomplete; provider reconciliation is required"
                    )
                # Keep the reservation id and expose a confirmed terminal
                # status to generate_json, while retaining the original
                # prediction object used by its telemetry finalizer.
                prediction.update(polled_prediction)
                if prediction.get("status") in {"succeeded", "failed", "canceled", "aborted"}:
                    record_prediction(prediction)
                status = prediction.get("status")
            if status != "succeeded":
                raise RuntimeError(f"Replicate prediction {status}: {prediction.get('error')}")
            if "output" not in prediction:
                raise LLMRequestTransportAmbiguous(
                    "Replicate prediction succeeded without an output; provider reconciliation is required"
                )
            return prediction.get("output")


def create_llm_client() -> ReplicateClient:
    settings = load_settings()
    if settings["llm_provider"] != "replicate":
        raise LLMClientUnavailable("Only the Replicate LLM provider is currently configured")
    return ReplicateClient()


def _user_prompt_for_model(model: str, system_prompt: str, user_prompt: str) -> str:
    if _is_gemini_model(model) or _is_qwen_model(model):
        return (
            f"{user_prompt}\n\n"
            "RAPPEL FINAL: réponds uniquement par un objet JSON valide. "
            "Le premier caractère de ta réponse doit être { et le dernier doit être }."
        )
    return _combine_prompts(system_prompt, user_prompt)


def _is_gemini_3_model(model: str) -> bool:
    return bool(re.search(r"(?:^|/)gemini-3(?:[.-]|$)", model, re.I))


def _is_qwen_model(model: str) -> bool:
    model_path = model.split(":", 1)[0].lower()
    return bool(re.search(r"(?:^|/)qwen(?:[\d._-]|$)", model_path))


def _is_qwen2_7b_instruct_model(model: str) -> bool:
    model_path = model.split(":", 1)[0].lower()
    return model_path.endswith("/qwen2-7b-instruct")


def _combine_prompts(system_prompt: str, user_prompt: str) -> str:
    return (
        f"{system_prompt}\n\n"
        f"{user_prompt}\n\n"
        "RAPPEL FINAL: réponds uniquement par un objet JSON valide. "
        "Le premier caractère de ta réponse doit être {."
    )


def parse_json_response(raw_response: str) -> dict[str, Any]:
    text = raw_response.strip().lstrip("\ufeff")
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, flags=re.I).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        value = _json_loads_with_safe_repairs(text)
    except json.JSONDecodeError as exc:
        escaped_value = _parse_escaped_json_response(text)
        if escaped_value is not None:
            value = escaped_value
        else:
            value = _parse_json_object_from_response_text(text, exc)
    if not isinstance(value, dict):
        raise ValueError("LLM response must be a JSON object")
    return repair_json_payload(value)


_JSON_NUMERIC_KEYS = {
    "surface_m2",
    "value_m2",
    "page_number",
}
_JSON_COUNT_KEYS = {"rooms_count", "bedrooms_count"}
_JSON_MISSING_NUMBER_VALUES = {
    "",
    "-",
    "?",
    "na",
    "n/a",
    "none",
    "null",
    "unknown",
    "inconnu",
    "non renseigne",
    "non renseigné",
}
_JSON_MEASUREMENT_SUFFIX_RE = re.compile(r"\s*(?:m(?:2|²)|mètres?\s+carrés?)\s*$", re.I)
_JSON_NUMBER_RE = re.compile(r"^[+-]?(?:\d[\d\s\u00a0.,]*|[.,]\d+)$")


def repair_json_payload(value: Any) -> Any:
    """Apply only lossless, schema-agnostic repairs to a parsed LLM payload.

    Model responses commonly contain ``null`` placeholders in arrays or use a
    human-friendly representation for optional measurements.  These values are
    not useful facts and can make the later Pydantic validation reject an
    otherwise valuable response.  We remove only null array members and
    normalize fields whose names unambiguously identify numeric values.  The
    schema-specific salvage (for example, dropping one invalid room while
    retaining the other rooms) lives in ``extract_structured``.
    """

    if isinstance(value, list):
        return [repair_json_payload(item) for item in value if item is not None]
    if not isinstance(value, dict):
        return value

    repaired: dict[str, Any] = {}
    for key, item in value.items():
        field_name = str(key)
        if field_name in _JSON_NUMERIC_KEYS:
            repaired[field_name] = _repair_json_number(field_name, item)
        elif field_name in _JSON_COUNT_KEYS:
            # ``LLMExtraction`` already understands values such as ``T3`` or
            # ``2 chambres``.  Only normalize pure numeric strings here and
            # leave richer count labels for the schema validator.
            repaired[field_name] = _repair_json_count(item)
        elif field_name == "confidence":
            # Top-level extraction confidence is a mapping, while nested
            # measurements/candidates carry a scalar confidence. Preserve
            # both shapes so a safe repair never lowers a valid fact's score.
            repaired[field_name] = (
                _repair_json_confidence(item)
                if isinstance(item, dict)
                else _repair_json_confidence_score(item)
            )
        else:
            repaired[field_name] = repair_json_payload(item)
    return repaired


def _json_loads_with_safe_repairs(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as original_exc:
        # A trailing comma is unambiguous and can be repaired without
        # inventing any model content.  Keep all other syntax errors on the
        # existing retry path.
        repaired = _remove_trailing_json_commas(text)
        if repaired == text:
            raise
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            raise original_exc from None


def _remove_trailing_json_commas(text: str) -> str:
    """Remove commas before ``}``/``]`` only when outside JSON strings."""

    repaired: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_string:
            repaired.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            repaired.append(character)
            index += 1
            continue
        if character == ",":
            lookahead = index + 1
            while lookahead < len(text) and text[lookahead].isspace():
                lookahead += 1
            if lookahead < len(text) and text[lookahead] in "}]":
                index += 1
                continue
        repaired.append(character)
        index += 1
    return "".join(repaired)


def _repair_json_number(field_name: str, value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            return None
        return value if float(value) > 0 else None
    if not isinstance(value, str):
        return None

    text = value.strip().lower()
    if text in _JSON_MISSING_NUMBER_VALUES:
        return None
    if field_name in {"surface_m2", "value_m2"}:
        text = _JSON_MEASUREMENT_SUFFIX_RE.sub("", text).strip()
    if not _JSON_NUMBER_RE.fullmatch(text):
        return None
    compact = text.replace("\u00a0", " ").replace(" ", "")
    if "," in compact and "." in compact:
        # The last separator is the decimal separator; the other one is a
        # thousands separator.  This handles both French and English forms.
        decimal_separator = "," if compact.rfind(",") > compact.rfind(".") else "."
        thousands_separator = "." if decimal_separator == "," else ","
        compact = compact.replace(thousands_separator, "").replace(decimal_separator, ".")
    elif "," in compact:
        compact = compact.replace(",", ".")
    try:
        parsed = float(compact)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def _repair_json_count(value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else None
    if not isinstance(value, str):
        return value
    text = value.strip().lower()
    if text in _JSON_MISSING_NUMBER_VALUES:
        return None
    if not re.fullmatch(r"[+-]?\d+(?:\.0+)?", text):
        return value
    try:
        return int(float(text))
    except ValueError:
        return value


def _repair_json_confidence(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    repaired: dict[str, float] = {}
    for key, score in value.items():
        if score is None or isinstance(score, bool):
            continue
        try:
            parsed = float(score)
        except (TypeError, ValueError):
            continue
        if math.isfinite(parsed):
            repaired[str(key)] = parsed
    return repaired


def _repair_json_confidence_score(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _parse_json_object_from_response_text(text: str, original_exc: json.JSONDecodeError) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(
            f"No JSON object found in LLM response; response_excerpt={_response_excerpt(text)!r}"
        ) from original_exc
    try:
        value = _json_loads_with_safe_repairs(match.group(0))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON from LLM: {exc}; response_excerpt={_response_excerpt(text)!r}"
        ) from exc
    if not isinstance(value, dict):
        raise ValueError("LLM response must be a JSON object")
    return value


def _parse_escaped_json_response(text: str) -> dict[str, Any] | None:
    candidates: list[str] = []
    if text.startswith('"') and text.endswith('"'):
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, str):
            candidates.append(decoded)
    if '\\"' in text:
        candidates.append(text.replace('\\"', '"'))

    for candidate in candidates:
        try:
            value = _json_loads_with_safe_repairs(candidate)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", candidate, re.S)
            if not match:
                continue
            try:
                value = _json_loads_with_safe_repairs(match.group(0))
            except json.JSONDecodeError:
                continue
        if isinstance(value, dict):
            return repair_json_payload(value)
    return None


def _display_description_payload_from_text(system_prompt: str, raw_response: str) -> dict[str, Any] | None:
    if not _is_display_description_prompt(system_prompt):
        return None
    text = _display_description_text_from_jsonish(raw_response) or _plain_display_description_text(raw_response)
    if not text:
        return None
    return {
        "display_description": text,
        "confidence": {"display_description": 0.58},
    }


def _is_display_description_prompt(system_prompt: str) -> bool:
    return "MODE SYNTHESE STRICTE" in system_prompt.upper()


def _is_fact_extraction_prompt(system_prompt: str) -> bool:
    return "MODE EXTRACTION STRICTE" in system_prompt.upper()


def _response_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        message = payload.get("detail") or payload.get("message") or payload.get("error")
        if message:
            return str(message)[:500]
    try:
        text = str(response.text or "")
    except Exception:  # pragma: no cover - defensive for test doubles.
        text = ""
    return _response_excerpt(text, max_chars=500) or f"HTTP {response.status_code}"


def _response_request_status(status_code: int) -> str:
    # A gateway timeout or server error can still mean that Replicate accepted
    # the request.  Persist it as unresolved so a queue retry hits the request
    # key guard instead of sending a possible duplicate.
    if status_code in {408, 500, 502, 503, 504}:
        return "ambiguous"
    return "failed"


def _prediction_payload_is_complete(payload: Any) -> bool:
    if not isinstance(payload, dict) or not payload.get("id"):
        return False
    status = payload.get("status")
    if status == "succeeded":
        return "output" in payload
    if status in {"failed", "canceled", "aborted"}:
        return True
    if status not in {"starting", "processing", "queued"}:
        return False
    urls = payload.get("urls")
    return isinstance(urls, dict) and bool(urls.get("get"))


def _request_failure_status(
    prediction: dict[str, Any],
    *,
    exception: Exception | None,
    output_chars: int,
) -> str:
    if isinstance(exception, LLMRequestTransportAmbiguous):
        return "ambiguous"
    status = prediction.get("status")
    if status in {"failed", "canceled", "aborted"}:
        return "failed"
    # A completed output that is not valid JSON is an ordinary model result
    # and may use the existing bounded JSON retry.  Polling/transport failures
    # keep the reservation ambiguous so that retrying the job cannot duplicate
    # a prediction that may still be running.
    if status == "succeeded" or (isinstance(exception, ValueError) and output_chars > 0):
        return "failed"
    return "ambiguous"


def _request_key_for_payload(model: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"model": model, "payload": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _display_description_text_from_jsonish(raw_response: str) -> str | None:
    candidates = [raw_response.strip()]
    if candidates[0].startswith('"') and candidates[0].endswith('"'):
        try:
            decoded = json.loads(candidates[0])
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, str):
            candidates.append(decoded)
    if '\\"' in candidates[0]:
        candidates.append(candidates[0].replace('\\"', '"'))

    for candidate in candidates:
        match = re.search(
            r'"display_description"\s*:\s*"(?P<value>.*?)(?:"\s*(?:[,}]|$))',
            candidate,
            re.S,
        ) or re.search(r'"display_description"\s*:\s*"(?P<value>.+)', candidate, re.S)
        if not match:
            continue
        value = _decode_json_string_fragment(match.group("value"))
        text = _clean_display_description_candidate(value)
        if text:
            return text
    return None


def _decode_json_string_fragment(value: str) -> str:
    try:
        decoded = json.loads(f'"{value}"')
    except json.JSONDecodeError:
        return value.replace('\\"', '"')
    return decoded if isinstance(decoded, str) else value


def _plain_display_description_text(raw_response: str) -> str | None:
    text = raw_response.strip()
    if not text:
        return None
    if "{" in text or "}" in text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:text|markdown)?", "", text, flags=re.I).strip()
        text = re.sub(r"```$", "", text).strip()
    return _clean_display_description_candidate(text)


def _clean_display_description_candidate(text: str) -> str | None:
    text = re.sub(r"^\s*(?:display_description|synth[eè]se|description)\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip(" \t\r\n\"'")
    lowered = text.lower()
    if any(marker in lowered for marker in ("objet json", "json valide", "je ne peux", "désolé", "desole")):
        return None
    if len(text.split()) < 8:
        return None
    return text


def _response_excerpt(text: str, max_chars: int = 180) -> str:
    excerpt = re.sub(r"\s+", " ", text).strip()
    if len(excerpt) <= max_chars:
        return excerpt
    return f"{excerpt[: max_chars - 1]}…"


def _split_replicate_model(model: str) -> tuple[str, str]:
    if "/" not in model:
        raise ValueError("REPLICATE_MODEL must be formatted as owner/model")
    model_path = model.split(":", 1)[0]
    owner, model_name = model_path.split("/", 1)
    return owner, model_name


def _replicate_model_version(model: str) -> str | None:
    if ":" not in model:
        return None
    _model_path, version = model.rsplit(":", 1)
    return version or None


def _is_gemini_model(model: str) -> bool:
    return model.lower().startswith("google/gemini")


def _retry_sleep_seconds(
    attempt: int,
    response: httpx.Response | None,
    backoff_seconds: float,
    max_sleep_seconds: float,
) -> float:
    exponential_sleep = min(backoff_seconds * (2 ** max(0, attempt - 1)), max_sleep_seconds)
    retry_after = response.headers.get("Retry-After") if response is not None else None
    if retry_after:
        try:
            parsed_retry_after = float(retry_after)
            if response is not None and response.status_code == 429:
                return min(max(parsed_retry_after, exponential_sleep), max_sleep_seconds)
            return min(parsed_retry_after, max_sleep_seconds)
        except ValueError:
            pass
    return exponential_sleep


def _stringify_output(output: Any) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "".join(str(item) for item in output)
    if isinstance(output, dict):
        for key in ("text", "output", "response"):
            if key in output:
                return _stringify_output(output[key])
        return json.dumps(output, ensure_ascii=False)
    return str(output or "")
