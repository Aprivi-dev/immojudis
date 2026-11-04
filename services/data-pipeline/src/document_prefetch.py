"""Lecture des pièces en avance, hors du verrou du catalogue.

Mesure du 04/11/2026 sur le vidage des pièces (42 minutes) : 60 % du temps à télécharger et lire les pièces
(1 974 pages, OCR à une page par seconde environ), 33 % à attendre le verrou du catalogue tenu par les collectes,
une seule vente à la fois sur un seul cœur. Le verrou ne protège pourtant que les écritures du catalogue.

Pendant qu'une vente est traitée sous le verrou, les ventes suivantes sont préparées par des processus à part :
téléchargement des pièces dans le cache local et lecture de leurs pages (cache de pages par contenu de fichier,
``extract_pdf_pages``). Aucune écriture en base : la passe sous verrou reste seule à publier, avec le même code,
et trouve les pages déjà lues.

* Des processus, pas des fils d'exécution : PyMuPDF ne se partage pas entre fils.
* Politesse : chaque processus applique un délai par hôte multiplié par le nombre de processus, si bien que le
  rythme cumulé vers un même site reste celui d'un seul téléchargeur.
* Une vente n'est jamais préparée et traitée en même temps : la passe sous verrou attend que sa préparation finisse.

Ce module reste léger à l'import : un processus de préparation importe la lecture des pièces seulement après
avoir réglé son délai par hôte (lu à l'import de ``src.pdf_enrichment``).
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import time
from collections.abc import Callable
from concurrent.futures import Executor, Future, ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

PREFETCH_WORKERS_ENV = "DOCUMENT_BACKLOG_PREFETCH_WORKERS"
DEFAULT_PREFETCH_WORKERS = 3
MAX_PREFETCH_WORKERS = 6
# A long scanned report stops at the per-document OCR budget; each round resumes from the page cache.
MAX_ROUNDS_PER_DOCUMENT = 6
# Sales prepared ahead per worker. A collection can hold the catalogue lock for 30 minutes (04/11/2026, 10:45):
# with one sale ahead per worker the processes sat idle while the locked pass waited. The queue is only file
# names and a deadline; the work it holds is what the locked pass would have done anyway.
LOOKAHEAD_PER_WORKER = 4


def prefetch_workers_from_env() -> int:
    raw = (os.getenv(PREFETCH_WORKERS_ENV) or "").strip()
    try:
        value = int(raw) if raw else DEFAULT_PREFETCH_WORKERS
    except ValueError:
        value = DEFAULT_PREFETCH_WORKERS
    return max(0, min(MAX_PREFETCH_WORKERS, value))


def _init_worker(host_delay_seconds: float) -> None:
    from src.document_politeness import HOST_DELAY_ENV

    os.environ[HOST_DELAY_ENV] = str(host_delay_seconds)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")


def prefetch_sale_documents(source_url: str, remaining_seconds: float) -> dict[str, Any]:
    """Download a sale's documents and read their pages into the local caches. Never writes to the database."""
    from src.config import PDF_DOCUMENT_TEXTS_DIR, PDF_TEXTS_DIR, load_settings
    from src.pdf_enrichment import (
        PdfEnrichmentStats,
        _read_document_text_cache,
        _select_documents_for_extraction,
        download_documents,
        extract_attached_document,
        pdf_deadline_scope,
        sale_storage_id,
    )
    from src.pdf_ocr import PdfDeadlineExceeded, PdfExtractionDeferred
    from src.pdf_progress import restore_pdf_page_caches_from_manifest
    from src.storage.supabase_client import fetch_sale_for_data_refresh, restore_persisted_pdf_progress_for_sale

    started = time.monotonic()
    result: dict[str, Any] = {"source_url": source_url, "documents": 0, "read": 0, "cached": 0, "error": None}
    with pdf_deadline_scope(started + max(0.0, remaining_seconds)):
        try:
            sale = fetch_sale_for_data_refresh(source_url)
            if sale is None or not sale.documents:
                return result
            restore_persisted_pdf_progress_for_sale(sale)
            downloaded = download_documents(sale, stats=PdfEnrichmentStats())
            settings = load_settings()
            restore_pdf_page_caches_from_manifest(
                PDF_TEXTS_DIR / f"{sale_storage_id(sale)}.json",
                downloaded,
                cache_root=PDF_DOCUMENT_TEXTS_DIR,
                ocr_enabled=bool(settings["pdf_ocr_enabled"]),
                ocr_language=str(settings["pdf_ocr_language"]),
            )
            revalidate = {str(item.get("url") or "") for item in downloaded}
            for document in _select_documents_for_extraction(downloaded, sale=sale, revalidate_urls=revalidate):
                result["documents"] += 1
                file_path = Path(document["file_path"])
                if _read_document_text_cache(document, file_path):
                    result["cached"] += 1
                    continue
                for _ in range(MAX_ROUNDS_PER_DOCUMENT):
                    try:
                        extract_attached_document(file_path, document=document)
                    except PdfDeadlineExceeded:
                        return result
                    except PdfExtractionDeferred:
                        continue
                    result["read"] += 1
                    break
        except Exception as exc:  # preparation is best effort: the locked pass reads what is missing
            result["error"] = f"{type(exc).__name__}: {exc}"[:300]
    result["seconds"] = round(time.monotonic() - started, 1)
    return result


