from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from src import llm_requests
from src.enrichment import llm_client
from src.enrichment.llm_client import ReplicateClient
from src.enrichment.prompts import SYSTEM_PROMPT


def _settings(**overrides):
    settings = {
        "supabase_url": None,
        "supabase_service_role_key": None,
        "supabase_db_url": None,
        "replicate_max_calls_per_hour": 2,
    }
    settings.update(overrides)
    return settings


def test_llm_request_context_is_nested_and_maps_auction_id() -> None:
    assert llm_requests.current_llm_request_context() == {}
    with llm_requests.llm_request_context(auction_id="sale-1", job_id="job-1", reason="outer"):
        assert llm_requests.current_llm_request_context() == {
            "auction_id": "sale-1",
            "sale_id": "sale-1",
            "job_id": "job-1",
            "reason": "outer",
        }
        with llm_requests.llm_request_context(stage="facts", reason="inner"):
            assert llm_requests.current_llm_request_context()["sale_id"] == "sale-1"
            assert llm_requests.current_llm_request_context()["stage"] == "facts"
            assert llm_requests.current_llm_request_context()["reason"] == "inner"
        assert llm_requests.current_llm_request_context()["reason"] == "outer"
    assert llm_requests.current_llm_request_context() == {}


def test_rest_reservation_is_atomic_rpc_with_context(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update(url=url, headers=headers, json=json, timeout=timeout)
        return httpx.Response(
            200,
            json="reservation-1",
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(llm_requests, "load_settings", lambda: _settings(
        supabase_url="https://db.example.test",
        supabase_service_role_key="service-key",
    ))
    monkeypatch.setattr(llm_requests.httpx, "post", fake_post)

    with llm_requests.llm_request_context(
        sale_id="sale-1",
        job_id="job-1",
        source_url="https://example.test/sale",
        stage="facts",
        reason="cache_miss",
    ):
        reservation = llm_requests.reserve_llm_request(
            provider="replicate",
            model="owner/model:v1",
            request_kind="fact_extraction",
            attempt_number=1,
            max_calls_per_hour=2,
        )

    assert reservation == "reservation-1"
    assert str(captured["url"]).endswith("/rest/v1/rpc/reserve_llm_request")
    assert captured["json"] == {
        "p_provider": "replicate",
        "p_model": "owner/model:v1",
        "p_request_kind": "fact_extraction",
        "p_attempt_number": 1,
        "p_max_calls_per_hour": 2,
        "p_request_key": None,
        "p_sale_id": "sale-1",
        "p_job_id": "job-1",
        "p_source_url": "https://example.test/sale",
        "p_stage": "facts",
        "p_reason": "cache_miss",
    }


def test_production_without_budget_storage_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setattr(llm_requests, "load_settings", lambda: _settings())

    with pytest.raises(llm_requests.LLMRequestStorageUnavailable, match="not configured"):
        llm_requests.reserve_llm_request(
            provider="replicate",
            model="owner/model:v1",
            request_kind="display_description",
            attempt_number=1,
            max_calls_per_hour=2,
        )


def test_budget_rpc_rejection_does_not_send_provider_post(monkeypatch) -> None:
    calls = []

    def fake_post(url, **kwargs):
        calls.append(url)
        return httpx.Response(
            400,
            json={"message": "Hourly LLM request budget exhausted"},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(llm_requests, "load_settings", lambda: _settings(
        supabase_url="https://db.example.test",
        supabase_service_role_key="service-key",
    ))
    monkeypatch.setattr(llm_requests.httpx, "post", fake_post)

    with pytest.raises(llm_requests.LLMRequestBudgetExhausted):
        llm_requests.reserve_llm_request(
            provider="replicate",
            model="owner/model:v1",
            request_kind="fact_extraction",
            attempt_number=1,
            max_calls_per_hour=2,
        )

    assert calls == ["https://db.example.test/rest/v1/rpc/reserve_llm_request"]


def test_unresolved_request_key_is_fail_closed(monkeypatch) -> None:
    def fake_post(url, **kwargs):
        return httpx.Response(
            400,
            json={"message": "Unresolved LLM request key requires provider reconciliation before retry"},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(llm_requests, "load_settings", lambda: _settings(
        supabase_url="https://db.example.test",
        supabase_service_role_key="service-key",
    ))
    monkeypatch.setattr(llm_requests.httpx, "post", fake_post)

    with pytest.raises(llm_requests.LLMRequestUnresolved):
        llm_requests.reserve_llm_request(
            provider="replicate",
            model="owner/model:v1",
            request_kind="fact_extraction",
            attempt_number=2,
            max_calls_per_hour=2,
            request_key="same-payload-key",
        )


def test_deterministic_request_cooldown_has_dedicated_24_hour_error(monkeypatch) -> None:
    def fake_post(url, **kwargs):
        return httpx.Response(
            400,
            json={
                "message": (
                    "Unresolved deterministic LLM request key is blocked for 24 hours "
                    "after invalid JSON or structured validation failure"
                )
            },
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(
        llm_requests,
        "load_settings",
        lambda: _settings(
            supabase_url="https://db.example.test",
            supabase_service_role_key="service-key",
        ),
    )
    monkeypatch.setattr(llm_requests.httpx, "post", fake_post)

    with pytest.raises(llm_requests.LLMRequestDeterministicCooldown) as cooldown:
        llm_requests.reserve_llm_request(
            provider="replicate",
            model="owner/model:v1",
            request_kind="fact_extraction",
            attempt_number=1,
            max_calls_per_hour=2,
            request_key="same-invalid-output",
        )

    assert cooldown.value.next_attempt_at > datetime.now(UTC) + timedelta(hours=23)


def test_post_retries_known_429_with_a_new_reservation(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        max_retries=2,
        min_interval_seconds=0,
        retry_backoff_seconds=0,
        retry_max_sleep_seconds=0,
    )
    reservations = iter(("reservation-1", "reservation-2"))
    reservation_calls: list[str] = []
    telemetry: list[dict[str, object]] = []
    responses = iter(
        (
            httpx.Response(
                429,
                json={"message": "rate limited"},
                request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
            ),
            httpx.Response(
                201,
                json={
                    "id": "prediction-1",
                    "status": "starting",
                    "urls": {"get": "https://api.replicate.com/v1/predictions/prediction-1"},
                },
                request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
            ),
        )
    )

    monkeypatch.setattr(
        llm_client,
        "reserve_llm_request",
        lambda **kwargs: reservation_calls.append(next(reservations)) or reservation_calls[-1],
    )
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )
    monkeypatch.setattr(llm_client.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(llm_client.httpx, "post", lambda *args, **kwargs: next(responses))

    response = client._post_with_retries(
        "https://api.replicate.com/v1/predictions",
        headers={},
        payload={"input": {}},
    )

    assert response.json()["id"] == "prediction-1"
    assert reservation_calls == ["reservation-1", "reservation-2"]
    assert [item["status"] for item in telemetry] == ["rate_limited", "reserved"]
    assert telemetry[-1]["prediction_id"] == "prediction-1"


def test_post_transport_error_is_ambiguous_and_not_retried(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        max_retries=4,
        min_interval_seconds=0,
    )
    provider_calls = 0
    telemetry: list[dict[str, object]] = []

    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: "reservation-1")
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )

    def fail_post(*args, **kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise httpx.ReadTimeout("provider read timed out")

    monkeypatch.setattr(llm_client.httpx, "post", fail_post)

    with pytest.raises(llm_requests.LLMRequestTransportAmbiguous):
        client._post_with_retries("https://api.replicate.com/v1/predictions", headers={}, payload={})

    assert provider_calls == 1
    assert [item["status"] for item in telemetry] == ["ambiguous"]


def test_successful_2xx_malformed_body_does_not_trigger_json_retry(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        max_retries=4,
        min_interval_seconds=0,
    )
    provider_calls = 0
    telemetry: list[dict[str, object]] = []

    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: "reservation-1")
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )

    def malformed_post(*args, **kwargs):
        nonlocal provider_calls
        provider_calls += 1
        return httpx.Response(
            200,
            content=b"truncated provider body",
            request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
        )

    monkeypatch.setattr(llm_client.httpx, "post", malformed_post)

    with pytest.raises(llm_requests.LLMRequestTransportAmbiguous):
        client.generate_json("MODE EXTRACTION STRICTE", "source text")

    assert provider_calls == 1
    assert [item["status"] for item in telemetry] == ["ambiguous"]


def test_successful_2xx_missing_polling_identity_does_not_trigger_retry(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        max_retries=4,
        min_interval_seconds=0,
    )
    provider_calls = 0
    telemetry: list[dict[str, object]] = []

    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: "reservation-1")
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )

    def incomplete_post(*args, **kwargs):
        nonlocal provider_calls
        provider_calls += 1
        return httpx.Response(
            201,
            json={"status": "starting"},
            request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
        )

    monkeypatch.setattr(llm_client.httpx, "post", incomplete_post)

    with pytest.raises(llm_requests.LLMRequestTransportAmbiguous):
        client.generate_json("MODE EXTRACTION STRICTE", "source text")

    assert provider_calls == 1
    assert [item["status"] for item in telemetry] == ["ambiguous"]


