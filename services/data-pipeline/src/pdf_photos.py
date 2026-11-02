"""Photos du bien trouvées dans les pièces jointes des ventes (cahier des charges, procès-verbal descriptif…).

``python -m src.pdf_photos [--max-sales 4] [--budget-seconds 300]``

La page d'une vente montre souvent une seule photo quand son cahier des charges ou son procès-verbal en contient
une dizaine (Cessions de l'État, 66 rue Lafaurie de Monbadon à Bordeaux : une photo sur la page, neuf dans le
cahier des charges). Ce passage borné les retrouve et les ajoute à la galerie de la vente, après les photos de
la source (migrations ``20261111020013_sale_document_photos.sql`` et ``20261111020117_sale_document_photos_gallery.sql``).
Il ne lit ``auction_sales`` et ``auction_documents`` qu'en lecture ; il écrit dans le bucket ``sale-photos``
(préfixe ``documents/{sale_id}/``), ``public.sale_document_photos`` et ``public.sale_document_photo_scans``.

* **Interrupteur** : ``PDF_PHOTOS_ENABLED`` (allumé par défaut, comme les autres étapes du lanceur automatique ;
  ``false``, ``0``, ``no`` ou ``off`` l'éteignent). Éteint, rien n'est téléchargé ni copié, mais les retraits
  s'exécutent quand même : un retrait n'attend jamais la réactivation.
* **Sélection** : ventes du catalogue public (même prédicat que ``photo_mirror``) qui ont au moins une pièce
  jointe d'un type porteur de photos (``pv_huissier``, ``cahier_conditions_vente``, ``proces_verbal``,
  ``conditions_vente`` ; jamais les diagnostics) sans ligne ``sale_document_photo_scans`` (ou en échec ancien,
  3 essais au plus, à 12 h d'écart), et moins de 12 photos de documents. Les ventes les plus proches de leur date
  passent en premier ; une vente sans date compte comme se terminant dans une semaine. Enchères Publiques est
  exclue tant que l'accès n'est pas autorisé (source de la vente et hôte du document).
* **Téléchargement** : celui de ``photo_mirror`` (garde anti-SSRF, transport épinglé, robots.txt, 2 s au moins
  par hôte, reprises bornées, aucune reprise sur 401/403/404/410), pour un PDF de 40 Mo au plus, contrôlé sur
  ses premiers octets (``%PDF-``).
* **Extraction** : le PDF n'est jamais ouvert dans ce processus. ``src/pdf_photo_extract.py`` le lit dans un
  **sous-processus sans secret** (environnement en liste blanche de ``photo_mirror``, répertoire vide, délai,
  plafonds de processeur et de mémoire) : images dédoublonnées par ``xref`` et par empreinte, règle « photo du
  bien » (cartes, logos, schémas et pages scannées écartés, voir ce module), ré-encodage WebP 640 px et 1600 px.
* **Plafond** : 12 photos par vente, tous documents confondus ; une image déjà gardée pour la vente (même
  empreinte) n'est pas reprise.
* **Fichiers** : ``documents/{sale_id}/{sha256[:16]}-640.webp`` et ``-1600.webp``. Un chemin qui attend encore
  sa suppression dans ``sale_retention_storage_queue`` n'est jamais réutilisé : le document est reporté au
  passage suivant, sans ligne écrite.
* **Retraits** : au début de chaque passage, les photos d'une source retirée (vente entièrement retirée ou
  document sur un hôte retiré) et celles passées en ``withdrawn`` à la main sont supprimées ; le déclencheur de
  la table met leurs fichiers en file de rétention. Interrupteur allumé, les photos d'un document qui n'est plus
  rattaché à la vente sont supprimées de la même façon.
* **Code de sortie** : 0 tant que le passage a pu s'exécuter, quels que soient les échecs de documents ; 1 si le
  passage lui-même n'a pas pu tourner (base injoignable, identifiant manquant).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

from src import photo_mirror, source_withdrawal
from src.config import EncheresPubliquesAccessNotAuthorized, load_settings
from src.encheres_publiques_guard import (
    require_encheres_publiques_sale_access,
    require_encheres_publiques_url_access,
)
from src.pdf_document_types import classify_document_type
from src.photo_mirror import (
    BUCKET,
    ENCHERES_PUBLIQUES_URL_PATTERN,
    ImageRejected,
    MirrorFailure,
    PathPending,
    PhotoDownloader,
    PhotoStorage,
    SupabasePhotoStorage,
    build_politeness,
    host_of,
    image_decoder_environment,
)
from src.source_withdrawal import is_withdrawn_source_url, sale_is_fully_withdrawn

LOGGER = logging.getLogger(__name__)

ENABLED_ENV = "PDF_PHOTOS_ENABLED"
DEFAULT_MAX_SALES = 4
MAX_SALES_LIMIT = 200
DEFAULT_BUDGET_SECONDS = 300
MAX_BUDGET_SECONDS = 3600

#: Types de pièces jointes qui portent des photos du bien, dans l'ordre où on les lit pour une vente : le
#: procès-verbal descriptif d'abord (c'est lui qui photographie chaque pièce). Jamais les diagnostics.
PHOTO_DOCUMENT_TYPES: tuple[str, ...] = ("pv_huissier", "cahier_conditions_vente", "proces_verbal", "conditions_vente")
MAX_PHOTOS_PER_SALE = 12
MAX_ATTEMPTS = 3
RETRY_AFTER_HOURS = 12
PATH_PREFIX = "documents"

MAX_PDF_BYTES = 40 * 1024 * 1024
PDF_ACCEPT_HEADER = "application/pdf,*/*;q=0.1"
#: Un PDF de quelques dizaines de mégaoctets demande plus que les 15 s d'une photo.
PDF_REQUEST_TIMEOUT_SECONDS = 90.0
#: Le processus d'extraction (src/pdf_photo_extract.py) : au plus ce délai par document, lancé sans secret.
EXTRACTOR_TIMEOUT_SECONDS = 120.0
EXTRACTOR_SCRIPT = Path(__file__).resolve().with_name("pdf_photo_extract.py")

HOST_FAILURE_LIMIT = 3
CONSECUTIVE_ERROR_LIMIT = 5
WITHDRAWAL_BATCH = 500
STALE_BATCH = 300
LOCK_NAME = "immojudis:pdf-photos:v1"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


# --------------------------------------------------------------------------------------------------
# Téléchargement
# --------------------------------------------------------------------------------------------------


def check_pdf_prefix(head: bytes) -> None:
    """Un PDF commence par ``%PDF-`` (parfois après quelques octets) ; une page HTML ou une image est refusée."""
    if b"%PDF-" not in head[: photo_mirror.PREFIX_BYTES]:
        raise MirrorFailure("failed", "not_pdf", permanent=True)


class PdfDownloader(PhotoDownloader):
    """Le téléchargement poli et borné des photos, pour une pièce jointe PDF."""

    def request_options(self) -> tuple[str, int, Callable[[bytes], None], float]:
        return PDF_ACCEPT_HEADER, MAX_PDF_BYTES, check_pdf_prefix, PDF_REQUEST_TIMEOUT_SECONDS


# --------------------------------------------------------------------------------------------------
# Extraction (sous-processus sans secret)
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class DocumentPhoto:
    sha256: str
    page: int
    position: int
    width: int
    height: int
    single: bool
    data_640: bytes
    data_1600: bytes


@dataclass(frozen=True)
class Extraction:
    pages: int
    images: int
    rejected: Mapping[str, int]
    photos: tuple[DocumentPhoto, ...]


def extractor_command(max_photos: int = MAX_PHOTOS_PER_SALE) -> list[str]:
    """``python -I src/pdf_photo_extract.py``: mode isolé (ni PYTHONPATH, ni site utilisateur, ni dossier courant)."""
    return [sys.executable, "-I", str(EXTRACTOR_SCRIPT), "--max-photos", str(int(max_photos))]


def extract_photos(data: bytes, *, max_photos: int = MAX_PHOTOS_PER_SALE) -> Extraction:
    """Photos du bien d'un PDF téléchargé, lues par un processus qui n'a aucun secret.

    Ce processus-ci n'ouvre jamais le PDF ni ses images (ni PyMuPDF, ni Pillow) : il ne lit que la ligne JSON
    et les octets WebP rendus, après les avoir contrôlés.
    """
    check_pdf_prefix(data[: photo_mirror.PREFIX_BYTES])
    with tempfile.TemporaryDirectory(prefix="pdf-photos-") as workdir:
        try:
            completed = subprocess.run(
                extractor_command(max_photos),
                input=data,
                capture_output=True,
                env=image_decoder_environment(),
                cwd=workdir,
                timeout=EXTRACTOR_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ImageRejected("extract_timeout") from exc
    if completed.returncode != 0:
        LOGGER.warning("PDF photos: the extractor process ended with code %s", completed.returncode)
        raise ImageRejected("extractor_crashed")
    return parse_extraction(completed.stdout, max_photos=max_photos)


def _positive_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("not a positive integer")
    return value


def parse_extraction(output: bytes, *, max_photos: int = MAX_PHOTOS_PER_SALE) -> Extraction:
    """La réponse du processus d'extraction, contrôlée : tout écart devient ``extract_error``."""
    header_line, _, body = output.partition(b"\n")
    try:
        header = json.loads(header_line)
        if not isinstance(header, dict):
            raise ValueError("header is not an object")
        if header.get("ok") is not True:
            raise ImageRejected(str(header.get("reason") or "extract_error"))
        entries = header["photos"]
        if not isinstance(entries, list) or len(entries) > max_photos:
            raise ValueError("photos")
        rejected = header.get("rejected") or {}
        if not isinstance(rejected, dict):
            raise ValueError("rejected")
        photos: list[DocumentPhoto] = []
        offset = 0
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("entry")
            sha256 = str(entry["sha256"])
            if not _SHA256.match(sha256):
                raise ValueError("sha256")
            single = entry["single"]
            if not isinstance(single, bool):
                raise ValueError("single")
            length_640 = _positive_int(entry["len640"])
            length_1600 = entry["len1600"]
            if not isinstance(length_1600, int) or length_1600 < 0 or (single and length_1600 != 0):
                raise ValueError("len1600")
            if not single and length_1600 == 0:
                raise ValueError("len1600")
            data_640 = body[offset : offset + length_640]
            data_1600 = body[offset + length_640 : offset + length_640 + length_1600]
            offset += length_640 + length_1600
            if len(data_640) != length_640 or len(data_1600) != length_1600:
                raise ValueError("body")
            for payload in (data_640, data_1600):
                if payload and (
                    len(payload) > photo_mirror.BUCKET_FILE_LIMIT_BYTES
                    or not (payload[:4] == b"RIFF" and payload[8:12] == b"WEBP")
                ):
                    raise ValueError("webp")
            photos.append(
                DocumentPhoto(
                    sha256=sha256,
                    page=_positive_int(entry["page"]),
                    position=_positive_int(entry["position"]),
                    width=_positive_int(entry["width"]),
                    height=_positive_int(entry["height"]),
                    single=single,
                    data_640=data_640,
                    data_1600=data_640 if single else data_1600,
                )
            )
        if offset != len(body):
            raise ValueError("trailing bytes")
        pages = header.get("pages")
        images = header.get("images")
        return Extraction(
            pages=pages if isinstance(pages, int) and not isinstance(pages, bool) and pages >= 0 else 0,
            images=images if isinstance(images, int) and not isinstance(images, bool) and images >= 0 else 0,
            rejected={str(key): int(value) for key, value in rejected.items() if isinstance(value, int)},
            photos=tuple(photos),
        )
    except ImageRejected:
        raise
    except (ValueError, KeyError, TypeError) as exc:
        raise ImageRejected("extract_error") from exc


