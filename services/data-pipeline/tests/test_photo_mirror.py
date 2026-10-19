"""Copie hébergée de la photo principale : aucun test n'ouvre de connexion réseau ni de base."""

from __future__ import annotations

import io
import json
import re
import struct
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from PIL import Image

from src import document_politeness, photo_mirror, source_withdrawal
from src.document_politeness import DocumentRobotsDisallowed, DocumentRobotsUnavailable
from src.photo_mirror import (
    BLOCKED_HOSTS,
    Candidate,
    Hop,
    ImageRejected,
    MirrorFailure,
    MirrorLimits,
    PhotoDownloader,
    PhotoResult,
    PostgresPhotoStore,
    RetryableFailure,
    SupabasePhotoStorage,
    apply_withdrawals,
    build_politeness,
    limits_from_inputs,
    mirror_candidate,
    mirror_enabled,
    parse_retry_after,
    photo_paths,
    pinned_get,
    process_image,
    read_limited,
    rejection_reason,
    run_photo_mirror,
    sniff_image_type,
)

SALE_ID = "11111111-1111-4111-8111-111111111111"
OTHER_SALE_ID = "22222222-2222-4222-8222-222222222222"
PHOTO_URL = "https://img.example.test/photos/1.jpg"
SETTINGS: dict[str, object] = {
    "user_agent": "TestBot/1.0 (+https://example.test/contact)",
    "supabase_db_url": "",
    "enable_encheres_publiques_benchmark": False,
    "encheres_publiques_access_authorized": False,
}


# --------------------------------------------------------------------------------------------------
# Images
# --------------------------------------------------------------------------------------------------


def _picture(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height), (200, 120, 40))
    for x in range(0, width, 7):  # not a flat colour: the encoder has something to compress
        for y in range(0, height, 11):
            image.putpixel((x, y), (x % 256, y % 256, 90))
    return image


def make_jpeg(width: int = 800, height: int = 600, *, exif: bool = False, orientation: int | None = None) -> bytes:
    image = _picture(width, height)
    buffer = io.BytesIO()
    kwargs: dict[str, Any] = {}
    if exif:
        tags = Image.Exif()
        tags[0x010F] = "SecretCameraMaker"
        tags[0x0132] = "2026:10:16 10:00:00"
        if orientation is not None:
            tags[0x0112] = orientation
        gps = tags.get_ifd(0x8825)
        gps[1], gps[2], gps[3], gps[4] = "N", (48.0, 51.0, 24.0), "E", (2.0, 21.0, 8.0)
        kwargs["exif"] = tags
        kwargs["comment"] = b"private comment"
    image.save(buffer, "JPEG", quality=90, **kwargs)
    return buffer.getvalue()


def make_png(width: int = 800, height: int = 600) -> bytes:
    buffer = io.BytesIO()
    _picture(width, height).save(buffer, "PNG")
    return buffer.getvalue()


def make_webp(width: int = 800, height: int = 600) -> bytes:
    buffer = io.BytesIO()
    _picture(width, height).save(buffer, "WEBP", quality=80)
    return buffer.getvalue()


def make_gif() -> bytes:
    buffer = io.BytesIO()
    _picture(600, 400).convert("P").save(buffer, "GIF")
    return buffer.getvalue()


