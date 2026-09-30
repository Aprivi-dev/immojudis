import time

import httpx
import pytest

from src.sources import common


class _Response:
    def __init__(
        self,
        status_code: int,
        *,
        text: str = "",
        location: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.text = text
        self.headers = dict(headers or {})
        if location:
            self.headers["location"] = location

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _patch_http_client(monkeypatch, response_batches):
    clients = []

    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs
            self.responses = list(response_batches.pop(0))
            self.calls: list[tuple[str, str]] = []
            clients.append(self)

        def _next(self, method: str, url: str):
            self.calls.append((method, url))
            if not self.responses:
                raise AssertionError(f"unexpected HTTP request: {method} {url}")
            response = self.responses.pop(0)
            if isinstance(response, BaseException):
                raise response
            return response

        def get(self, url: str):
            return self._next("GET", url)

        def request(self, method: str, url: str, **kwargs: object):
            del kwargs
            return self._next(method, url)

    monkeypatch.setattr(common.httpx, "Client", Client)
    return clients


@pytest.mark.parametrize(
    "robots_response",
    [httpx.ReadTimeout("robots timeout"), _Response(503, text="upstream unavailable")],
)
def test_polite_client_blocks_catalogue_when_robots_is_unavailable(monkeypatch, robots_response) -> None:
    clients = _patch_http_client(monkeypatch, [[robots_response]])
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    with pytest.raises(common.RobotsUnavailableError) as caught:
        client.get("https://source.example/catalogue")

    assert isinstance(caught.value, httpx.NetworkError)
    assert "robots.txt could not be verified" in str(caught.value)
    assert "does not allow" not in str(caught.value)
    assert clients[0].calls == [("GET", "https://source.example/robots.txt")]


@pytest.mark.parametrize("status_code", [404, 410])
def test_polite_client_treats_absent_robots_as_empty_policy(monkeypatch, status_code) -> None:
    clients = _patch_http_client(
        monkeypatch,
        [[
            _Response(status_code, text="User-agent: *\nDisallow: /catalogue"),
            _Response(200, text="catalogue"),
        ]],
    )
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert client.get("https://source.example/catalogue") == "catalogue"
    assert clients[0].calls == [
        ("GET", "https://source.example/robots.txt"),
        ("GET", "https://source.example/catalogue"),
    ]


@pytest.mark.parametrize("status_code", [404, 410])
def test_polite_client_ignores_absent_robots_body_after_redirect(monkeypatch, status_code) -> None:
    clients = _patch_http_client(
        monkeypatch,
        [[
            _Response(200, text="User-agent: *\nAllow: /"),
            _Response(302, location="https://cdn.example/landing"),
            _Response(status_code, text="User-agent: *\nDisallow: /landing"),
            _Response(200, text="catalogue"),
        ]],
    )
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        allowed_redirect_origins=("https://cdn.example",),
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert client.get("https://source.example/catalogue") == "catalogue"
    assert clients[0].calls == [
        ("GET", "https://source.example/robots.txt"),
        ("GET", "https://source.example/catalogue"),
        ("GET", "https://cdn.example/robots.txt"),
        ("GET", "https://cdn.example/landing"),
    ]


def test_polite_client_recovers_with_a_new_client_after_robots_failure(monkeypatch) -> None:
    clients = _patch_http_client(
        monkeypatch,
        [
            [httpx.ReadTimeout("robots timeout")],
            [
                _Response(200, text="User-agent: *\nAllow: /"),
                _Response(200, text="catalogue"),
            ],
        ],
    )
    first = common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )
    with pytest.raises(common.RobotsUnavailableError):
        first.get("https://source.example/catalogue")

    second = common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )
    assert second.get("https://source.example/catalogue") == "catalogue"
    assert len(clients) == 2
    assert clients[1].calls == [
        ("GET", "https://source.example/robots.txt"),
        ("GET", "https://source.example/catalogue"),
    ]


@pytest.mark.parametrize(
    "robots_response, exception_type",
    [
        (_Response(403, text="<html><body>challenge</body></html>"), common.RobotsAccessRefusedError),
        (
            _Response(200, text="<!doctype html><html><body>Just a moment...</body></html>"),
            common.RobotsAccessRefusedError,
        ),
        (
            _Response(
                200,
                text="<html><body>Please enable JavaScript</body></html>",
                headers={"content-type": "text/html; charset=utf-8"},
            ),
            common.RobotsAccessRefusedError,
        ),
    ],
)
def test_polite_client_does_not_interpret_html_or_403_as_empty_robots(
    monkeypatch, robots_response, exception_type
) -> None:
    clients = _patch_http_client(monkeypatch, [[robots_response]])
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    with pytest.raises(exception_type):
        client.get("https://source.example/catalogue")
    assert clients[0].calls == [("GET", "https://source.example/robots.txt")]


def test_polite_client_keeps_actual_rules_when_plain_text_is_mislabeled_html(monkeypatch) -> None:
    clients = _patch_http_client(
        monkeypatch,
        [[
            _Response(
                200,
                text="User-agent: *\nDisallow: /private\nAllow: /",
                headers={"content-type": "text/html; charset=utf-8"},
            ),
            _Response(200, text="catalogue"),
        ]],
    )
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert client.get("https://source.example/catalogue") == "catalogue"
    assert clients[0].calls[-1] == ("GET", "https://source.example/catalogue")


