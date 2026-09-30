from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from src import llm_task_deadline
from src.enrichment import extract_structured as extraction
from src.enrichment import llm_client
from src.llm_requests import RESERVATION_KEY
from src.models import AuctionSale


def _client(**overrides: object) -> llm_client.ReplicateClient:
    defaults: dict[str, object] = {
        "api_token": "token",
        "model": "owner/model:v1",
        "min_interval_seconds": 0,
        "max_retries": 1,
    }
    defaults.update(overrides)
    return llm_client.ReplicateClient(**defaults)


def test_deadline_scope_resets_and_bounds_timeouts(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [10.0]
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])

    assert llm_task_deadline.llm_task_deadline_remaining() is None
    with llm_task_deadline.llm_task_deadline_scope(25.0):
        assert llm_task_deadline.llm_task_deadline_remaining() == 15.0
        assert llm_task_deadline.llm_task_bounded_timeout(30.0, "test request") == 15.0
        now[0] = 25.0
        with pytest.raises(llm_task_deadline.LLMTaskDeadlineExceeded) as exc_info:
            llm_task_deadline.ensure_llm_task_deadline("test request")
        assert exc_info.value.operation == "test request"
        assert exc_info.value.deadline == 25.0
    assert llm_task_deadline.llm_task_deadline_remaining() is None


def test_deadline_stops_before_request_reservation(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    now = [100.0]
    reservations: list[object] = []
    provider_calls: list[object] = []
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(
        llm_client,
        "reserve_llm_request",
        lambda **kwargs: reservations.append(kwargs) or "reservation-1",
    )
    monkeypatch.setattr(llm_client.httpx, "post", lambda *args, **kwargs: provider_calls.append(kwargs))

    with llm_task_deadline.llm_task_deadline_scope(100.0), pytest.raises(
        llm_task_deadline.LLMTaskDeadlineExceeded,
        match="starting Replicate request attempt",
    ):
        client._post_with_retries(
            "https://api.replicate.com/v1/predictions",
            headers={},
            payload={"input": {"prompt": "test"}},
        )

    assert reservations == []
    assert provider_calls == []


def test_post_timeout_is_recomputed_after_payload_preparation(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    now = [10.0]
    captured: dict[str, object] = {}
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: "reservation-1")
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model, **kwargs: None)
    monkeypatch.setattr(llm_client, "record_llm_request", lambda *args, **kwargs: None)
    monkeypatch.setattr(llm_client, "record_prediction", lambda *args, **kwargs: None)

    original_input_payload = client._input_payload

    def prepare_payload(prompt: str, *, system_prompt: str | None = None) -> dict[str, object]:
        payload = original_input_payload(prompt, system_prompt=system_prompt)
        now[0] = 50.0
        return payload

    monkeypatch.setattr(client, "_input_payload", prepare_payload)

    def post(*args: object, **kwargs: object) -> httpx.Response:
        captured.update(kwargs)
        return httpx.Response(
            201,
            json={
                "id": "prediction-1",
                "status": "starting",
                "urls": {"get": "https://api.replicate.com/v1/predictions/prediction-1"},
            },
            request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
        )

    monkeypatch.setattr(llm_client.httpx, "post", post)
    with llm_task_deadline.llm_task_deadline_scope(100.0):
        prediction = client._create_prediction("prompt", system_prompt="system")

    assert captured["timeout"] == 50.0
    assert prediction["id"] == "prediction-1"


def test_deadline_stops_cadence_without_reserving_or_posting(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(min_interval_seconds=10)
    now = [100.0]
    sleeps: list[float] = []
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(llm_client, "_LAST_REPLICATE_REQUEST_AT", 95.0)
    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: pytest.fail("reserved too late"))

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(llm_client.time, "sleep", sleep)

    with llm_task_deadline.llm_task_deadline_scope(105.0), pytest.raises(
        llm_task_deadline.LLMTaskDeadlineExceeded,
        match="after cadence",
    ):
        client._post_with_retries(
            "https://api.replicate.com/v1/predictions",
            headers={},
            payload={"input": {}},
        )

    assert sleeps == [5.0]