def make_mpo(width: int = 800, height: int = 600) -> bytes:
    """A multi-picture JPEG (two frames), the kind some phones and cameras produce."""
    buffer = io.BytesIO()
    _picture(width, height).save(
        buffer, "MPO", save_all=True, append_images=[Image.new("RGB", (width // 2, height // 2), (10, 10, 200))]
    )
    return buffer.getvalue()


def _s15(value: float) -> bytes:
    return struct.pack(">i", round(value * 65536))


def linear_rgb_profile() -> bytes:
    """A minimal ICC profile: sRGB primaries with a linear tone curve (so unlike sRGB, mid-tones are darker)."""

    def xyz(x: float, y: float, z: float) -> bytes:
        return b"XYZ \x00\x00\x00\x00" + _s15(x) + _s15(y) + _s15(z)

    def gamma(value: float) -> bytes:
        return b"curv\x00\x00\x00\x00" + struct.pack(">IH", 1, round(value * 256)) + b"\x00\x00"

    text = b"none\x00"
    tags = {
        b"desc": b"desc\x00\x00\x00\x00" + struct.pack(">I", len(text)) + text + b"\x00" * 78,
        b"cprt": b"text\x00\x00\x00\x00" + text,
        b"wtpt": xyz(0.9642, 1.0, 0.8249),
        b"rXYZ": xyz(0.4360, 0.2225, 0.0139),
        b"gXYZ": xyz(0.3851, 0.7169, 0.0971),
        b"bXYZ": xyz(0.1431, 0.0606, 0.7141),
        b"rTRC": gamma(1.0),
        b"gTRC": gamma(1.0),
        b"bTRC": gamma(1.0),
    }
    first = 128 + 4 + 12 * len(tags)
    table, body = b"", b""
    for signature, data in tags.items():
        table += signature + struct.pack(">II", first + len(body), len(data))
        body += data + b"\x00" * (-len(data) % 4)
    header = struct.pack(">I4sI4s4s4s", first + len(body), b"none", 0x02100000, b"mntr", b"RGB ", b"XYZ ")
    header += b"\x00" * 12 + b"acsp" + b"\x00" * 24 + struct.pack(">I", 0)
    header += _s15(0.9642) + _s15(1.0) + _s15(0.8249) + b"none" + b"\x00" * 16 + b"\x00" * 28
    return header + struct.pack(">I", len(tags)) + table + body


def make_jpeg_with_profile(color: tuple[int, int, int], profile: bytes, width: int = 800, height: int = 600) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, "JPEG", quality=95, icc_profile=profile)
    return buffer.getvalue()


SVG = b'<?xml version="1.0"?><svgxmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>'


def webp_size(data: bytes) -> tuple[int, int]:
    return Image.open(io.BytesIO(data)).size


# --------------------------------------------------------------------------------------------------
# Type from the first bytes
# --------------------------------------------------------------------------------------------------


def test_type_is_read_from_the_first_bytes() -> None:
    assert sniff_image_type(make_jpeg()[:64]) == "jpeg"
    assert sniff_image_type(make_png()[:64]) == "png"
    assert sniff_image_type(make_webp()[:64]) == "webp"


@pytest.mark.parametrize(
    ("head", "reason"),
    [
        (make_gif()[:64], "gif_refused"),
        (SVG[:64], "svg_refused"),
        (b"\xef\xbb\xbf  <svg width='10'></svg>", "svg_refused"),
        (b"<!DOCTYPE html><html><body>Cloudflare</body></html>", "unsupported_type"),
        (b"", "unsupported_type"),
        (b"%PDF-1.7 ...", "unsupported_type"),
    ],
)
def test_gif_svg_html_and_unknown_types_are_refused(head: bytes, reason: str) -> None:
    with pytest.raises(ImageRejected) as caught:
        sniff_image_type(head)
    assert caught.value.reason == reason
    assert caught.value.status == "failed"
    assert caught.value.permanent


def test_a_jpeg_served_as_php_is_accepted_because_only_the_bytes_count() -> None:
    # info-encheres answers ``application/x-httpd-php`` for real JPEG files.
    hop = Hop(200, {"content-type": "application/x-httpd-php"}, make_jpeg())
    downloader = PhotoDownloader(
        politeness=_Politeness(),
        user_agent="t",
        settings=SETTINGS,
        get=lambda *a, **k: hop,
    )
    body = downloader.download("https://www.info-encheres.com/photo.php?id=1", pass_deadline=1e9)
    assert process_image(body).width == 800


# --------------------------------------------------------------------------------------------------
# Streaming: size and early type check
# --------------------------------------------------------------------------------------------------


def test_stream_is_cut_at_the_size_limit() -> None:
    chunks = (b"\xff\xd8\xff" + b"0" * 1000 for _ in range(100))
    with pytest.raises(MirrorFailure) as caught:
        read_limited(chunks, max_bytes=5000, deadline=1e9, clock=lambda: 0.0)
    assert caught.value.reason == "too_large"
    assert caught.value.permanent


def test_stream_type_is_checked_before_the_rest_is_downloaded() -> None:
    consumed = 0

    def endless_svg():
        nonlocal consumed
        yield SVG + b" " * 100
        while True:
            consumed += 1
            yield b" " * 1000

    with pytest.raises(ImageRejected) as caught:
        read_limited(endless_svg(), max_bytes=8 * 1024 * 1024, deadline=1e9, check_prefix=photo_mirror._check_prefix)
    assert caught.value.reason == "svg_refused"
    assert consumed == 0


def test_a_short_body_is_still_checked() -> None:
    with pytest.raises(ImageRejected):
        read_limited([b"<html>"], max_bytes=1000, deadline=1e9, check_prefix=photo_mirror._check_prefix)


def test_stream_stops_at_the_request_deadline() -> None:
    times = iter([0.0, 5.0, 20.0, 30.0])
    with pytest.raises(RetryableFailure) as caught:
        read_limited([b"a" * 10] * 4, max_bytes=1000, deadline=15.0, clock=lambda: next(times))
    assert caught.value.reason == "timeout"


def _mock_get(handler, url: str = PHOTO_URL, **kwargs: Any) -> Hop:
    return pinned_get(
        url,
        headers={"User-Agent": "t"},
        deadline=1e12,
        max_bytes=kwargs.pop("max_bytes", 1_000_000),
        check_prefix=kwargs.pop("check_prefix", photo_mirror._check_prefix),
        transport_factory=lambda target: httpx.MockTransport(handler),
        resolver=lambda target_url: SimpleNamespace(url=target_url),
        clock=lambda: 0.0,
        **kwargs,
    )


def test_pinned_get_reads_a_200_body_whatever_its_content_type() -> None:
    jpeg = make_jpeg()
    hop = _mock_get(lambda request: httpx.Response(200, content=jpeg, headers={"content-type": "text/html"}))
    assert (hop.status, hop.body) == (200, jpeg)
    assert hop.headers["content-type"] == "text/html"


def test_pinned_get_does_not_read_the_body_of_an_error() -> None:
    hop = _mock_get(lambda request: httpx.Response(403, content=b"<html>forbidden</html>"))
    assert (hop.status, hop.body) == (403, b"")


def test_pinned_get_refuses_a_declared_size_above_the_limit() -> None:
    with pytest.raises(MirrorFailure) as caught:
        _mock_get(
            lambda request: httpx.Response(200, content=make_jpeg(), headers={"content-length": "9000000"}),
            max_bytes=8 * 1024 * 1024,
        )
    assert caught.value.reason == "too_large"


def test_pinned_get_refuses_a_svg_served_as_an_image() -> None:
    with pytest.raises(ImageRejected) as caught:
        _mock_get(lambda request: httpx.Response(200, content=SVG, headers={"content-type": "image/svg+xml"}))
    assert caught.value.reason == "svg_refused"


def test_pinned_get_maps_network_errors_to_a_retryable_failure() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(RetryableFailure) as caught:
        _mock_get(broken)
    assert caught.value.reason == "network_error"

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(RetryableFailure) as caught:
        _mock_get(slow)
    assert caught.value.reason == "timeout"


def test_pinned_get_refuses_a_private_address() -> None:
    # The real resolver of the document transport: loopback and private ranges never get a request.
    for url in ("http://127.0.0.1/a.jpg", "http://localhost/a.jpg", "http://user:pw@example.test/a.jpg"):
        with pytest.raises(MirrorFailure) as caught:
            pinned_get(url, headers={}, deadline=1e12, max_bytes=10, clock=lambda: 0.0)
        assert caught.value.reason == "unsafe_url"


# --------------------------------------------------------------------------------------------------
# Image processing
# --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("width", "height", "reason"),
    [
        (299, 900, "too_small"),
        (900, 299, "too_small"),
        (400, 400, "too_small"),
        (479, 300, "too_small"),
        (1000, 300, "too_elongated"),
        (300, 1000, "too_elongated"),
        (960, 300, None),
        (480, 300, None),
    ],
)
def test_size_rules_are_those_of_the_site(width: int, height: int, reason: str | None) -> None:
    assert rejection_reason(width, height) == reason


def test_a_small_image_is_rejected_and_never_retried() -> None:
    with pytest.raises(ImageRejected) as caught:
        process_image(make_jpeg(320, 240))
    assert caught.value.reason == "too_small"
    assert (caught.value.width, caught.value.height) == (320, 240)


def test_an_elongated_image_is_rejected() -> None:
    with pytest.raises(ImageRejected) as caught:
        process_image(make_png(1400, 400))
    assert caught.value.reason == "too_elongated"


def test_exif_and_other_metadata_are_removed() -> None:
    original = make_jpeg(800, 600, exif=True)
    assert b"SecretCameraMaker" in original  # the fixture really carries personal data
    processed = process_image(original)
    for data in (processed.data_640, processed.data_1600):
        assert b"SecretCameraMaker" not in data
        assert b"private comment" not in data
        assert b"EXIF" not in data
        assert b"XMP" not in data
        decoded = Image.open(io.BytesIO(data))
        assert decoded.format == "WEBP"
        assert not dict(decoded.getexif())
        assert not {"exif", "xmp", "icc_profile", "comment"} & set(decoded.info)


def test_the_exif_orientation_is_applied_before_the_metadata_is_dropped() -> None:
    processed = process_image(make_jpeg(800, 500, exif=True, orientation=6))
    assert (processed.width, processed.height) == (500, 800)
    assert webp_size(processed.data_640) == (500, 800)


def test_an_original_of_640_px_or_less_gives_a_single_file_without_enlargement() -> None:
    processed = process_image(make_jpeg(640, 480))
    assert processed.single
    assert webp_size(processed.data_640) == (640, 480)
    assert processed.data_1600 is processed.data_640
    small = process_image(make_jpeg(500, 400))
    assert small.single
    assert webp_size(small.data_640) == (500, 400)


def test_a_mid_size_original_is_never_enlarged_to_1600() -> None:
    processed = process_image(make_jpeg(1000, 700))
    assert not processed.single
    assert webp_size(processed.data_640) == (640, 448)
    assert webp_size(processed.data_1600) == (1000, 700)


def test_a_large_original_gives_640_and_1600() -> None:
    processed = process_image(make_jpeg(2400, 1600))
    assert webp_size(processed.data_640) == (640, 427)
    assert webp_size(processed.data_1600) == (1600, 1067)
    assert len(processed.data_1600) < photo_mirror.BUCKET_FILE_LIMIT_BYTES


@pytest.mark.parametrize("builder", [make_png, make_webp])
def test_png_and_webp_originals_are_accepted(builder) -> None:
    assert webp_size(process_image(builder(900, 600)).data_640) == (640, 427)


def test_a_multi_picture_jpeg_is_accepted_as_a_jpeg() -> None:
    original = make_mpo(1200, 800)
    assert sniff_image_type(original[:64]) == "jpeg"
    assert Image.open(io.BytesIO(original)).format == "MPO"  # Pillow does not call it JPEG
    processed = process_image(original)
    assert (processed.width, processed.height) == (1200, 800)  # the first frame is the photo
    assert webp_size(processed.data_640) == (640, 427)


def test_a_body_that_is_not_the_format_its_signature_claims_is_still_refused() -> None:
    # MPO is accepted only behind a JPEG signature; a PNG body behind a JPEG head decodes as nothing.
    with pytest.raises(ImageRejected):
        process_image(b"\xff\xd8\xff" + make_png(600, 400))


def test_an_icc_profile_is_converted_to_srgb_then_dropped() -> None:
    profile = linear_rgb_profile()
    original = make_jpeg_with_profile((128, 64, 32), profile)
    source = Image.open(io.BytesIO(original))
    assert source.info.get("icc_profile") == profile  # the fixture really carries a profile
    assert source.convert("RGB").getpixel((10, 10)) == pytest.approx((128, 64, 32), abs=2)
    processed = process_image(original)
    for data in (processed.data_640, processed.data_1600):
        decoded = Image.open(io.BytesIO(data))
        assert "icc_profile" not in decoded.info
        red, green, blue = decoded.convert("RGB").getpixel((10, 10))
        # Linear (128, 64, 32) is (188, 136, 98) in sRGB (the colours were not just copied).
        assert (red, green, blue) == pytest.approx((188, 136, 98), abs=6)


def test_an_image_without_a_profile_keeps_its_pixels() -> None:
    flat = io.BytesIO()
    Image.new("RGB", (800, 600), (128, 64, 32)).save(flat, "PNG")
    red, green, blue = Image.open(io.BytesIO(process_image(flat.getvalue()).data_640)).convert("RGB").getpixel((5, 5))
    assert (red, green, blue) == pytest.approx((128, 64, 32), abs=6)


def test_an_unreadable_icc_profile_is_dropped_and_the_pixels_are_kept() -> None:
    original = make_jpeg_with_profile((128, 64, 32), b"not an icc profile at all")
    processed = process_image(original)
    decoded = Image.open(io.BytesIO(processed.data_640))
    assert "icc_profile" not in decoded.info
    assert decoded.convert("RGB").getpixel((5, 5)) == pytest.approx((128, 64, 32), abs=6)


def test_the_alpha_channel_survives_the_profile_conversion() -> None:
    profile = linear_rgb_profile()
    rgba = Image.new("RGBA", (800, 600), (128, 64, 32, 100))
    buffer = io.BytesIO()
    rgba.save(buffer, "PNG", icc_profile=profile)
    decoded = Image.open(io.BytesIO(process_image(buffer.getvalue()).data_640)).convert("RGBA")
    red, green, blue, alpha = decoded.getpixel((5, 5))
    assert alpha == pytest.approx(100, abs=3)
    assert red == pytest.approx(188, abs=8)


def test_a_gif_and_a_svg_are_refused_by_the_processor() -> None:
    for data, reason in ((make_gif(), "gif_refused"), (SVG, "svg_refused")):
        with pytest.raises(ImageRejected) as caught:
            process_image(data)
        assert caught.value.reason == reason


def test_a_truncated_image_is_a_decode_error() -> None:
    with pytest.raises(ImageRejected) as caught:
        process_image(make_jpeg(900, 700)[:200])
    assert caught.value.reason == "decode_error"
    assert caught.value.permanent


def test_a_decompression_bomb_is_refused_before_decoding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(photo_mirror, "MAX_PIXELS", 100_000)
    with pytest.raises(ImageRejected) as caught:
        process_image(make_jpeg(600, 400))
    assert caught.value.reason == "decompression_bomb"
    assert Image.MAX_IMAGE_PIXELS != 100_000  # the global limit is restored


def test_paths_follow_the_contract() -> None:
    sha = "0123456789abcdef" + "0" * 48
    assert photo_paths(SALE_ID, sha, single=False) == (
        f"{SALE_ID}/0123456789abcdef-640.webp",
        f"{SALE_ID}/0123456789abcdef-1600.webp",
    )
    path_640, path_1600 = photo_paths(SALE_ID, sha, single=True)
    assert path_640 == path_1600
    with pytest.raises(ValueError):
        photo_paths("../../etc", sha, single=False)


# --------------------------------------------------------------------------------------------------
# Download: statuses, retries, redirects, politeness
# --------------------------------------------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class _Politeness:
    def __init__(self, error: Exception | None = None) -> None:
        self.calls: list[str] = []
        self.error = error

    def wait_turn(self, url: str) -> None:
        self.calls.append(url)
        if self.error is not None:
            raise self.error


class _Get:
    """Scripted responses, one per request."""

    def __init__(self, *responses: Hop | Exception) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, url: str, **kwargs: Any) -> Hop:
        self.calls.append({"url": url, **kwargs})
        response = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(response, Exception):
            raise response
        return response