@pytest.mark.parametrize(
    "redirect_robots_response",
    [httpx.ReadTimeout("redirect robots timeout"), _Response(503)],
)
def test_polite_client_blocks_redirect_target_when_robots_is_unavailable(
    monkeypatch, redirect_robots_response
) -> None:
    clients = _patch_http_client(
        monkeypatch,
        [
            [
                _Response(200, text="User-agent: *\nAllow: /"),
                _Response(302, location="https://cdn.example/landing"),
                redirect_robots_response,
            ]
        ],
    )
    client = common.PoliteHttpClient(
        base_url="https://source.example",
        allowed_redirect_origins=("https://cdn.example",),
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    with pytest.raises(common.RobotsUnavailableError, match="could not be verified"):
        client.get("https://source.example/catalogue")
    assert clients[0].calls == [
        ("GET", "https://source.example/robots.txt"),
        ("GET", "https://source.example/catalogue"),
        ("GET", "https://cdn.example/robots.txt"),
    ]


def test_polite_client_accepts_configured_canonical_robots_redirect(monkeypatch) -> None:
    requested: list[str] = []

    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str) -> _Response:
            requested.append(url)
            if url == "https://www.encheres-publiques.com/robots.txt":
                return _Response(301, location="https://encheres-publiques.com/robots.txt")
            return _Response(200, text="User-agent: *\nDisallow: /services")

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://www.encheres-publiques.com",
        allowed_redirect_origins=("https://encheres-publiques.com",),
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert requested == [
        "https://www.encheres-publiques.com/robots.txt",
        "https://encheres-publiques.com/robots.txt",
    ]
    assert client._robots.can_fetch("https://encheres-publiques.com/encheres/immobilier/lot_1")
    assert not client._robots.can_fetch("https://encheres-publiques.com/services")


def test_polite_client_rejects_unconfigured_robots_redirect(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str) -> _Response:
            del url
            return _Response(301, location="https://evil.example/robots.txt")

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://www.encheres-publiques.com",
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    assert client._robots == common.RobotsRules()


def test_polite_client_verifies_redirect_origin_robots_before_fetch(monkeypatch) -> None:
    requested: list[str] = []

    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str) -> _Response:
            requested.append(url)
            if url == "https://www.agorastore.fr/robots.txt":
                return _Response(200, text="User-agent: *\n")
            if url == "https://www.agorastore-immo.fr/robots.txt":
                return _Response(200, text="User-agent: *\nDisallow: /vente-occasion/")
            raise AssertionError(f"unexpected request: {url}")

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://www.agorastore.fr",
        allowed_redirect_origins=("https://www.agorastore-immo.fr",),
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    with pytest.raises(RuntimeError, match="robots.txt does not allow"):
        client._guard("https://www.agorastore-immo.fr/vente-occasion/item-407453.aspx")
    assert requested == [
        "https://www.agorastore.fr/robots.txt",
        "https://www.agorastore-immo.fr/robots.txt",
    ]


def test_polite_client_fails_closed_when_redirect_origin_robots_are_unavailable(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def get(self, url: str) -> _Response:
            if url == "https://www.agorastore.fr/robots.txt":
                return _Response(200, text="User-agent: *\n")
            return _Response(503)

    monkeypatch.setattr(common.httpx, "Client", Client)
    client = common.PoliteHttpClient(
        base_url="https://www.agorastore.fr",
        allowed_redirect_origins=("https://www.agorastore-immo.fr",),
        user_agent="immojudis-test",
        delay_seconds=0,
        timeout_seconds=1,
    )

    with pytest.raises(RuntimeError, match="could not be verified"):
        client._guard("https://www.agorastore-immo.fr/vente-occasion/item-407453.aspx")


def test_agrasc_intermediate_does_not_disable_root_or_hostname_validation():
    import hashlib
    import ssl
    from pathlib import Path

    from src.sources import agrasc
    from src.sources.agrasc import agrasc_tls_context

    context = agrasc_tls_context()
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert not context.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN
    certificate = Path(agrasc.__file__).with_name("certificates") / "sectigo-qualified-r39.pem"
    der = ssl.PEM_cert_to_DER_cert(certificate.read_text())
    assert hashlib.sha256(der).hexdigest() == "ac8c7ef96eb4b535fbfb4e7521f130536198a60dff716312b22d4acc4afe9a7d"


def test_listing_signature_requires_date_and_price_before_skipping_detail() -> None:
    url = "https://example.test/auction/1"

    assert common.listing_signature({"sale_date": "10 janvier 2027", "starting_price_eur": None}) is None
    assert common.listing_signature({"sale_date": None, "starting_price_eur": 100000}) is None
    assert common.should_fetch_detail(
        {"source_url": url, "sale_date": "10 janvier 2027", "starting_price_eur": None},
        {url: "2027-01-10|"},
    ) is True


def test_listing_signature_skips_known_unchanged_card_when_both_values_are_present() -> None:
    url = "https://example.test/auction/1"

    sale = {"source_url": url, "sale_date": "10 janvier 2027", "starting_price_eur": 100000}

    assert common.should_fetch_detail(sale, {url: "2027-01-10|100000"}) is False
    assert sale["_known_unchanged"] is True


def test_parse_html_rejects_oversized_source_body() -> None:
    with pytest.raises(common.SourceParseLimitExceeded):
        common.parse_html("x" * (common.MAX_SOURCE_HTML_CHARS + 1))


def test_parse_html_interrupts_a_slow_parser(monkeypatch) -> None:
    def slow_parser(*_args, **_kwargs):
        time.sleep(0.05)
        return object()

    monkeypatch.setattr(common, "BeautifulSoup", slow_parser)
    with pytest.raises(common.SourceParseTimeout):
        common.parse_html("<html></html>", timeout_seconds=0.01)
