from __future__ import annotations

from decimal import Decimal

import httpx

from src import pipeline_usage
from src.enrichment import llm_client


def test_token_pricing_uses_provider_counts_and_keeps_logs_out_of_metrics() -> None:
    metrics = {"input_token_count": 3000, "output_token_count": 500, "predict_time": 30}
    cost, source = pipeline_usage._prediction_cost(
        "qwen/qwen3-7-plus", {"logs": "sensitive prompt text"}, metrics
    )

    assert cost == Decimal("0.0013785")
    assert source == pipeline_usage.TOKEN_PRICES["qwen/qwen3-7-plus"][2]
    assert "logs" not in metrics


def test_qwen_pricing_uses_actual_replicate_metric_names() -> None:
    metrics = {"token_input_count": 3000, "token_output_count": 500}
    cost, _ = pipeline_usage._prediction_cost("qwen/qwen3-7-plus", {}, metrics)

    assert cost == Decimal("0.0013785")
    assert metrics["input_token_count"] == 3000
    assert metrics["output_token_count"] == 500


def test_token_pricing_recovers_counts_from_provider_logs_without_storing_logs() -> None:
    metrics: dict[str, int] = {}
    prediction = {"logs": "Generating...\nInput token count: 4600\nOutput token count: 1200\n"}
    cost, _ = pipeline_usage._prediction_cost("google/gemini-2.5-flash", prediction, metrics)

    assert cost == Decimal("0.004380")
    assert metrics == {"input_token_count": 4600, "output_token_count": 1200}


def test_missing_token_counts_keep_the_conservative_reservation() -> None:
    cost, source = pipeline_usage._prediction_cost(
        "qwen/qwen3-7-plus", {"logs": "No usage reported"}, {"predict_time": 2}
    )

    assert cost is None
    assert source == pipeline_usage.TOKEN_PRICES["qwen/qwen3-7-plus"][2]


def test_unrecognised_model_does_not_get_a_misleading_price() -> None:
    cost, source = pipeline_usage._prediction_cost(
        "other/model", {"logs": "Input token count: 100\nOutput token count: 100"}, {}
    )

    assert cost is None
    assert source is None


def test_replicate_reserves_conservative_utf8_input_and_output_caps(monkeypatch) -> None:
    client = llm_client.ReplicateClient(
        api_token="test-token",
        model="qwen/qwen3-7-plus",
        max_tokens=512,
        min_interval_seconds=0,
        max_retries=1,
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(llm_client, "reserve_llm_request", lambda **kwargs: None)
    monkeypatch.setattr(llm_client, "record_llm_request", lambda *args, **kwargs: None)
    monkeypatch.setattr(llm_client, "record_prediction", lambda *args, **kwargs: None)

    def reserve(model: str, **kwargs: object) -> None:
        captured.update(model=model, **kwargs)

    monkeypatch.setattr(llm_client, "reserve_prediction", reserve)
    monkeypatch.setattr(
        llm_client.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(
            201,
            json={
                "id": "prediction-test",
                "status": "starting",
                "urls": {"get": "https://api.replicate.com/v1/predictions/prediction-test"},
            },
            request=httpx.Request("POST", "https://api.replicate.com/v1/models/qwen/qwen3-7-plus/predictions"),
        ),
    )

    client._post_with_retries(
        "https://api.replicate.com/v1/models/qwen/qwen3-7-plus/predictions",
        headers={},
        payload={"input": {"prompt": "café", "system_prompt": "résumé", "max_tokens": 512}},
    )

    assert captured == {
        "model": "qwen/qwen3-7-plus",
        "input_token_ceiling": len("café".encode()) + len("résumé".encode()) + 256,
        "output_token_ceiling": 512,
    }