def photo_paths(sale_id: str, sha256: str, *, single: bool) -> tuple[str, str]:
    """``documents/{sale_id}/{sha256[0:16]}-640.webp`` et ``-1600.webp`` (le même chemin quand ``single``)."""
    uuid.UUID(str(sale_id))
    if not _SHA256.match(sha256):
        raise ValueError("invalid sha256")
    prefix = f"{PATH_PREFIX}/{sale_id}/{sha256[:16]}"
    path_640 = f"{prefix}-640.webp"
    return path_640, path_640 if single else f"{prefix}-1600.webp"


def public_url(supabase_url: str, path: str) -> str:
    """URL publique d'un fichier du bucket, sous la forme du site (``photoMirrorUrl`` de src/lib/photo-mirror.ts)."""
    base = str(supabase_url or "").strip().rstrip("/")
    if not re.match(r"^https?://[^/?#]+$", base):
        raise ValueError("SUPABASE_URL is not an origin")
    return f"{base}/storage/v1/object/public/{BUCKET}/{path}"


# --------------------------------------------------------------------------------------------------
# Base de données
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    sale_id: str
    sale_source_name: str
    observations: object
    sale_source_url: str
    document_url: str
    label: str
    document_type: str
    previous_attempts: int = 0


@dataclass(frozen=True)
class PhotoRow:
    sale_id: str
    document_url: str
    image_sha256: str
    page_number: int
    position: int
    width: int
    height: int
    path_640: str
    path_1600: str
    public_url: str


