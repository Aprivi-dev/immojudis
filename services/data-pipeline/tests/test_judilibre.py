from __future__ import annotations

import base64
from urllib.parse import parse_qs

import httpx
import pytest

from src.config import load_settings
from src.official_sources.base import (
    OfficialSourceConfigurationError,
    OfficialSourceDisabledError,
    OfficialSourceDryRun,
    OfficialSourceHTTPError,
    RetryPolicy,
    canonical_sha256,
)
from src.official_sources.judilibre import (
    JUDILIBRE_PRODUCTION_BASE_URL,
    JudilibreClient,
    JudilibreCredentials,
    JudilibreDecision,
    JudilibreHistoryCursor,
    JudilibreSearchQuery,
)


def _search_payload(*, page: int = 0, page_size: int = 2, total: int = 1) -> dict[str, object]:
    return {
        "page": page,
        "page_size": page_size,
        "query": {},
        "total": total,
        "next_page": None,
        "results": [
            {
                "id": f"decision-{page * page_size + offset}",
                "jurisdiction": "tj",
                "decision_date": "2025-01-02",
                "future_api_field": {"kept": True},
            }
            for offset in range(min(page_size, max(0, total - page * page_size)))
        ],
    }


def _keyid_client(
    handler: httpx.MockTransport,
    *,
    sleep=lambda _seconds: None,
    retry_policy: RetryPolicy | None = None,
    page_size: int = 2,
    **kwargs: object,
) -> JudilibreClient:
    return JudilibreClient(
        credentials=JudilibreCredentials(key_id="private-key-id", auth_mode="keyid"),
        policy_allows_network=True,
        transport=handler,
        sleep=sleep,
        retry_policy=retry_policy or RetryPolicy(max_retries=2, backoff_seconds=0, max_sleep_seconds=5),
        page_size=page_size,
        **kwargs,
    )


def test_client_is_fail_closed_until_policy_is_approved() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_search_payload())

    client = JudilibreClient(
        credentials=JudilibreCredentials(key_id="private-key-id"),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(OfficialSourceDisabledError, match="source policy"):
        client.search()
    assert calls == 0


def test_dry_run_never_sends_a_request_or_discloses_query() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_search_payload())

    client = _keyid_client(httpx.MockTransport(handler), dry_run=True)
    with pytest.raises(OfficialSourceDryRun) as raised:
        client.search(JudilibreSearchQuery(query="sensitive case query"))
    assert str(raised.value) == "dry-run mode: request not sent (GET /search)"
    assert calls == 0


def test_keyid_auth_search_parameters_and_unknown_response_fields_are_preserved() -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        payload = _search_payload(page_size=25)
        payload["response_schema_version"] = "future-v2"
        return httpx.Response(200, json=payload)

    client = _keyid_client(httpx.MockTransport(handler), page_size=25)
    page = client.search(
        JudilibreSearchQuery(
            query="adjudication immobilière",
            jurisdiction=["tj", "ca"],
            decision_types=["jugement"],
            resolve_references=True,
        )
    )

    assert len(observed) == 1
    request = observed[0]
    assert request.url.host == "api.piste.gouv.fr"
    assert request.url.path == "/cassation/judilibre/v1.0/search"
    assert request.headers["KeyId"] == "private-key-id"
    assert "authorization" not in request.headers
    assert request.url.params.get_list("jurisdiction") == ["tj", "ca"]
    assert request.url.params.get_list("type") == ["jugement"]
    assert request.url.params["page_size"] == "25"
    assert request.url.params["resolve_references"] == "true"
    assert page.model_extra == {"response_schema_version": "future-v2"}
    assert page.results[0].model_extra == {"future_api_field": {"kept": True}}


