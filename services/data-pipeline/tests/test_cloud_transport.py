import json

import httpx
import pytest

from src.source_task_deadline import SourceTaskDeadlineExceeded, source_task_deadline_scope
from src.sources.cloud_transport import SourceRelayTransport, configured_transport


def test_relay_preserves_source_status_and_never_forwards_authorization():
    transport = SourceRelayTransport("https://example.supabase.co/functions/v1/source-fetch-relay", "fetch-only")
    calls = []

    def upstream(request):
        import json
        calls.append(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer fetch-only"
        assert request.headers["x-region"] == "eu-west-3"
        return httpx.Response(403, headers={"x-immojudis-source-relay": "1", "cf-mitigated": "challenge"}, text="blocked")

    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    with httpx.Client(transport=transport) as client:
        response = client.get("https://www.petitesaffiches.fr/encheres-immobilieres/",
                              headers={"authorization": "never-forward", "user-agent": "collector"})
    assert response.status_code == 403
    assert response.text == "blocked"
    assert "authorization" not in calls[0]["headers"]
    assert calls[0]["headers"]["user-agent"] == "collector"


def test_gateway_errors_are_not_catalogue_pages():
    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401, text="Unauthorized")))
    with httpx.Client(transport=transport) as client, pytest.raises(
        httpx.TransportError, match=r"authentication rejected \(HTTP 401\)"
    ):
        client.get("https://cessions.immobilier-etat.gouv.fr/")


def test_relay_target_errors_are_distinguished_without_exposing_target():
    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(400, text="Target not allowed: secret-token")
        )
    )
    target = (
        "https://www.petitesaffiches.fr/vente/immobiliere/n/secret-token-165935.html"
        "?session=private-secret"
    )
    with httpx.Client(transport=transport) as client, pytest.raises(
        httpx.TransportError, match=r"target not allowed \(HTTP 400\)"
    ) as raised:
        client.get(target)
    message = str(raised.value)
    assert "secret-token" not in message
    assert "private-secret" not in message
    assert target not in message


def test_relay_gzip_is_decoded_exactly_once():
    import gzip
    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(
        200, headers={"x-immojudis-source-relay": "1", "content-encoding": "gzip"},
        content=gzip.compress(b"<html>catalogue</html>"))))
    with httpx.Client(transport=transport) as client:
        response = client.get("https://www.petitesaffiches.fr/encheres-immobilieres/")
    assert response.text == "<html>catalogue</html>"
    assert "content-encoding" not in response.headers


@pytest.mark.parametrize("url", ["https://evil.example/", "http://www.petitesaffiches.fr/",
                                 "https://www.petitesaffiches.fr:444/"])
def test_transport_rejects_other_origins(url):
    with httpx.Client(transport=SourceRelayTransport("https://example.supabase.co/relay", "test")) as client:
        with pytest.raises(ValueError):
            client.get(url)


def test_relay_configuration_is_opt_in_and_scoped(monkeypatch):
    monkeypatch.delenv("SOURCE_FETCH_RELAY_URL", raising=False)
    monkeypatch.delenv("SOURCE_FETCH_RELAY_TOKEN", raising=False)
    assert configured_transport("https://www.petitesaffiches.fr") is None
    monkeypatch.setenv("SOURCE_FETCH_RELAY_URL", "https://example.supabase.co/relay")
    assert configured_transport("https://www.licitor.com") is None
    with pytest.raises(ValueError):
        configured_transport("https://www.petitesaffiches.fr")


def test_relay_redirect_is_checked_by_source_guard(monkeypatch):
    from src.sources.common import PoliteHttpClient
    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    calls = []

    def upstream(request):
        calls.append(request)
        return httpx.Response(302, headers={"x-immojudis-source-relay": "1", "location": "https://evil.example/"})

    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    monkeypatch.setattr("src.sources.common.configured_transport", lambda _: transport)
    client = PoliteHttpClient("https://www.petitesaffiches.fr", "test", 0, 5)
    with pytest.raises(RuntimeError, match="outside configured"):
        client.get("https://www.petitesaffiches.fr/encheres-immobilieres/")
    assert len(calls) == 1
    robots_request = json.loads(calls[0].content)
    assert robots_request["url"] == "https://www.petitesaffiches.fr/robots.txt"
    assert robots_request["method"] == "GET"
    client._client.close()


def test_relay_deadline_expires_before_post_after_request_body(monkeypatch):
    now = [99.0]
    monkeypatch.setattr("src.source_task_deadline.time.monotonic", lambda: now[0])
    calls = []

    def upstream(request):
        calls.append(request)
        return httpx.Response(200, headers={"x-immojudis-source-relay": "1"}, text="ok")

    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    request = httpx.Request("GET", "https://www.petitesaffiches.fr/annonce")
    original_read = request.read

    def read_body():
        body = original_read()
        now[0] = 100.0
        return body

    request.read = read_body
    with source_task_deadline_scope(100.0), pytest.raises(
        SourceTaskDeadlineExceeded, match="preparing source relay POST"
    ):
        transport.handle_request(request)
    assert calls == []
    transport.close()


def test_relay_timeout_is_bounded_by_time_remaining_after_body(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("src.source_task_deadline.time.monotonic", lambda: now[0])
    seen = {}

    def upstream(request):
        seen["timeout"] = request.extensions["timeout"]
        return httpx.Response(200, headers={"x-immojudis-source-relay": "1"}, text="ok")

    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    request = httpx.Request(
        "GET",
        "https://www.petitesaffiches.fr/annonce",
        extensions={
            "timeout": {"connect": 30.0, "read": 30.0, "write": 30.0, "pool": 30.0}
        },
    )
    original_read = request.read

    def read_body():
        body = original_read()
        now[0] = 106.0
        return body

    request.read = read_body
    with source_task_deadline_scope(110.0):
        response = transport.handle_request(request)
    assert response.text == "ok"
    assert seen["timeout"] == {
        "connect": pytest.approx(4.0),
        "read": pytest.approx(4.0),
        "write": pytest.approx(4.0),
        "pool": pytest.approx(4.0),
    }
    response.close()
    transport.close()


def test_relay_defaults_to_forty_seconds_without_deadline_scope():
    seen = {}

    def upstream(request):
        seen["timeout"] = request.extensions["timeout"]
        return httpx.Response(200, headers={"x-immojudis-source-relay": "1"}, text="ok")

    transport = SourceRelayTransport("https://example.supabase.co/relay", "test")
    transport.client.close()
    transport.client = httpx.Client(transport=httpx.MockTransport(upstream))
    response = transport.handle_request(
        httpx.Request(
            "GET",
            "https://www.petitesaffiches.fr/annonce",
            extensions={
                "timeout": {"connect": 3.0, "read": 3.0, "write": 3.0, "pool": 3.0}
            },
        )
    )
    assert response.text == "ok"
    assert seen["timeout"] == {
        "connect": pytest.approx(40.0),
        "read": pytest.approx(40.0),
        "write": pytest.approx(40.0),
        "pool": pytest.approx(40.0),
    }
    response.close()
    transport.close()