def _downloader(get: _Get, clock: _Clock | None = None, politeness: _Politeness | None = None, settings=None):
    clock = clock or _Clock()
    politeness = politeness or _Politeness()
    return (
        PhotoDownloader(
            politeness=politeness,
            user_agent=str(SETTINGS["user_agent"]),
            settings=settings or SETTINGS,
            get=get,
            sleep=clock.sleep,
            clock=clock,
        ),
        clock,
        politeness,
    )


def _ok() -> Hop:
    return Hop(200, {}, make_jpeg())


@pytest.mark.parametrize(
    ("status", "expected_status", "reason"),
    [(401, "blocked", "http_401"), (403, "blocked", "http_403"), (404, "gone", "http_404"), (410, "gone", "http_410")],
)
def test_401_403_404_410_are_final_and_never_retried(status: int, expected_status: str, reason: str) -> None:
    get = _Get(Hop(status, {}))
    downloader, clock, _ = _downloader(get)
    with pytest.raises(MirrorFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert (caught.value.status, caught.value.reason, caught.value.permanent) == (expected_status, reason, True)
    assert len(get.calls) == 1
    assert clock.sleeps == []


def test_429_waits_for_retry_after_then_succeeds() -> None:
    get = _Get(Hop(429, {"retry-after": "20"}), _ok())
    downloader, clock, politeness = _downloader(get)
    assert downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert clock.sleeps == [20.0]
    assert len(get.calls) == 2
    assert len(politeness.calls) == 2  # robots.txt and the host delay apply to the retry too


def test_429_gives_up_after_two_retries_with_growing_waits() -> None:
    get = _Get(Hop(429, {}))
    downloader, clock, _ = _downloader(get)
    with pytest.raises(RetryableFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert (caught.value.status, caught.value.reason, caught.value.http_status) == ("failed", "http_429", 429)
    assert len(get.calls) == 3
    assert clock.sleeps == [3.0, 9.0]
    assert clock.sleeps == sorted(clock.sleeps)


def test_a_retry_after_longer_than_a_minute_is_not_waited_for() -> None:
    get = _Get(Hop(429, {"retry-after": "3600"}))
    downloader, clock, _ = _downloader(get)
    with pytest.raises(RetryableFailure):
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert len(get.calls) == 1
    assert clock.sleeps == []


def test_5xx_and_network_errors_are_retried() -> None:
    get = _Get(Hop(503, {}), RetryableFailure("network_error"), _ok())
    downloader, clock, _ = _downloader(get)
    assert downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert len(get.calls) == 3
    assert clock.sleeps == [3.0, 9.0]


def test_a_retry_is_not_started_after_the_pass_deadline() -> None:
    get = _Get(Hop(500, {}))
    downloader, clock, _ = _downloader(get)
    with pytest.raises(RetryableFailure):
        downloader.download(PHOTO_URL, pass_deadline=clock() + 2)
    assert len(get.calls) == 1


def test_other_client_errors_are_not_retried() -> None:
    get = _Get(Hop(400, {}))
    downloader, clock, _ = _downloader(get)
    with pytest.raises(MirrorFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert (caught.value.status, caught.value.reason, caught.value.permanent) == ("failed", "http_400", False)
    assert len(get.calls) == 1


def test_every_redirect_hop_goes_through_the_politeness_and_the_guards() -> None:
    get = _Get(Hop(302, {"location": "/moved/1.jpg"}), Hop(301, {"location": "https://cdn.example.test/1.jpg"}), _ok())
    downloader, clock, politeness = _downloader(get)
    assert downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert politeness.calls == [
        PHOTO_URL,
        "https://img.example.test/moved/1.jpg",
        "https://cdn.example.test/1.jpg",
    ]
    assert get.calls[0]["headers"]["User-Agent"] == SETTINGS["user_agent"]


def test_a_redirect_to_a_blocked_host_is_not_followed() -> None:
    get = _Get(Hop(302, {"location": "https://www.petitesaffiches.fr/img/1.jpg"}))
    downloader, clock, politeness = _downloader(get)
    with pytest.raises(MirrorFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert (caught.value.status, caught.value.reason) == ("blocked", "host_blocklisted")
    assert len(get.calls) == 1
    assert politeness.calls == [PHOTO_URL]


def test_redirect_loops_stop() -> None:
    get = _Get(Hop(302, {"location": PHOTO_URL}))
    downloader, clock, _ = _downloader(get)
    with pytest.raises(MirrorFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert caught.value.reason == "too_many_redirects"
    assert len(get.calls) == photo_mirror.MAX_REDIRECTS + 1


def test_robots_txt_refusal_is_final_and_sends_no_request() -> None:
    get = _Get(_ok())
    downloader, clock, _ = _downloader(get, politeness=_Politeness(DocumentRobotsDisallowed("no")))
    with pytest.raises(MirrorFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert (caught.value.status, caught.value.reason, caught.value.permanent) == ("blocked", "robots_disallowed", True)
    assert get.calls == []


def test_robots_txt_that_cannot_be_read_is_retried_later_not_now() -> None:
    get = _Get(_ok())
    downloader, clock, politeness = _downloader(get, politeness=_Politeness(DocumentRobotsUnavailable("down")))
    with pytest.raises(RetryableFailure) as caught:
        downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    assert caught.value.reason == "robots_unavailable"
    assert len(politeness.calls) == 1
    assert get.calls == []


def test_each_request_is_bounded_to_fifteen_seconds_and_eight_megabytes() -> None:
    get = _Get(_ok())
    downloader, clock, _ = _downloader(get)
    downloader.download(PHOTO_URL, pass_deadline=clock() + 1000)
    call = get.calls[0]
    assert call["deadline"] == pytest.approx(clock() + 15.0)
    assert call["max_bytes"] == 8 * 1024 * 1024


def test_retry_after_accepts_seconds_and_http_dates() -> None:
    from datetime import UTC, datetime

    assert parse_retry_after("7") == 7.0
    assert parse_retry_after(None) is None
    assert parse_retry_after("soon") is None
    now = datetime(2026, 10, 16, 12, 0, 0, tzinfo=UTC)
    assert parse_retry_after("Fri, 16 Oct 2026 12:00:30 GMT", now=now) == 30.0
    assert parse_retry_after("Fri, 16 Oct 2026 11:00:00 GMT", now=now) == 0.0


# --------------------------------------------------------------------------------------------------
# robots.txt and host delay (the document politeness, same transport)
# --------------------------------------------------------------------------------------------------


def test_politeness_waits_two_seconds_per_host_and_honours_crawl_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)
    monkeypatch.delenv(document_politeness.HOST_DELAY_ENV, raising=False)
    clock = _Clock()
    fetched: list[dict[str, Any]] = []

    def get(url: str, **kwargs: Any) -> Hop:
        fetched.append({"url": url, **kwargs})
        return Hop(200, {"content-type": "text/plain"}, b"User-agent: *\nDisallow: /private/\n")

    politeness = build_politeness(SETTINGS, get=get, sleep=clock.sleep, clock=clock)
    politeness.wait_turn("https://img.example.test/a.jpg")
    politeness.wait_turn("https://img.example.test/b.jpg")
    assert fetched[0]["url"] == "https://img.example.test/robots.txt"
    assert fetched[0]["headers"]["User-Agent"] == SETTINGS["user_agent"]
    assert clock.sleeps == [2.0, 2.0]
    with pytest.raises(DocumentRobotsDisallowed):
        politeness.wait_turn("https://img.example.test/private/c.jpg")

    slow = _Clock()
    slow_politeness = build_politeness(
        SETTINGS,
        get=lambda url, **kw: Hop(200, {}, b"User-agent: *\nCrawl-delay: 5\n"),
        sleep=slow.sleep,
        clock=slow,
    )
    slow_politeness.wait_turn("https://slow.example.test/a.jpg")
    slow_politeness.wait_turn("https://slow.example.test/b.jpg")
    assert slow.sleeps == [5.0, 5.0]


def test_the_host_delay_cannot_be_lowered_below_two_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(document_politeness.HOST_DELAY_ENV, "1")
    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)
    clock = _Clock()
    politeness = build_politeness(
        SETTINGS, get=lambda url, **kw: Hop(404, {}), sleep=clock.sleep, clock=clock
    )
    politeness.wait_turn("https://img.example.test/a.jpg")
    politeness.wait_turn("https://img.example.test/b.jpg")
    assert clock.sleeps == [2.0, 2.0]


def test_an_unreadable_robots_txt_stops_the_download(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)
    clock = _Clock()

    def get(url: str, **kwargs: Any) -> Hop:
        raise RetryableFailure("network_error")

    politeness = build_politeness(SETTINGS, get=get, sleep=clock.sleep, clock=clock)
    with pytest.raises(DocumentRobotsUnavailable):
        politeness.wait_turn("https://img.example.test/a.jpg")


# --------------------------------------------------------------------------------------------------
# One photo
# --------------------------------------------------------------------------------------------------


class _Storage:
    def __init__(self, fail_on: str | None = None) -> None:
        self.uploads: dict[str, bytes] = {}
        self.removed: list[str] = []
        self.fail_on = fail_on

    def upload(self, path: str, data: bytes) -> None:
        if self.fail_on and path.endswith(self.fail_on):
            raise RuntimeError("storage down")
        self.uploads[path] = data

    def remove(self, paths: list[str]) -> None:
        self.removed.extend(paths)


def _candidate(url: str = PHOTO_URL, *, attempts: int = 0, name: str = "notaires", observations=None) -> Candidate:
    return Candidate(SALE_ID, name, observations or [], url, attempts)


def _mirror(candidate: Candidate, get: _Get, storage: _Storage | None = None, settings=None, store=None):
    downloader, clock, politeness = _downloader(get, settings=settings)
    storage = storage or _Storage()
    result = mirror_candidate(
        candidate,
        downloader=downloader,
        storage=storage,
        pass_deadline=clock() + 1000,
        settings=settings or SETTINGS,
        clock=clock,
        store=store,
    )
    return result, storage, get, politeness


def test_a_photo_is_copied_in_two_files_with_the_documented_names_and_status() -> None:
    original = make_jpeg(1600, 1000)
    result, storage, _, _ = _mirror(_candidate(), _Get(Hop(200, {}, original)))
    import hashlib

    sha = hashlib.sha256(original).hexdigest()
    assert result.status == "stored"
    assert result.sha256 == sha
    assert result.path_640 == f"{SALE_ID}/{sha[:16]}-640.webp"
    assert result.path_1600 == f"{SALE_ID}/{sha[:16]}-1600.webp"
    assert set(storage.uploads) == {result.path_640, result.path_1600}
    assert (result.width, result.height) == (1600, 1000)
    assert result.bytes_640 == len(storage.uploads[result.path_640])
    assert result.bytes_downloaded == len(original)
    assert result.attempts == 1


def test_a_narrow_original_is_uploaded_once() -> None:
    result, storage, _, _ = _mirror(_candidate(), _Get(Hop(200, {}, make_jpeg(600, 450))))
    assert result.status == "stored"
    assert result.path_640 == result.path_1600
    assert list(storage.uploads) == [result.path_640]
    assert result.bytes_640 == result.bytes_1600


def test_a_rejected_image_is_failed_with_the_attempts_used_up() -> None:
    result, storage, _, _ = _mirror(_candidate(attempts=0), _Get(Hop(200, {}, make_jpeg(320, 240))))
    assert (result.status, result.reason, result.attempts) == ("failed", "too_small", 3)
    assert result.path_640 is None and storage.uploads == {}
    assert result.sha256  # the fingerprint of what was refused is kept
    assert (result.width, result.height) == (320, 240)


def test_a_svg_is_failed_for_good() -> None:
    result, storage, _, _ = _mirror(_candidate(), _Get(Hop(200, {"content-type": "image/svg+xml"}, SVG)))
    assert (result.status, result.reason, result.attempts) == ("failed", "svg_refused", 3)
    assert storage.uploads == {}


@pytest.mark.parametrize(
    ("hop", "status", "reason", "attempts"),
    [
        (Hop(403, {}), "blocked", "http_403", 2),
        (Hop(404, {}), "gone", "http_404", 2),
        (Hop(410, {}), "gone", "http_410", 2),
        (Hop(429, {}), "failed", "http_429", 2),
        (Hop(503, {}), "failed", "http_503", 2),
    ],
)
def test_http_statuses_map_to_the_documented_row_status(hop: Hop, status: str, reason: str, attempts: int) -> None:
    result, storage, _, _ = _mirror(_candidate(attempts=1), _Get(hop))
    assert (result.status, result.reason, result.attempts) == (status, reason, attempts)
    assert storage.uploads == {}


def test_a_blocked_host_is_recorded_without_any_request() -> None:
    assert "www.petitesaffiches.fr" in BLOCKED_HOSTS
    get = _Get(_ok())
    result, _, get, politeness = _mirror(_candidate("https://www.petitesaffiches.fr/photo/1.jpg"), get)
    assert (result.status, result.reason) == ("blocked", "host_blocklisted")
    assert get.calls == [] and politeness.calls == []


def test_a_withdrawn_source_is_never_downloaded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"licitor"}))
    by_host, _, get, politeness = _mirror(_candidate("https://www.licitor.com/data/pub/pic/1.jpg"), _Get(_ok()))
    assert (by_host.status, by_host.reason) == ("withdrawn", "source_withdrawn")
    by_sale, _, get2, _ = _mirror(_candidate(name="licitor", observations=[{"source_name": "licitor"}]), _Get(_ok()))
    assert (by_sale.status, by_sale.reason) == ("withdrawn", "source_withdrawn")
    assert get.calls == [] and get2.calls == [] and politeness.calls == []
    # A sale merged with a source that is not withdrawn keeps its own photo.
    merged, storage, _, _ = _mirror(
        _candidate(name="licitor", observations=[{"source_name": "notaires"}]), _Get(_ok())
    )
    assert merged.status == "stored" and storage.uploads


def test_encheres_publiques_photos_need_the_access_gate() -> None:
    url = "https://www.encheres-publiques.com/images/1.jpg"
    result, _, get, _ = _mirror(_candidate(url), _Get(_ok()))
    assert (result.status, result.reason) == ("blocked", "ep_not_authorized")
    assert get.calls == []
    allowed = {**SETTINGS, "enable_encheres_publiques_benchmark": True, "encheres_publiques_access_authorized": True}
    result, _, _, _ = _mirror(_candidate(url), _Get(_ok()), settings=allowed)
    assert result.status == "stored"


def test_a_photo_of_an_encheres_publiques_sale_needs_the_access_gate_whatever_its_host() -> None:
    # The photo is hosted on a neutral CDN: only the sale's source says it belongs to Encheres Publiques.
    for candidate in (
        Candidate(SALE_ID, "encheres_publiques", [], PHOTO_URL),
        Candidate(SALE_ID, "Encheres-Publiques", [], PHOTO_URL),
        Candidate(SALE_ID, "other", [], PHOTO_URL, 0, "https://www.encheres-publiques.com/vente/1"),
    ):
        result, storage, get, politeness = _mirror(candidate, _Get(_ok()))
        assert (result.status, result.reason) == ("blocked", "ep_not_authorized")
        assert get.calls == [] and politeness.calls == [] and storage.uploads == {}
    allowed = {**SETTINGS, "enable_encheres_publiques_benchmark": True, "encheres_publiques_access_authorized": True}
    result, _, _, _ = _mirror(Candidate(SALE_ID, "encheres_publiques", [], PHOTO_URL), _Get(_ok()), settings=allowed)
    assert result.status == "stored"
    # Another source keeps working with the gate closed.
    result, _, _, _ = _mirror(Candidate(SALE_ID, "notaires", [], PHOTO_URL, 0, "https://www.notaires.fr/x"), _Get(_ok()))
    assert result.status == "stored"


def test_a_path_still_in_the_retention_queue_is_not_reused() -> None:
    original = make_jpeg(1000, 700)
    import hashlib

    sha = hashlib.sha256(original).hexdigest()
    store = _Store()
    store.queued = {f"{SALE_ID}/{sha[:16]}-1600.webp"}
    result, storage, _, _ = _mirror(_candidate(attempts=1), _Get(Hop(200, {}, original)), store=store)
    assert (result.status, result.reason) == ("deferred", "path_queued_for_deletion")
    assert result.attempts == 1 and result.path_640 is None and result.path_1600 is None
    assert storage.uploads == {} and storage.removed == []  # nothing sent, nothing removed
    store.queued = set()  # the cron has emptied the queue: the next pass copies the photo
    result, storage, _, _ = _mirror(_candidate(attempts=1), _Get(Hop(200, {}, original)), store=store)
    assert result.status == "stored" and len(storage.uploads) == 2


def test_a_file_another_stored_row_still_serves_is_never_removed_by_a_failure() -> None:
    original = make_jpeg(1000, 700)
    import hashlib

    sha = hashlib.sha256(original).hexdigest()
    shared_640 = f"{SALE_ID}/{sha[:16]}-640.webp"
    # Same sale, same photo under another URL: that row is stored and owns the 640 px file.
    store = _Store()
    store.stored = {shared_640}
    storage = _Storage(fail_on="-1600.webp")
    result, storage, _, _ = _mirror(_candidate(), _Get(Hop(200, {}, original)), storage=storage, store=store)
    assert result.status == "failed"
    assert storage.removed == []  # the 640 px file belongs to the other row
    # Without the other row the partial file is cleaned up as before.
    store.stored = set()
    storage = _Storage(fail_on="-1600.webp")
    _, storage, _, _ = _mirror(_candidate(), _Get(Hop(200, {}, original)), storage=storage, store=store)
    assert storage.removed == [shared_640]


def test_discard_keeps_the_files_when_the_database_cannot_say() -> None:
    store = _Store()
    store.stored_paths = lambda paths: (_ for _ in ()).throw(RuntimeError("db down"))  # type: ignore[method-assign]
    storage = _Storage()
    photo_mirror._discard(storage, ["s/a-640.webp"], store)
    assert storage.removed == []


def test_a_failed_second_upload_does_not_leave_the_first_file_behind() -> None:
    storage = _Storage(fail_on="-1600.webp")
    result, _, _, _ = _mirror(_candidate(), _Get(Hop(200, {}, make_jpeg(1600, 1000))), storage=storage)
    assert (result.status, result.reason) == ("failed", "unexpected_RuntimeError")
    assert result.path_640 is None
    assert len(storage.removed) == 1 and storage.removed[0].endswith("-640.webp")


def test_the_storage_upload_tolerates_a_duplicate_and_sends_the_documented_options() -> None:
    sent: list[dict[str, Any]] = []

    class Bucket:
        def upload(self, **kwargs: Any) -> None:
            sent.append(kwargs)
            if len(sent) == 2:
                raise _duplicate_error()

    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda name: Bucket() if name == "sale-photos" else None))
    storage = SupabasePhotoStorage(client)
    storage.upload("a/b-640.webp", b"data")
    storage.upload("a/b-640.webp", b"data")  # the same photo again: no error
    assert len(sent) == 2
    assert sent[0]["file_options"] == {
        "cache-control": "31536000",
        "content-type": "image/webp",
        "upsert": "false",
    }