def test_oauth2_client_credentials_are_cached_and_used_as_bearer_token() -> None:
    token_calls = 0
    api_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_calls, api_calls
        if request.url.host == "oauth.piste.gouv.fr":
            token_calls += 1
            scheme, encoded = request.headers["Authorization"].split(" ", 1)
            assert scheme == "Basic"
            assert base64.b64decode(encoded).decode() == "oauth-client:oauth-secret"
            assert parse_qs(request.content.decode()) == {
                "grant_type": ["client_credentials"],
                "scope": ["openid judilibre"],
            }
            return httpx.Response(200, json={"access_token": "short-lived-token", "expires_in": 300})
        api_calls += 1
        assert request.headers["Authorization"] == "Bearer short-lived-token"
        assert "keyid" not in request.headers
        return httpx.Response(200, json=_search_payload(page_size=25))

    client = JudilibreClient(
        credentials=JudilibreCredentials(
            oauth_client_id="oauth-client",
            oauth_client_secret="oauth-secret",
            oauth_scope="openid judilibre",
            auth_mode="oauth2",
        ),
        policy_allows_network=True,
        page_size=25,
        transport=httpx.MockTransport(handler),
        monotonic=lambda: 100.0,
    )
    client.search()
    client.search()

    assert token_calls == 1
    assert api_calls == 2