def test_polling_timeout_keeps_running_prediction_ambiguous(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        max_retries=4,
        min_interval_seconds=0,
    )
    create_calls = 0
    telemetry: list[dict[str, object]] = []

    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: "reservation-1")
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )
    monkeypatch.setattr(llm_client.time, "sleep", lambda seconds: None)

    def provider_post(*args, **kwargs):
        nonlocal create_calls
        create_calls += 1
        return httpx.Response(
            201,
            json={
                "id": "prediction-1",
                "status": "starting",
                "urls": {"get": "https://api.replicate.com/v1/predictions/prediction-1"},
            },
            request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
        )

    class PollingClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def get(self, *args, **kwargs):
            raise httpx.ReadTimeout("polling read timed out")

    monkeypatch.setattr(llm_client.httpx, "post", provider_post)
    monkeypatch.setattr(llm_client.httpx, "Client", lambda timeout: PollingClient())

    with pytest.raises(llm_requests.LLMRequestTransportAmbiguous):
        client.generate_json("MODE EXTRACTION STRICTE", "source text")

    assert create_calls == 1
    assert [item["status"] for item in telemetry] == ["reserved", "ambiguous"]


def test_terminal_prediction_failure_is_finalized_as_failed(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        min_interval_seconds=0,
    )
    telemetry: list[dict[str, object]] = []

    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: "reservation-1")
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )
    monkeypatch.setattr(
        llm_client.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(
            201,
            json={"id": "prediction-1", "status": "failed", "error": "provider failure"},
            request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
        ),
    )

    with pytest.raises(RuntimeError, match="prediction failed"):
        client.generate_json("MODE EXTRACTION STRICTE", "source text")

    assert [item["status"] for item in telemetry] == ["reserved", "failed"]