def test_the_cache_lifetime_is_one_year_and_reaches_the_storage_request_as_max_age() -> None:
    """Checked with the real storage3 client (the version pinned in requirements.txt), not a stand-in.

    ``immutable`` cannot be added through storage3: the header is built from the number alone.
    """
    import httpx
    from storage3 import SyncStorageClient

    assert photo_mirror.CACHE_CONTROL_SECONDS == 365 * 24 * 3600
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"Key": "sale-photos/a/b-640.webp", "Id": "id"})

    client = SyncStorageClient(
        "https://project.supabase.co/storage/v1/",
        {"apikey": "service-key", "authorization": "Bearer service-key"},
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    SupabasePhotoStorage(SimpleNamespace(storage=client)).upload("a/b-640.webp", b"webp-bytes")

    assert len(requests) == 1
    request = requests[0]
    assert request.url.path == "/storage/v1/object/sale-photos/a/b-640.webp"
    assert request.headers["cache-control"] == "max-age=31536000"
    assert b'name="cacheControl"' in request.content and b"31536000" in request.content
    assert "immutable" not in request.headers["cache-control"]


def test_other_storage_errors_are_not_mistaken_for_duplicates() -> None:
    from storage3.exceptions import StorageApiError

    assert photo_mirror.is_duplicate_upload(_duplicate_error())
    assert photo_mirror.is_duplicate_upload(StorageApiError("exists", "Duplicate", "409"))
    assert photo_mirror.is_duplicate_upload(Exception({"statusCode": 400, "error": "Duplicate", "message": "x"}))
    assert not photo_mirror.is_duplicate_upload(StorageApiError("too big", "Payload too large", 413))
    assert not photo_mirror.is_duplicate_upload(StorageApiError("denied", "Unauthorized", 403))
    assert not photo_mirror.is_duplicate_upload(RuntimeError("boom"))


def _duplicate_error() -> Exception:
    from storage3.exceptions import StorageApiError

    return StorageApiError("The resource already exists", "Duplicate", 409)


# --------------------------------------------------------------------------------------------------
# The pass
# --------------------------------------------------------------------------------------------------


class _Store:
    def __init__(self, candidates: list[Candidate] | None = None, *, lock: bool = True) -> None:
        self.candidates = candidates or []
        self.lock = lock
        self.saved: list[PhotoResult] = []
        self.select_args: list[tuple[int, bool]] = []
        self.rows: list[dict[str, Any]] = []
        self.file_rows: list[dict[str, Any]] = []
        self.marked: list[str] = []
        self.cleared: list[str] = []
        self.closed = False
        self.stale = 0
        self.stale_limits: list[int] = []
        self.queued: set[str] = set()
        self.stored: set[str] = set()
        self.calls: list[str] = []

    def try_lock(self) -> bool:
        return self.lock

    def select_candidates(self, limit: int, *, include_encheres_publiques: bool) -> list[Candidate]:
        self.calls.append("select")
        self.select_args.append((limit, include_encheres_publiques))
        return self.candidates[:limit]

    def delete_stale_rows(self, limit: int) -> int:
        self.calls.append("stale")
        self.stale_limits.append(limit)
        return self.stale

    def paths_queued_for_deletion(self, paths: list[str]) -> bool:
        return bool(self.queued & set(paths))

    def stored_paths(self, paths: list[str]) -> set[str]:
        return self.stored & set(paths)

    def save(self, result: PhotoResult) -> bool:
        self.saved.append(result)
        return True

    def stored_rows(self) -> list[dict[str, Any]]:
        return self.rows

    def mark_withdrawn(self, ids: list[str]) -> None:
        self.marked.extend(ids)

    def rows_with_files_to_remove(self, limit: int) -> list[dict[str, Any]]:
        return self.file_rows

    def clear_paths(self, ids: list[str]) -> None:
        self.cleared.extend(ids)

    def close(self) -> None:
        self.closed = True


ENABLED = {"PHOTO_MIRROR_ENABLED": "true"}


def _run(store: _Store, get: _Get, *, limits: MirrorLimits | None = None, clock: _Clock | None = None, storage=None):
    downloader, clock, _ = _downloader(get, clock=clock)
    storage = storage or _Storage()
    summary = run_photo_mirror(
        limits or MirrorLimits(),
        settings=SETTINGS,
        store=store,
        storage=storage,
        downloader=downloader,
        env=ENABLED,
        clock=clock,
    )
    return summary, storage


@pytest.mark.parametrize("value", [None, "", "false", "0", "1", "yes", "off"])
def test_nothing_is_copied_unless_the_switch_is_true(value: str | None) -> None:
    class Exploding:
        def __getattr__(self, name: str):
            raise AssertionError(f"{name} must not be touched while the switch is off")

    class WithdrawalOnlyStore(_Store):
        def select_candidates(self, limit: int, *, include_encheres_publiques: bool) -> list[Candidate]:
            raise AssertionError("no candidate is selected while the switch is off")

        def delete_stale_rows(self, limit: int) -> int:
            raise AssertionError("the switch is off: no copy is touched except for a withdrawal")

    env = {} if value is None else {"PHOTO_MIRROR_ENABLED": value}
    store = WithdrawalOnlyStore([Candidate(SALE_ID, "n", [], PHOTO_URL)])
    summary = run_photo_mirror(
        MirrorLimits(), settings=SETTINGS, store=store, storage=_Storage(), downloader=Exploding(), env=env
    )
    assert summary.stop_reason == "disabled"
    assert summary.processed == 0 and store.saved == []
    assert not mirror_enabled(env)


def test_withdrawals_run_even_when_the_switch_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"licitor"}))
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])
    store.rows = [
        {"id": "a", "source_url": "https://www.licitor.com/data/pub/pic/1.jpg", "source_name": "notaires", "observations": []},
        {"id": "c", "source_url": "https://x.example.test/3.jpg", "source_name": "notaires", "observations": []},
    ]
    store.file_rows = [{"id": "a", "path_640": "s/a-640.webp", "path_1600": "s/a-1600.webp", "shared": False}]
    storage = _Storage()
    summary = run_photo_mirror(
        MirrorLimits(), settings=SETTINGS, store=store, storage=storage, env={"PHOTO_MIRROR_ENABLED": "false"}
    )
    assert store.marked == ["a"]
    assert storage.removed == ["s/a-640.webp", "s/a-1600.webp"]
    assert store.cleared == ["a"]
    assert (summary.stop_reason, summary.withdrawn_marked, summary.withdrawn_files_removed) == ("disabled", 1, 2)
    assert store.calls == []  # no stale-copy cleanup and no selection: nothing else runs
    assert store.saved == []