class DocumentPrefetcher:
    """Prepares the next sales while the current one is processed under the catalogue lock."""

    def __init__(
        self,
        source_urls: list[str],
        *,
        workers: int,
        deadline: float,
        executor_factory: Callable[[int, float], Executor] | None = None,
        prefetch: Callable[[str, float], dict[str, Any]] = prefetch_sale_documents,
        clock: Callable[[], float] = time.monotonic,
        lookahead: int | None = None,
    ) -> None:
        self._urls = list(source_urls)
        self._workers = workers
        self._lookahead = max(workers + 1, lookahead if lookahead is not None else workers * LOOKAHEAD_PER_WORKER)
        self._deadline = deadline
        self._prefetch = prefetch
        self._clock = clock
        self._futures: dict[str, Future] = {}
        self._next = 0
        self.prepared = 0
        self._executor: Executor | None = None
        if workers > 0 and self._urls:
            factory = executor_factory or _process_executor
            self._executor = factory(workers, _per_process_host_delay(workers))

    def _schedule(self) -> None:
        if self._executor is None:
            return
        # Keep the workers busy even while the locked pass waits for a collection to release the lock.
        while self._next < len(self._urls) and len(self._futures) < self._lookahead:
            url = self._urls[self._next]
            self._next += 1
            remaining = self._deadline - self._clock()
            if remaining <= 0:
                return
            self._futures[url] = self._executor.submit(self._prefetch, url, remaining)

    def start(self) -> None:
        self._schedule()

    def wait_for(self, source_url: str) -> None:
        """Wait until this sale is no longer being prepared, then top the queue up."""
        future = self._futures.pop(source_url, None)
        # A preparation that has not started yet is dropped: the locked pass reads the documents itself.
        if future is not None and not future.cancel():
            try:
                outcome = future.result(timeout=max(0.0, self._deadline - self._clock()))
            except FutureTimeout:
                LOGGER.warning("Document prefetch still running for %s at the deadline", source_url)
            except Exception as exc:  # noqa: BLE001 - a broken worker never stops the drain
                LOGGER.warning("Document prefetch failed for %s: %s", source_url, exc)
            else:
                self.prepared += 1
                LOGGER.info("Document prefetch %s", outcome)
        self._schedule()

    def close(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=True)
            self._executor = None


def _per_process_host_delay(workers: int) -> float:
    from src.document_politeness import configured_host_delay_seconds

    return configured_host_delay_seconds() * max(1, workers)


def _process_executor(workers: int, host_delay_seconds: float) -> Executor:
    return ProcessPoolExecutor(
        max_workers=workers,
        mp_context=multiprocessing.get_context("spawn"),
        initializer=_init_worker,
        initargs=(host_delay_seconds,),
    )