@dataclass
class ScanResult:
    sale_id: str
    document_url: str
    status: str = "failed"
    reason: str | None = None
    attempts: int = 0
    pages: int | None = None
    images: int | None = None
    photos_stored: int = 0
    http_status: int | None = None
    bytes_downloaded: int = 0
    rejected: Mapping[str, int] = field(default_factory=dict)
    seconds: float = 0.0


class DocumentPhotoStore(Protocol):
    def try_lock(self) -> bool: ...

    def select_candidates(self, max_sales: int, *, include_encheres_publiques: bool) -> list[Candidate]: ...

    def known_hashes(self, sale_id: str) -> set[str]: ...

    def stored_count(self, sale_id: str) -> int: ...

    def paths_queued_for_deletion(self, paths: list[str]) -> bool: ...

    def insert_photo(self, row: PhotoRow) -> bool: ...

    def save_scan(self, result: ScanResult) -> None: ...

    def stored_rows(self) -> list[dict[str, Any]]: ...

    def delete_rows(self, ids: list[str]) -> int: ...

    def mark_scans_withdrawn(self, keys: list[tuple[str, str]]) -> None: ...

    def delete_hidden_rows(self, limit: int) -> int: ...

    def delete_stale_rows(self, limit: int) -> int: ...

    def close(self) -> None: ...