def test_withdrawals_with_the_switch_off_need_no_database_to_stay_quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(photo_mirror, "PostgresPhotoStore", lambda *a, **k: pytest.fail("no database to open"))
    summary = run_photo_mirror(MirrorLimits(), settings=SETTINGS, env={})
    assert summary.stop_reason == "disabled"
    with pytest.raises(RuntimeError, match="SUPABASE_DB_URL"):
        run_photo_mirror(MirrorLimits(), settings=SETTINGS, env=ENABLED)


def test_the_switch_is_true_only_for_true(monkeypatch: pytest.MonkeyPatch) -> None:
    assert mirror_enabled({"PHOTO_MIRROR_ENABLED": " TRUE "})
    monkeypatch.delenv("PHOTO_MIRROR_ENABLED", raising=False)
    assert not mirror_enabled()


def test_main_with_the_switch_off_still_runs_the_pass_for_withdrawals(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("PHOTO_MIRROR_ENABLED", raising=False)
    monkeypatch.setattr(
        photo_mirror, "PostgresPhotoStore", lambda *a, **k: pytest.fail("no database without SUPABASE_DB_URL")
    )
    monkeypatch.setattr(photo_mirror, "load_settings", lambda: SETTINGS)
    assert photo_mirror.main([]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["event"] == "photo_mirror_summary" and summary["stop_reason"] == "disabled"

    seen: list[MirrorLimits] = []

    def fake_run(limits: MirrorLimits, **kwargs: Any) -> photo_mirror.MirrorSummary:
        seen.append(limits)
        return photo_mirror.MirrorSummary(stop_reason="disabled")

    monkeypatch.setattr(photo_mirror, "run_photo_mirror", fake_run)
    assert photo_mirror.main(["--automatic", "--budget-minutes", "150"]) == 0
    assert seen == [MirrorLimits(budget_seconds=20 * 60.0, max_photos=400)]


def test_limits_come_from_the_environment_inputs_and_are_bounded() -> None:
    assert limits_from_inputs() == MirrorLimits(budget_seconds=15 * 60, max_photos=400)
    assert limits_from_inputs("3000", "60") == MirrorLimits(budget_seconds=3600, max_photos=3000)
    assert limits_from_inputs("abc", "") == MirrorLimits(budget_seconds=900, max_photos=400)
    assert limits_from_inputs("0", "100000") == MirrorLimits(budget_seconds=150 * 60, max_photos=1)
    assert limits_from_inputs("999999", None).max_photos == photo_mirror.MAX_PHOTOS_LIMIT


def test_the_automatic_budget_never_exceeds_twenty_minutes() -> None:
    # The scheduled step stops at 25 minutes (data-pipeline.yml): a high setting must not get it killed mid-upload.
    assert photo_mirror.AUTOMATIC_MAX_BUDGET_MINUTES == 20
    assert limits_from_inputs(None, "150", automatic=True).budget_seconds == 20 * 60
    assert limits_from_inputs(None, "21", automatic=True).budget_seconds == 20 * 60
    assert limits_from_inputs(None, "10", automatic=True).budget_seconds == 10 * 60
    assert limits_from_inputs(None, None, automatic=True).budget_seconds == 15 * 60
    assert limits_from_inputs(None, "abc", automatic=True).budget_seconds == 15 * 60
    assert limits_from_inputs(None, "150").budget_seconds == 150 * 60  # the manual backfill keeps its range
    workflow = (Path(__file__).parents[3] / ".github/workflows/data-pipeline.yml").read_text(encoding="utf-8")
    step = workflow.split("- name: Copie des photos principales", 1)[1].split("\n      - name:", 1)[0]
    timeout = int(re.search(r"timeout-minutes:\s*(\d+)", step).group(1))  # type: ignore[union-attr]
    assert timeout > photo_mirror.AUTOMATIC_MAX_BUDGET_MINUTES
    assert "python -m src.photo_mirror --automatic" in step


def test_a_pass_stores_logs_one_json_line_per_photo_and_a_summary(capsys: pytest.CaptureFixture[str]) -> None:
    candidates = [
        Candidate(SALE_ID, "notaires", [], "https://a.example.test/1.jpg"),
        Candidate(OTHER_SALE_ID, "notaires", [], "https://b.example.test/2.jpg"),
    ]
    store = _Store(candidates)
    get = _Get(Hop(200, {}, make_jpeg(900, 600)), Hop(404, {}))
    summary, storage = _run(store, get)
    assert [r.status for r in store.saved] == ["stored", "gone"]
    assert summary.stored == 1 and summary.by_status == {"stored": 1, "gone": 1}
    assert summary.failures_by_reason == {"http_404": 1}
    assert summary.bytes_stored == sum(len(data) for data in storage.uploads.values())
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["event"] for line in lines] == ["photo_mirror", "photo_mirror"]
    assert lines[0]["sale_id"] == SALE_ID and lines[0]["status"] == "stored" and lines[0]["host"] == "a.example.test"
    assert {"status", "reason", "bytes_downloaded", "bytes_640", "bytes_1600", "seconds"} <= set(lines[0])
    assert summary.as_dict()["event"] == "photo_mirror_summary"


def test_the_selection_is_capped_by_the_maximum_number_of_photos() -> None:
    candidates = [Candidate(SALE_ID, "n", [], f"https://a{i}.example.test/p.jpg") for i in range(10)]
    store = _Store(candidates)
    summary, _ = _run(store, _Get(Hop(404, {})), limits=MirrorLimits(max_photos=4))
    assert store.select_args == [(4, False)]
    assert summary.processed == 4


def test_the_pass_stops_when_the_time_budget_is_spent() -> None:
    clock = _Clock()

    class SlowGet(_Get):
        def __call__(self, url: str, **kwargs: Any) -> Hop:
            clock.now += 100.0  # every photo takes 100 s
            return super().__call__(url, **kwargs)

    candidates = [Candidate(SALE_ID, "n", [], f"https://a{i}.example.test/p.jpg") for i in range(10)]
    store = _Store(candidates)
    summary, _ = _run(
        store, SlowGet(Hop(404, {})), limits=MirrorLimits(budget_seconds=250.0, max_photos=400), clock=clock
    )
    assert summary.stop_reason == "budget"
    assert summary.processed == 3
    assert len(store.saved) == 3


def test_a_pass_does_not_start_while_another_one_runs() -> None:
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)], lock=False)
    get = _Get(_ok())
    summary, _ = _run(store, get)
    assert summary.stop_reason == "another_pass_running"
    assert get.calls == [] and store.saved == []


