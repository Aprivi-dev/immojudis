"""Copie hébergée de la photo principale des ventes (test d'hébergement du 16/10/2026).

``python -m src.photo_mirror [--max-photos 400] [--budget-minutes 15] [--automatic]``

Étape séparée et bornée, jamais appelée par la collecte ni par ``_finalize_sale_for_app`` : elle ne lit
que ``auction_sales`` et n'y écrit jamais (une écriture déclencherait une quinzaine de déclencheurs). Elle
écrit dans le bucket Storage ``sale-photos`` et dans ``public.sale_photos`` (migration
``20261026100000_sale_photo_mirrors.sql``).

* **Interrupteur** : si ``PHOTO_MIRROR_ENABLED`` ne vaut pas ``true``, aucune photo n'est téléchargée ni
  copiée, mais les retraits (copies d'une source retirée, fichiers d'une copie ``withdrawn``) s'exécutent
  quand même : un retrait n'attend jamais la réactivation.
* **Sélection** : ventes du catalogue public dont ``catalogue_thumbnail_url`` n'a pas de ligne
  ``sale_photos``, ou dont la ligne est ``failed`` (moins de 3 essais, dernier essai de plus de 12 h). Les
  ventes les plus proches de leur date passent en premier. Les ventes Enchères Publiques sont exclues tant
  que l'accès n'est pas autorisé.
* **Plafonds** : ``PHOTO_MIRROR_BUDGET_MINUTES`` (15) et ``PHOTO_MIRROR_MAX_PHOTOS`` (400). Avec
  ``--automatic`` (étape planifiée de data-pipeline.yml), le budget est plafonné à 20 minutes quel que soit
  le réglage, pour que le ``timeout-minutes`` de l'étape ne coupe jamais un envoi en cours.
* **Téléchargement** : même garde anti-SSRF et même transport épinglé que les pièces jointes
  (``pdf_document_transport``), même politesse (``document_politeness`` : robots.txt, 2 s au moins par hôte,
  ``Crawl-delay``), même User-Agent. 15 s au plus par requête, 2 reprises seulement sur erreur réseau, 5xx ou
  429 (``Retry-After`` respecté), jamais sur 401/403/404/410. Lecture en flux coupée à 8 Mo. Le type est
  contrôlé sur les premiers octets (jpeg, png, webp ; gif et svg refusés), jamais sur l'en-tête
  ``Content-Type`` (info-encheres renvoie ``application/x-httpd-php`` pour de vrais JPEG).
* **Image** : Pillow, pixels bornés (un JPEG multi-images est lu comme ``MPO``), rotation EXIF appliquée,
  profil ICC converti en sRGB puis supprimé, ré-encodage complet sans métadonnée en WebP qualité 75, 640 px et 1600 px de large au plus, sans jamais agrandir (original de 640 px ou moins :
  un seul fichier, ``path_1600 = path_640``). Images trop petites ou allongées refusées comme sur le site
  (``shouldRejectRenderedPropertyImage`` de ``src/lib/sale-media.ts``).
* **Retrait** : au début de chaque passage, les copies d'une source retirée passent en ``withdrawn`` et leurs
  fichiers sont supprimés du bucket ; aucune copie n'est faite pour une source retirée.
* **Copies périmées** : interrupteur allumé, chaque passage supprime (au plus ``STALE_BATCH`` lignes) les
  lignes ``stored`` dont ``source_url`` n'est plus la ``catalogue_thumbnail_url`` de leur vente ; le
  déclencheur de la table met leurs fichiers en file de rétention, sauf ceux qu'une autre ligne ``stored``
  de la vente référence encore.
* **Chemins déjà en file** : un chemin qui attend encore sa suppression dans
  ``sale_retention_storage_queue`` n'est jamais réutilisé. La photo est reportée au passage suivant (aucune
  ligne écrite), faute de quoi le cron effacerait le fichier tout juste recopié.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import sys
import time
import uuid
import warnings
from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from types import SimpleNamespace
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image, ImageCms, ImageOps

from src import source_withdrawal
from src.config import EncheresPubliquesAccessNotAuthorized, load_settings
from src.document_politeness import (
    DocumentPoliteness,
    DocumentRobotsDisallowed,
    DocumentRobotsUnavailable,
    configured_host_delay_seconds,
    fetch_robots_document,
)
from src.encheres_publiques_guard import (
    require_encheres_publiques_sale_access,
    require_encheres_publiques_url_access,
)
from src.pdf_document_transport import _PinnedHTTPTransport, resolve_public_document_target
from src.source_withdrawal import is_withdrawn_source_url, sale_is_fully_withdrawn

LOGGER = logging.getLogger(__name__)

ENABLED_ENV = "PHOTO_MIRROR_ENABLED"
BUDGET_ENV = "PHOTO_MIRROR_BUDGET_MINUTES"
MAX_PHOTOS_ENV = "PHOTO_MIRROR_MAX_PHOTOS"
DEFAULT_BUDGET_MINUTES = 15
# The GitHub job stops at 180 minutes; keep room for setup and the collection that precedes the pass.
MAX_BUDGET_MINUTES = 150
# The scheduled step of data-pipeline.yml stops at 25 minutes: its budget never goes above 20, whatever
# PHOTO_MIRROR_BUDGET_MINUTES says (5 minutes left for the request in flight, retries and the summary).
AUTOMATIC_MAX_BUDGET_MINUTES = 20
DEFAULT_MAX_PHOTOS = 400
MAX_PHOTOS_LIMIT = 10_000

BUCKET = "sale-photos"
WIDTHS = (640, 1600)
WEBP_QUALITY = 75
# One year. The file name carries the fingerprint of the original photo (``photo_paths``), so a new
# image always has a new name and a file is never overwritten (``upsert`` is false): nothing
# needs to be revalidated. The price: a withdrawal deletes the file (and Supabase invalidates its
# CDN), but a browser that already holds the image keeps showing it until it expires, one year at
# the latest (see docs/runbooks/retrait-photos.md). storage3 turns this number into
# ``cache-control: max-age=<seconds>``; it has no way to add ``immutable``.
CACHE_CONTROL_SECONDS = 31_536_000
# Same ceiling as the bucket (file_size_limit of the migration).
BUCKET_FILE_LIMIT_BYTES = 2 * 1024 * 1024

MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
MAX_ROBOTS_BYTES = 512 * 1024
PREFIX_BYTES = 64
# Decompression bomb guard: 40 megapixels is about 120 MB once decoded to RGB.
MAX_PIXELS = 40_000_000
# One request, connection included.
REQUEST_TIMEOUT_SECONDS = 15.0
MAX_RETRIES = 2
RETRY_BACKOFF_SECONDS = (3.0, 9.0)
# A host asking for a longer pause than this is left alone for the rest of the pass.
MAX_RETRY_AFTER_SECONDS = 60.0
MAX_REDIRECTS = 3
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# A failed photo is retried at most three times, at least twelve hours apart.
MAX_ATTEMPTS = 3
RETRY_AFTER_HOURS = 12
# Consecutive photos of one host that failed on network, 5xx, 429 or robots.txt before the host is left alone.
HOST_FAILURE_LIMIT = 3
CONSECUTIVE_ERROR_LIMIT = 5
WITHDRAWAL_BATCH = 500
# Copies whose URL is no longer the sale's main photo, deleted per pass.
STALE_BATCH = 300

# Same rules as shouldRejectRenderedPropertyImage (src/lib/sale-media.ts).
MIN_SHORT_SIDE = 300
MIN_LONG_SIDE = 480
MAX_ASPECT_RATIO = 3.2

#: Hosts known to refuse automated downloads (Cloudflare challenge): no request is sent, the status is
#: ``blocked``. Matches the host and its subdomains.
BLOCKED_HOSTS: tuple[str, ...] = ("www.petitesaffiches.fr",)

LOCK_NAME = "immojudis:photo-mirror:v1"
ACCEPT_HEADER = "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1"


# --------------------------------------------------------------------------------------------------
# Failures
# --------------------------------------------------------------------------------------------------


class MirrorFailure(Exception):
    """A photo that is not stored. ``status`` is the ``sale_photos.status`` to record."""

    def __init__(
        self,
        status: str,
        reason: str,
        *,
        permanent: bool = False,
        http_status: int | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> None:
        super().__init__(f"{status}: {reason}")
        self.status = status
        self.reason = reason
        self.permanent = permanent
        self.http_status = http_status
        self.width = width
        self.height = height


class RetryableFailure(MirrorFailure):
    """Network error, 5xx or 429: worth another request in the same pass (a few times)."""

    def __init__(self, reason: str, *, http_status: int | None = None, retry_after: float | None = None) -> None:
        super().__init__("failed", reason, http_status=http_status)
        self.retry_after = retry_after


class PathPending(MirrorFailure):
    """The files' names are still in the retention queue: nothing is written, the photo waits for the next pass."""

    def __init__(self) -> None:
        super().__init__("deferred", "path_queued_for_deletion")