CANDIDATES_SQL = """
with pending as (
  select s.id as sale_id, s.source_name, s.observations, s.source_url as sale_source_url,
         coalesce(s.sale_date, now() + interval '7 days') as due_at,
         d.document_url, d.label, d.document_type, coalesce(scan.attempts, 0) as attempts
    from public.auction_sales s
    join public.auction_documents d on d.source_url = s.source_url
    left join public.sale_document_photo_scans scan
      on scan.sale_id = s.id and scan.document_url = d.document_url
   where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
     and not s.catalogue_quarantined
     and app_private.sale_catalogue_projection_is_live(
           s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
           s.catalogue_expiry_fallback, s.catalogue_state_observed_at, s.catalogue_state_end_estimate)
     and d.document_url ~* '^https?://'
     and d.document_type = any (%s::text[])
     and (
           scan.id is null
           or (
                scan.status = 'failed'
                and scan.attempts < %s
                and (scan.last_attempt_at is null or scan.last_attempt_at < now() - make_interval(hours => %s::int))
              )
         )
     and (
           select count(*) from public.sale_document_photos photo
            where photo.sale_id = s.id and photo.status = 'stored'
         ) < %s
     and (%s or d.document_url !~* %s)
     and (
           %s
           or replace(replace(lower(btrim(coalesce(s.source_name, ''))), '-', '_'), ' ', '_')
              <> 'encheres_publiques'
         )
),
chosen as (
  select pending.sale_id, min(pending.due_at) as due_at
    from pending
   group by pending.sale_id
   order by min(pending.due_at), pending.sale_id
   limit %s
)
select p.sale_id, p.source_name, p.observations, p.sale_source_url, p.document_url, p.label,
       p.document_type, p.attempts
  from pending p
  join chosen c on c.sale_id = p.sale_id
 order by c.due_at, p.sale_id, array_position(%s::text[], p.document_type), p.document_url
"""

KNOWN_HASHES_SQL = "select image_sha256 from public.sale_document_photos where sale_id = %s"

STORED_COUNT_SQL = "select count(*) from public.sale_document_photos where sale_id = %s and status = 'stored'"

QUEUED_PATHS_SQL = photo_mirror.QUEUED_PATHS_SQL

INSERT_PHOTO_SQL = """
insert into public.sale_document_photos
       (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600,
        public_url, status)
values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'stored')
on conflict (sale_id, image_sha256) do nothing
"""

SAVE_SCAN_SQL = """
insert into public.sale_document_photo_scans
       (sale_id, document_url, status, reason, attempts, pages, images, photos_stored, last_attempt_at, updated_at)
values (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())
on conflict (sale_id, document_url) do update
   set status = excluded.status,
       reason = excluded.reason,
       attempts = excluded.attempts,
       pages = excluded.pages,
       images = excluded.images,
       photos_stored = excluded.photos_stored,
       last_attempt_at = excluded.last_attempt_at,
       updated_at = excluded.updated_at
"""

STORED_ROWS_SQL = """
select p.id, p.sale_id, p.document_url, s.source_name, s.observations
  from public.sale_document_photos p
  join public.auction_sales s on s.id = p.sale_id
 where p.status = 'stored'
"""

DELETE_ROWS_SQL = "delete from public.sale_document_photos where id = any(%s::uuid[])"

MARK_SCANS_WITHDRAWN_SQL = """
update public.sale_document_photo_scans
   set status = 'withdrawn', reason = 'source_withdrawn', updated_at = now()
 where (sale_id, document_url) in (select * from unnest(%s::uuid[], %s::text[]))
"""

# Photos retirées à la main (status = 'withdrawn') : déjà masquées par la galerie ; la ligne part, le déclencheur
# met ses fichiers en file de rétention.
DELETE_HIDDEN_ROWS_SQL = """
delete from public.sale_document_photos
 where id in (
   select p.id from public.sale_document_photos p where p.status = 'withdrawn' order by p.id limit %s
 )
"""

# Photos d'un document qui n'est plus rattaché à sa vente (la source l'a retiré de l'annonce). La ligne
# d'examen du document part aussi : s'il réapparaît, il est relu.
DELETE_STALE_ROWS_SQL = """
with stale as (
  select p.id, p.sale_id, p.document_url
    from public.sale_document_photos p
    join public.auction_sales s on s.id = p.sale_id
   where p.status = 'stored'
     and not exists (
       select 1 from public.auction_documents d
        where d.source_url = s.source_url and d.document_url = p.document_url
     )
   order by p.id
   limit %s
),
dropped_scans as (
  delete from public.sale_document_photo_scans scan
   using stale
   where scan.sale_id = stale.sale_id and scan.document_url = stale.document_url
)
delete from public.sale_document_photos photo
 using stale
 where photo.id = stale.id
"""