def test_a_host_that_keeps_failing_is_left_alone_for_the_rest_of_the_pass() -> None:
    candidates = [Candidate(SALE_ID, "n", [], f"https://flaky.example.test/{i}.jpg") for i in range(6)]
    candidates.append(Candidate(OTHER_SALE_ID, "n", [], "https://fine.example.test/1.jpg"))
    store = _Store(candidates)

    class Get(_Get):
        def __call__(self, url: str, **kwargs: Any) -> Hop:
            self.calls.append({"url": url})
            return Hop(200, {}, make_jpeg()) if "fine" in url else Hop(503, {})

    get = Get()
    summary, _ = _run(store, get)
    flaky_calls = [c for c in get.calls if "flaky" in c["url"]]
    assert len(flaky_calls) == photo_mirror.HOST_FAILURE_LIMIT * (photo_mirror.MAX_RETRIES + 1)
    assert summary.skipped_hosts == {"flaky.example.test": 3}
    assert [r.status for r in store.saved].count("stored") == 1
    assert len(store.saved) == 4  # three failures recorded, the fourth host fine; the skipped ones are not recorded


def test_a_429_pauses_the_host_at_once() -> None:
    candidates = [Candidate(SALE_ID, "n", [], f"https://busy.example.test/{i}.jpg") for i in range(3)]
    store = _Store(candidates)
    summary, _ = _run(store, _Get(Hop(429, {"retry-after": "9999"})))
    assert summary.skipped_hosts == {"busy.example.test": 2}
    assert len(store.saved) == 1


