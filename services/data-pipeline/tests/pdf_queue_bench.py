"""Banc d'essai de la file de lecture des pièces : une vente, un worker, une base en mémoire.

Vrai code : la visite du vidage (``document_backlog.drain_sale``), la passe de la file
(``run_enrichment_queue_batch``), le téléchargement, la lecture, le manifeste, la restauration depuis les lignes
persistées, la validation du point d'étape, la lecture en avance. Faux : le réseau (PDF synthétiques servis en
mémoire), la base (un dictionnaire pour la vente, ses lignes d'extraction et ses tâches) et les étapes sans
rapport avec les pièces (position, tribunal, procédure, caractéristiques).

Repris des essais du diagnostic R6 du 11/11/2026 (cas T1 à T12), dont les tests de ``test_pdf_queue_ticks.py``
rejouent les cas T3, T4 et T8.

Le temps passe par une horloge (``age``, time-machine) : rien n'est réécrit, ni en base ni sur le disque du
runner. L'empreinte d'une tâche ne change donc que si une passe écrit, et la même tâche est reprise à son
échéance, essai après essai.

Limites. Les transitions des tâches (``ENSURE_JOB_SQL``, ``CLAIM_JOB_SQL``, fin et report) et l'écriture de la
vente (admission, garde de révision, création de la tâche pdf) sont récrites ici en Python : relues contre le
SQL, mais rien ne les y lie. La sélection des ventes (``CANDIDATES_SQL``) n'est pas jouée : chaque ``drain`` est
une visite décidée par le test, y compris quand la base ferait attendre la vente. Ces deux points sont
vérifiés sur une vraie base dans ``test_document_backlog_candidates_postgres.py`` et
``test_pdf_final_write_contract_postgres.py``.
"""

from __future__ import annotations

import importlib
import json
import shutil
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pymupdf
import time_machine

import src.config as config
from src.admission import catalogue_write_rejection, closes_expired_offer_deadline
from src.freshness import documents_are_current
from src.models import AuctionSale

document_backlog = importlib.import_module("src.document_backlog")
pdf_document_selection = importlib.import_module("src.pdf_document_selection")
pdf_enrichment = importlib.import_module("src.pdf_enrichment")
pdf_fact_extraction = importlib.import_module("src.pdf_fact_extraction")
queued_runner = importlib.import_module("src.queued_runner")
supabase_client = importlib.import_module("src.storage.supabase_client")

SALE_URL = "https://example.test/vente-au-banc"
SETTINGS: dict[str, object] = {
    "user_agent": "immojudis-banc-file-pdf",
    "request_timeout_seconds": 5,
    "incremental_enrichment": True,
    "pdf_max_documents_per_sale": 6,
    "pdf_max_download_mb": 25,
    "pdf_max_total_pages": 300,
    "pdf_max_extract_pages": 75,
    "pdf_ocr_enabled": False,
    "pdf_ocr_language": "fra",
    "pdf_ocr_tessdata": None,
    "pdf_extractor": "pymupdf",
    "pdf_docling_enabled": False,
    "pdf_docling_threshold_chars": 1000,
    "pdf_docling_timeout_seconds": 5,
    "pdf_docling_ocr_max_pages": 0,
    "pdf_docling_ocr_max_size_mb": 0,
    "pdf_docling_ocr_mode": "disabled",
    "pdf_docling_chunk_pages": 10,
    "pdf_docling_ocr_chunk_pages": 10,
    "supabase_db_url": "",
    "supabase_url": "http://base.invalid",
    "supabase_service_role_key": "banc",
    "llm_enabled": True,
    "llm_prompt_version": "banc",
}
def pdf_bytes(directory: Path, text: str) -> bytes:
    """Un PDF d'une page portant ``text`` (une page blanche si ``text`` est vide)."""
    path = directory / f"source-{time.monotonic_ns()}.pdf"
    with pymupdf.open() as document:
        page = document.new_page()
        if text:
            page.insert_text((72, 72), text)
        document.save(path)
    return path.read_bytes()