class ImageRejected(MirrorFailure):
    """The bytes are not a usable photo: recorded as ``failed`` with no further attempt."""

    def __init__(self, reason: str, *, width: int | None = None, height: int | None = None) -> None:
        super().__init__("failed", reason, permanent=True, width=width, height=height)


# --------------------------------------------------------------------------------------------------
# Image type and processing
# --------------------------------------------------------------------------------------------------


def sniff_image_type(head: bytes) -> str:
    """Type from the first bytes: ``jpeg``, ``png`` or ``webp``. GIF, SVG and the rest are refused."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        raise ImageRejected("gif_refused")
    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if stripped.startswith((b"<svg", b"<?xml", b"<!doctype svg")):
        raise ImageRejected("svg_refused")
    raise ImageRejected("unsupported_type")


def _check_prefix(head: bytes) -> None:
    sniff_image_type(head)


@dataclass(frozen=True)
class ProcessedImage:
    width: int
    height: int
    data_640: bytes
    data_1600: bytes
    #: One file only: the original is 640 px wide or less.
    single: bool


@contextmanager
def _pixel_limit() -> Iterator[None]:
    previous = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            yield
    finally:
        Image.MAX_IMAGE_PIXELS = previous


def rejection_reason(width: int, height: int) -> str | None:
    """Same rule as ``shouldRejectRenderedPropertyImage`` (src/lib/sale-media.ts)."""
    if not width or not height:
        return None
    shortest, longest = min(width, height), max(width, height)
    if shortest < MIN_SHORT_SIDE or longest < MIN_LONG_SIDE:
        return "too_small"
    if longest / shortest > MAX_ASPECT_RATIO:
        return "too_elongated"
    return None


def _encode_webp(image: Image.Image, width: int) -> bytes:
    """Re-encode ``image`` at ``width`` px at most (never enlarged), with no metadata at all."""
    if width < image.width:
        height = max(1, round(image.height * width / image.width))
        output = image.resize((width, height), Image.Resampling.LANCZOS, reducing_gap=3.0)
    else:
        output = image.copy()
    # Nothing from the source (EXIF, XMP, ICC profile, comments) is handed to the encoder.
    output.info = {}
    buffer = io.BytesIO()
    output.save(buffer, "WEBP", quality=WEBP_QUALITY, method=4)
    data = buffer.getvalue()
    if len(data) > BUCKET_FILE_LIMIT_BYTES:
        raise ImageRejected("output_too_large")
    return data


#: Pillow formats accepted for each signature. A multi-picture JPEG (some cameras and phones) is opened as
#: ``MPO``: same bytes signature, first frame is the photo.
EXPECTED_FORMATS: Mapping[str, frozenset[str]] = {
    "jpeg": frozenset({"JPEG", "MPO"}),
    "png": frozenset({"PNG"}),
    "webp": frozenset({"WEBP"}),
}


def _to_srgb(image: Image.Image) -> Image.Image:
    """Convert to sRGB when the image carries an ICC profile; the result carries no profile.

    The browser would otherwise show the re-encoded WebP (stripped of its profile, so read as sRGB) with
    shifted colours for a Display P3, Adobe RGB or CMYK original. An unreadable profile is dropped and the
    pixels are taken as they are.
    """
    icc = image.info.get("icc_profile")
    if not icc:
        return image
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    base = image if image.mode in ("RGB", "L", "CMYK") else image.convert("RGB")
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        converted = ImageCms.profileToProfile(
            base,
            source,
            ImageCms.createProfile("sRGB"),
            renderingIntent=ImageCms.Intent.PERCEPTUAL,
            outputMode="RGB",
        )
    except (ImageCms.PyCMSError, OSError, ValueError, TypeError):
        converted = base.convert("RGB")
    if converted is None:  # pragma: no cover - only when inPlace is requested
        converted = base.convert("RGB")
    if alpha is not None:
        converted.putalpha(alpha)
    converted.info = {}
    return converted


def process_image(data: bytes) -> ProcessedImage:
    """Check, orient and re-encode a downloaded original into the files to host."""
    kind = sniff_image_type(data[:PREFIX_BYTES])
    expected = EXPECTED_FORMATS[kind]
    try:
        with _pixel_limit():
            source = Image.open(io.BytesIO(data))
            if source.format not in expected:
                raise ImageRejected("unsupported_type")
            if source.width * source.height > MAX_PIXELS:
                raise ImageRejected("decompression_bomb", width=source.width, height=source.height)
            source.load()
            oriented = ImageOps.exif_transpose(source)
            if oriented is None:  # pragma: no cover - in_place is never requested
                oriented = source
            width, height = oriented.size
            reason = rejection_reason(width, height)
            if reason is not None:
                raise ImageRejected(reason, width=width, height=height)
            oriented = _to_srgb(oriented)
            if oriented.mode in ("RGBA", "LA") or (oriented.mode == "P" and "transparency" in oriented.info):
                prepared = oriented.convert("RGBA")
            elif oriented.mode != "RGB":
                prepared = oriented.convert("RGB")
            else:
                prepared = oriented
            data_640 = _encode_webp(prepared, WIDTHS[0])
            single = width <= WIDTHS[0]
            data_1600 = data_640 if single else _encode_webp(prepared, WIDTHS[1])
    except ImageRejected:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageRejected("decompression_bomb") from exc
    except (OSError, ValueError, SyntaxError, EOFError, MemoryError) as exc:
        raise ImageRejected("decode_error") from exc
    return ProcessedImage(width=width, height=height, data_640=data_640, data_1600=data_1600, single=single)


def photo_paths(sale_id: str, sha256: str, *, single: bool) -> tuple[str, str]:
    """``{sale_id}/{sha256[0:16]}-640.webp`` and ``-1600.webp`` (the same path when ``single``)."""
    uuid.UUID(str(sale_id))
    prefix = f"{sale_id}/{sha256[:16]}"
    path_640 = f"{prefix}-640.webp"
    return path_640, path_640 if single else f"{prefix}-1600.webp"


# --------------------------------------------------------------------------------------------------
# Network
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Hop:
    """One response. The body is read only for a 200."""

    status: int
    headers: Mapping[str, str]
    body: bytes = b""


GetFunction = Callable[..., Hop]


def read_limited(
    chunks: Iterable[bytes],
    *,
    max_bytes: int,
    deadline: float,
    check_prefix: Callable[[bytes], None] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> bytes:
    """Read a stream up to ``max_bytes``; the type is checked as soon as the first bytes are in."""
    parts: list[bytes] = []
    size = 0
    checked = False
    for chunk in chunks:
        if clock() > deadline:
            raise RetryableFailure("timeout")
        size += len(chunk)
        if size > max_bytes:
            raise MirrorFailure("failed", "too_large", permanent=True)
        parts.append(chunk)
        if check_prefix is not None and not checked and size >= PREFIX_BYTES:
            check_prefix(b"".join(parts)[:PREFIX_BYTES])
            checked = True
    data = b"".join(parts)
    if check_prefix is not None and not checked:
        check_prefix(data[:PREFIX_BYTES])
    return data


def pinned_get(
    url: str,
    *,
    headers: Mapping[str, str],
    deadline: float,
    max_bytes: int,
    check_prefix: Callable[[bytes], None] | None = None,
    transport_factory: Callable[[Any], httpx.BaseTransport] = _PinnedHTTPTransport,
    resolver: Callable[[str], Any] = resolve_public_document_target,
    clock: Callable[[], float] = time.monotonic,
) -> Hop:
    """GET one URL through the pinned transport (public addresses only), no redirect followed."""
    try:
        target = resolver(url)
    except ValueError as exc:
        raise MirrorFailure("failed", "unsafe_url", permanent=True) from exc
    remaining = deadline - clock()
    if remaining <= 0:
        raise RetryableFailure("timeout")
    try:
        with httpx.Client(
            transport=transport_factory(target),
            follow_redirects=False,
            timeout=httpx.Timeout(remaining),
            trust_env=False,
        ) as client:
            with client.stream("GET", target.url, headers=dict(headers)) as response:
                response_headers = {key.lower(): value for key, value in response.headers.items()}
                if response.status_code != 200:
                    return Hop(response.status_code, response_headers)
                try:
                    declared = int(response_headers.get("content-length", ""))
                except ValueError:
                    declared = 0
                if declared > max_bytes:
                    raise MirrorFailure("failed", "too_large", permanent=True)
                body = read_limited(
                    response.iter_bytes(chunk_size=64 * 1024),
                    max_bytes=max_bytes,
                    deadline=deadline,
                    check_prefix=check_prefix,
                    clock=clock,
                )
                return Hop(response.status_code, response_headers, body)
    except httpx.TimeoutException as exc:
        raise RetryableFailure("timeout") from exc
    except (httpx.RequestError, OSError) as exc:
        # Connection, TLS and decoding errors alike: the host did not give us a usable response.
        raise RetryableFailure("network_error") from exc


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """``Retry-After`` as a number of seconds (delta or HTTP date); ``None`` when absent or unreadable."""
    if not value or not value.strip():
        return None
    text = value.strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - (now or datetime.now(UTC))).total_seconds())


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").rstrip(".").lower()
    except ValueError:
        return ""


def is_blocked_host(url: str) -> bool:
    host = host_of(url)
    return any(host == blocked or host.endswith(f".{blocked}") for blocked in BLOCKED_HOSTS)


class PhotoDownloader:
    """Polite, bounded download of one photo: robots.txt, host delay, redirects and a few retries."""

    def __init__(
        self,
        *,
        politeness: Any,
        user_agent: str,
        settings: Mapping[str, object],
        get: GetFunction = pinned_get,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._politeness = politeness
        self._user_agent = user_agent
        self._settings = settings
        self._get = get
        self._sleep = sleep
        self._clock = clock

    def precheck(self, url: str) -> None:
        """Refuse before any request: known blocking host, withdrawn source, Encheres Publiques gate."""
        if is_blocked_host(url):
            raise MirrorFailure("blocked", "host_blocklisted", permanent=True)
        db_url = str(self._settings.get("supabase_db_url") or "")
        if is_withdrawn_source_url(url, db_url):
            raise MirrorFailure("withdrawn", "source_withdrawn", permanent=True)
        try:
            require_encheres_publiques_url_access(url, self._settings)
        except EncheresPubliquesAccessNotAuthorized as exc:
            raise MirrorFailure("blocked", "ep_not_authorized", permanent=True) from exc

    def download(self, url: str, *, pass_deadline: float) -> bytes:
        for attempt in range(MAX_RETRIES + 1):
            try:
                return self._follow(url)
            except RetryableFailure as failure:
                if attempt >= MAX_RETRIES or failure.reason == "robots_unavailable":
                    raise
                wait = RETRY_BACKOFF_SECONDS[min(attempt, len(RETRY_BACKOFF_SECONDS) - 1)]
                if failure.retry_after is not None:
                    if failure.retry_after > MAX_RETRY_AFTER_SECONDS:
                        raise
                    wait = max(wait, failure.retry_after)
                if self._clock() + wait >= pass_deadline:
                    raise
                self._sleep(wait)
        raise AssertionError("unreachable")  # pragma: no cover

    def _follow(self, url: str) -> bytes:
        current = url
        headers = {"User-Agent": self._user_agent, "Accept": ACCEPT_HEADER}
        for redirects in range(MAX_REDIRECTS + 1):
            self.precheck(current)
            try:
                # robots.txt and the per-host delay apply to every hop, redirects included.
                self._politeness.wait_turn(current)
            except DocumentRobotsDisallowed as exc:
                raise MirrorFailure("blocked", "robots_disallowed", permanent=True) from exc
            except DocumentRobotsUnavailable as exc:
                raise RetryableFailure("robots_unavailable") from exc
            hop = self._get(
                current,
                headers=headers,
                deadline=self._clock() + REQUEST_TIMEOUT_SECONDS,
                max_bytes=MAX_DOWNLOAD_BYTES,
                check_prefix=_check_prefix,
            )
            status = hop.status
            if status == 200:
                return hop.body
            if status in REDIRECT_STATUSES:
                location = hop.headers.get("location")
                if not location or redirects >= MAX_REDIRECTS:
                    raise MirrorFailure(
                        "failed", "too_many_redirects" if location else "redirect_without_location", http_status=status
                    )
                current = urljoin(current, location)
                continue
            if status in (401, 403):
                raise MirrorFailure("blocked", f"http_{status}", permanent=True, http_status=status)
            if status in (404, 410):
                raise MirrorFailure("gone", f"http_{status}", permanent=True, http_status=status)
            if status == 429 or status >= 500:
                raise RetryableFailure(
                    f"http_{status}",
                    http_status=status,
                    retry_after=parse_retry_after(hop.headers.get("retry-after")),
                )
            raise MirrorFailure("failed", f"http_{status}", http_status=status)
        raise AssertionError("unreachable")  # pragma: no cover


def build_politeness(
    settings: Mapping[str, object],
    *,
    get: GetFunction = pinned_get,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> DocumentPoliteness:
    """robots.txt and host delay of the documents, fetched through the same pinned transport."""
    robots_settings = {"user_agent": str(settings["user_agent"]), "request_timeout_seconds": REQUEST_TIMEOUT_SECONDS}

    def send(url: str, *, headers: dict[str, str], timeout_seconds: float) -> httpx.Response:
        try:
            hop = get(url, headers=headers, deadline=clock() + timeout_seconds, max_bytes=MAX_ROBOTS_BYTES)
        except MirrorFailure as exc:
            # DocumentPoliteness treats this as "robots.txt could not be verified".
            raise OSError(exc.reason) from exc
        kept = {k: v for k, v in hop.headers.items() if k not in {"content-encoding", "content-length"}}
        kept["content-length"] = str(len(hop.body))
        return httpx.Response(hop.status, headers=kept, content=hop.body, request=httpx.Request("GET", url))

    return DocumentPoliteness(
        user_agent=lambda: str(settings["user_agent"]),
        fetch_robots=lambda robots_url: fetch_robots_document(robots_url, send=send, settings=robots_settings),
        sleep=sleep,
        clock=clock,
        # Never faster than one request every two seconds per host, whatever PDF_HOST_MIN_DELAY_SECONDS says.
        min_delay_seconds=max(2.0, configured_host_delay_seconds()),
    )


# --------------------------------------------------------------------------------------------------
# Storage and database
# --------------------------------------------------------------------------------------------------


class PhotoStorage(Protocol):
    def upload(self, path: str, data: bytes) -> None: ...

    def remove(self, paths: list[str]) -> None: ...


def is_duplicate_upload(error: Exception) -> bool:
    """``upsert=false`` upload refused because the object exists (HTTP 409 ``Duplicate``, or 400 on older servers).

    Same intent as ``outcome_ingestion.artifact_store._is_duplicate_storage_error``, which only reads a dict in
    ``args[0]``: the installed storage3 raises ``StorageApiError`` with the status, code and message as attributes.
    """
    details = error.args[0] if error.args and isinstance(error.args[0], dict) else {}
    status = details.get("statusCode", getattr(error, "status", None))
    label = " ".join(
        str(value or "")
        for value in (
            details.get("error"),
            details.get("message"),
            details.get("code"),
            getattr(error, "code", None),
            getattr(error, "message", None),
        )
    )
    return str(status) in {"400", "409"} and "duplicate" in label.casefold()


class SupabasePhotoStorage:
    """The ``sale-photos`` bucket through the service-role client."""

    def __init__(self, client: Any, bucket: str = BUCKET) -> None:
        self._bucket = client.storage.from_(bucket)

    def upload(self, path: str, data: bytes) -> None:
        try:
            self._bucket.upload(
                path=path,
                file=data,
                file_options={
                    "cache-control": str(CACHE_CONTROL_SECONDS),
                    "content-type": "image/webp",
                    "upsert": "false",
                },
            )
        except Exception as exc:
            # The file name carries the fingerprint of the original: an existing file is the same photo.
            if not is_duplicate_upload(exc):
                raise

    def remove(self, paths: list[str]) -> None:
        unique = list(dict.fromkeys(path for path in paths if path))
        for start in range(0, len(unique), 100):
            self._bucket.remove(unique[start : start + 100])


@dataclass(frozen=True)
class Candidate:
    sale_id: str
    sale_source_name: str
    observations: object
    photo_url: str
    previous_attempts: int = 0
    #: ``auction_sales.source_url``: the sale's own page, for the Encheres Publiques access gate.
    sale_source_url: str = ""


@dataclass
class PhotoResult:
    sale_id: str
    source_url: str
    source_host: str
    status: str
    reason: str | None = None
    attempts: int = 0
    sha256: str | None = None
    width: int | None = None
    height: int | None = None
    path_640: str | None = None
    path_1600: str | None = None
    bytes_640: int | None = None
    bytes_1600: int | None = None
    bytes_downloaded: int = 0
    seconds: float = 0.0
    http_status: int | None = None


class PhotoStore(Protocol):
    def try_lock(self) -> bool: ...

    def select_candidates(self, limit: int, *, include_encheres_publiques: bool) -> list[Candidate]: ...

    def save(self, result: PhotoResult) -> bool: ...

    def stored_rows(self) -> list[dict[str, Any]]: ...

    def mark_withdrawn(self, ids: list[str]) -> None: ...

    def rows_with_files_to_remove(self, limit: int) -> list[dict[str, Any]]: ...

    def clear_paths(self, ids: list[str]) -> None: ...

    def delete_stale_rows(self, limit: int) -> int: ...

    def paths_queued_for_deletion(self, paths: list[str]) -> bool: ...

    def stored_paths(self, paths: list[str]) -> set[str]: ...

    def close(self) -> None: ...


CANDIDATES_SQL = """
select s.id, s.source_name, s.observations, s.catalogue_thumbnail_url, coalesce(p.attempts, 0), s.source_url
  from public.auction_sales s
  left join public.sale_photos p
    on p.sale_id = s.id and p.source_url = s.catalogue_thumbnail_url
 where s.catalogue_thumbnail_url is not null
   and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
   and not s.catalogue_quarantined
   and (
         case
           when s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null
             then s.catalogue_expiry_deadline > now()
           else app_private.sale_catalogue_entry_is_live_materialized(
                  false, null, s.sale_date, s.raw_payload, s.sale_procedure)
         end
       )
   and (
         p.id is null
         or (
              p.status = 'failed'
              and p.attempts < %s
              and (p.last_attempt_at is null or p.last_attempt_at < now() - make_interval(hours => %s::int))
            )
       )
   and (%s or s.catalogue_thumbnail_url !~* %s)
   and (
         %s
         or replace(replace(lower(btrim(coalesce(s.source_name, ''))), '-', '_'), ' ', '_')
            <> 'encheres_publiques'
       )
 order by (s.sale_date is null), s.sale_date, s.id
 limit %s
