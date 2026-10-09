"""Listing images must be displayable cross-origin before reaching raw_payload (P2-17)."""

from __future__ import annotations

import httpx
import pytest

from src import image_validation
from src.image_validation import ImageValidator, filter_raw_image_url, is_excluded_image_url


@pytest.fixture(autouse=True)
def _enable_checks(monkeypatch):
    monkeypatch.setenv("IMAGE_VALIDATION_ENABLED", "true")


def _validator(handler) -> tuple[ImageValidator, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(record), follow_redirects=True)
    return ImageValidator(client=client), seen


def _image(status=200, content_type="image/jpeg", **headers):
    return lambda request: httpx.Response(status, headers={"content-type": content_type, **headers})


def test_excluded_urls() -> None:
    assert is_excluded_image_url("https://annonces-legales.petites-affiches.fr/vae/json/vignette/abc123")
    assert is_excluded_image_url("http://annonces-legales.petites-affiches.fr/vae/json/vignette/1.jpg")
    assert is_excluded_image_url("https://www.petitesaffiches.fr/wp-content/uploads/template-vlimmo.png")
    assert is_excluded_image_url("https://petitesaffiches.fr/template-vlimmo.png?v=2")
    assert not is_excluded_image_url("https://www.petitesaffiches.fr/wp-content/uploads/photo-bien.jpg")
    assert not is_excluded_image_url("https://cdn.example.test/vae/json/vignette/1.jpg")
    assert not is_excluded_image_url(None)


def test_excluded_urls_never_trigger_a_request() -> None:
    validator, seen = _validator(_image())

    assert validator.is_displayable("https://annonces-legales.petites-affiches.fr/vae/json/vignette/1") is False
    assert validator.is_displayable("https://www.petitesaffiches.fr/x/template-vlimmo.png") is False
    assert seen == []


def test_keeps_a_200_image_and_uses_head() -> None:
    validator, seen = _validator(_image(**{"cross-origin-resource-policy": "cross-origin"}))

    assert validator.is_displayable("https://cdn.example.test/a.jpg") is True
    assert [request.method for request in seen] == ["HEAD"]


@pytest.mark.parametrize(
    "handler",
    [
        _image(status=404),
        _image(status=403),
        _image(status=500),
        _image(content_type="application/json"),
        _image(content_type="text/html; charset=utf-8"),
        _image(**{"cross-origin-resource-policy": "same-origin"}),
        _image(**{"cross-origin-resource-policy": "Same-Origin"}),
        _image(**{"cross-origin-resource-policy": "same-site"}),
    ],
)
def test_rejects_blocked_or_non_image_responses(handler) -> None:
    validator, _ = _validator(handler)

    assert validator.is_displayable("https://cdn.example.test/a.jpg") is False


def test_content_type_parameters_and_missing_policy_are_fine() -> None:
    validator, _ = _validator(_image(content_type="image/webp; charset=binary"))

    assert validator.is_displayable("https://cdn.example.test/a.webp") is True


def test_results_are_cached_per_url() -> None:
    validator, seen = _validator(_image())

    for _ in range(3):
        assert validator.is_displayable("https://cdn.example.test/a.jpg") is True

    assert len(seen) == 1


def test_head_unsupported_falls_back_to_a_one_byte_range_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "HEAD":
            return httpx.Response(405)
        assert request.headers["range"] == "bytes=0-0"
        return httpx.Response(206, headers={"content-type": "image/png"}, content=b"x")

    validator, seen = _validator(handler)

    assert validator.is_displayable("https://cdn.example.test/a.png") is True
    assert [request.method for request in seen] == ["HEAD", "GET"]


def test_timeouts_reject_and_an_unreachable_host_stops_costing_time() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    validator, seen = _validator(handler)

    results = [validator.is_displayable(f"https://slow.example.test/{index}.jpg") for index in range(6)]

    assert results == [False] * 6
    assert len(seen) == image_validation.IMAGE_HOST_FAILURE_LIMIT


def test_relative_and_non_http_urls_are_rejected_without_a_request() -> None:
    validator, seen = _validator(_image())

    for url in ("/media/a.jpg", "//cdn.example.test/a.jpg", "data:image/png;base64,AAAA", "", "ftp://x/a.jpg"):
        assert validator.is_displayable(url) is False
    assert seen == []