class PostgresDocumentPhotoStore:
    """Les deux tables et la sélection en lecture seule, sur une connexion en autocommit.

    La connexion tient aussi le verrou consultatif qui empêche deux passages de viser les mêmes hôtes ensemble.
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

    def select_candidates(self, max_sales: int, *, include_encheres_publiques: bool) -> list[Candidate]:
        types = list(PHOTO_DOCUMENT_TYPES)
        rows = self._connection.execute(
            CANDIDATES_SQL,
            (
                types,
                MAX_ATTEMPTS,
                RETRY_AFTER_HOURS,
                MAX_PHOTOS_PER_SALE,
                include_encheres_publiques,
                ENCHERES_PUBLIQUES_URL_PATTERN,
                include_encheres_publiques,
                int(max_sales),
                types,
            ),
        ).fetchall()
        return [
            Candidate(
                sale_id=str(row[0]),
                sale_source_name=str(row[1] or ""),
                observations=row[2],
                sale_source_url=str(row[3] or ""),
                document_url=str(row[4]),
                label=str(row[5] or ""),
                document_type=str(row[6] or ""),
                previous_attempts=int(row[7] or 0),
            )
            for row in rows
        ]

    def known_hashes(self, sale_id: str) -> set[str]:
        return {str(row[0]) for row in self._connection.execute(KNOWN_HASHES_SQL, (sale_id,)).fetchall()}

    def stored_count(self, sale_id: str) -> int:
        row = self._connection.execute(STORED_COUNT_SQL, (sale_id,)).fetchone()
        return int(row[0] if row else 0)

    def paths_queued_for_deletion(self, paths: list[str]) -> bool:
        return self._connection.execute(QUEUED_PATHS_SQL, (paths,)).fetchone() is not None

    def insert_photo(self, row: PhotoRow) -> bool:
        cursor = self._connection.execute(
            INSERT_PHOTO_SQL,
            (
                row.sale_id,
                row.document_url,
                row.image_sha256,
                row.page_number,
                row.position,
                row.width,
                row.height,
                row.path_640,
                row.path_1600,
                row.public_url,
            ),
        )
        return bool(cursor.rowcount)

    def save_scan(self, result: ScanResult) -> None:
        self._connection.execute(
            SAVE_SCAN_SQL,
            (
                result.sale_id,
                result.document_url,
                result.status,
                (result.reason or "")[:200] or None,
                result.attempts,
                result.pages,
                result.images,
                result.photos_stored,
            ),
        )

    def stored_rows(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(STORED_ROWS_SQL).fetchall()
        return [
            {
                "id": str(row[0]),
                "sale_id": str(row[1]),
                "document_url": str(row[2]),
                "source_name": row[3],
                "observations": row[4],
            }
            for row in rows
        ]

    def delete_rows(self, ids: list[str]) -> int:
        return int(self._connection.execute(DELETE_ROWS_SQL, (ids,)).rowcount or 0)

    def mark_scans_withdrawn(self, keys: list[tuple[str, str]]) -> None:
        if keys:
            self._connection.execute(
                MARK_SCANS_WITHDRAWN_SQL, ([key[0] for key in keys], [key[1] for key in keys])
            )

    def delete_hidden_rows(self, limit: int) -> int:
        return int(self._connection.execute(DELETE_HIDDEN_ROWS_SQL, (int(limit),)).rowcount or 0)

    def delete_stale_rows(self, limit: int) -> int:
        return int(self._connection.execute(DELETE_STALE_ROWS_SQL, (int(limit),)).rowcount or 0)

    def close(self) -> None:
        try:
            self._connection.close()
        except Exception:  # noqa: BLE001 - fermer libère de toute façon le verrou consultatif
            pass


# --------------------------------------------------------------------------------------------------
# Plafonds, résumé et journaux
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PassLimits:
    budget_seconds: float = float(DEFAULT_BUDGET_SECONDS)
    max_sales: int = DEFAULT_MAX_SALES


def _bounded_int(value: object, default: int, low: int, high: int) -> int:
    try:
        parsed = int(str(value).strip()) if value is not None and str(value).strip() else default
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


def limits_from_inputs(max_sales: object = None, budget_seconds: object = None) -> PassLimits:
    return PassLimits(
        budget_seconds=float(_bounded_int(budget_seconds, DEFAULT_BUDGET_SECONDS, 10, MAX_BUDGET_SECONDS)),
        max_sales=_bounded_int(max_sales, DEFAULT_MAX_SALES, 1, MAX_SALES_LIMIT),
    )


def pass_enabled(env: Mapping[str, str] | None = None) -> bool:
    value = str((env if env is not None else os.environ).get(ENABLED_ENV, "true")).strip().lower()
    return value not in {"0", "false", "no", "off"}


@dataclass
class PassSummary:
    stop_reason: str = "candidates_exhausted"
    documents_selected: int = 0
    sales_selected: int = 0
    documents_processed: int = 0
    photos_stored: int = 0
    by_status: Counter[str] = field(default_factory=Counter)
    failures_by_reason: Counter[str] = field(default_factory=Counter)
    rejected_images: Counter[str] = field(default_factory=Counter)
    skipped_hosts: Counter[str] = field(default_factory=Counter)
    bytes_downloaded: int = 0
    withdrawn_deleted: int = 0
    hidden_deleted: int = 0
    stale_deleted: int = 0
    elapsed_seconds: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "event": "pdf_photos_summary",
            "stop_reason": self.stop_reason,
            "sales_selected": self.sales_selected,
            "documents_selected": self.documents_selected,
            "documents_processed": self.documents_processed,
            "photos_stored": self.photos_stored,
            "by_status": dict(sorted(self.by_status.items())),
            "failures_by_reason": dict(sorted(self.failures_by_reason.items())),
            "rejected_images": dict(sorted(self.rejected_images.items())),
            "skipped_hosts": dict(sorted(self.skipped_hosts.items())),
            "bytes_downloaded": self.bytes_downloaded,
            "withdrawn_deleted": self.withdrawn_deleted,
            "hidden_deleted": self.hidden_deleted,
            "stale_deleted": self.stale_deleted,
            "elapsed_seconds": round(self.elapsed_seconds, 1),
        }


def _emit(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str), flush=True)


def _scan_log(result: ScanResult) -> dict[str, Any]:
    return {
        "event": "pdf_photos",
        "sale_id": result.sale_id,
        "host": host_of(result.document_url),
        "status": result.status,
        "reason": result.reason,
        "http_status": result.http_status,
        "attempts": result.attempts,
        "pages": result.pages,
        "images": result.images,
        "photos_stored": result.photos_stored,
        "rejected": dict(sorted(result.rejected.items())),
        "bytes_downloaded": result.bytes_downloaded,
        "seconds": round(result.seconds, 2),
    }


# --------------------------------------------------------------------------------------------------
# Un document
# --------------------------------------------------------------------------------------------------


def select_new_photos(photos: tuple[DocumentPhoto, ...], known: set[str], room: int) -> list[DocumentPhoto]:
    """Photos à garder : pas déjà connues pour la vente, sans doublon, ``room`` au plus (plafond par vente)."""
    chosen: list[DocumentPhoto] = []
    seen = set(known)
    for photo in photos:
        if len(chosen) >= max(0, room):
            break
        if photo.sha256 in seen:
            continue
        seen.add(photo.sha256)
        chosen.append(photo)
    return chosen


def process_document(
    candidate: Candidate,
    *,
    downloader: PhotoDownloader,
    storage: PhotoStorage,
    store: DocumentPhotoStore,
    settings: Mapping[str, object],
    pass_deadline: float,
    extract: Callable[[bytes], Extraction] = extract_photos,
    clock: Callable[[], float] = time.monotonic,
) -> ScanResult:
    """Cherche les photos d'une pièce jointe. Ne lève jamais pour un échec du document : le résultat le dit.

    Un statut ``deferred`` signifie qu'aucune ligne ne doit être écrite (chemin encore en file de suppression).
    """
    started = clock()
    url = candidate.document_url
    result = ScanResult(
        sale_id=candidate.sale_id, document_url=url, attempts=candidate.previous_attempts + 1
    )
    uploaded: list[str] = []
    try:
        db_url = str(settings.get("supabase_db_url") or "")
        names = SimpleNamespace(source_name=candidate.sale_source_name, observations=candidate.observations)
        if sale_is_fully_withdrawn(names, db_url):
            raise MirrorFailure("withdrawn", "source_withdrawn", permanent=True)
        try:
            require_encheres_publiques_sale_access(
                source_name=candidate.sale_source_name,
                source_url=candidate.sale_source_url or None,
                source_urls=[url],
                documents=[],
                settings=settings,
            )
        except EncheresPubliquesAccessNotAuthorized as exc:
            raise MirrorFailure("blocked", "ep_not_authorized", permanent=True) from exc
        # Le type enregistré peut dater d'un ancien classement : un document que le classement actuel range dans
        # les diagnostics n'est jamais lu (un libellé trop vague pour être classé garde le type enregistré).
        if classify_document_type(candidate.label, url) == "diagnostics_techniques":
            result.status, result.reason = "skipped", "document_type"
            return result
        downloader.precheck(url)
        pdf = downloader.download(url, pass_deadline=pass_deadline)
        result.bytes_downloaded = len(pdf)
        extraction = extract(pdf)
        result.pages, result.images, result.rejected = extraction.pages, extraction.images, extraction.rejected
        room = MAX_PHOTOS_PER_SALE - store.stored_count(candidate.sale_id)
        chosen = select_new_photos(extraction.photos, store.known_hashes(candidate.sale_id), room)
        planned = [(photo, *photo_paths(candidate.sale_id, photo.sha256, single=photo.single)) for photo in chosen]
        all_paths = [path for _photo, path_640, path_1600 in planned for path in (path_640, path_1600)]
        if all_paths and store.paths_queued_for_deletion(list(dict.fromkeys(all_paths))):
            raise PathPending
        supabase_url = str(settings.get("supabase_url") or "")
        for photo, path_640, path_1600 in planned:
            row = PhotoRow(
                sale_id=candidate.sale_id,
                document_url=url,
                image_sha256=photo.sha256,
                page_number=photo.page,
                position=photo.position,
                width=photo.width,
                height=photo.height,
                path_640=path_640,
                path_1600=path_1600,
                public_url=public_url(supabase_url, path_1600),
            )
            storage.upload(path_640, photo.data_640)
            uploaded.append(path_640)
            if not photo.single:
                storage.upload(path_1600, photo.data_1600)
                uploaded.append(path_1600)
            if store.insert_photo(row):
                result.photos_stored += 1
            else:
                # Une autre ligne a pris cette empreinte entre-temps : ses fichiers ont le même nom, on les garde.
                pass
            uploaded = []
        result.status = "done"
    except MirrorFailure as failure:
        result.status, result.reason, result.http_status = failure.status, failure.reason, failure.http_status
        if failure.status == "deferred":
            result.attempts = candidate.previous_attempts
        elif failure.status == "failed" and failure.permanent:
            result.attempts = MAX_ATTEMPTS
        _discard(storage, uploaded)
    except Exception as exc:  # noqa: BLE001 - stockage, base ou encodeur : ce document seulement, retenté plus tard
        LOGGER.warning("PDF photos: unexpected %s for sale %s", type(exc).__name__, candidate.sale_id)
        result.status, result.reason = "failed", f"unexpected_{type(exc).__name__}"
        _discard(storage, uploaded)
    result.seconds = clock() - started
    return result


def _discard(storage: PhotoStorage, paths: list[str]) -> None:
    """Au mieux : ne pas laisser les fichiers d'une photo dont la ligne n'a pas été écrite."""
    if not paths:
        return
    try:
        storage.remove(list(dict.fromkeys(paths)))
    except Exception:  # noqa: BLE001
        LOGGER.warning("PDF photos: could not remove %s partial file(s)", len(paths))


# --------------------------------------------------------------------------------------------------
# Retraits, au début de chaque passage
# --------------------------------------------------------------------------------------------------


def apply_withdrawals(store: DocumentPhotoStore, db_url: str, summary: PassSummary) -> None:
    """Photos d'une source retirée et photos retirées à la main : lignes supprimées, fichiers mis en file."""
    if source_withdrawal.withdrawn_sources(db_url):
        rows = [
            row
            for row in store.stored_rows()
            if is_withdrawn_source_url(row["document_url"], db_url)
            or sale_is_fully_withdrawn(
                SimpleNamespace(source_name=row["source_name"], observations=row["observations"]), db_url
            )
        ]
        for start in range(0, len(rows), WITHDRAWAL_BATCH):
            batch = rows[start : start + WITHDRAWAL_BATCH]
            summary.withdrawn_deleted += store.delete_rows([row["id"] for row in batch])
            # Le document n'est pas relu tant que la source reste retirée.
            store.mark_scans_withdrawn(sorted({(row["sale_id"], row["document_url"]) for row in batch}))
    summary.hidden_deleted = store.delete_hidden_rows(WITHDRAWAL_BATCH)