class QueueBench:
    def __init__(self, monkeypatch, tmp_path: Path) -> None:
        self.tmp_path = tmp_path
        self.dirs = {name: tmp_path / name for name in ("documents", "pdf-texts", "document-texts", "docling")}
        for directory in self.dirs.values():
            directory.mkdir()
        for module in (pdf_enrichment, pdf_document_selection, queued_runner, supabase_client, config):
            monkeypatch.setattr(module, "load_settings", lambda: SETTINGS)
        monkeypatch.setattr(pdf_enrichment, "DOCUMENTS_DIR", self.dirs["documents"])
        monkeypatch.setattr(pdf_enrichment, "DOCLING_TEXTS_DIR", self.dirs["docling"])
        for module in (pdf_enrichment, pdf_fact_extraction, config, queued_runner, supabase_client):
            monkeypatch.setattr(module, "PDF_TEXTS_DIR", self.dirs["pdf-texts"])
        for module in (pdf_enrichment, config, supabase_client):
            monkeypatch.setattr(module, "PDF_DOCUMENT_TEXTS_DIR", self.dirs["document-texts"])

        # Réseau : chaque requête est notée ; ``gone`` répond 404.
        self.served: dict[str, bytes] = {}
        self.gone: set[str] = set()
        self.requests: list[str] = []
        monkeypatch.setattr(pdf_enrichment, "_download_document_response", self._respond)
        real_download = pdf_enrichment.download_documents
        monkeypatch.setattr(
            pdf_enrichment,
            "download_documents",
            lambda sale, *, stats=None: real_download(sale, output_root=self.dirs["documents"], stats=stats),
        )

        # Base : la ligne de la vente, ses lignes d'extraction, ses tâches pdf.
        self.row: dict[str, Any] = {}
        self.extraction_rows: list[dict[str, Any]] = []
        self.jobs: list[dict[str, Any]] = []
        self.discarded_writes = 0  # nombre d'écritures à venir que la garde de révision écartera
        self._clock: list[Any] = []
        for module in (queued_runner, supabase_client):
            monkeypatch.setattr(module, "fetch_sale_for_data_refresh", lambda _url: self.stored_sale())
        monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", self._upsert)
        monkeypatch.setattr(queued_runner, "finish_auction_enrichment_job_in_supabase", self._finish)
        monkeypatch.setattr(queued_runner, "defer_budget_jobs", self._defer)
        monkeypatch.setattr(
            supabase_client, "read_persisted_pdf_rows_rest", lambda *_args: [dict(row) for row in self.extraction_rows]
        )
        monkeypatch.setattr(supabase_client, "_persist_pdf_document_checkpoint_payload_to_supabase", self._checkpoint)
        monkeypatch.setattr(document_backlog, "_fetch_sale", lambda _url: self.stored_sale())
        monkeypatch.setattr(document_backlog, "_reproject", lambda sale: self._upsert([sale]))
        monkeypatch.setattr(document_backlog, "ensure_pdf_job", self._ensure)
        monkeypatch.setattr(document_backlog, "claim_pdf_job", self._claim)
        monkeypatch.setattr(document_backlog, "read_job_state", self._job_state)
        monkeypatch.setattr(document_backlog, "read_document_counts", self._document_counts)

        # Étapes de la passe sans rapport avec les pièces.
        monkeypatch.setattr(queued_runner, "sale_needs_position", lambda _sale: False)
        monkeypatch.setattr(queued_runner, "derive_sale_facts", lambda _sale, surface_context: None)

    # --- réseau
    def _respond(self, url: str, *, headers: dict[str, str], timeout_seconds: float) -> httpx.Response:
        del headers, timeout_seconds
        self.requests.append(url)
        request = httpx.Request("GET", url)
        if url in self.gone:
            return httpx.Response(404, request=request)
        return httpx.Response(
            200, headers={"content-type": "application/pdf"}, content=self.served[url], request=request
        )

    def serve(self, url: str, text: str) -> None:
        self.served[url] = pdf_bytes(self.tmp_path, text)

    # --- base
    def publish(self, urls: list[str], *, source: str = "licitor") -> None:
        """Une collecte publie la vente : ses pièces sont listées, aucune n'est lue."""
        documents = []
        for index, url in enumerate(urls):
            self.serve(url, f"Pièce {index}. Surface habitable : {80 + index} m2. Texte du cahier.")
            documents.append({"label": f"Cahier des conditions de vente {index}", "url": url, "document_type": "pdf"})
        self._store(
            AuctionSale(
                source_name=source,
                source_url=SALE_URL,
                documents=documents,
                starting_price_eur=100_000,
                property_type="other",
                status="upcoming",
                sale_date=datetime.now(UTC) + timedelta(days=30),
                updated_at=datetime.now(UTC),
            )
        )
        self.extraction_rows, self.jobs = [], []

    def _store(self, sale: AuctionSale) -> None:
        self.row = json.loads(json.dumps(sale.to_storage_dict(exclude_none=False), default=str))

    def stored_sale(self) -> AuctionSale:
        row = json.loads(json.dumps(self.row))
        return AuctionSale(**{key: value for key, value in row.items() if key in AuctionSale.model_fields})

    @property
    def manifest(self) -> dict[str, Any]:
        return self.row["raw_payload"].get("document_analysis") or {}

    def _upsert(self, sales: list[AuctionSale], **_kwargs: object) -> int:
        """``upsert_sales_to_supabase`` : admission, garde de révision, écriture, tâche pdf si la vente est à relire."""
        sale = sales[0]
        if catalogue_write_rejection(sale) is not None and not closes_expired_offer_deadline(sale):
            return 0
        if self.discarded_writes:  # la ligne a changé pendant la passe
            self.discarded_writes -= 1
            return 0
        sale.updated_at = datetime.now(UTC)
        self._store(sale)
        for row in supabase_client._extraction_rows_for_sale(sale):
            row = json.loads(json.dumps(row, default=str))
            self.extraction_rows = [item for item in self.extraction_rows if item["input_hash"] != row["input_hash"]]
            self.extraction_rows.append(row)
        if sale.documents and not documents_are_current(sale):
            input_hash = supabase_client.pdf_enrichment_input_hash_for_sale(sale)
            if not any(job["input_hash"] == input_hash for job in self.jobs):  # on conflict do nothing
                self._insert_job(input_hash, priority=30)
        return 1

    def _checkpoint(self, sale: AuctionSale, analysis: dict, result: list, *, pdf_job: object = None) -> bool:
        del pdf_job
        self.row["raw_payload"]["document_analysis"] = json.loads(json.dumps(analysis, default=str))
        self.extraction_rows.append(
            {
                "source_url": sale.source_url,
                "provider": supabase_client.PDF_EXTRACTION_PROVIDER,
                "model": supabase_client.PDF_EXTRACTION_MODEL,
                "input_hash": "pdf_checkpoint:" + supabase_client.pdf_enrichment_input_hash_for_sale(sale),
                "schema_version": supabase_client.PDF_EXTRACTION_SCHEMA_VERSION,
                "result": json.loads(json.dumps(result, default=str)),
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
        return True

    # --- tâches pdf (mêmes transitions que ENSURE_JOB_SQL, CLAIM_JOB_SQL, finish et defer)
    def _insert_job(self, input_hash: str, *, priority: int) -> dict[str, Any]:
        job = {
            "id": f"tache-{len(self.jobs) + 1}",
            "source_url": SALE_URL,
            "job_type": "pdf",
            "input_hash": input_hash,
            "status": "queued",
            "priority": priority,
            "attempt_count": 0,
            "max_attempts": 4,
            "next_attempt_at": datetime.now(UTC),
            "locked_at": None,
            "completed_at": None,
            "last_error": "",
        }
        self.jobs.append(job)
        return job

    def _job(self, job_id: str) -> dict[str, Any]:
        return next(job for job in self.jobs if job["id"] == job_id)

    def _ensure(self, _db: str, _source_url: str, input_hash: str) -> str | None:
        job = next((item for item in self.jobs if item["input_hash"] == input_hash), None)
        if job is None:
            return self._insert_job(input_hash, priority=document_backlog.BACKLOG_PDF_PRIORITY)["id"]
        if job["status"] == "running":
            return None
        if job["status"] in {"completed", "cancelled"} or job["attempt_count"] >= job["max_attempts"]:
            job["attempt_count"] = 0
        job.update(status="queued", next_attempt_at=datetime.now(UTC), completed_at=None, last_error="")
        return job["id"]

    def _claim(self, _db: str, job_id: str) -> dict[str, Any] | None:
        job = self._job(job_id)
        if job["status"] not in {"queued", "failed"} or job["attempt_count"] >= job["max_attempts"]:
            return None
        job.update(status="running", attempt_count=job["attempt_count"] + 1, locked_at=datetime.now(UTC).isoformat())
        job["last_error"] = ""
        return dict(job)

    def _finish(
        self,
        job_id: str,
        *,
        succeeded: bool,
        cancelled: bool = False,
        error_message: str | None = None,
        retry_not_before: datetime | None = None,
        **_claim,
    ) -> bool:
        job = self._job(job_id)
        job.update(
            status="cancelled" if cancelled else ("completed" if succeeded else "failed"),
            completed_at=datetime.now(UTC) if succeeded else None,
            last_error="" if succeeded else (error_message or "enrichment failed"),
            locked_at=None,
        )
        if not succeeded and not cancelled:  # nouvel essai dans 30 minutes, ou plus tard si la fin le demande
            retry_at = datetime.now(UTC) + timedelta(minutes=30)
            job["next_attempt_at"] = max(retry_at, retry_not_before) if retry_not_before else retry_at
        return True

    def _defer(self, jobs: list[dict[str, Any]], error: Any) -> None:
        for claimed in jobs:
            job = self._job(str(claimed["id"]))
            job.update(
                status="queued",
                attempt_count=max(0, job["attempt_count"] - 1),
                next_attempt_at=error.next_attempt_at,
                last_error=str(error),
                locked_at=None,
            )

    def _job_state(self, _db: str, job_id: str) -> tuple[str, str]:
        job = self._job(job_id)
        return job["status"], job["last_error"]

    def _document_counts(self, _db: str, _source_url: str) -> dict[str, int]:
        return {"extracted": int(self.manifest.get("documents_extracted") or 0)}

    # --- le worker
    def cold_runner(self) -> None:
        """Un runner neuf : ni fichier téléchargé, ni texte lu, ni fichier de suivi."""
        for name in ("documents", "pdf-texts", "document-texts"):
            shutil.rmtree(self.dirs[name])
            self.dirs[name].mkdir()

    def age(self, hours: float) -> None:
        """Le temps passe : l'horloge avance de ``hours`` heures, pour la base du banc comme pour le runner."""
        traveller = time_machine.travel(datetime.now(UTC) + timedelta(hours=hours), tick=True)
        traveller.start()
        self._clock.append(traveller)

    def close(self) -> None:
        """Remet l'horloge du processus (à appeler en fin de test)."""
        while self._clock:
            self._clock.pop().stop()

    def prefetch(self) -> dict[str, Any]:
        """La lecture en avance du vidage, hors verrou, avant la visite de la vente."""
        from src.document_prefetch import prefetch_sale_documents

        report = prefetch_sale_documents(SALE_URL, 60.0)
        assert report["error"] is None, report
        return report

    def drain(self) -> Any:
        """Une visite du vidage sur la vente : ``document_backlog.drain_sale`` et ses passes."""
        return document_backlog.drain_sale(
            "base-du-banc",
            {"source_url": SALE_URL, "source_name": self.row["source_name"]},
            document_backlog.BacklogLimits(),
            time.monotonic() + 600,
        )