"""

# Encheres Publiques stays closed until its access is explicitly authorized.
ENCHERES_PUBLIQUES_URL_PATTERN = r"^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)"

SAVE_SQL = """
insert into public.sale_photos
       (sale_id, source_url, source_host, sha256, path_640, path_1600, width, height,
        bytes_640, bytes_1600, status, attempts, last_attempt_at, stored_at)
values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), case when %s::text = 'stored' then now() end)
on conflict (sale_id, source_url) do update
   set source_host = excluded.source_host,
       sha256 = excluded.sha256,
       path_640 = excluded.path_640,
       path_1600 = excluded.path_1600,
       width = excluded.width,
       height = excluded.height,
       bytes_640 = excluded.bytes_640,
       bytes_1600 = excluded.bytes_1600,
       status = excluded.status,
       attempts = excluded.attempts,
       last_attempt_at = excluded.last_attempt_at,
       stored_at = excluded.stored_at
 where public.sale_photos.status = 'failed'
"""

STORED_ROWS_SQL = """
select p.id, p.source_url, s.source_name, s.observations
  from public.sale_photos p
  join public.auction_sales s on s.id = p.sale_id
 where p.status = 'stored'
"""

MARK_WITHDRAWN_SQL = """
update public.sale_photos set status = 'withdrawn', last_attempt_at = now()
 where id = any(%s::uuid[]) and status = 'stored'
