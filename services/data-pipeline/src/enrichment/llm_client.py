from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx

from src.config import load_settings

LOGGER = logging.getLogger(__name__)
RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
_LAST_REPLICATE_REQUEST_AT = 0.0
_REPLICATE_REQUEST_LOCK = threading.Lock()


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

    def is_available(self) -> bool:
        return bool(self.api_token and self.model)

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        if not self.api_token:
            raise LLMClientUnavailable("REPLICATE_API_TOKEN is missing")
        last_error: Exception | None = None
        prompt = _user_prompt_for_model(str(self.model), system_prompt, user_prompt)
        for _attempt in range(2):
            prediction = self._create_prediction(prompt, system_prompt=system_prompt)
            output = self._wait_for_output(prediction)
            raw_response = _stringify_output(output)
            try:
                return parse_json_response(raw_response)
            except ValueError as exc:
                last_error = exc
                prompt = _user_prompt_for_model(
                    str(self.model),
                    system_prompt,
                    f"{user_prompt}\n\nTa réponse précédente n'était pas du JSON valide. "
                    "Réponds uniquement avec un objet JSON valide. Le premier caractère doit être { "
                    "et le dernier caractère doit être }. Aucun markdown, aucun commentaire.",
                )
        raise ValueError(f"Replicate returned invalid JSON after retry: {last_error}")

    def _create_prediction(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        owner, model_name = _split_replicate_model(str(self.model))
        endpoint = f"https://api.replicate.com/v1/models/{owner}/{model_name}/predictions"
        headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
            "Prefer": f"wait={min(int(self.wait_seconds or 60), 60)}",
            "Cancel-After": str(self.cancel_after),
        }
        payload = {"input": self._input_payload(prompt, system_prompt=system_prompt)}
        response = self._post_with_retries(endpoint, headers=headers, payload=payload)
        return response.json()

    def _post_with_retries(self, endpoint: str, headers: dict[str, str], payload: dict[str, Any]) -> httpx.Response:
        attempts = max(1, int(self.max_retries or 1))
        last_response: httpx.Response | None = None
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            self._respect_min_interval()
            try:
                response = httpx.post(
                    endpoint,
                    headers=headers,
                    json=payload,
                    timeout=float(self.timeout_seconds or 180),
                )
                self._mark_request_finished()
                if response.status_code not in RETRYABLE_STATUS_CODES:
                    response.raise_for_status()
                    return response
                last_response = response
                sleep_seconds = _retry_sleep_seconds(
                    attempt=attempt,
                    response=response,
                    backoff_seconds=float(self.retry_backoff_seconds or 20),
                    max_sleep_seconds=float(self.retry_max_sleep_seconds or 180),
                )
                LOGGER.warning(
                    "Replicate returned %s; retrying in %.1fs (%s/%s)",
                    response.status_code,
                    sleep_seconds,
                    attempt,
                    attempts,
                )
            except (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException) as exc:
                self._mark_request_finished()
                last_error = exc
                sleep_seconds = _retry_sleep_seconds(
                    attempt=attempt,
                    response=None,
                    backoff_seconds=float(self.retry_backoff_seconds or 20),
                    max_sleep_seconds=float(self.retry_max_sleep_seconds or 180),
                )
                LOGGER.warning("Replicate request failed; retrying in %.1fs (%s/%s): %s", sleep_seconds, attempt, attempts, exc)
            if attempt < attempts:
                time.sleep(sleep_seconds)
        if last_response is not None:
            last_response.raise_for_status()
        if last_error is not None:
            raise last_error
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
        global _LAST_REPLICATE_REQUEST_AT
        if float(self.min_interval_seconds or 0) <= 0:
            return
        with _REPLICATE_REQUEST_LOCK:
            _LAST_REPLICATE_REQUEST_AT = time.monotonic()

    def _input_payload(self, prompt: str, system_prompt: str | None = None) -> dict[str, Any]:
        if _is_gemini_model(str(self.model)):
            return {
                "prompt": prompt,
                "system_instruction": system_prompt or "",
                "temperature": float(self.temperature if self.temperature is not None else 0),
                "top_p": 1,
                "max_output_tokens": int(self.max_tokens or 8192),
                "thinking_budget": int(self.thinking_budget or 0),
                "dynamic_thinking": bool(self.dynamic_thinking),
            }
        return {
            "prompt": prompt,
            "max_tokens": int(self.max_tokens or 4096),
            "temperature": float(self.temperature if self.temperature is not None else 0.1),
            "top_p": 1,
            "presence_penalty": 0,
            "frequency_penalty": 0,
        }

    def _wait_for_output(self, prediction: dict[str, Any]) -> Any:
        status = prediction.get("status")
        if status == "succeeded":
            return prediction.get("output")
        if status in {"failed", "canceled"}:
            raise RuntimeError(f"Replicate prediction {status}: {prediction.get('error')}")

        get_url = prediction.get("urls", {}).get("get")
        if not get_url:
            raise RuntimeError("Replicate prediction did not include a polling URL")
        timeout_at = time.monotonic() + float(self.timeout_seconds or 180)
        with httpx.Client(timeout=20) as client:
            while status not in {"succeeded", "failed", "canceled"}:
                if time.monotonic() > timeout_at:
                    raise TimeoutError("Replicate prediction timed out")
                time.sleep(2)
                response = client.get(get_url, headers={"Authorization": f"Bearer {self.api_token}"})
                response.raise_for_status()
                prediction = response.json()
                status = prediction.get("status")
            if status != "succeeded":
                raise RuntimeError(f"Replicate prediction {status}: {prediction.get('error')}")
            return prediction.get("output")


def create_llm_client() -> ReplicateClient:
    settings = load_settings()
    if settings["llm_provider"] != "replicate":
        raise LLMClientUnavailable("Only the Replicate LLM provider is currently configured")
    return ReplicateClient()


def _user_prompt_for_model(model: str, system_prompt: str, user_prompt: str) -> str:
    if _is_gemini_model(model):
        return (
            f"{user_prompt}\n\n"
            "RAPPEL FINAL: réponds uniquement par un objet JSON valide. "
            "Le premier caractère de ta réponse doit être { et le dernier doit être }."
        )
    return _combine_prompts(system_prompt, user_prompt)


def _combine_prompts(system_prompt: str, user_prompt: str) -> str:
    return (
        f"{system_prompt}\n\n"
        f"{user_prompt}\n\n"
        "RAPPEL FINAL: réponds uniquement par un objet JSON valide. "
        "Le premier caractère de ta réponse doit être {."
    )


def parse_json_response(raw_response: str) -> dict[str, Any]:
    text = raw_response.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, flags=re.I).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise ValueError("No JSON object found in LLM response") from exc
        try:
            value = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON from LLM: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("LLM response must be a JSON object")
    return value


def _split_replicate_model(model: str) -> tuple[str, str]:
    if "/" not in model:
        raise ValueError("REPLICATE_MODEL must be formatted as owner/model")
    owner, model_name = model.split("/", 1)
    return owner, model_name


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