def test_piste_form_oauth_uses_documented_default_openid_scope() -> None:
    token_forms: list[dict[str, list[str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth.piste.gouv.fr":
            assert "authorization" not in request.headers
            token_forms.append(parse_qs(request.content.decode()))
            return httpx.Response(
                200,
                json={"access_token": "access-token", "token_type": "Bearer", "expires_in": 300},
            )
        assert request.headers["Authorization"] == "Bearer access-token"
        return httpx.Response(200, json=_search_payload(page_size=25))

    client = JudilibreClient.from_settings(
        {
            "judilibre_enabled": True,
            "judilibre_auth_mode": "oauth2",
            "judilibre_oauth_client_id": "oauth-client",
            "judilibre_oauth_client_secret": "oauth-secret",
            "judilibre_oauth_client_auth_method": "form",
            "judilibre_page_size": 25,
        },
        transport=httpx.MockTransport(handler),
        monotonic=lambda: 100.0,
    )

    client.search()

    assert token_forms == [
        {
            "grant_type": ["client_credentials"],
            "client_id": ["oauth-client"],
            "client_secret": ["oauth-secret"],
            "scope": ["openid"],
        }
    ]


def test_combined_piste_auth_sends_keyid_and_bearer() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth.piste.gouv.fr":
            return httpx.Response(200, json={"access_token": "access-token", "expires_in": 300})
        assert request.headers["KeyId"] == "application-key"
        assert request.headers["Authorization"] == "Bearer access-token"
        return httpx.Response(200, json=_search_payload(page_size=25))

    client = JudilibreClient(
        credentials=JudilibreCredentials(
            key_id=" application-key ",
            oauth_client_id="oauth-client",
            oauth_client_secret="oauth-secret",
            auth_mode="keyid+oauth2",
        ),
        policy_allows_network=True,
        page_size=25,
        transport=httpx.MockTransport(handler),
        monotonic=lambda: 100.0,
    )

    client.search()


def test_oauth2_token_is_refreshed_once_after_unauthorized() -> None:
    token_calls = 0
    seen_bearers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_calls
        if request.url.host == "oauth.piste.gouv.fr":
            token_calls += 1
            return httpx.Response(200, json={"access_token": f"token-{token_calls}", "expires_in": 300})
        seen_bearers.append(request.headers["Authorization"])
        if len(seen_bearers) == 1:
            return httpx.Response(401, json={"error": "expired"})
        return httpx.Response(200, json=_search_payload(page_size=25))

    client = JudilibreClient(
        credentials=JudilibreCredentials(
            oauth_client_id="oauth-client",
            oauth_client_secret="oauth-secret",
            auth_mode="oauth2",
        ),
        policy_allows_network=True,
        page_size=25,
        transport=httpx.MockTransport(handler),
        monotonic=lambda: 100.0,
    )
    client.search()

    assert token_calls == 2
    assert seen_bearers == ["Bearer token-1", "Bearer token-2"]


@pytest.mark.parametrize("status_code", [423, 429, 503])
def test_retryable_gateway_statuses_honor_retry_after(status_code: int) -> None:
    calls = 0
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(status_code, headers={"Retry-After": "2"})
        return httpx.Response(200, json=_search_payload(page_size=25))

    client = _keyid_client(
        httpx.MockTransport(handler),
        page_size=25,
        sleep=sleeps.append,
        retry_policy=RetryPolicy(max_retries=1, backoff_seconds=0.25, max_sleep_seconds=5),
    )
    client.search()

    assert calls == 2
    assert sleeps == [2.0]


def test_exhausted_429_retries_raise_a_sanitized_http_error() -> None:
    calls = 0
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(429, headers={"Retry-After": "1"}, json={"secret": "hidden"})

    client = _keyid_client(
        httpx.MockTransport(handler),
        sleep=sleeps.append,
        retry_policy=RetryPolicy(max_retries=1, backoff_seconds=0, max_sleep_seconds=5),
    )
    with pytest.raises(OfficialSourceHTTPError) as raised:
        client.search()

    assert calls == 2
    assert sleeps == [1.0]
    assert raised.value.status_code == 429
    assert "hidden" not in str(raised.value)


@pytest.mark.parametrize("status_code", [200, 201, 206])
def test_json_endpoints_accept_successful_2xx_responses(status_code: int) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=_search_payload())

    assert _keyid_client(httpx.MockTransport(handler)).search().results[0].id == "decision-0"


def test_empty_success_response_is_rejected_as_a_protocol_error() -> None:
    client = _keyid_client(httpx.MockTransport(lambda _request: httpx.Response(204)))

    with pytest.raises(OfficialSourceHTTPError) as raised:
        client.search()

    assert raised.value.status_code == 204


def test_conditional_decision_fetch_represents_304_without_parsing_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["If-None-Match"] == '"version-1"'
        assert request.headers["If-Modified-Since"] == "Wed, 21 Oct 2015 07:28:00 GMT"
        return httpx.Response(
            304,
            headers={
                "ETag": '"version-1"',
                "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
            },
        )

    result = _keyid_client(httpx.MockTransport(handler)).fetch_decision(
        "decision-1",
        if_none_match='"version-1"',
        if_modified_since="Wed, 21 Oct 2015 07:28:00 GMT",
    )

    assert result.not_modified is True
    assert result.status_code == 304
    assert result.decision is None
    assert result.etag == '"version-1"'


def test_conditional_headers_reject_line_breaks_before_network() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(304)

    client = _keyid_client(httpx.MockTransport(handler))
    with pytest.raises(OfficialSourceConfigurationError, match="validator"):
        client.fetch_decision("decision-1", if_none_match='"safe"\r\nKeyId: injected')
    assert calls == 0


def test_redirect_is_refused_without_following_or_disclosing_location() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            302,
            headers={"Location": "https://attacker.invalid/collect?secret=leaked-value"},
        )

    client = _keyid_client(httpx.MockTransport(handler))
    with pytest.raises(OfficialSourceHTTPError) as raised:
        client.search()

    assert calls == 1
    assert "302" in str(raised.value)
    assert "attacker" not in str(raised.value)
    assert "leaked-value" not in str(raised.value)


def test_iter_search_uses_bounded_page_numbers_and_max_results() -> None:
    requested_pages: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        requested_pages.append(page)
        payload = _search_payload(page=page, page_size=2, total=5)
        payload["next_page"] = (
            f"{JUDILIBRE_PRODUCTION_BASE_URL}/search?page={page + 1}" if page < 2 else None
        )
        return httpx.Response(200, json=payload)

    client = _keyid_client(httpx.MockTransport(handler), page_size=2)
    results = list(client.iter_search(JudilibreSearchQuery(query="adjudication"), max_results=3))

    assert [result.id for result in results] == ["decision-0", "decision-1", "decision-2"]
    assert requested_pages == [0, 1]


def test_direct_search_cannot_cross_the_ten_thousand_result_window() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_search_payload())

    client = _keyid_client(httpx.MockTransport(handler), page_size=25)
    with pytest.raises(ValueError, match="10,000-result window"):
        client.search(JudilibreSearchQuery(page=400))
    assert calls == 0