def test_deadline_stops_before_rate_limit_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(max_retries=2, retry_backoff_seconds=10, retry_max_sleep_seconds=10)
    now = [100.0]
    provider_calls = 0
    reservation_calls = 0
    telemetry: list[dict[str, object]] = []
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])

    def reserve(**kwargs: object) -> str:
        nonlocal reservation_calls
        reservation_calls += 1
        return "reservation-1"

    monkeypatch.setattr(llm_client, "reserve_llm_request", reserve)
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model, **kwargs: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )

    def rate_limited(*args: object, **kwargs: object) -> httpx.Response:
        nonlocal provider_calls
        provider_calls += 1
        return httpx.Response(
            429,
            json={"error": "busy"},
            headers={"Retry-After": "10"},
            request=httpx.Request("POST", "https://api.replicate.com/v1/predictions"),
        )

    monkeypatch.setattr(llm_client.httpx, "post", rate_limited)

    def sleep(seconds: float) -> None:
        now[0] += seconds

    monkeypatch.setattr(llm_client.time, "sleep", sleep)
    with llm_task_deadline.llm_task_deadline_scope(105.0), pytest.raises(
        llm_task_deadline.LLMTaskDeadlineExceeded,
        match="starting next Replicate retry",
    ):
        client._post_with_retries(
            "https://api.replicate.com/v1/predictions",
            headers={},
            payload={"input": {}},
        )

    assert provider_calls == 1
    assert reservation_calls == 1
    assert [item["status"] for item in telemetry] == ["rate_limited"]


def test_transport_error_at_cutoff_keeps_reservation_ambiguous(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client()
    now = [99.0]
    provider_calls = 0
    reservation_calls = 0
    telemetry: list[dict[str, object]] = []
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])

    def reserve(**kwargs: object) -> str:
        nonlocal reservation_calls
        reservation_calls += 1
        return "reservation-1"

    monkeypatch.setattr(llm_client, "reserve_llm_request", reserve)
    monkeypatch.setattr(llm_client, "reserve_prediction", lambda model, **kwargs: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )
    monkeypatch.setattr(
        llm_client,
        "release_llm_request",
        lambda *args, **kwargs: pytest.fail("released a reservation after POST engagement"),
    )

    def fail_post(*args: object, **kwargs: object) -> httpx.Response:
        nonlocal provider_calls
        provider_calls += 1
        now[0] = 100.0
        raise httpx.ReadTimeout("provider read timed out")

    monkeypatch.setattr(llm_client.httpx, "post", fail_post)

    with llm_task_deadline.llm_task_deadline_scope(100.0), pytest.raises(
        llm_task_deadline.LLMTaskDeadlineExceeded,
        match="finishing Replicate POST transport handling",
    ):
        client._post_with_retries(
            "https://api.replicate.com/v1/predictions",
            headers={},
            payload={"input": {}},
        )

    assert provider_calls == 1
    assert reservation_calls == 1
    assert telemetry == [
        {
            "id": "reservation-1",
            "status": "ambiguous",
            "prompt_chars": 0,
            "system_prompt_chars": 0,
            "error_message": "provider read timed out",
        }
    ]