def test_a_database_failure_does_not_lose_the_uploaded_files() -> None:
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])

    def broken_save(result: PhotoResult) -> bool:
        raise RuntimeError("db down")

    store.save = broken_save  # type: ignore[method-assign]
    summary, storage = _run(store, _Get(Hop(200, {}, make_jpeg(1000, 700))))
    assert summary.failures_by_reason == {"database_error": 1}
    assert len(storage.removed) == 2  # no orphan: the files are removed when the row could not be written


def test_files_of_a_row_changed_under_us_are_removed() -> None:
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])
    store.save = lambda result: False  # type: ignore[method-assign]
    summary, storage = _run(store, _Get(Hop(200, {}, make_jpeg(1000, 700))))
    assert len(storage.removed) == 2
    assert summary.stored == 0


def test_a_pass_deletes_stale_copies_before_selecting_and_reports_them() -> None:
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])
    store.stale = 12
    summary, _ = _run(store, _Get(Hop(404, {})))
    assert store.calls == ["stale", "select"]
    assert store.stale_limits == [photo_mirror.STALE_BATCH]
    assert 100 <= photo_mirror.STALE_BATCH <= 500  # a few hundred per pass
    assert summary.stale_deleted == 12
    assert summary.as_dict()["stale_deleted"] == 12


def test_a_failing_stale_cleanup_does_not_stop_the_pass() -> None:
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])

    def broken(limit: int) -> int:
        raise RuntimeError("db hiccup")

    store.delete_stale_rows = broken  # type: ignore[method-assign]
    summary, _ = _run(store, _Get(Hop(404, {})))
    assert summary.failures_by_reason["stale_RuntimeError"] == 1
    assert len(store.saved) == 1


def test_a_deferred_photo_writes_no_row_and_is_not_counted_as_a_failure_to_retry() -> None:
    original = make_jpeg(1000, 700)
    import hashlib

    sha = hashlib.sha256(original).hexdigest()
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL), Candidate(OTHER_SALE_ID, "n", [], "https://b.example.test/2.jpg")])
    store.queued = {f"{SALE_ID}/{sha[:16]}-640.webp"}
    get = _Get(Hop(200, {}, original), Hop(404, {}))
    summary, storage = _run(store, get)
    assert [r.sale_id for r in store.saved] == [OTHER_SALE_ID]  # the deferred photo has no row
    assert summary.by_status == {"deferred": 1, "gone": 1}
    assert storage.uploads == {} and storage.removed == []


# --------------------------------------------------------------------------------------------------
# Withdrawal at the start of the pass
# --------------------------------------------------------------------------------------------------