"""

FILES_TO_REMOVE_SQL = """
select p.id, p.path_640, p.path_1600,
       exists (
         select 1 from public.sale_photos o
          where o.id <> p.id and o.sale_id = p.sale_id and o.status <> 'withdrawn'
            and (o.path_640 in (p.path_640, p.path_1600) or o.path_1600 in (p.path_640, p.path_1600))
       ) as shared
  from public.sale_photos p
 where p.status = 'withdrawn' and (p.path_640 is not null or p.path_1600 is not null)
 order by p.id
 limit %s
"""

CLEAR_PATHS_SQL = """
update public.sale_photos set path_640 = null, path_1600 = null, bytes_640 = null, bytes_1600 = null
 where id = any(%s::uuid[]) and status = 'withdrawn'
"""

# A copy whose URL is no longer the sale's main photo. Only ``stored`` rows: a ``withdrawn`` row must stay,
# it is what keeps a withdrawn photo from being copied again if the sale shows it once more. The delete
# trigger puts the files in the retention queue (except those another ``stored`` row still uses).
DELETE_STALE_ROWS_SQL = """
delete from public.sale_photos
 where id in (
   select p.id
     from public.sale_photos p
     join public.auction_sales s on s.id = p.sale_id
    where p.status = 'stored'
      and s.catalogue_thumbnail_url is distinct from p.source_url
    order by p.id
    limit %s
 )
