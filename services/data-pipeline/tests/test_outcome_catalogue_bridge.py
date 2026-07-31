from __future__ import annotations

import httpx
import pytest

from src.outcome_ingestion.catalogue_bridge import (
    BRIDGE_RPC_NAME,
    OutcomeCatalogueBridgeError,
    bridge_auction_sales_before_cleanup,
)


def _response(payload: object, *, status_code: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code,
        json=payload,
        request=httpx.Request("POST", "https://example.supabase.co/rest/v1/rpc/bridge"),
    )


def _settings() -> dict[str, object]:
    return {
        "supabase_url": "https://example.supabase.co/",
        "supabase_service_role_key": "service-role-secret",
    }


def test_bridge_calls_the_service_role_rpc_without_serializing_sale_money() -> None:
    calls: list[dict[str, object]] = []

    def post(url: str, **kwargs: object) -> httpx.Response:
        calls.append({"url": url, **kwargs})
        return _response(
            [
                {
                    "scanned_count": 413,
                    "created_count": 413,
                    "reused_count": 0,
                    "linked_count": 413,
                    "complete": True,
                }
            ]
        )

    result = bridge_auction_sales_before_cleanup(_settings(), post=post)

    assert result.scanned_count == 413
    assert result.remaining_unlinked == 0
    assert calls[0]["url"] == (
        f"https://example.supabase.co/rest/v1/rpc/{BRIDGE_RPC_NAME}"
    )
    assert calls[0]["json"] == {}
    headers = calls[0]["headers"]
    assert isinstance(headers, dict)
    assert headers["apikey"] == "service-role-secret"
    assert headers["Authorization"] == "Bearer service-role-secret"


def test_bridge_accepts_an_idempotent_replay() -> None:
    result = bridge_auction_sales_before_cleanup(
        _settings(),
        post=lambda *_args, **_kwargs: _response(
            [
                {
                    "scanned_count": "413",
                    "created_count": "0",
                    "reused_count": "413",
                    "linked_count": "413",
                    "complete": True,
                }
            ]
        ),
    )

    assert result.created_count == 0
    assert result.reused_count == 413


@pytest.mark.parametrize(
    "payload",
    [
        [],
        [{"scanned_count": 1}],
        [
            {
                "scanned_count": 2,
                "created_count": 1,
                "reused_count": 0,
                "linked_count": 1,
                "complete": False,
            }
        ],
        [
            {
                "scanned_count": 2,
                "created_count": 2,
                "reused_count": 1,
                "linked_count": 2,
                "complete": True,
            }
        ],
    ],
)
def test_bridge_fails_closed_on_incomplete_or_incoherent_results(payload: object) -> None:
    with pytest.raises(OutcomeCatalogueBridgeError, match="cleanup is disabled|field|shape|counters"):
        bridge_auction_sales_before_cleanup(
            _settings(),
            post=lambda *_args, **_kwargs: _response(payload),
        )


def test_bridge_fails_closed_without_service_credentials() -> None:
    called = False

    def post(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal called
        called = True
        return _response([])

    with pytest.raises(OutcomeCatalogueBridgeError, match="supabase_service_role_key"):
        bridge_auction_sales_before_cleanup(
            {"supabase_url": "https://example.supabase.co"},
            post=post,
        )

    assert called is False


def test_bridge_fails_closed_on_http_error_without_echoing_response_body() -> None:
    with pytest.raises(OutcomeCatalogueBridgeError, match="HTTP 503") as error:
        bridge_auction_sales_before_cleanup(
            _settings(),
            post=lambda *_args, **_kwargs: _response(
                {"message": "database details must stay private"},
                status_code=503,
            ),
        )

    assert "database details" not in str(error.value)