def test_invalid_json_telemetry_keeps_actual_output_size(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        min_interval_seconds=0,
    )
    raw_response = '{"surface_m2": }'
    events: list[dict[str, object]] = []

    monkeypatch.setattr(client, "_create_prediction", lambda prompt, system_prompt=None: {"id": "prediction-1"})
    monkeypatch.setattr(client, "_wait_for_output", lambda prediction: raw_response)
    from src.storage import supabase_client

    monkeypatch.setattr(supabase_client, "record_llm_usage_event", events.append)

    with pytest.raises(ValueError, match="invalid JSON"):
        client.generate_json("MODE EXTRACTION STRICTE", "source text")

    assert events
    assert events[-1]["output_chars"] == len(raw_response)


def test_fact_extraction_uses_separate_output_cap() -> None:
    client = ReplicateClient(
        api_token="token",
        model="owner/model:v1",
        max_tokens=512,
        fact_max_tokens=4096,
    )

    payload = client._input_payload("facts", system_prompt=SYSTEM_PROMPT)

    assert payload["max_tokens"] == 4096


def test_request_key_is_stable_for_same_model_and_payload() -> None:
    first = llm_client._request_key_for_payload("owner/model:v1", {"input": {"prompt": "same"}})
    second = llm_client._request_key_for_payload("owner/model:v1", {"input": {"prompt": "same"}})
    different = llm_client._request_key_for_payload("owner/model:v1", {"input": {"prompt": "other"}})

    assert first == second
    assert first != different