def test_poll_deadline_marks_existing_prediction_ambiguous(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    now = [100.0]
    sleeps: list[float] = []
    telemetry: list[dict[str, object]] = []
    poll_calls: list[object] = []
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(llm_client, "record_prediction", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )

    class NoPollClient:
        def __enter__(self) -> NoPollClient:
            return self

        def __exit__(self, exc_type, exc, traceback) -> bool:
            return False

        def get(self, *args: object, **kwargs: object) -> None:
            poll_calls.append((args, kwargs))
            return None

    monkeypatch.setattr(llm_client.httpx, "Client", lambda timeout: NoPollClient())

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(llm_client.time, "sleep", sleep)
    prediction = {
        "id": "prediction-1",
        "status": "starting",
        "urls": {"get": "https://api.replicate.com/v1/predictions/prediction-1"},
        RESERVATION_KEY: "reservation-1",
    }

    with llm_task_deadline.llm_task_deadline_scope(101.0), pytest.raises(
        llm_task_deadline.LLMTaskDeadlineExceeded,
        match="sending Replicate prediction poll",
    ):
        client._wait_for_output(prediction)

    assert poll_calls == []
    assert sleeps == [1.0]
    assert telemetry == [
        {
            "id": "reservation-1",
            "status": "ambiguous",
            "prediction_id": "prediction-1",
            "error_message": "LLM task deadline reached during sending Replicate prediction poll",
        }
    ]


def test_generate_json_records_poll_deadline_once_with_prediction_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client()
    now = [100.0]
    telemetry: list[dict[str, object]] = []
    prediction = {
        "id": "prediction-1",
        "status": "starting",
        "urls": {"get": "https://api.replicate.com/v1/predictions/prediction-1"},
        RESERVATION_KEY: "reservation-1",
    }
    monkeypatch.setattr(llm_task_deadline.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(llm_client, "record_prediction", lambda *args, **kwargs: None)
    monkeypatch.setattr(client, "_create_prediction", lambda prompt, system_prompt=None: prediction)
    monkeypatch.setattr(
        llm_client,
        "record_llm_request",
        lambda reservation_id, **kwargs: telemetry.append({"id": reservation_id, **kwargs}),
    )

    def sleep(seconds: float) -> None:
        now[0] += seconds

    monkeypatch.setattr(llm_client.time, "sleep", sleep)

    with llm_task_deadline.llm_task_deadline_scope(101.0), pytest.raises(
        llm_task_deadline.LLMTaskDeadlineExceeded,
        match="sending Replicate prediction poll",
    ):
        client.generate_json("MODE EXTRACTION STRICTE", "source text")

    assert len(telemetry) == 1
    assert telemetry[0]["id"] == "reservation-1"
    assert telemetry[0]["status"] == "ambiguous"
    assert telemetry[0]["prediction_id"] == "prediction-1"


def _sale() -> AuctionSale:
    return AuctionSale(
        source_name="test",
        source_url="https://example.test/sale",
        raw_text="Maison à Bordeaux.",
    )


def test_extract_structured_rethrows_deadline_in_display_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setattr(extraction, "load_llm_context_for_sale", lambda *_a, **_kw: "context")

    class DeadlineClient:
        model = "test-model"

        def is_available(self) -> bool:
            return True

        def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, object]:
            raise llm_task_deadline.LLMTaskDeadlineExceeded("display request")

    with pytest.raises(llm_task_deadline.LLMTaskDeadlineExceeded, match="display request"):
        extraction.enrich_sale_with_llm(
            _sale(),
            client=DeadlineClient(),
            output_dir=tmp_path,
            extraction_mode="display_description",
        )


def test_fact_checkpoint_survives_deadline_before_next_chunk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("INCREMENTAL_ENRICHMENT", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "0")
    monkeypatch.setattr(extraction, "load_llm_fact_context_chunks_for_sale", lambda *_a, **_kw: ["chunk-A", "chunk-B"])
    monkeypatch.setattr(extraction, "load_cached_result", lambda *_a, **_kw: None)
    monkeypatch.setattr(extraction, "save_cached_result", lambda *_a, **_kw: None)

    class CheckpointClient:
        model = "test-model"
        calls = 0

        def is_available(self) -> bool:
            return True

        def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, object]:
            self.calls += 1
            if self.calls == 1:
                return {}
            raise llm_task_deadline.LLMTaskDeadlineExceeded("second fact chunk")

    with pytest.raises(llm_task_deadline.LLMTaskDeadlineExceeded, match="second fact chunk"):
        extraction.enrich_sale_with_llm(
            _sale(),
            client=CheckpointClient(),
            output_dir=tmp_path,
            extraction_mode="facts",
        )

    assert len(list((tmp_path / "chunks").glob("*.json"))) == 1
