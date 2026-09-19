from __future__ import annotations

import httpx
import pytest

from src import llm_cache
from src.llm_cache import LLMCacheUnavailable, load_cached_result, save_cached_result
from src.pipeline_usage import PipelineBudgetExhausted

CACHE_KEY = "a" * 64
SETTINGS = {
    "supabase_url": "https://supabase.test/",
    "supabase_service_role_key": "service-role-test",
}


def test_cache_exception_is_budget_deferred() -> None:
    assert issubclass(LLMCacheUnavailable, PipelineBudgetExhausted)


def test_missing_credentials_do_not_make_network_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_cache, "load_settings", lambda: {})
    monkeypatch.setattr(
        llm_cache.httpx,
        "get",
        lambda *_args, **_kwargs: pytest.fail("cache read made a network request"),
    )
    monkeypatch.setattr(
        llm_cache.httpx,
        "post",
        lambda *_args, **_kwargs: pytest.fail("cache write made a network request"),
    )

    assert load_cached_result(CACHE_KEY, stage="display") is None
    save_cached_result(CACHE_KEY, {"display_description": "Maison"}, stage="display", model="qwen")


def test_load_cached_result_reads_only_result_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_cache, "load_settings", lambda: SETTINGS)
    calls: dict[str, object] = {}

    def fake_get(url: str, **kwargs: object) -> httpx.Response:
        calls.update(url=url, **kwargs)
        return httpx.Response(200, json=[{"result": {"display_description": "Maison"}}])

    monkeypatch.setattr(llm_cache.httpx, "get", fake_get)

    assert load_cached_result(CACHE_KEY, stage="display") == {"display_description": "Maison"}
    assert calls["url"] == "https://supabase.test/rest/v1/llm_analysis_cache"
    assert calls["params"] == {
        "select": "result",
        "cache_key": f"eq.{CACHE_KEY}",
        "stage": "eq.display",
        "limit": "1",
    }
    assert calls["headers"] == {
        "apikey": "service-role-test",
        "Authorization": "Bearer service-role-test",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def test_load_cache_miss_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_cache, "load_settings", lambda: SETTINGS)
    monkeypatch.setattr(llm_cache.httpx, "get", lambda *_args, **_kwargs: httpx.Response(200, json=[]))

    assert load_cached_result(CACHE_KEY, stage="facts") is None


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503),
        httpx.Response(200, json={"result": {}}),
        httpx.Response(200, json=[{"result": []}]),
    ],
)
def test_configured_cache_read_errors_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response,
) -> None:
    monkeypatch.setattr(llm_cache, "load_settings", lambda: SETTINGS)
    monkeypatch.setattr(llm_cache.httpx, "get", lambda *_args, **_kwargs: response)

    with pytest.raises(LLMCacheUnavailable):
        load_cached_result(CACHE_KEY, stage="display")


def test_save_cached_result_upserts_validated_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_cache, "load_settings", lambda: SETTINGS)
    calls: dict[str, object] = {}

    def fake_post(url: str, **kwargs: object) -> httpx.Response:
        calls.update(url=url, **kwargs)
        return httpx.Response(204)

    monkeypatch.setattr(llm_cache.httpx, "post", fake_post)
    result = {"surface_m2": 80}

    assert save_cached_result(CACHE_KEY, result, stage="facts", model="qwen") is None
    assert calls["url"] == "https://supabase.test/rest/v1/llm_analysis_cache"
    assert calls["params"] == {"on_conflict": "cache_key,stage"}
    assert calls["json"] == {
        "cache_key": CACHE_KEY,
        "stage": "facts",
        "result": result,
        "model": "qwen",
    }
    assert calls["headers"]["Prefer"] == "resolution=merge-duplicates,return=minimal"


def test_configured_cache_write_errors_surface(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_cache, "load_settings", lambda: SETTINGS)
    monkeypatch.setattr(llm_cache.httpx, "post", lambda *_args, **_kwargs: httpx.Response(500))

    with pytest.raises(LLMCacheUnavailable):
        save_cached_result(CACHE_KEY, {"surface_m2": 80}, stage="facts", model="qwen")


@pytest.mark.parametrize(
    ("cache_key", "stage"),
    [("not-a-hash", "facts"), (CACHE_KEY, ""), (CACHE_KEY, "facts\ncurrent")],
)
def test_cache_arguments_are_validated(cache_key: str, stage: str) -> None:
    with pytest.raises(ValueError):
        load_cached_result(cache_key, stage=stage)