def test_transactional_history_cursor_tracks_updates_and_deletions() -> None:
    requested_from_ids: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        from_id = request.url.params.get("from_id")
        requested_from_ids.append(from_id)
        if from_id is None:
            return httpx.Response(
                200,
                json={
                    "transactions": [
                        {"id": "decision-a", "action": "updated", "date": "2025-01-15T10:00:00Z"},
                        {"id": "decision-b", "action": "deleted", "date": "2025-01-15T10:01:00Z"},
                    ],
                    "page_size": 10,
                    "total": 3,
                    "query_date": "2025-01-15T11:00:00Z",
                    "next_page": "date=2025-01-01T00%3A00%3A00Z&page_size=10&from_id=opaque%262",
                },
            )
        assert from_id == "opaque&2"
        return httpx.Response(
            200,
            json={
                "transactions": [
                    {"id": "decision-c", "action": "created", "date": "2025-01-15T10:02:00Z"}
                ],
                "page_size": 10,
                "total": 3,
                "query_date": "2025-01-15T11:00:01Z",
                "next_page": None,
            },
        )

    client = _keyid_client(httpx.MockTransport(handler), history_page_size=10)
    cursor = JudilibreHistoryCursor(date="2025-01-01T00:00:00Z", page_size=10)
    pages = list(client.iter_transactional_history(cursor))

    assert requested_from_ids == [None, "opaque&2"]
    assert pages[0].has_deletions is True
    assert pages[0].transactions[1].is_deletion is True
    assert pages[1].has_deletions is False


def test_history_terminal_page_may_report_zero_actual_results() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "transactions": [],
                "page_size": 0,
                "total": 0,
                "query_date": "2025-01-15T11:00:01Z",
                "next_page": None,
            },
        )

    client = _keyid_client(httpx.MockTransport(handler), history_page_size=10)
    page = client.transactional_history(since="2025-01-01", page_size=10)

    assert page.page_size == 0
    assert page.transactions == []


def test_history_cursor_without_page_size_preserves_the_requested_size() -> None:
    requested_page_sizes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_page_sizes.append(request.url.params["page_size"])
        if len(requested_page_sizes) == 1:
            return httpx.Response(
                200,
                json={
                    "transactions": [
                        {"id": "decision-a", "action": "updated", "date": "2025-01-15T10:00:00Z"}
                    ],
                    "page_size": 10,
                    "total": 1,
                    "query_date": "2025-01-15T11:00:00Z",
                    "next_page": "date=2025-01-01T00%3A00%3A00Z&from_id=cursor-2",
                },
            )
        return httpx.Response(
            200,
            json={
                "transactions": [],
                "page_size": 0,
                "total": 1,
                "query_date": "2025-01-15T11:00:01Z",
                "next_page": None,
            },
        )

    client = _keyid_client(httpx.MockTransport(handler), history_page_size=10)
    pages = list(
        client.iter_transactional_history(
            JudilibreHistoryCursor(date="2025-01-01T00:00:00Z", page_size=10)
        )
    )

    assert len(pages) == 2
    assert requested_page_sizes == ["10", "10"]


def test_history_cursor_cannot_move_the_initial_date_forward() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "transactions": [
                    {"id": "decision-a", "action": "updated", "date": "2025-01-15T10:00:00Z"}
                ],
                "page_size": 10,
                "total": 1,
                "query_date": "2025-01-15T11:00:00Z",
                "next_page": "date=2025-01-02T00%3A00%3A00Z&page_size=10&from_id=cursor-2",
            },
        )

    client = _keyid_client(httpx.MockTransport(handler), history_page_size=10)
    with pytest.raises(OfficialSourceConfigurationError, match="boundary"):
        list(
            client.iter_transactional_history(
                JudilibreHistoryCursor(date="2025-01-01T00:00:00Z", page_size=10)
            )
        )


def test_history_cursor_accepts_same_origin_absolute_url_and_rejects_external_origin() -> None:
    cursor = JudilibreHistoryCursor.from_next_page(
        f"{JUDILIBRE_PRODUCTION_BASE_URL}/transactionalhistory"
        "?date=2025-01-01T00%3A00%3A00Z&page_size=100&from_id=cursor-2",
        base_url=JUDILIBRE_PRODUCTION_BASE_URL,
    )
    assert cursor.from_id == "cursor-2"

    with pytest.raises(OfficialSourceConfigurationError, match="unexpected origin"):
        JudilibreHistoryCursor.from_next_page(
            "https://attacker.invalid/transactionalhistory?date=2025-01-01&page_size=100",
            base_url=JUDILIBRE_PRODUCTION_BASE_URL,
        )


