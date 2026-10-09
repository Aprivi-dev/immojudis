from __future__ import annotations

import io
import urllib.request

import pytest

from src import dvf_download
from src.dvf_download import DvfDownloadError, validate_dvf_resource_url


@pytest.mark.parametrize(
    "url",
    [
        "https://files.data.gouv.fr/geo-dvf/latest/csv/2025/full.csv.gz",
        "https://static.data.gouv.fr/resources/x/y.csv",
        "https://www.data.gouv.fr/api/1/datasets/statistiques-dvf/",
        "https://data.gouv.fr/fr/datasets/r/abc",
        "https://FILES.DATA.GOUV.FR./x.csv",
    ],
)
def test_validate_accepts_data_gouv_https_urls(url: str) -> None:
    assert validate_dvf_resource_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "http://files.data.gouv.fr/x.csv",
        "https://evil.example.com/x.csv",
        "https://data.gouv.fr.evil.example.com/x.csv",
        "https://evil.example.com/files.data.gouv.fr/x.csv",
        "https://files.data.gouv.fr@evil.example.com/x.csv",
        "https://user:pw@files.data.gouv.fr/x.csv",
        "https://sub.static.data.gouv.fr/x.csv",
        "file:///etc/passwd",
        "ftp://files.data.gouv.fr/x.csv",
        "",
        "not a url",
    ],
)
def test_validate_rejects_other_urls(url: str) -> None:
    with pytest.raises(DvfDownloadError):
        validate_dvf_resource_url(url)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()


class FakeOpener:
    def __init__(self, response: FakeResponse | Exception) -> None:
        self.response = response
        self.calls: list[tuple[str, float | None]] = []

    def open(self, request: urllib.request.Request, timeout: float | None = None):
        self.calls.append((request.full_url, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def test_download_uses_a_timeout_and_only_publishes_complete_files(tmp_path, monkeypatch) -> None:
    opener = FakeOpener(FakeResponse(b"id_mutation|date\n1|2025-01-01\n"))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: opener)

    target = dvf_download.download_dvf_resource(
        "https://files.data.gouv.fr/geo-dvf/full.csv", tmp_path / "raw" / "full.csv"
    )

    assert opener.calls == [("https://files.data.gouv.fr/geo-dvf/full.csv", 120)]
    assert target.read_bytes().startswith(b"id_mutation")
    assert [path.name for path in target.parent.iterdir()] == ["full.csv"]


def test_download_failure_leaves_no_partial_file(tmp_path, monkeypatch) -> None:
    class Broken(FakeResponse):
        def read(self, size: int = -1) -> bytes:
            raise TimeoutError("timed out")

    opener = FakeOpener(Broken(b"abc"))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: opener)

    with pytest.raises(TimeoutError):
        dvf_download.download_dvf_resource("https://files.data.gouv.fr/x.csv", tmp_path / "x.csv")

    assert list(tmp_path.iterdir()) == []


def test_download_never_opens_a_disallowed_host(tmp_path, monkeypatch) -> None:
    opener = FakeOpener(FakeResponse(b""))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: opener)

    with pytest.raises(DvfDownloadError):
        dvf_download.download_dvf_resource("https://evil.example.com/x.csv", tmp_path / "x.csv")

    assert opener.calls == []


def test_redirects_are_checked_against_the_same_allow_list() -> None:
    handler = dvf_download._AllowListedRedirectHandler()
    request = urllib.request.Request("https://files.data.gouv.fr/x.csv")

    with pytest.raises(DvfDownloadError):
        handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, "https://evil.example.com/x.csv")
    followed = handler.redirect_request(
        request, io.BytesIO(), 302, "Found", {}, "https://static.data.gouv.fr/x.csv"
    )
    assert followed is not None and followed.full_url == "https://static.data.gouv.fr/x.csv"


def test_fetch_json_uses_the_api_timeout(monkeypatch) -> None:
    opener = FakeOpener(FakeResponse(b'{"resources": []}'))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: opener)

    assert dvf_download.fetch_json("https://www.data.gouv.fr/api/1/datasets/x/") == {"resources": []}
    assert opener.calls[0][1] == 60