# --------------------------------------------------------------------------------------------------
# Le passage
# --------------------------------------------------------------------------------------------------


def run_pdf_photos(
    limits: PassLimits,
    *,
    settings: Mapping[str, object] | None = None,
    store: DocumentPhotoStore | None = None,
    storage: PhotoStorage | None = None,
    downloader: PhotoDownloader | None = None,
    env: Mapping[str, str] | None = None,
    extract: Callable[[bytes], Extraction] = extract_photos,
    clock: Callable[[], float] = time.monotonic,
) -> PassSummary:
    """Un passage. Interrupteur éteint : retraits seulement (aucun téléchargement, aucune copie)."""
    summary = PassSummary()
    enabled = pass_enabled(env)
    settings = settings if settings is not None else load_settings()
    started = clock()
    deadline = started + limits.budget_seconds
    owns_store = store is None
    try:
        db_url = str(settings.get("supabase_db_url") or "")
        if store is None:
            if not db_url:
                if not enabled:
                    summary.stop_reason = "disabled"
                    return summary
                raise RuntimeError("SUPABASE_DB_URL is required for the PDF photos pass")
            store = PostgresDocumentPhotoStore(db_url)
        if not store.try_lock():
            summary.stop_reason = "another_pass_running"
            return summary

        try:
            apply_withdrawals(store, db_url, summary)
        except Exception as exc:  # noqa: BLE001 - photos retenues par leur statut ; le passage suivant reprend
            LOGGER.warning("PDF photos: withdrawal step failed: %s", type(exc).__name__)
            summary.failures_by_reason[f"withdrawal_{type(exc).__name__}"] += 1

        if not enabled:
            summary.stop_reason = "disabled"
            return summary
        if not str(settings.get("supabase_url") or "").strip():
            raise RuntimeError("SUPABASE_URL is required for the PDF photos pass (public URL of the copies)")
        if storage is None:
            from src.storage.supabase_client import get_supabase_client

            client = get_supabase_client()
            if client is None:
                raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the PDF photos pass")
            storage = SupabasePhotoStorage(client)
        if downloader is None:
            downloader = PdfDownloader(
                politeness=build_politeness(settings), user_agent=str(settings["user_agent"]), settings=settings
            )

        try:
            summary.stale_deleted = store.delete_stale_rows(STALE_BATCH)
        except Exception as exc:  # noqa: BLE001 - hygiène seulement : le passage suivant reprend
            LOGGER.warning("PDF photos: stale photos step failed: %s", type(exc).__name__)
            summary.failures_by_reason[f"stale_{type(exc).__name__}"] += 1

        ep_open = _encheres_publiques_open(settings)
        candidates = store.select_candidates(limits.max_sales, include_encheres_publiques=ep_open)
        summary.documents_selected = len(candidates)
        summary.sales_selected = len({candidate.sale_id for candidate in candidates})
        host_failures: Counter[str] = Counter()
        paused_hosts: set[str] = set()
        consecutive_errors = 0
        for candidate in candidates:
            if clock() >= deadline:
                summary.stop_reason = "budget"
                break
            host = host_of(candidate.document_url)
            if host in paused_hosts:
                summary.skipped_hosts[host] += 1
                continue
            result = process_document(
                candidate,
                downloader=downloader,
                storage=storage,
                store=store,
                settings=settings,
                pass_deadline=deadline,
                extract=extract,
                clock=clock,
            )
            if result.status != "deferred":
                try:
                    store.save_scan(result)
                except Exception as exc:  # noqa: BLE001 - la base, pas le document
                    LOGGER.warning("PDF photos: could not record sale %s: %s", candidate.sale_id, type(exc).__name__)
                    summary.failures_by_reason["database_error"] += 1
                    consecutive_errors += 1
                    if consecutive_errors >= CONSECUTIVE_ERROR_LIMIT:
                        summary.stop_reason = "database_errors"
                        break
                    continue
            consecutive_errors = 0
            _count(summary, result)
            _emit(_scan_log(result))
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