"""

QUEUED_PATHS_SQL = """
select 1 from public.sale_retention_storage_queue
 where bucket = 'sale-photos' and object_path = any(%s::text[])
 limit 1
"""

STORED_PATHS_SQL = """
select p.path_640, p.path_1600 from public.sale_photos p
 where p.status = 'stored' and (p.path_640 = any(%s::text[]) or p.path_1600 = any(%s::text[]))
"""


class PostgresPhotoStore:
    """``sale_photos`` and the read-only catalogue selection, on one autocommit connection.

    The connection also holds the session advisory lock that keeps two passes (the scheduled one and a
    manual backfill) from hitting the same hosts together.
    """

    def __init__(self, db_url: str, *, connect: Callable[[str], Any] | None = None) -> None:
        if connect is None:
            from src.storage.supabase_client import connect as connect_postgres

            connect = connect_postgres
        self._connection = connect(db_url)
        self._connection.autocommit = True

    def try_lock(self) -> bool:
        row = self._connection.execute("select pg_try_advisory_lock(hashtextextended(%s, 0))", (LOCK_NAME,)).fetchone()
        return bool(row and row[0])

    def select_candidates(self, limit: int, *, include_encheres_publiques: bool) -> list[Candidate]:
        rows = self._connection.execute(
            CANDIDATES_SQL,
            (
                MAX_ATTEMPTS,
                RETRY_AFTER_HOURS,
                include_encheres_publiques,
                ENCHERES_PUBLIQUES_URL_PATTERN,
                include_encheres_publiques,
                int(limit),
            ),
        ).fetchall()
        return [
            Candidate(
                sale_id=str(row[0]),
                sale_source_name=str(row[1] or ""),
                observations=row[2],
                photo_url=str(row[3]),
                previous_attempts=int(row[4] or 0),
                sale_source_url=str(row[5] or ""),
            )
            for row in rows
        ]

    def save(self, result: PhotoResult) -> bool:
        cursor = self._connection.execute(
            SAVE_SQL,
            (
                result.sale_id,
                result.source_url,
                result.source_host,
                result.sha256,
                result.path_640,
                result.path_1600,
                result.width,
                result.height,
                result.bytes_640,
                result.bytes_1600,
                result.status,
                result.attempts,
                result.status,
            ),
        )
        return bool(cursor.rowcount)

    def stored_rows(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(STORED_ROWS_SQL).fetchall()
        return [
            {"id": str(row[0]), "source_url": str(row[1]), "source_name": row[2], "observations": row[3]}
            for row in rows
        ]

    def mark_withdrawn(self, ids: list[str]) -> None:
        self._connection.execute(MARK_WITHDRAWN_SQL, (ids,))

    def rows_with_files_to_remove(self, limit: int) -> list[dict[str, Any]]:
        rows = self._connection.execute(FILES_TO_REMOVE_SQL, (int(limit),)).fetchall()
        return [{"id": str(row[0]), "path_640": row[1], "path_1600": row[2], "shared": bool(row[3])} for row in rows]

    def clear_paths(self, ids: list[str]) -> None:
        self._connection.execute(CLEAR_PATHS_SQL, (ids,))

    def delete_stale_rows(self, limit: int) -> int:
        cursor = self._connection.execute(DELETE_STALE_ROWS_SQL, (int(limit),))
        return int(cursor.rowcount or 0)

    def paths_queued_for_deletion(self, paths: list[str]) -> bool:
        return self._connection.execute(QUEUED_PATHS_SQL, (paths,)).fetchone() is not None

    def stored_paths(self, paths: list[str]) -> set[str]:
        rows = self._connection.execute(STORED_PATHS_SQL, (paths, paths)).fetchall()
        return {path for row in rows for path in row if path in paths}

    def close(self) -> None:
        try:
            self._connection.close()
        except Exception:  # noqa: BLE001 - closing releases the advisory lock anyway
            pass


# --------------------------------------------------------------------------------------------------
# Limits, summary and logs
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MirrorLimits:
    budget_seconds: float = DEFAULT_BUDGET_MINUTES * 60.0
    max_photos: int = DEFAULT_MAX_PHOTOS


def _bounded_int(value: object, default: int, low: int, high: int) -> int:
    try:
        parsed = int(str(value).strip()) if value is not None and str(value).strip() else default
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


def limits_from_inputs(
    max_photos: object = None, budget_minutes: object = None, *, automatic: bool = False
) -> MirrorLimits:
    """Bounded limits. ``automatic`` (scheduled step) caps the budget at ``AUTOMATIC_MAX_BUDGET_MINUTES``."""
    ceiling = min(MAX_BUDGET_MINUTES, AUTOMATIC_MAX_BUDGET_MINUTES) if automatic else MAX_BUDGET_MINUTES
    return MirrorLimits(
        budget_seconds=60.0 * _bounded_int(budget_minutes, min(DEFAULT_BUDGET_MINUTES, ceiling), 1, ceiling),
        max_photos=_bounded_int(max_photos, DEFAULT_MAX_PHOTOS, 1, MAX_PHOTOS_LIMIT),
    )


def mirror_enabled(env: Mapping[str, str] | None = None) -> bool:
    return str((env if env is not None else os.environ).get(ENABLED_ENV, "")).strip().lower() == "true"


@dataclass
class MirrorSummary:
    stop_reason: str = "candidates_exhausted"
    selected: int = 0
    processed: int = 0
    stored: int = 0
    by_status: Counter[str] = field(default_factory=Counter)
    failures_by_reason: Counter[str] = field(default_factory=Counter)
    skipped_hosts: Counter[str] = field(default_factory=Counter)
    bytes_downloaded: int = 0
    bytes_stored: int = 0
    withdrawn_marked: int = 0
    withdrawn_files_removed: int = 0
    stale_deleted: int = 0
    elapsed_seconds: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "event": "photo_mirror_summary",
            "stop_reason": self.stop_reason,
            "selected": self.selected,
            "processed": self.processed,
            "stored": self.stored,
            "by_status": dict(sorted(self.by_status.items())),
            "failures_by_reason": dict(sorted(self.failures_by_reason.items())),
            "skipped_hosts": dict(sorted(self.skipped_hosts.items())),
            "bytes_downloaded": self.bytes_downloaded,
            "bytes_stored": self.bytes_stored,
            "withdrawn_marked": self.withdrawn_marked,
            "withdrawn_files_removed": self.withdrawn_files_removed,
            "stale_deleted": self.stale_deleted,
            "elapsed_seconds": round(self.elapsed_seconds, 1),
        }


def _emit(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str), flush=True)


def _photo_log(result: PhotoResult) -> dict[str, Any]:
    return {
        "event": "photo_mirror",
        "sale_id": result.sale_id,
        "host": result.source_host,
        "status": result.status,
        "reason": result.reason,
        "http_status": result.http_status,
        "attempts": result.attempts,
        "width": result.width,
        "height": result.height,
        "bytes_downloaded": result.bytes_downloaded,
        "bytes_640": result.bytes_640,
        "bytes_1600": result.bytes_1600,
        "seconds": round(result.seconds, 2),
    }


# --------------------------------------------------------------------------------------------------
# One photo
# --------------------------------------------------------------------------------------------------


def mirror_candidate(
    candidate: Candidate,
    *,
    downloader: PhotoDownloader,
    storage: PhotoStorage,
    pass_deadline: float,
    settings: Mapping[str, object],
    clock: Callable[[], float] = time.monotonic,
    store: PhotoStore | None = None,
) -> PhotoResult:
    """Copy one photo. Never raises for a photo-level failure: the outcome is the returned result.

    With a ``store``: a path still waiting in the retention queue is not reused (``deferred`` result, nothing
    written), and a file another ``stored`` row of the sale uses is never removed on failure.
    """
    started = clock()
    url = candidate.photo_url
    result = PhotoResult(
        sale_id=candidate.sale_id,
        source_url=url,
        source_host=host_of(url),
        status="failed",
        attempts=candidate.previous_attempts + 1,
    )
    uploaded: list[str] = []
    try:
        db_url = str(settings.get("supabase_db_url") or "")
        names = SimpleNamespace(source_name=candidate.sale_source_name, observations=candidate.observations)
        if sale_is_fully_withdrawn(names, db_url):
            raise MirrorFailure("withdrawn", "source_withdrawn", permanent=True)
        try:
            # The sale itself (its source and page), not only the host of the photo.
            require_encheres_publiques_sale_access(
                source_name=candidate.sale_source_name,
                source_url=candidate.sale_source_url or None,
                source_urls=[url],
                documents=[],
                settings=settings,
            )
        except EncheresPubliquesAccessNotAuthorized as exc:
            raise MirrorFailure("blocked", "ep_not_authorized", permanent=True) from exc
        downloader.precheck(url)
        original = downloader.download(url, pass_deadline=pass_deadline)
        result.bytes_downloaded = len(original)
        result.sha256 = hashlib.sha256(original).hexdigest()
        processed = process_image(original)
        result.width, result.height = processed.width, processed.height
        result.path_640, result.path_1600 = photo_paths(candidate.sale_id, result.sha256, single=processed.single)
        if store is not None and store.paths_queued_for_deletion([result.path_640, result.path_1600]):
            raise PathPending
        storage.upload(result.path_640, processed.data_640)
        uploaded.append(result.path_640)
        if not processed.single:
            storage.upload(result.path_1600, processed.data_1600)
            uploaded.append(result.path_1600)
        result.bytes_640 = len(processed.data_640)
        result.bytes_1600 = len(processed.data_1600)
        result.status = "stored"
    except MirrorFailure as failure:
        _apply_failure(result, failure, candidate.previous_attempts)
        _discard(storage, uploaded, store)
    except Exception as exc:  # noqa: BLE001 - storage or encoder bug: this photo only, retried later
        LOGGER.warning("Photo mirror: unexpected %s for sale %s", type(exc).__name__, candidate.sale_id)
        result.status, result.reason = "failed", f"unexpected_{type(exc).__name__}"
        result.path_640 = result.path_1600 = result.bytes_640 = result.bytes_1600 = None
        _discard(storage, uploaded, store)
    result.seconds = clock() - started
    return result


def _apply_failure(result: PhotoResult, failure: MirrorFailure, previous_attempts: int) -> None:
    result.status = failure.status
    result.reason = failure.reason
    result.http_status = failure.http_status
    result.width = failure.width if failure.width is not None else result.width
    result.height = failure.height if failure.height is not None else result.height
    result.path_640 = result.path_1600 = result.bytes_640 = result.bytes_1600 = None
    # A rejected image is never tried again: the attempts are used up at once.
    if failure.status == "deferred":
        result.attempts = previous_attempts  # nothing was tried: no attempt is used up
    else:
        result.attempts = MAX_ATTEMPTS if failure.status == "failed" and failure.permanent else previous_attempts + 1


def _discard(storage: PhotoStorage, paths: list[str], store: PhotoStore | None = None) -> None:
    """Best effort: do not leave a half-copied photo behind, nor remove one another row still serves.

    Two rows of a sale can share a path (same photo under two URLs: same sale, same fingerprint). The upload
    tolerates the existing file, so a failure afterwards must not delete it. When the database cannot say,
    the files are kept: an orphan costs a few kilobytes, a missing file breaks a served photo.
    """
    if not paths:
        return
    try:
        if store is not None:
            kept = store.stored_paths(paths)
            paths = [path for path in paths if path not in kept]
        if paths:
            storage.remove(paths)
    except Exception:  # noqa: BLE001
        LOGGER.warning("Photo mirror: could not remove %s partial file(s)", len(paths))


# --------------------------------------------------------------------------------------------------
# Withdrawal at the start of every pass
# --------------------------------------------------------------------------------------------------


def apply_withdrawals(store: PhotoStore, storage: PhotoStorage, db_url: str, summary: MirrorSummary) -> None:
    """Copies of a withdrawn source become ``withdrawn``; every withdrawn copy loses its files."""
    if source_withdrawal.withdrawn_sources(db_url):
        ids = [
            row["id"]
            for row in store.stored_rows()
            if is_withdrawn_source_url(row["source_url"], db_url)
            or sale_is_fully_withdrawn(
                SimpleNamespace(source_name=row["source_name"], observations=row["observations"]), db_url
            )
        ]
        for start in range(0, len(ids), WITHDRAWAL_BATCH):
            store.mark_withdrawn(ids[start : start + WITHDRAWAL_BATCH])
        summary.withdrawn_marked = len(ids)
    # Also removes the files of a copy withdrawn by hand (docs/runbooks/retrait-photos.md).
    rows = store.rows_with_files_to_remove(WITHDRAWAL_BATCH)
    if not rows:
        return
    paths: list[str] = []
    for row in rows:
        if not row["shared"]:
            paths.extend(path for path in (row["path_640"], row["path_1600"]) if path)
    paths = list(dict.fromkeys(paths))
    # Rows keep their paths until the files are gone, so a failed removal is retried by the next pass.
    storage.remove(paths)
    store.clear_paths([row["id"] for row in rows])
    summary.withdrawn_files_removed = len(paths)


# --------------------------------------------------------------------------------------------------
# The pass
# --------------------------------------------------------------------------------------------------


def run_photo_mirror(
    limits: MirrorLimits,
    *,
    settings: Mapping[str, object] | None = None,
    store: PhotoStore | None = None,
    storage: PhotoStorage | None = None,
    downloader: PhotoDownloader | None = None,
    env: Mapping[str, str] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> MirrorSummary:
    """One pass. Switch off: withdrawals only (no download, no copy, no other write)."""
    summary = MirrorSummary()
    enabled = mirror_enabled(env)
    settings = settings if settings is not None else load_settings()
    started = clock()
    deadline = started + limits.budget_seconds
    owns_store = store is None
    try:
        if store is None:
            db_url = str(settings.get("supabase_db_url") or "")
            if not db_url:
                if not enabled:  # nothing to withdraw without a database; not an error while the switch is off
                    summary.stop_reason = "disabled"
                    return summary
                raise RuntimeError("SUPABASE_DB_URL is required for the photo mirror")
            store = PostgresPhotoStore(db_url)
        if storage is None:
            from src.storage.supabase_client import get_supabase_client

            client = get_supabase_client()
            if client is None:
                if not enabled:
                    summary.stop_reason = "disabled"
                    return summary
                raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the photo mirror")
            storage = SupabasePhotoStorage(client)
        if enabled and downloader is None:
            downloader = PhotoDownloader(
                politeness=build_politeness(settings),
                user_agent=str(settings["user_agent"]),
                settings=settings,
            )
        if not store.try_lock():
            summary.stop_reason = "another_pass_running"
            return summary

        db_url = str(settings.get("supabase_db_url") or "")
        try:
            apply_withdrawals(store, storage, db_url, summary)
        except Exception as exc:  # noqa: BLE001 - copies still hidden by status; retried by the next pass
            LOGGER.warning("Photo mirror: withdrawal step failed: %s", type(exc).__name__)
            summary.failures_by_reason[f"withdrawal_{type(exc).__name__}"] += 1

        if not enabled:
            summary.stop_reason = "disabled"
            return summary
        if downloader is None:  # pragma: no cover - built above whenever the switch is on
            raise RuntimeError("downloader missing")

        try:
            summary.stale_deleted = store.delete_stale_rows(STALE_BATCH)
        except Exception as exc:  # noqa: BLE001 - hygiene only: the copies stay, the next pass retries
            LOGGER.warning("Photo mirror: stale copies step failed: %s", type(exc).__name__)
            summary.failures_by_reason[f"stale_{type(exc).__name__}"] += 1

        ep_open = _encheres_publiques_open(settings)
        candidates = store.select_candidates(limits.max_photos, include_encheres_publiques=ep_open)
        summary.selected = len(candidates)
        host_failures: Counter[str] = Counter()
        paused_hosts: set[str] = set()
        consecutive_errors = 0
        for candidate in candidates:
            if clock() >= deadline:
                summary.stop_reason = "budget"
                break
            host = host_of(candidate.photo_url)
            if host in paused_hosts:
                summary.skipped_hosts[host] += 1
                continue
            result = mirror_candidate(
                candidate,
                downloader=downloader,
                storage=storage,
                pass_deadline=deadline,
                settings=settings,
                clock=clock,
                store=store,
            )
            if result.status == "deferred":
                # Nothing is written: the photo is selected again by the next pass.
                _count(summary, result)
                _emit(_photo_log(result))
                continue
            try:
                written = store.save(result)
            except Exception as exc:  # noqa: BLE001 - the database, not the photo
                LOGGER.warning("Photo mirror: could not record sale %s: %s", candidate.sale_id, type(exc).__name__)
                _discard(storage, [p for p in (result.path_640, result.path_1600) if p], store)
                consecutive_errors += 1
                summary.failures_by_reason["database_error"] += 1
                if consecutive_errors >= CONSECUTIVE_ERROR_LIMIT:
                    summary.stop_reason = "database_errors"
                    break
                continue
            consecutive_errors = 0
            if not written:
                # The row changed under us (withdrawn by hand): do not leave the files we just sent.
                _discard(storage, [p for p in (result.path_640, result.path_1600) if p], store)
                result.status, result.reason = "failed", "row_changed"
            _count(summary, result)
            _emit(_photo_log(result))
            _update_host_health(host, result, host_failures, paused_hosts)
        return summary
    finally:
        summary.elapsed_seconds = clock() - started
        if owns_store and store is not None:
            store.close()


def _encheres_publiques_open(settings: Mapping[str, object]) -> bool:
    try:
        require_encheres_publiques_url_access("https://www.encheres-publiques.com/", settings)
    except EncheresPubliquesAccessNotAuthorized:
        return False
    return True


def _count(summary: MirrorSummary, result: PhotoResult) -> None:
    summary.processed += 1
    summary.by_status[result.status] += 1
    summary.bytes_downloaded += result.bytes_downloaded
    if result.status == "stored":
        summary.stored += 1
        summary.bytes_stored += (result.bytes_640 or 0) + (
            (result.bytes_1600 or 0) if result.path_1600 != result.path_640 else 0
        )
    elif result.reason:
        summary.failures_by_reason[result.reason] += 1


_HOST_HEALTH_REASONS = ("network_error", "timeout", "robots_unavailable")


def _update_host_health(host: str, result: PhotoResult, failures: Counter[str], paused: set[str]) -> None:
    """Leave a host alone for the rest of the pass when it keeps failing or asks us to slow down."""
    if result.status == "stored":
        failures[host] = 0
        return
    reason = result.reason or ""
    http_status = result.http_status
    transient = reason in _HOST_HEALTH_REASONS or http_status == 429 or (http_status is not None and http_status >= 500)
    if transient:
        failures[host] += 1
        if failures[host] >= HOST_FAILURE_LIMIT or http_status == 429:
            paused.add(host)
    elif result.status in ("blocked", "gone", "failed"):
        failures[host] = 0


# --------------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------------


def _write_step_summary(summary: Mapping[str, Any]) -> None:
    path = os.getenv("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [
        "### Copie des photos principales",
        "",
        f"- Arrêt : `{summary['stop_reason']}` après {summary['elapsed_seconds']} s",
        f"- Photos choisies : {summary['selected']}, traitées : {summary['processed']}, copiées : {summary['stored']}",
        f"- Octets téléchargés : {summary['bytes_downloaded']}, octets hébergés : {summary['bytes_stored']}",
        f"- Statuts : {json.dumps(summary['by_status'], ensure_ascii=False)}",
        f"- Échecs par motif : {json.dumps(summary['failures_by_reason'], ensure_ascii=False)}",
        f"- Retraits : {summary['withdrawn_marked']} copie(s) retirée(s), "
        f"{summary['withdrawn_files_removed']} fichier(s) supprimé(s) ; copies périmées supprimées : "
        f"{summary['stale_deleted']}",
    ]
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    except OSError as exc:
        LOGGER.warning("Could not write the GitHub step summary: %s", exc)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Copie des photos principales des ventes (bucket sale-photos).")
    parser.add_argument("--max-photos", default=os.getenv(MAX_PHOTOS_ENV))
    parser.add_argument("--budget-minutes", default=os.getenv(BUDGET_ENV))
    parser.add_argument(
        "--automatic",
        action="store_true",
        help=f"scheduled run: the budget never exceeds {AUTOMATIC_MAX_BUDGET_MINUTES} minutes",
    )
    args = parser.parse_args(argv)
    if not mirror_enabled():
        # No copy, but withdrawals still run (the summary says `disabled`).
        LOGGER.info("%s is not true: no photo is copied, only withdrawals are applied", ENABLED_ENV)
    limits = limits_from_inputs(args.max_photos, args.budget_minutes, automatic=args.automatic)
    summary = run_photo_mirror(limits).as_dict()
    _emit(summary)
    _write_step_summary(summary)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