def test_copies_of_a_withdrawn_source_are_withdrawn_and_their_files_removed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"licitor"}))
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])
    store.rows = [
        {"id": "a", "source_url": "https://www.licitor.com/data/pub/pic/1.jpg", "source_name": "notaires", "observations": []},
        {"id": "b", "source_url": "https://x.example.test/2.jpg", "source_name": "licitor", "observations": []},
        {"id": "c", "source_url": "https://x.example.test/3.jpg", "source_name": "notaires", "observations": []},
        {
            "id": "d",
            "source_url": "https://x.example.test/4.jpg",
            "source_name": "licitor",
            "observations": [{"source_name": "notaires"}],
        },
    ]
    store.file_rows = [
        {"id": "a", "path_640": "s/a-640.webp", "path_1600": "s/a-1600.webp", "shared": False},
        {"id": "b", "path_640": "s/b-640.webp", "path_1600": "s/b-640.webp", "shared": False},
        {"id": "z", "path_640": "s/z-640.webp", "path_1600": "s/z-1600.webp", "shared": True},
    ]
    summary, storage = _run(store, _Get(_ok()))
    assert store.marked == ["a", "b"]  # c is not withdrawn; d is merged with a source that is still shown
    assert summary.withdrawn_marked == 2
    assert storage.removed == ["s/a-640.webp", "s/a-1600.webp", "s/b-640.webp"]  # shared files stay, no duplicate path
    assert store.cleared == ["a", "b", "z"]
    assert summary.withdrawn_files_removed == 3
    assert summary.stop_reason == "candidates_exhausted" and store.saved  # the pass goes on to copy


def test_files_are_removed_before_the_row_forgets_its_paths() -> None:
    order: list[str] = []
    store = _Store()
    store.file_rows = [{"id": "a", "path_640": "s/a-640.webp", "path_1600": None, "shared": False}]
    store.clear_paths = lambda ids: order.append("clear")  # type: ignore[method-assign]
    storage = _Storage()
    storage.remove = lambda paths: order.append("remove")  # type: ignore[method-assign]
    apply_withdrawals(store, storage, "", photo_mirror.MirrorSummary())
    assert order == ["remove", "clear"]


def test_no_database_read_for_withdrawal_when_no_source_is_withdrawn() -> None:
    store = _Store()
    store.stored_rows = lambda: pytest.fail("stored rows must not be read")  # type: ignore[method-assign]
    apply_withdrawals(store, _Storage(), "", photo_mirror.MirrorSummary())


def test_a_failed_removal_keeps_the_paths_for_the_next_pass() -> None:
    store = _Store([Candidate(SALE_ID, "n", [], PHOTO_URL)])
    store.file_rows = [{"id": "a", "path_640": "s/a-640.webp", "path_1600": None, "shared": False}]
    storage = _Storage()

    def broken(paths: list[str]) -> None:
        raise RuntimeError("storage down")

    storage.remove = broken  # type: ignore[method-assign]
    summary, _ = _run(store, _Get(Hop(404, {})), storage=storage)
    assert store.cleared == []
    assert summary.failures_by_reason["withdrawal_RuntimeError"] == 1
    assert store.saved  # the copy still goes on


# --------------------------------------------------------------------------------------------------
# Database layer
# --------------------------------------------------------------------------------------------------


class _Connection:
    def __init__(self, rows: list[tuple[Any, ...]] | None = None, rowcount: int = 1) -> None:
        self.rows = rows or []
        self.rowcount = rowcount
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self.autocommit = False

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Connection:
        self.executed.append((sql, params))
        return self

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows

    def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None

    def close(self) -> None:
        pass


def test_the_selection_picks_new_photos_and_old_failures_nearest_sale_first() -> None:
    connection = _Connection([(SALE_ID, "notaires", [], PHOTO_URL, 1, "https://www.notaires.fr/x")])
    store = PostgresPhotoStore("postgresql://x", connect=lambda url: connection)
    assert connection.autocommit
    candidates = store.select_candidates(400, include_encheres_publiques=False)
    assert candidates == [Candidate(SALE_ID, "notaires", [], PHOTO_URL, 1, "https://www.notaires.fr/x")]
    sql, params = connection.executed[0]
    normalized = re.sub(r"\s+", " ", sql)
    assert "p.id is null" in normalized
    assert "p.status = 'failed' and p.attempts < %s" in normalized
    assert "p.last_attempt_at < now() - make_interval(hours => %s::int)" in normalized
    assert "not s.catalogue_quarantined" in normalized
    # The visibility is read on columns only, like public.sale_photo_mirrors: raw_payload is never touched.
    assert (
        "app_private.sale_catalogue_projection_is_live( s.catalogue_expiry_materialized, "
        "s.catalogue_expiry_deadline, s.sale_date, s.catalogue_expiry_fallback, "
        "s.catalogue_state_observed_at, s.catalogue_state_end_estimate)"
    ) in normalized
    assert "sale_catalogue_entry_is_live" not in normalized
    assert "raw_payload" not in normalized
    assert "order by (s.sale_date is null), s.sale_date, s.id" in normalized
    # Encheres Publiques: by the photo host AND by the sale's source, both switched by the access flag.
    assert "s.catalogue_thumbnail_url !~* %s" in normalized
    assert "<> 'encheres_publiques'" in normalized
    assert params[:3] == (3, 12, False) and params[-1] == 400
    assert params[2] is False and params[4] is False and normalized.count("%s") == len(params)
    store.select_candidates(5, include_encheres_publiques=True)
    assert connection.executed[1][1][2] is True and connection.executed[1][1][4] is True


def test_the_stale_copies_query_only_touches_stored_rows_of_a_changed_photo() -> None:
    connection = _Connection(rowcount=7)
    store = PostgresPhotoStore("postgresql://x", connect=lambda url: connection)
    assert store.delete_stale_rows(300) == 7
    sql, params = connection.executed[0]
    normalized = re.sub(r"\s+", " ", sql)
    assert normalized.strip().startswith("delete from public.sale_photos")  # the trigger queues the files
    assert "p.status = 'stored'" in normalized  # a withdrawn row must survive: it blocks the copy
    assert "s.catalogue_thumbnail_url is distinct from p.source_url" in normalized
    assert "limit %s" in normalized and params == (300,)


def test_the_queue_and_stored_path_queries() -> None:
    connection = _Connection([(1,)])
    store = PostgresPhotoStore("postgresql://x", connect=lambda url: connection)
    assert store.paths_queued_for_deletion(["a", "b"]) is True
    sql, params = connection.executed[0]
    assert "sale_retention_storage_queue" in sql and "bucket = 'sale-photos'" in sql and params == (["a", "b"],)
    connection.rows = []
    assert store.paths_queued_for_deletion(["a"]) is False
    connection.rows = [("a", "b"), ("c", None)]
    assert store.stored_paths(["a", "c", "z"]) == {"a", "c"}
    sql, params = connection.executed[-1]
    assert "p.status = 'stored'" in sql and params == (["a", "c", "z"], ["a", "c", "z"])


def test_the_pass_never_writes_to_auction_sales_and_is_not_part_of_the_collection() -> None:
    source = Path(photo_mirror.__file__).read_text(encoding="utf-8")
    assert not re.search(r"(insert\s+into|update|delete\s+from)\s+(public\.)?auction_sales", source, re.I)
    assert "photo_mirror" not in (Path(photo_mirror.__file__).parent / "main.py").read_text(encoding="utf-8")


def test_saving_a_row_never_overwrites_a_copy_that_is_not_failed() -> None:
    connection = _Connection(rowcount=0)
    store = PostgresPhotoStore("postgresql://x", connect=lambda url: connection)
    result = PhotoResult(SALE_ID, PHOTO_URL, "img.example.test", "stored", attempts=1, sha256="a" * 64)
    assert store.save(result) is False
    sql, params = connection.executed[0]
    assert "on conflict (sale_id, source_url) do update" in sql
    assert "where public.sale_photos.status = 'failed'" in sql
    assert params[0] == SALE_ID and params[-1] == "stored"


def test_the_pass_takes_an_advisory_lock() -> None:
    connection = _Connection([(True,)])
    store = PostgresPhotoStore("postgresql://x", connect=lambda url: connection)
    assert store.try_lock() is True
    assert "pg_try_advisory_lock" in connection.executed[0][0]
    assert connection.executed[0][1] == (photo_mirror.LOCK_NAME,)