def test_filter_replaces_a_blocked_primary_with_the_next_valid_source_image() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "blocked" in str(request.url):
            return httpx.Response(
                200, headers={"content-type": "image/jpeg", "cross-origin-resource-policy": "same-origin"}
            )
        return httpx.Response(200, headers={"content-type": "image/jpeg"})

    validator, _ = _validator(handler)
    payload = {
        "raw_image_url": "https://cdn.example.test/blocked.jpg",
        "source_images": ["https://cdn.example.test/blocked.jpg", "https://cdn.example.test/ok.jpg"],
        "other": 1,
    }

    assert filter_raw_image_url(payload, validator) is True

    assert payload["raw_image_url"] == "https://cdn.example.test/ok.jpg"
    assert payload["source_images"] == ["https://cdn.example.test/blocked.jpg", "https://cdn.example.test/ok.jpg"]


def test_filter_removes_raw_image_url_when_nothing_is_displayable() -> None:
    validator, _ = _validator(_image(status=404))
    payload = {"raw_image_url": "https://cdn.example.test/a.jpg", "source_images": ["https://cdn.example.test/a.jpg"]}

    assert filter_raw_image_url(payload, validator) is True

    assert "raw_image_url" not in payload
    assert payload["source_images"] == ["https://cdn.example.test/a.jpg"]


def test_filter_excludes_known_placeholders_even_when_network_checks_are_off(monkeypatch) -> None:
    monkeypatch.setenv("IMAGE_VALIDATION_ENABLED", "false")
    payload = {
        "raw_image_url": "https://annonces-legales.petites-affiches.fr/vae/json/vignette/1",
        "source_images": [
            "https://annonces-legales.petites-affiches.fr/vae/json/vignette/1",
            "https://www.petitesaffiches.fr/template-vlimmo.png",
            "/relative/photo.jpg",
        ],
    }

    assert filter_raw_image_url(payload) is True

    assert payload["raw_image_url"] == "/relative/photo.jpg"
    keep = {"raw_image_url": "/relative/photo.jpg"}
    assert filter_raw_image_url(keep) is False
    assert keep == {"raw_image_url": "/relative/photo.jpg"}
    only_placeholder = {"raw_image_url": "https://www.petitesaffiches.fr/template-vlimmo.png"}
    assert filter_raw_image_url(only_placeholder) is True
    assert only_placeholder == {}


def test_filter_leaves_payloads_without_images_alone() -> None:
    validator, _ = _validator(_image())
    payload = {"title": "x"}

    assert filter_raw_image_url(payload, validator) is False
    assert payload == {"title": "x"}


def test_finalizing_a_sale_applies_the_image_filter(monkeypatch) -> None:
    from src import main
    from src.normalize import normalize_sale

    validator, _ = _validator(_image(**{"cross-origin-resource-policy": "same-origin"}))
    monkeypatch.setattr(image_validation, "_VALIDATOR", validator)
    sale = normalize_sale(
        {
            "source_url": "https://example.test/annonce/1",
            "source_name": "licitor",
            "title": "Appartement",
            "raw_image_url": "https://cdn.example.test/blocked.jpg",
            "source_images": ["https://cdn.example.test/blocked.jpg"],
        }
    )
    sale.raw_payload["raw_image_url"] = "https://cdn.example.test/blocked.jpg"

    main._finalize_sale_for_app(sale, geocode=False)

    assert "raw_image_url" not in sale.raw_payload


def test_warm_checks_primary_images_concurrently_and_fills_the_cache(monkeypatch) -> None:
    validator, seen = _validator(_image())
    monkeypatch.setattr(image_validation, "_VALIDATOR", validator)

    class Sale:
        def __init__(self, url: str) -> None:
            self.raw_payload = {"raw_image_url": url, "source_images": [url, url + "?alt"]}

    sales = [Sale(f"https://cdn.example.test/{index}.jpg") for index in range(5)]
    image_validation.warm_image_validations(sales)

    assert len(seen) == 5
    for sale in sales:
        assert filter_raw_image_url(sale.raw_payload) is False
    assert len(seen) == 5