def _count(summary: PassSummary, result: ScanResult) -> None:
    summary.documents_processed += 1
    summary.by_status[result.status] += 1
    summary.bytes_downloaded += result.bytes_downloaded
    summary.photos_stored += result.photos_stored
    summary.rejected_images.update(result.rejected)
    if result.status != "done" and result.reason:
        summary.failures_by_reason[result.reason] += 1


def _update_host_health(host: str, result: ScanResult, failures: Counter[str], paused: set[str]) -> None:
    """Laisser un hôte tranquille pour le reste du passage quand il échoue en série ou demande de ralentir."""
    if result.status == "done":
        failures[host] = 0
        return
    http_status = result.http_status
    transient = (
        result.reason in ("network_error", "timeout", "robots_unavailable")
        or http_status == 429
        or (http_status is not None and http_status >= 500)
    )
    if transient:
        failures[host] += 1
        if failures[host] >= HOST_FAILURE_LIMIT or http_status == 429:
            paused.add(host)


# --------------------------------------------------------------------------------------------------
# Ligne de commande
# --------------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Photos du bien trouvées dans les pièces jointes des ventes.")
    parser.add_argument("--max-sales", default=None)
    parser.add_argument("--budget-seconds", default=None)
    args = parser.parse_args(argv)
    if not pass_enabled():
        LOGGER.info("%s is off: no document is read, only withdrawals are applied", ENABLED_ENV)
    limits = limits_from_inputs(args.max_sales, args.budget_seconds)
    try:
        summary = run_pdf_photos(limits).as_dict()
    except Exception as exc:  # noqa: BLE001 - le passage lui-même n'a pas pu tourner : cela doit se voir
        LOGGER.exception("PDF photos pass failed")
        print(f"::error title=Photos des pièces jointes::the pass could not run ({type(exc).__name__}).")
        return 1
    _emit(summary)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