def test_decision_deletion_flag_and_canonical_hash_are_deterministic() -> None:
    left = JudilibreDecision.model_validate(
        {
            "id": "decision-1",
            "to_be_deleted": True,
            "decision_date": "2025-01-02",
            "unknown": {"b": 2, "a": 1},
        }
    )
    right = JudilibreDecision.model_validate(
        {
            "unknown": {"a": 1, "b": 2},
            "decision_date": "2025-01-02",
            "to_be_deleted": True,
            "id": "decision-1",
        }
    )

    assert left.is_deletion is True
    assert left.canonical_json() == right.canonical_json()
    assert left.canonical_sha256() == right.canonical_sha256()
    assert left.canonical_sha256() == canonical_sha256(left)
    assert len(left.canonical_sha256()) == 64


def test_errors_and_credential_repr_do_not_expose_secrets() -> None:
    credentials = JudilibreCredentials(
        oauth_client_id="client-should-not-leak",
        oauth_client_secret="secret-should-not-leak",
        auth_mode="oauth2",
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "error": "secret-should-not-leak",
                "client": "client-should-not-leak",
            },
        )

    client = JudilibreClient(
        credentials=credentials,
        policy_allows_network=True,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(OfficialSourceHTTPError) as raised:
        client.search()

    rendered = f"{credentials!r} {raised.value!r} {raised.value}"
    assert "secret-should-not-leak" not in rendered
    assert "client-should-not-leak" not in rendered


def test_response_validation_errors_hide_judicial_input_values() -> None:
    sensitive_value = "Mme SECRET PERSONNE"

    with pytest.raises(ValueError) as raised:
        JudilibreDecision.model_validate(
            {
                "id": "decision-1",
                "decision_date": sensitive_value,
            }
        )

    assert sensitive_value not in str(raised.value)


def test_settings_add_judilibre_without_enabling_it_by_default(monkeypatch) -> None:
    monkeypatch.setenv("JUDILIBRE_ENABLED", "false")
    monkeypatch.setenv("JUDILIBRE_KEY_ID", "setting-secret")
    monkeypatch.setenv("JUDILIBRE_PAGE_SIZE", "500")
    monkeypatch.setenv("JUDILIBRE_HISTORY_PAGE_SIZE", "1")
    monkeypatch.setenv("JUDILIBRE_MAX_RESULTS", "999999")

    settings = load_settings()

    assert settings["judilibre_enabled"] is False
    assert settings["judilibre_base_url"] == JUDILIBRE_PRODUCTION_BASE_URL
    assert settings["judilibre_page_size"] == 50
    assert settings["judilibre_history_page_size"] == 10
    assert settings["judilibre_max_results"] == 10_000


def test_only_approved_piste_api_origins_are_accepted() -> None:
    with pytest.raises(OfficialSourceConfigurationError, match="approved PISTE endpoint"):
        JudilibreClient(
            credentials=JudilibreCredentials(key_id="private-key-id"),
            base_url="https://attacker.invalid/cassation/judilibre/v1.0",
        )


def test_oauth_credentials_cannot_be_sent_to_a_custom_token_origin() -> None:
    with pytest.raises(OfficialSourceConfigurationError, match="approved PISTE environment"):
        JudilibreClient(
            credentials=JudilibreCredentials(
                oauth_client_id="client",
                oauth_client_secret="secret",
                auth_mode="oauth2",
            ),
            oauth_token_url="https://attacker.invalid/token",
        )


def test_transactional_history_endpoint_casing_is_configurable() -> None:
    observed_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed_paths.append(request.url.path)
        return httpx.Response(
            200,
            json={
                "transactions": [],
                "page_size": 10,
                "total": 0,
                "query_date": "2025-01-15T11:00:01Z",
            },
        )

    client = _keyid_client(
        httpx.MockTransport(handler),
        history_page_size=10,
        transactional_history_path="/transactionalHistory",
    )
    client.transactional_history(since="2025-01-01", page_size=10)

    assert observed_paths == ["/cassation/judilibre/v1.0/transactionalHistory"]
