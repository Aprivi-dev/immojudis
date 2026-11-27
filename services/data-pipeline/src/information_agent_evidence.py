from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pymupdf as fitz

from src.config import llm_provider, load_settings
from src.image_dimensions import _isobmff_dimensions, _jpeg_dimensions, _webp_dimensions
from src.information_agent_auto_publication_arbiter import run_arbitration_pass
from src.information_agent_evidence_child import (
    child_popen_kwargs,
    kill_and_collect,
    limit_child_memory,
    terminate_process_group,
)
from src.information_agent_evidence_facts import EvidenceFact, deduplicate_facts, extract_evidence_facts
from src.information_agent_evidence_rows import (
    MAX_ATTEMPTS,
    claim_jobs,
    download_asset,
    fail_job,
    fetch_asset,
    fetch_case_status,
    fetch_footer_ai_provider,
    fetch_sale,
    fetch_sale_lot_context,
    mark_case_for_review,
    processing_lease_params,
    retry_schedule,
)
from src.information_agent_fact_candidates import (
    PROCESSOR_VERSION,
    fetch_existing_message_fact_values,
    insert_fact_candidates,
)
from src.information_agent_semantic import (
    MAX_SEMANTIC_INPUT_CHARS,
    MAX_VISION_IMAGE_BYTES,
    PhotoSemanticAnalysis,
    SemanticAnalysis,
    SemanticFact,
    pages_contain_prompt_injection,
    prompt_injection_skip,
    run_configured_photo_analysis,
    run_configured_semantic_analysis,
)
from src.normalize import clean_text
from src.pdf_document_types import classify_document_type
from src.pdf_ocr_child_output import parse_ocr_child_output
from src.storage.postgrest_helpers import rest_headers

# Le pied du message envoyé au professionnel nomme un autre prestataire d'IA que celui qui lirait sa réponse : ni
# lecture du texte ni lecture de la photo par l'IA, relecture humaine.
AI_PROVIDER_MISMATCH = "AI_PROVIDER_MISMATCH"
VISION_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"})
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
# Pages lues d'un PDF ; au-delà, les premières pages sont lues et la lecture est déclarée partielle. 300 comme la
# valeur par défaut des annonces (``pdf_max_total_pages``), sans en dépendre, sous les bornes de la table
# (``page_count`` et ``source_page`` au plus 1 000). La durée de lecture ne dépend pas de ce plafond : elle est bornée
# par passage (``PDF_READ_PASS_SECONDS``, ``PDF_TEXT_READ_SECONDS``) et par nombre de passages (``MAX_READING_PASSES``).
MAX_PAGES = 300
# ``extracted_text`` est borné à 250 000 caractères en base : le texte lu au-delà sert aux faits et au détecteur de
# consignes, mais n'est pas conservé (``stored_text_truncated`` dans ``metadata.reading``).
MAX_EXTRACTED_TEXT_CHARS = 240_000
MAX_PAGE_TEXT_CHARS = 30_000
# Image decoders expand compressed input before OCR. Keep both the dimensions
# and the estimated RGBA allocation bounded; the latter catches tiny highly
# compressible PNG/WebP payloads without rejecting normal property photos.
MAX_IMAGE_DIMENSION = 10_000
MAX_IMAGE_PIXELS = 20_000_000
MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024
PDF_OCR_DPI = 300
PDF_OCR_MAX_PIXELS = 16_000_000
PDF_OCR_MAX_DIMENSION = 5_000
PDF_OCR_PAGE_TIMEOUT_SECONDS = 10
# Lecture d'un long PDF en plusieurs passages du workflow (``information-agent-evidence.yml`` : 25 minutes, runner
# éphémère, d'où la progression rangée dans la ligne d'extraction). Un passage d'une pièce lit jusqu'à
# PDF_READ_PASS_SECONDS après sa prise en charge : une page n'est passée à l'OCR que si son délai entier
# (PDF_OCR_PAGE_TIMEOUT_SECONDS) y tient encore, sinon la lecture reprend à cette page au passage suivant. OCR mesuré
# à 2,7 s par page à 300 dpi : environ 85 pages par passage, un scan de 300 pages en 4 passages.
PDF_READ_PASS_SECONDS = 240
# Texte natif des pages d'un passage, lu dans un processus enfant tué au-delà : un PDF hostile (flux partagé et très
# compressé) coûte plusieurs secondes par page. La lecture reprend à la première page non atteinte au passage suivant ;
# au dernier passage, les pages non atteintes sont « text_timeout », non lues.
PDF_TEXT_READ_SECONDS = 120
# Un lot ne prend une pièce que si un passage entier tient avant cette durée (14 min, plus la fin du dernier passage :
# IA, écritures ; l'installation du workflow prend quelques minutes sur les 25). Les pièces non prises restent en
# file sans perdre d'essai.
EVIDENCE_BATCH_SECONDS = 14 * 60
# À partir de ce passage, chaque passage est un dernier passage (``_is_last_pass``) : 10 passages couvrent 300 pages
# jusqu'à 7 s d'OCR par page. Une pièce dont une page a été lue s'arrête là en partielle déclarée ; une pièce dont rien
# n'a jamais été lu passe en échec et réessaie, jusqu'à 12 passages (les 2 essais restants de ``MAX_ATTEMPTS``). Le
# dernier essai est aussi le dernier passage.
MAX_READING_PASSES = 10
PDF_OCR_LANGUAGE = "fra+eng"
IMAGE_OCR_TIMEOUT_SECONDS = 20
HEIF_CONVERT_TIMEOUT_SECONDS = 20
# Pages examinées dont le texte n'a pas été lu : texte natif hors délai ou illisible, OCR hors budget, en échec,
# refusé pour la taille de la page, ou désactivé pour une page sans texte natif suffisant.
UNREAD_PAGE_METHODS = frozenset(
    {
        "text_timeout",
        "text_failed",
        "ocr_total_timeout",
        "ocr_timeout",
        "ocr_failed",
        "ocr_skipped_dimensions",
        "ocr_not_run",
    }
)
# Texte natif d'une page, au plus, renvoyé par le processus enfant (le texte gardé est borné à MAX_PAGE_TEXT_CHARS
# après nettoyage) : une page hostile ne remplit pas la mémoire du worker.
MAX_NATIVE_PAGE_TEXT_CHARS = 4 * MAX_PAGE_TEXT_CHARS
# Statut d'une analyse dont la lecture continue au passage suivant (jamais écrit : la ligne repart ``queued``).
READING_IN_PROGRESS = "reading"
_SEMANTIC_PAGE_RE = re.compile(
    r"^--- page (?P<page>\d+) ---\n(?P<text>.*?)(?=\n\n--- page \d+ ---\n|\Z)",
    re.MULTILINE | re.DOTALL,
)
FACT_CANDIDATE_CASE_STATUSES = frozenset({"sending", "sent", "replied", "review"})
SUPPORTED_MIME_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "text/plain",
}


@dataclass(frozen=True)
class ReadingProgress:
    """Lecture d'un PDF commencée à un passage précédent, relue de la ligne d'extraction (runner éphémère).

    Les pages déjà examinées sont dans ``pages`` (sans texte), leurs faits par règles dans ``extracted_facts``, le
    début de leur texte dans ``extracted_text`` (borné à 240 000 caractères : la suite n'est pas conservée), le reste
    dans ``metadata.reading`` : page suivante, passages faits, consigne adressée à une IA déjà vue dans le texte lu.
    """

    next_page: int
    passes: int
    pages_total: int
    pages: list[dict[str, object]]
    stored_text: str
    stored_text_truncated: bool
    facts: list[EvidenceFact]
    prompt_injection: bool


@dataclass(frozen=True)
class EvidenceAnalysis:
    status: str
    detected_mime_type: str | None
    document_kind: str | None
    page_count: int | None
    is_encrypted: bool
    summary: str | None
    extracted_text: str | None
    pages: list[dict[str, object]]
    facts: list[EvidenceFact]
    error_code: str | None = None
    error_message: str | None = None
    # Le texte lu à ce passage, précédé du texte conservé des passages précédents ; en mémoire seulement :
    # ``extracted_text`` n'en conserve que le début. La lecture sémantique le lit.
    read_text: str | None = None
    # Pages lues sur pages du document, coupures, progression de la lecture et consigne adressée à une IA vue dans
    # tout le texte lu, passages précédents compris (``metadata.reading``) ; nul quand rien n'a été lu.
    reading: dict[str, object] | None = None


def run_information_agent_evidence_batch(*, limit: int = 5) -> int:
    settings = load_settings()
    supabase_url = str(settings.get("supabase_url") or "").rstrip("/")
    service_key = str(settings.get("supabase_service_role_key") or "")
    if not supabase_url or not service_key:
        return 0

    bounded_limit = max(1, min(10, int(limit)))
    batch_deadline = _monotonic() + EVIDENCE_BATCH_SECONDS
    # Aucune pièce remise en file pendant le lot n'est reprise avant sa fin : un passage par pièce et par lot. La RPC
    # sert la plus ancienne pièce d'abord ; sans cela, une lecture en reprise repasserait aussitôt devant les pièces
    # arrivées après elle.
    batch_end = datetime.now(UTC) + timedelta(seconds=EVIDENCE_BATCH_SECONDS)
    processed = 0
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=30.0), trust_env=False) as client:
        # Une pièce à la fois, prise seulement si un passage entier de lecture tient avant la fin du lot : le lot tient
        # dans le délai du workflow même si toutes ses pièces sont de longs scans, et une pièce non prise ne perd pas
        # d'essai.
        while processed < bounded_limit:
            read_deadline = _monotonic() + PDF_READ_PASS_SECONDS
            if read_deadline > batch_deadline:
                break
            jobs = claim_jobs(client, supabase_url, service_key, 1)
            if not jobs:
                break
            _process_job(
                client, supabase_url, service_key, jobs[0], read_deadline=read_deadline, requeue_not_before=batch_end
            )
            processed += 1
        # Publication automatique (étape 6) : verdict de Claude Haiku sur les informations du corps des réponses, après
        # le lot (les faits des règles et la lecture du corps sont alors écrits). Un échec n'annule pas le lot (déjà
        # écrit) : il est annoncé dans le workflow (annotation d'erreur), puis relevé à la fin pour que l'exécution
        # échoue visiblement. Un fait sans verdict reste en relecture humaine.
        arbitration_error: Exception | None = None
        try:
            run_arbitration_pass(client, supabase_url, service_key, settings)
        except Exception as exc:
            arbitration_error = exc
            print(
                "::error title=Arbitre de la publication automatique::passe en échec "
                f"({type(exc).__name__}) ; les faits sans verdict restent en relecture humaine.",
                flush=True,
            )
    if arbitration_error is not None:
        raise AutoPublicationArbitrationFailed(type(arbitration_error).__name__) from arbitration_error
    return processed


class AutoPublicationArbitrationFailed(RuntimeError):
    """La passe de l'arbitre a échoué après le lot des pièces (le lot, lui, est écrit)."""


def analyze_evidence_bytes(
    content: bytes,
    *,
    filename: str,
    declared_mime_type: str,
    ocr_enabled: bool = True,
    email_body: bool = False,
    resume: ReadingProgress | None = None,
    read_deadline: float | None = None,
    final_attempt: bool = False,
) -> EvidenceAnalysis:
    """``email_body`` : le corps du message (``metadata.evidence_kind``), un texte qui n'est pas une pièce de la vente.

    Un PDF est lu par passages : ``resume`` reprend la lecture d'un passage précédent, ``read_deadline`` (horloge
    ``_monotonic``) borne l'OCR de ce passage, ``PDF_READ_PASS_SECONDS`` après l'appel par défaut. Une lecture à
    poursuivre rend le statut ``READING_IN_PROGRESS``. ``final_attempt`` : dernier essai de la pièce, donc son dernier
    passage (``_is_last_pass``).
    """
    if read_deadline is None:
        read_deadline = _monotonic() + PDF_READ_PASS_SECONDS
    if not content or len(content) > MAX_ATTACHMENT_BYTES:
        return _unsupported("FILE_SIZE_INVALID", "La taille du fichier est invalide.")

    detected = detect_mime_type(content)
    if detected not in SUPPORTED_MIME_TYPES:
        return _unsupported("UNSUPPORTED_FILE_SIGNATURE", "La signature du fichier n’est pas prise en charge.", detected)
    if not _mime_types_compatible(declared_mime_type, detected):
        return _unsupported(
            "MIME_MISMATCH",
            "Le contenu réel du fichier ne correspond pas au type annoncé.",
            detected,
        )

    if resume is not None and detected != "application/pdf":
        raise ValueError("Only a PDF reading can be resumed")
    if detected == "application/pdf":
        return _analyze_pdf(
            content,
            filename=filename,
            detected_mime_type=detected,
            ocr_enabled=ocr_enabled,
            resume=resume,
            read_deadline=read_deadline,
            final_attempt=final_attempt,
        )
    if detected == "text/plain":
        return _analyze_text(content, filename=filename, detected_mime_type=detected, email_body=email_body)
    dimensions = _read_image_dimensions(content, detected)
    image_limit = _image_limit_error(dimensions, len(content))
    if image_limit is not None:
        return _unsupported(image_limit[0], image_limit[1], detected)
    return _analyze_image(
        content,
        filename=filename,
        detected_mime_type=detected,
        ocr_enabled=ocr_enabled,
    )


def detect_mime_type(content: bytes) -> str | None:
    if content.startswith(b"%PDF-"):
        return "application/pdf"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    if len(content) >= 12 and content[4:8] == b"ftyp":
        brand = content[8:12]
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "image/heic"
    if b"\x00" not in content[:4096] and _looks_like_text(content[:8192]):
        return "text/plain"
    return None


def _looks_like_text(sample: bytes) -> bool:
    """Accept UTF-8 text while rejecting arbitrary binary bytes.

    The previous latin-1 fallback classified every byte sequence without a
    NUL byte as ``text/plain`` because latin-1 can decode all byte values. A
    corrupt or executable attachment could therefore reach the text parser
    and be stored as if it were a professional reply. Email text is UTF-8 in
    the inbound contract, so require valid UTF-8 and reject control characters
    other than normal whitespace.
    """
    if not sample:
        return False
    try:
        text = sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    if not text:
        return False
    return not any(
        unicodedata.category(character) == "Cc" and character not in "\t\n\r\f"
        for character in text
    )


def _analyze_pdf(
    content: bytes,
    *,
    filename: str,
    detected_mime_type: str,
    ocr_enabled: bool,
    resume: ReadingProgress | None,
    read_deadline: float,
    final_attempt: bool,
) -> EvidenceAnalysis:
    """Un passage de lecture : les pages depuis ``resume.next_page`` (ou la première), dans l'ordre.

    Le texte natif est lu dans un processus enfant borné (``PDF_TEXT_READ_SECONDS``). Une page de moins de 80
    caractères passe à l'OCR si son délai entier tient avant ``read_deadline``. Une page que le passage n'a plus le temps
    de lire (OCR, ou texte natif non atteint) arrête la lecture, qui reprend à cette page au passage suivant. Au dernier
    passage (``_is_last_pass``), dès qu'une page a été lue, les pages restantes sont déclarées non lues
    (« ocr_total_timeout », « text_timeout ») et la lecture se termine, partielle ; une lecture dont aucune page n'a été
    lue reste à poursuivre et passe en échec (``_continue_reading_later``). La lecture s'arrête aussi dès qu'une
    consigne adressée à une IA est lue : aucun fait ne sera proposé, la suite est du temps perdu.
    """
    try:
        document = fitz.open(stream=content, filetype="pdf")
    except Exception as exc:
        return _unsupported("INVALID_PDF", f"PDF illisible : {str(exc)[:300]}", detected_mime_type)

    with document:
        if document.needs_pass:
            return EvidenceAnalysis(
                status="needs_password",
                detected_mime_type=detected_mime_type,
                document_kind=classify_document_type(filename),
                page_count=document.page_count,
                is_encrypted=True,
                summary="PDF protégé par mot de passe : une intervention est nécessaire.",
                extracted_text=None,
                pages=[],
                facts=[],
                error_code="PDF_PASSWORD_REQUIRED",
                error_message="Le document est chiffré. Aucun contournement ou essai de mot de passe n’a été effectué.",
            )
        total_pages = document.page_count
        if resume is not None and resume.pages_total != total_pages:
            raise RuntimeError("Evidence reading progress does not match the document")
        first_page = resume.next_page if resume is not None else 1
        last_page = min(total_pages, MAX_PAGES)
        passes = (resume.passes if resume is not None else 0) + 1
        last_pass = _is_last_pass(passes, final_attempt=final_attempt)
        pages_read = _pages_read(resume.pages) if resume is not None else 0
        pages: list[dict[str, object]] = []
        next_page: int | None = None
        previous_text_page: dict[str, object] | None = None
        with tempfile.TemporaryDirectory(prefix="immojudis-evidence-pdf-") as temp_dir:
            source_path = Path(temp_dir) / "evidence.pdf"
            source_path.write_bytes(content)
            native_pages, native_timed_out, native_failed = _read_pdf_native_text(
                source_path, first_page, last_page, timeout_seconds=PDF_TEXT_READ_SECONDS
            )
            if native_failed and not (last_pass and pages_read):
                # Enfant mort sans délai dépassé (mémoire, import, encodage) : un nouvel essai, pas des pages
                # déclarées non lues pour de bon. Au dernier passage, ce qui a été lu avant est gardé.
                raise RuntimeError("PDF native text process failed")
            for index in range(first_page, last_page + 1):
                native = native_pages.get(index)
                if native is None and native_timed_out and not (last_pass and pages_read):
                    next_page = index  # page non atteinte avant le délai du texte natif : lue au passage suivant
                    break
                if native is None or native.get("error") is not None:
                    # Page non atteinte au dernier passage, illisible, ou laissée par un enfant mort : non lue.
                    unread = "text_timeout" if native is None and native_timed_out else "text_failed"
                    pages.append({"page": index, "text": "", "chars": 0, "method": unread, "confidence": 0.0})
                    continue
                raw_text = str(native.get("text") or "")
                text, method, confidence = raw_text, "pymupdf_text", 0.92 if raw_text else 0.0
                if len(clean_text(raw_text) or "") < 80:
                    if not ocr_enabled:
                        text, method, confidence = _ocr_fallback(raw_text, "ocr_not_run")
                    else:
                        page = document.load_page(index - 1)
                        if not _pdf_page_ocr_allowed(page):
                            text, method, confidence = raw_text, "ocr_skipped_dimensions", 0.2 if raw_text else 0.0
                        elif read_deadline - _monotonic() >= PDF_OCR_PAGE_TIMEOUT_SECONDS:
                            text, method, confidence = _ocr_pdf_page(
                                page,
                                raw_text,
                                source_path=source_path,
                                timeout_seconds=PDF_OCR_PAGE_TIMEOUT_SECONDS,
                            )
                        elif last_pass and pages_read:
                            text, method, confidence = _ocr_fallback(raw_text, "ocr_total_timeout")
                        else:
                            next_page = index
                            break
                examined = _page_reading(index, text, method, confidence, clipped=native.get("clipped") is True)
                pages.append(examined)
                if method not in UNREAD_PAGE_METHODS:
                    pages_read += 1
                if not examined["text"]:
                    continue
                # Avec la page précédente : une consigne coupée par la limite de page est lue d'un seul tenant.
                if pages_contain_prompt_injection([item for item in (previous_text_page, examined) if item]):
                    break
                previous_text_page = examined

    return _completed_analysis(
        filename=filename,
        detected_mime_type=detected_mime_type,
        pages=pages,
        is_encrypted=False,
        total_pages=total_pages,
        previous=resume,
        next_page=next_page,
        passes=passes,
    )


def _is_last_pass(passes: int, *, final_attempt: bool) -> bool:
    """Le passage ``passes`` (compté dès 1) termine la lecture : nombre de passages atteint, ou dernier essai."""
    return passes >= MAX_READING_PASSES or final_attempt


def _page_reading(
    page_number: int, text: str, method: str, confidence: float, *, clipped: bool = False
) -> dict[str, object]:
    """Une page examinée : texte nettoyé et borné, ``text_truncated`` quand sa fin n'a pas été gardée."""
    cleaned = clean_text(text) or ""
    kept = cleaned[:MAX_PAGE_TEXT_CHARS]
    page: dict[str, object] = {
        "page": page_number,
        "text": kept,
        "chars": len(kept),
        "method": method,
        "confidence": confidence if kept else 0.0,
    }
    if clipped or len(kept) < len(cleaned):
        page["text_truncated"] = True
    return page


def _read_pdf_native_text(
    source_path: Path,
    first_page: int,
    last_page: int,
    *,
    timeout_seconds: float,
) -> tuple[dict[int, dict[str, object]], bool, bool]:
    """Texte natif des pages ``first_page`` à ``last_page`` (numérotées dès 1), lu dans un processus enfant tué au délai.

    Rend les pages lues avant le délai (``text`` et ``clipped``, ou ``error`` pour une page illisible), si le délai a
    coupé la lecture, et si l'enfant s'est terminé en erreur sans délai dépassé. L'enfant écrit une ligne JSON par page
    dès qu'elle est lue : une page interminable n'arrête que la lecture, jamais le worker.
    """
    if first_page > last_page:
        return {}, False, False
    command = [
        sys.executable,
        "-m",
        "src.information_agent_evidence",
        "--read-pdf-text",
        str(source_path),
        str(first_page),
        str(last_page),
    ]
    process = subprocess.Popen(command, **child_popen_kwargs())
    timed_out = False
    try:
        stdout, _stderr = process.communicate(timeout=max(float(timeout_seconds), 0.01))
    except subprocess.TimeoutExpired:
        timed_out = True
        # Les lignes écrites avant le délai : communicate() les a gardées et rend la sortie entière.
        stdout = kill_and_collect(process)
    except BaseException:
        terminate_process_group(process)
        raise
    return _parse_native_text_output(stdout, first_page, last_page), timed_out, (
        not timed_out and process.returncode != 0
    )


def _parse_native_text_output(stdout: str, first_page: int, last_page: int) -> dict[int, dict[str, object]]:
    """Pages lues par l'enfant, une ligne JSON chacune (ASCII : seul ``\\n`` sépare deux lignes)."""
    pages: dict[int, dict[str, object]] = {}
    for line in stdout.split("\n"):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            # Avertissement de MuPDF, ou dernière ligne coupée par l'arrêt de l'enfant : pas une page lue.
            continue
        if not isinstance(payload, dict):
            continue
        number = payload.get("page")
        if isinstance(number, int) and first_page <= number <= last_page:
            pages[number] = payload
    return pages


def _read_pdf_native_text_in_process(source_path: str, first_page: int, last_page: int) -> None:
    with fitz.open(source_path) as document:
        for number in range(first_page, last_page + 1):
            try:
                raw_text = document.load_page(number - 1).get_text("text") or ""
                payload: dict[str, object] = {
                    "page": number,
                    "text": raw_text[:MAX_NATIVE_PAGE_TEXT_CHARS],
                    "clipped": len(raw_text) > MAX_NATIVE_PAGE_TEXT_CHARS,
                }
            except Exception as exc:  # page illisible : notée pour le parent, les suivantes sont lues
                payload = {"page": number, "error": str(exc)[:300]}
            # ASCII : un U+2028 ou U+0085 du texte reste échappé et ne coupe pas la ligne.
            print(json.dumps(payload, ensure_ascii=True), flush=True)


def _analyze_text(content: bytes, *, filename: str, detected_mime_type: str, email_body: bool) -> EvidenceAnalysis:
    decoded = content.decode("utf-8", errors="replace")
    cleaned = clean_text(decoded[:MAX_EXTRACTED_TEXT_CHARS]) or ""
    page: dict[str, object] = {
        "page": 1,
        "text": cleaned,
        "chars": len(cleaned),
        "method": "plain_text",
        "confidence": 0.98,
    }
    if len(decoded) > MAX_EXTRACTED_TEXT_CHARS:
        page["text_truncated"] = True
    pages = [page]
    return _completed_analysis(
        filename=filename,
        detected_mime_type=detected_mime_type,
        pages=pages,
        is_encrypted=False,
        email_body=email_body,
    )


def _analyze_image(
    content: bytes,
    *,
    filename: str,
    detected_mime_type: str,
    ocr_enabled: bool,
) -> EvidenceAnalysis:
    processing_content = content
    processing_mime_type = detected_mime_type
    if detected_mime_type in {"image/heic", "image/heif"}:
        prepared = _prepare_heif_for_processing(content, detected_mime_type)
        if prepared is None:
            return _unsupported(
                "IMAGE_FORMAT_UNSUPPORTED",
                "Le format HEIC/HEIF est accepté à la réception mais aucun décodeur local sécurisé n’est disponible.",
                detected_mime_type,
            )
        processing_content, processing_mime_type = prepared
    text = ""
    method = "image_metadata"
    confidence = 0.0
    metadata: dict[str, object] = {}
    try:
        with fitz.open(stream=processing_content, filetype=processing_mime_type.split("/")[-1]) as image_document:
            if image_document.page_count != 1:
                return _unsupported(
                    "INVALID_IMAGE",
                    "L’image ne contient pas exactement une page décodable.",
                    detected_mime_type,
                )
            rectangle = image_document[0].rect
            metadata = {"width": round(rectangle.width), "height": round(rectangle.height)}
    except Exception:
        return _unsupported(
            "INVALID_IMAGE",
            "La signature est reconnue mais l’image ne peut pas être décodée.",
            detected_mime_type,
        )
    if ocr_enabled:
        text = _ocr_image_bytes(processing_content, processing_mime_type)
        if text:
            method = "ocr_tesseract"
            confidence = 0.7
    page = _page_reading(1, text, method, confidence)
    cleaned = str(page["text"])
    pages = [{**page, "confidence": confidence, "processing_mime_type": processing_mime_type, **metadata}]
    analysis = _completed_analysis(
        filename=filename,
        detected_mime_type=detected_mime_type,
        pages=pages,
        is_encrypted=False,
    )
    if not cleaned:
        return EvidenceAnalysis(
            **{
                **analysis.__dict__,
                "summary": "Photographie reçue et contrôlée. Aucun texte exploitable n’a été détecté ; la publication reste soumise à vérification des droits.",
            }
        )
    return analysis


def _prepare_heif_for_processing(
    content: bytes,
    mime_type: str,
) -> tuple[bytes, str] | None:
    """Return HEIF bytes in a decoder-supported format, or fail visibly.

    PyMuPDF builds used by the worker do not consistently include an HEIF
    decoder. If one is present, retain the original bytes; otherwise use the
    optional ``heif-convert`` executable already provided by some runtimes to
    produce a bounded PNG. A missing converter is reported by the caller as
    ``IMAGE_FORMAT_UNSUPPORTED`` rather than silently claiming OCR succeeded.
    """
    try:
        with fitz.open(stream=content, filetype=mime_type.split("/")[-1]) as document:
            if document.page_count:
                return content, mime_type
    except Exception:  # this PyMuPDF has no HEIF decoder or refuses the image: try the external converter
        pass

    executable = shutil.which("heif-convert")
    if not executable:
        return None
    suffix = ".heif" if mime_type == "image/heif" else ".heic"
    process: subprocess.Popen | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="immojudis-evidence-heif-") as temp_dir:
            source_path = Path(temp_dir) / f"evidence{suffix}"
            output_path = Path(temp_dir) / "evidence.png"
            source_path.write_bytes(content)
            # Environnement réduit, sans aucune clé (``child_popen_kwargs``) : le convertisseur ouvre un fichier reçu
            # d'un tiers.
            process = subprocess.Popen(
                [executable, str(source_path), str(output_path)],
                **{**child_popen_kwargs(), "stdout": subprocess.DEVNULL},
            )
            try:
                process.communicate(timeout=HEIF_CONVERT_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                terminate_process_group(process)
                return None
            if process.returncode != 0 or not output_path.is_file():
                return None
            converted = output_path.read_bytes()
            dimensions = _read_image_dimensions(converted, "image/png")
            if len(converted) > MAX_ATTACHMENT_BYTES or _image_limit_error(dimensions, len(converted)) is not None:
                return None
            return converted, "image/png"
    except Exception:
        # Untrusted attachment that cannot be converted: the caller reports the format as unsupported.
        if process is not None:
            terminate_process_group(process)
        return None


def _prepare_image_for_vision(
    content: bytes,
    mime_type: str,
) -> tuple[bytes, str] | None:
    """Normalize one photo to a small EXIF-free JPEG for the vision API."""
    processing_content = content
    processing_mime_type = mime_type
    if mime_type in {"image/heic", "image/heif"}:
        prepared = _prepare_heif_for_processing(content, mime_type)
        if prepared is None:
            return None
        processing_content, processing_mime_type = prepared
    if processing_mime_type not in {"image/jpeg", "image/png", "image/webp"}:
        return None
    try:
        with fitz.open(
            stream=processing_content,
            filetype=processing_mime_type.split("/")[-1],
        ) as image_document:
            if image_document.page_count != 1:
                return None
            page = image_document[0]
            width = float(page.rect.width)
            height = float(page.rect.height)
            largest_dimension = max(width, height)
            if not math.isfinite(largest_dimension) or largest_dimension <= 0:
                return None
            scale = min(1.0, 1_600 / largest_dimension)
            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale),
                colorspace=fitz.csRGB,
                alpha=False,
            )
            for quality in (82, 70, 55, 40):
                normalized = pixmap.tobytes("jpeg", jpg_quality=quality)
                if len(normalized) <= MAX_VISION_IMAGE_BYTES:
                    return normalized, "image/jpeg"
    except Exception:  # undecodable photo: the caller records VISION_IMAGE_NORMALIZATION_FAILED
        return None
    return None


def _read_image_dimensions(content: bytes, mime_type: str) -> tuple[int, int] | None:
    if mime_type == "image/png":
        if len(content) < 24 or content[12:16] != b"IHDR":
            return None
        return int.from_bytes(content[16:20], "big"), int.from_bytes(content[20:24], "big")
    if mime_type == "image/jpeg":
        return _jpeg_dimensions(content)
    if mime_type == "image/webp":
        return _webp_dimensions(content)
    if mime_type in {"image/heic", "image/heif"}:
        return _isobmff_dimensions(content)
    return None



def _image_limit_error(
    dimensions: tuple[int, int] | None,
    compressed_size: int,
) -> tuple[str, str] | None:
    if dimensions is None:
        return "IMAGE_DIMENSIONS_UNREADABLE", "Les dimensions de l’image ne peuvent pas être contrôlées."
    width, height = dimensions
    pixels = width * height if width > 0 and height > 0 else 0
    if (
        width <= 0
        or height <= 0
        or width > MAX_IMAGE_DIMENSION
        or height > MAX_IMAGE_DIMENSION
        or pixels > MAX_IMAGE_PIXELS
    ):
        return "IMAGE_DIMENSIONS_EXCEEDED", "Les dimensions de l’image dépassent la limite autorisée."
    estimated_decoded_bytes = pixels * 4
    if estimated_decoded_bytes > MAX_DECODED_IMAGE_BYTES:
        return "IMAGE_DECOMPRESSION_LIMIT", "La décompression de l’image dépasserait la limite mémoire."
    if compressed_size <= 0:
        return "IMAGE_SIZE_INVALID", "La taille de l’image est invalide."
    return None


def _pdf_page_ocr_allowed(page: fitz.Page) -> bool:
    """Check page and embedded image sizes before PyMuPDF can rasterize them."""
    try:
        rectangle = page.rect
        width_px = math.ceil(float(rectangle.width) * PDF_OCR_DPI / 72)
        height_px = math.ceil(float(rectangle.height) * PDF_OCR_DPI / 72)
        page_pixels = width_px * height_px if width_px > 0 and height_px > 0 else 0
        if (
            not math.isfinite(float(rectangle.width))
            or not math.isfinite(float(rectangle.height))
            or width_px <= 0
            or height_px <= 0
            or width_px > PDF_OCR_MAX_DIMENSION
            or height_px > PDF_OCR_MAX_DIMENSION
            or page_pixels > PDF_OCR_MAX_PIXELS
        ):
            return False
        for image in page.get_images(full=True):
            if len(image) < 4:
                return False
            image_width = int(image[2])
            image_height = int(image[3])
            if _image_limit_error((image_width, image_height), 1) is not None:
                return False
        return True
    except Exception:
        # A malformed resource must not reach the OCR decoder.
        return False


def _completed_analysis(
    *,
    filename: str,
    detected_mime_type: str,
    pages: list[dict[str, object]],
    is_encrypted: bool,
    total_pages: int | None = None,
    email_body: bool = False,
    previous: ReadingProgress | None = None,
    next_page: int | None = None,
    passes: int = 1,
) -> EvidenceAnalysis:
    """Analyse des pages examinées à ce passage (avec leur texte), après celles des passages précédents (``previous``).

    ``total_pages`` : pages du document quand seules les ``MAX_PAGES`` premières sont lisibles ; ``next_page`` : page
    où la lecture reprendra au passage suivant (nul : lecture terminée).
    """
    facts = deduplicate_facts([*(previous.facts if previous else []), *extract_evidence_facts(pages)])
    pass_text = "\n\n".join(
        f"--- page {page['page']} ---\n{page.get('text') or ''}" for page in pages if page.get("text")
    )
    read_text = "\n\n".join(part for part in (previous.stored_text if previous else "", pass_text) if part)
    combined = read_text[:MAX_EXTRACTED_TEXT_CHARS]
    stored_text_truncated = (previous is not None and previous.stored_text_truncated) or len(read_text) > len(
        combined
    )
    # Le texte des passages précédents au-delà du texte conservé n'est plus là : leur verdict est gardé. Le texte lu est
    # celui que la lecture sémantique peut envoyer au modèle (``_text_pages``).
    prompt_injection = (previous is not None and previous.prompt_injection) or pages_contain_prompt_injection(
        _text_pages(read_text)
    )
    if prompt_injection:
        next_page = None  # aucun fait ne sera proposé : la suite du document ne sera pas lue
    # Le corps du message n'est pas une pièce de la vente : aucun type de document tiré des mots de son texte.
    kind = None if email_body else classify_document_type(filename, combined[:4000])
    label = "Corps du message" if email_body else _document_kind_label(kind)
    examined = [
        *(previous.pages if previous else []),
        *({key: value for key, value in page.items() if key != "text"} for page in pages),
    ]
    text_chars = sum(int(page.get("chars") or 0) for page in examined)
    pages_total = len(examined) if total_pages is None else total_pages
    unread_pages = [page["page"] for page in examined if page.get("method") in UNREAD_PAGE_METHODS]
    truncated_pages = [page["page"] for page in examined if page.get("text_truncated") is True]
    pages_read = len(examined) - len(unread_pages)
    reading: dict[str, object] = {
        "pages_total": pages_total,
        "pages_read": pages_read,
        # Complète : toutes les pages lues, aucun texte coupé (lecture IA : voir ``_declare_model_reading``).
        "complete": pages_read == pages_total and not truncated_pages and not stored_text_truncated,
        "unread_pages": unread_pages,
        "truncated_pages": truncated_pages,
        "pages_beyond_limit": max(0, pages_total - MAX_PAGES),
        "stored_text_truncated": stored_text_truncated,
        "passes": passes,
        "next_page": next_page,
        "prompt_injection_seen": prompt_injection,
    }
    if next_page is not None:
        status = READING_IN_PROGRESS
        summary = (
            f"Lecture en cours : {pages_read} page(s) lue(s) sur {pages_total}, la suite au prochain passage. "
            "Les informations seront proposées à la fin de la lecture."
        )
    else:
        status = "completed"
        notes: list[str] = []
        if pages_read < pages_total:
            notes.append(
                f"Lecture partielle : {pages_read} page(s) lue(s) sur {pages_total}, "
                "les autres sont à vérifier manuellement."
            )
        if truncated_pages:
            notes.append(f"Texte trop long coupé, fin non lue : {_pages_label(truncated_pages)}.")
        if stored_text_truncated:
            notes.append(
                f"Seuls les {_number(MAX_EXTRACTED_TEXT_CHARS)} premiers caractères du texte sont conservés ; "
                "tout le texte lu a servi à l’analyse."
            )
        notes.append(
            f"{label} · {len(examined)} page(s) · "
            f"{text_chars} caractère(s) extrait(s) · {len(facts)} information(s) candidate(s)."
        )
        summary = " ".join(notes)
    return EvidenceAnalysis(
        status=status,
        detected_mime_type=detected_mime_type,
        document_kind=kind,
        page_count=len(examined),
        is_encrypted=is_encrypted,
        summary=summary,
        extracted_text=combined or None,
        pages=examined,
        facts=facts,
        read_text=read_text or None,
        reading=reading,
    )


def _number(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def _pages_label(pages: list[object]) -> str:
    """« page 3 », « pages 3, 7 » ; au-delà de dix pages, les dix premières et le nombre total."""
    shown = ", ".join(str(page) for page in pages[:10])
    more = f"… ({len(pages)} au total)" if len(pages) > 10 else ""
    return f"page {shown}" if len(pages) == 1 else f"pages {shown}{more}"


def _declare_model_reading(analysis: EvidenceAnalysis, semantic_analysis: SemanticAnalysis) -> EvidenceAnalysis:
    """Pages lues par l'IA dans ``metadata.reading`` ; une lecture IA bornée (12 pages, 12 000 caractères) qui n'a
    pas vu tout le texte lu rend la lecture non complète et le dit dans le résumé."""
    if analysis.reading is None or not semantic_analysis.input_pages:
        return analysis
    reading = {**analysis.reading, "model_pages": list(semantic_analysis.input_pages)}
    if not semantic_analysis.input_truncated:
        return replace(analysis, reading=reading)
    reading["complete"] = False
    suffix = (
        f" Lecture par l’IA limitée aux {len(semantic_analysis.input_pages)} premières pages lisibles "
        f"(jusqu’à la page {max(semantic_analysis.input_pages)}, {_number(MAX_SEMANTIC_INPUT_CHARS)} caractères au "
        "plus) : la suite n’a été lue que par les règles."
    )
    return replace(analysis, reading=reading, summary=((analysis.summary or "") + suffix)[:4_000])


def _semantic_pages_from_analysis(analysis: EvidenceAnalysis) -> list[dict[str, object]]:
    """Recover page text without persisting raw text in ``pages``.

    The extraction row stores page metadata separately from the combined text.
    Keeping this adapter local means the optional semantic pass receives the
    same text that was read and can cite the page delimiters exactly,
    while the semantic module still applies its own page and character caps
    (and its prompt-injection check, on every page read).
    """
    if analysis.status != "completed" or not analysis.read_text:
        return []
    return _text_pages(analysis.read_text)


def _text_pages(read_text: str) -> list[dict[str, object]]:
    """Pages du texte lu (``--- page N ---``), dans l'ordre ; le texte d'une page, nettoyé, n'a aucun saut de ligne."""
    pages: list[dict[str, object]] = []
    for match in _SEMANTIC_PAGE_RE.finditer(read_text):
        text = match.group("text")
        if not text:
            continue
        pages.append({"page": int(match.group("page")), "text": text})
    return pages


def _merge_semantic_facts(
    analysis: EvidenceAnalysis,
    semantic_facts: list[SemanticFact],
) -> EvidenceAnalysis:
    if not semantic_facts:
        return analysis
    facts = [
        EvidenceFact(
            fact_key=fact.fact_key,
            value=fact.value,
            display_value=fact.display_value,
            evidence_excerpt=fact.evidence_excerpt,
            confidence=fact.confidence,
            source_page=fact.source_page,
            extraction_method=fact.extraction_method,
            review_reasons=fact.review_reasons,
        )
        for fact in semantic_facts
    ]
    return replace(analysis, facts=deduplicate_facts([*analysis.facts, *facts]))


def _append_photo_summary(
    analysis: EvidenceAnalysis,
    photo_analysis: PhotoSemanticAnalysis,
) -> EvidenceAnalysis:
    """Expose a bounded visual description while keeping it review-only."""
    if photo_analysis.status in {"unavailable", "invalid_output"}:
        base = analysis.summary or "Photographie reçue."
        suffix = " Analyse visuelle indisponible : vérification manuelle nécessaire."
        return replace(analysis, summary=(base + suffix)[:4_000])
    if photo_analysis.status != "completed" or not photo_analysis.description:
        return analysis
    base = analysis.summary or "Photographie reçue."
    suffix = f" Observation visuelle à revoir : {photo_analysis.description[:800]}"
    return replace(analysis, summary=(base + suffix)[:4_000])


def _withhold_facts_for_prompt_injection(analysis: EvidenceAnalysis) -> EvidenceAnalysis:
    """Retire tous les faits d'une pièce dont le texte s'adresse à un modèle et le dit dans le résumé."""
    base = analysis.summary or "Pièce jointe reçue."
    suffix = (
        " Consignes adressées à une IA repérées dans le texte : aucune information extraite, "
        "vérification manuelle nécessaire."
    )
    return replace(analysis, facts=[], summary=(base + suffix)[:4_000])


def _append_semantic_failure_summary(
    analysis: EvidenceAnalysis,
    semantic_analysis: SemanticAnalysis,
) -> EvidenceAnalysis:
    """Make an optional provider failure visible without exposing its error."""
    if semantic_analysis.status not in {"unavailable", "invalid_output"}:
        return analysis
    base = analysis.summary or "Pièce jointe reçue."
    suffix = " Analyse sémantique indisponible : vérification manuelle nécessaire."
    return replace(analysis, summary=(base + suffix)[:4_000])


def _ocr_pdf_page(
    page: fitz.Page,
    fallback: str,
    *,
    source_path: Path | None = None,
    timeout_seconds: float = PDF_OCR_PAGE_TIMEOUT_SECONDS,
) -> tuple[str, str, float]:
    """OCR one page in a killable child process with a hard wall-clock limit."""
    temporary_source: tempfile.TemporaryDirectory[str] | None = None
    process: subprocess.Popen | None = None
    try:
        if source_path is None:
            parent = page.parent
            if parent is None:
                return _ocr_fallback(fallback, "ocr_failed")
            temporary_source = tempfile.TemporaryDirectory(prefix="immojudis-evidence-pdf-")
            source_path = Path(temporary_source.name) / "evidence.pdf"
            source_path.write_bytes(parent.tobytes())
        command = [
            sys.executable,
            "-m",
            "src.information_agent_evidence",
            "--ocr-pdf-page",
            str(source_path),
            str(page.number),
        ]
        process = subprocess.Popen(command, **child_popen_kwargs())
        try:
            stdout, _stderr = process.communicate(timeout=max(float(timeout_seconds), 0.01))
        except subprocess.TimeoutExpired:
            terminate_process_group(process)
            return _ocr_fallback(fallback, "ocr_timeout")
        if process.returncode != 0:
            return _ocr_fallback(fallback, "ocr_failed")
        payload = parse_ocr_child_output(stdout)
        text = payload.get("text")
        if isinstance(text, str) and clean_text(text):
            return text, "ocr_pymupdf", 0.74
        if not isinstance(text, str):  # the child reported an error (no OCR engine, unreadable page)
            return _ocr_fallback(fallback, "ocr_failed")
        # OCR ran and found no text: the page is read (« fallback_text » keeps its native text).
        return _ocr_fallback(fallback, "fallback_text")
    except Exception:
        # The page keeps its native text, unread by OCR; no OCR child is left running.
        if process is not None:
            terminate_process_group(process)
    finally:
        if temporary_source is not None:
            temporary_source.cleanup()
    return _ocr_fallback(fallback, "ocr_failed")


def _ocr_pdf_page_in_process(source_path: str, page_number: int) -> dict[str, str]:
    with fitz.open(source_path) as document:
        page = document.load_page(page_number)
        text_page = page.get_textpage_ocr(language=PDF_OCR_LANGUAGE, full=True)
        return {"text": page.get_text("text", textpage=text_page) or ""}


def _ocr_fallback(fallback: str, method: str) -> tuple[str, str, float]:
    return fallback, method, 0.45 if clean_text(fallback) else 0.0


def _monotonic() -> float:
    # Kept behind a helper so timeout behavior can be deterministic in tests.
    import time

    return time.monotonic()


def _ocr_image_bytes(content: bytes, mime_type: str) -> str:
    executable = shutil.which("tesseract")
    if not executable:
        return ""
    suffix = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/heic": ".heic",
        "image/heif": ".heif",
    }.get(mime_type, ".img")
    process: subprocess.Popen | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="immojudis-evidence-") as temp_dir:
            path = Path(temp_dir) / f"evidence{suffix}"
            path.write_bytes(content)
            # Environnement réduit, sans aucune clé (``child_popen_kwargs``) : Tesseract ouvre un fichier reçu d'un tiers.
            process = subprocess.Popen(
                [executable, str(path), "stdout", "-l", "fra+eng"],
                **child_popen_kwargs(),
            )
            try:
                stdout, _stderr = process.communicate(timeout=IMAGE_OCR_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                terminate_process_group(process)
                return ""
            return stdout if process.returncode == 0 else ""
    except Exception:
        # No OCR text for this image: the analysis goes on without it; no child is left running.
        if process is not None:
            terminate_process_group(process)
        return ""


def _document_kind_label(kind: str | None) -> str:
    labels = {
        "diagnostics_techniques": "Diagnostics techniques",
        "cahier_conditions_vente": "Cahier des conditions de vente",
        "conditions_vente": "Conditions de vente",
        "pv_huissier": "Procès-verbal descriptif",
        "pv_notaire": "Procès-verbal notarié",
        "annonce_vente": "Annonce de vente",
        "bail": "Bail / document locatif",
        "cadastre": "Document cadastral",
    }
    return labels.get(kind or "", "Pièce jointe")


def _mime_types_compatible(declared: str, detected: str) -> bool:
    if declared == detected:
        return True
    return {declared, detected} <= {"image/heic", "image/heif"}


def _unsupported(code: str, message: str, detected: str | None = None) -> EvidenceAnalysis:
    return EvidenceAnalysis(
        status="unsupported",
        detected_mime_type=detected,
        document_kind=None,
        page_count=None,
        is_encrypted=False,
        summary=None,
        extracted_text=None,
        pages=[],
        facts=[],
        error_code=code,
        error_message=message,
    )


def _process_job(
    client: httpx.Client,
    base_url: str,
    key: str,
    job: dict[str, Any],
    *,
    read_deadline: float | None = None,
    requeue_not_before: datetime | None = None,
) -> None:
    """Un passage de la pièce prise par la RPC (``job`` : la ligne d'extraction entière).

    ``read_deadline`` borne la lecture de ce passage (``analyze_evidence_bytes``). Une lecture à poursuivre est rangée
    dans la ligne, qui revient en file (``_continue_reading_later``) : ni fait proposé, ni dossier remis en relecture,
    tant que la lecture n'est pas terminée. ``requeue_not_before`` : fin du lot, avant laquelle une pièce remise en
    file (lecture à poursuivre ou échec) n'est pas reprise ; nul hors d'un lot.
    """
    extraction_id = str(job.get("id") or "")
    asset_id = str(job.get("asset_id") or "")
    attempts = int(job.get("attempts") or 1)
    locked_at = str(job.get("locked_at") or "") or None
    if not extraction_id or not asset_id:
        return
    try:
        asset = fetch_asset(client, base_url, key, asset_id)
        if any(
            not job.get(field)
            or not asset.get(field)
            or str(asset[field]) != str(job[field])
            for field in ("case_id", "message_id", "sale_id")
        ):
            raise RuntimeError("Evidence asset association mismatch")
        content = download_asset(client, base_url, key, asset)
        settings = load_settings()
        asset_metadata = asset.get("metadata")
        email_body = isinstance(asset_metadata, dict) and asset_metadata.get("evidence_kind") == "email_body"
        resume = _reading_progress(job)
        analysis = analyze_evidence_bytes(
            content,
            filename=str(asset.get("original_filename") or "piece-jointe"),
            declared_mime_type=str(asset.get("mime_type") or ""),
            ocr_enabled=bool(settings.get("information_agent_evidence_ocr_enabled", True)),
            email_body=email_body,
            resume=resume,
            read_deadline=read_deadline,
            final_attempt=attempts >= MAX_ATTEMPTS,
        )
        if analysis.status == READING_IN_PROGRESS:
            _continue_reading_later(
                client,
                base_url,
                key,
                extraction_id,
                analysis,
                attempts=attempts,
                locked_at=locked_at,
                pages_examined_before=len(resume.pages) if resume is not None else 0,
                not_before=requeue_not_before,
            )
            return
        # Consigne adressée à un modèle dans le texte lu, tous passages confondus : aucun fait (ni règle ni IA),
        # aucun texte de la pièce envoyé au modèle, relecture.
        prompt_injection = analysis.reading is not None and analysis.reading["prompt_injection_seen"] is True
        is_photo = analysis.status == "completed" and analysis.detected_mime_type in VISION_MIME_TYPES
        # La réponse n'est lue par l'IA que par le prestataire nommé dans le pied du message envoyé (lu seulement
        # quand un appel est possible). Un dossier sans prestataire enregistré compte comme Replicate.
        ai_call_possible = not prompt_injection and (
            bool(settings.get("information_agent_evidence_semantic_enabled"))
            or (is_photo and bool(settings.get("information_agent_evidence_vision_enabled")))
        )
        provider_mismatch = ai_call_possible and fetch_footer_ai_provider(
            client, base_url, key, str(job.get("case_id") or "")
        ) != llm_provider()
        if prompt_injection:
            analysis = _withhold_facts_for_prompt_injection(analysis)
            semantic_analysis = prompt_injection_skip()
        elif provider_mismatch:
            semantic_analysis = SemanticAnalysis("unavailable", [], error_code=AI_PROVIDER_MISMATCH)
        else:
            sale_id = str(job.get("sale_id") or "")
            semantic_analysis = run_configured_semantic_analysis(
                _semantic_pages_from_analysis(analysis),
                settings,
                lot_context_loader=lambda: fetch_sale_lot_context(client, base_url, key, sale_id),
            )
        analysis = _merge_semantic_facts(analysis, semantic_analysis.facts)
        analysis = _append_semantic_failure_summary(analysis, semantic_analysis)
        analysis = _declare_model_reading(analysis, semantic_analysis)
        photo_analysis = PhotoSemanticAnalysis("not_run", error_code="EVIDENCE_NOT_IMAGE")
        if is_photo:
            if prompt_injection:
                # Le texte lu sur la photo s'adresse à un modèle : il n'est pas envoyé au modèle de vision.
                photo_analysis = PhotoSemanticAnalysis("skipped", error_code="PROMPT_INJECTION_SUSPECTED")
            elif provider_mismatch and settings.get("information_agent_evidence_vision_enabled"):
                photo_analysis = PhotoSemanticAnalysis("unavailable", error_code=AI_PROVIDER_MISMATCH)
            elif settings.get("information_agent_evidence_vision_enabled"):
                prepared = _prepare_image_for_vision(content, analysis.detected_mime_type)
                if prepared is None:
                    photo_analysis = PhotoSemanticAnalysis(
                        "unavailable",
                        error_code="VISION_IMAGE_NORMALIZATION_FAILED",
                    )
                else:
                    vision_content, vision_mime_type = prepared
                    photo_analysis = run_configured_photo_analysis(
                        vision_content,
                        vision_mime_type,
                        settings,
                        ocr_text=analysis.extracted_text,
                    )
            else:
                photo_analysis = PhotoSemanticAnalysis("disabled")
            analysis = _append_photo_summary(analysis, photo_analysis)
        if analysis.status == "completed" and analysis.facts:
            case_status = fetch_case_status(client, base_url, key, str(job.get("case_id") or ""))
            if case_status in FACT_CANDIDATE_CASE_STATUSES:
                sale = fetch_sale(client, base_url, key, str(job.get("sale_id") or ""))
                existing_body_values: dict[tuple[str, str], dict[str, Any]] = {}
                if email_body:
                    existing_body_values = fetch_existing_message_fact_values(
                        client,
                        base_url,
                        key,
                        str(job.get("message_id") or ""),
                    )
                insert_fact_candidates(
                    client,
                    base_url,
                    key,
                    job,
                    analysis.facts,
                    sale,
                    skip_values=existing_body_values,
                )
        _finish_job(
            client,
            base_url,
            key,
            extraction_id,
            analysis,
            attempts=attempts,
            locked_at=locked_at,
            semantic_metadata=semantic_analysis.metadata(),
            photo_metadata=photo_analysis.metadata(),
        )
        mark_case_for_review(client, base_url, key, str(job.get("case_id") or ""))
    except Exception as exc:
        fail_job(
            client,
            base_url,
            key,
            extraction_id,
            attempts,
            str(exc),
            locked_at=locked_at,
            not_before=requeue_not_before,
        )


def _analysis_columns(analysis: EvidenceAnalysis, **metadata: object) -> dict[str, object]:
    """Colonnes de la ligne d'extraction tirées de l'analyse, à la fin de la lecture comme entre deux passages."""
    return {
        "processor_version": PROCESSOR_VERSION,
        "detected_mime_type": analysis.detected_mime_type,
        "document_kind": analysis.document_kind,
        "page_count": analysis.page_count,
        "is_encrypted": analysis.is_encrypted,
        "summary": analysis.summary,
        "extracted_text": analysis.extracted_text,
        "pages": analysis.pages,
        "extracted_facts": [fact.as_json() for fact in analysis.facts],
        "error_code": analysis.error_code,
        "error_message": analysis.error_message,
        # Attachment text is evidence supplied by an external sender. Keep a
        # durable trust marker next to the extraction so a future AI consumer
        # cannot mistake instructions embedded in a PDF, image or text file
        # for application instructions.
        "metadata": {
            "processor_version": PROCESSOR_VERSION,
            "content_trust": "untrusted_external_evidence",
            "prompt_instructions_ignored": True,
            **metadata,
            **({"reading": analysis.reading} if analysis.reading is not None else {}),
        },
    }


def _finish_job(
    client: httpx.Client,
    base_url: str,
    key: str,
    extraction_id: str,
    analysis: EvidenceAnalysis,
    *,
    attempts: int | None = None,
    locked_at: str | None = None,
    semantic_metadata: dict[str, object] | None = None,
    photo_metadata: dict[str, object] | None = None,
) -> None:
    now = datetime.now(UTC).isoformat()
    payload = {
        **_analysis_columns(
            analysis,
            semantic=semantic_metadata or {"status": "not_run", "review_required": True},
            photo_semantic=photo_metadata or {"status": "not_run", "review_required": True},
        ),
        "status": analysis.status,
        "locked_at": None,
        "completed_at": now,
    }
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_evidence_extractions",
        headers=rest_headers(key, prefer="return=minimal"),
        params=processing_lease_params(extraction_id, attempts=attempts, locked_at=locked_at),
        json=payload,
    )
    response.raise_for_status()


def _reading_progress(job: dict[str, Any]) -> ReadingProgress | None:
    """Lecture d'un PDF commencée à un passage précédent (``metadata.reading.next_page``), relue de la ligne prise.

    Une progression mal formée lève : la pièce passe en échec visible au lieu d'être relue de zéro en silence.
    """
    metadata = job.get("metadata")
    reading = metadata.get("reading") if isinstance(metadata, dict) else None
    if not isinstance(reading, dict) or reading.get("next_page") is None:
        return None
    next_page = reading.get("next_page")
    passes = reading.get("passes")
    pages_total = reading.get("pages_total")
    pages = job.get("pages")
    facts = job.get("extracted_facts")
    stored_text = job.get("extracted_text")
    if (
        not all(isinstance(value, int) and not isinstance(value, bool) for value in (next_page, passes, pages_total))
        or not isinstance(pages, list)
        or not all(isinstance(page, dict) for page in pages)
        or [page.get("page") for page in pages] != list(range(1, int(next_page)))
        or not isinstance(facts, list)
        or not (stored_text is None or isinstance(stored_text, str))
        or not isinstance(reading.get("stored_text_truncated"), bool)
        or not isinstance(reading.get("prompt_injection_seen"), bool)
    ):
        raise RuntimeError("Invalid evidence reading progress")
    return ReadingProgress(
        next_page=int(next_page),
        passes=int(passes),
        pages_total=int(pages_total),
        pages=pages,
        stored_text=stored_text or "",
        stored_text_truncated=reading["stored_text_truncated"],
        facts=[EvidenceFact.from_json(fact) for fact in facts],
        prompt_injection=reading["prompt_injection_seen"],
    )


def _pages_read(pages: list[dict[str, object]]) -> int:
    return sum(1 for page in pages if page.get("method") not in UNREAD_PAGE_METHODS)


def _continue_reading_later(
    client: httpx.Client,
    base_url: str,
    key: str,
    extraction_id: str,
    analysis: EvidenceAnalysis,
    *,
    attempts: int,
    locked_at: str | None,
    pages_examined_before: int,
    not_before: datetime | None,
) -> None:
    """Range la progression d'une lecture à poursuivre dans la ligne, qui revient en file pour le passage suivant.

    Écrit sous le bail du passage (``_processing_lease_params``), comme la fin d'une analyse. Le progrès se compte en
    pages examinées, lues ou déclarées non lues : un passage qui en a examiné au moins une rend l'essai compté par la
    RPC à la prise (``attempts`` redescend de un) et revient en file ; ``MAX_READING_PASSES`` borne les passages. Un
    passage sans page examinée (vrai blocage) garde son essai et passe en échec avec le délai d'une erreur du worker.
    Au dernier passage (``_is_last_pass``), une lecture n'est encore à poursuivre que si aucune page n'a jamais été lue
    (``_analyze_pdf``) : c'est aussi un échec, définitif au dernier essai.
    """
    if analysis.reading is None:
        raise RuntimeError("Evidence reading progress is missing")
    pages_read = int(analysis.reading["pages_read"])
    pages_total = int(analysis.reading["pages_total"])
    last_pass = _is_last_pass(int(analysis.reading["passes"]), final_attempt=attempts >= MAX_ATTEMPTS)
    now = datetime.now(UTC)
    payload: dict[str, object] = {**_analysis_columns(analysis), "locked_at": None}
    if len(analysis.pages) > pages_examined_before and not last_pass:
        payload.update(
            {
                "status": "queued",
                "attempts": attempts - 1,
                "available_at": max(now, not_before or now).isoformat(),
                "completed_at": None,
            }
        )
    else:
        payload.update(
            {
                "status": "failed",
                "error_code": "OCR_NO_PROGRESS",
                "error_message": (
                    f"Aucune page lue au dernier passage permis : {pages_read} page(s) lue(s) sur {pages_total}."
                    if last_pass
                    else f"Aucune page examinée à ce passage : {pages_read} page(s) lue(s) sur {pages_total}."
                ),
                **retry_schedule(attempts, now, not_before),
            }
        )
        if attempts >= MAX_ATTEMPTS:
            payload["summary"] = (
                f"Lecture interrompue : {pages_read} page(s) lue(s) sur {pages_total} en {MAX_ATTEMPTS} essais. "
                "Aucune information proposée : vérification manuelle nécessaire."
            )
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_evidence_extractions",
        headers=rest_headers(key, prefer="return=minimal"),
        params=processing_lease_params(extraction_id, attempts=attempts, locked_at=locked_at),
        json=payload,
    )
    response.raise_for_status()


def _run_pdf_ocr_child(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] != "--ocr-pdf-page":
        return 2
    limit_child_memory()
    try:
        payload = _ocr_pdf_page_in_process(argv[1], int(argv[2]))
    except Exception as exc:
        payload = {"error": str(exc)[:300]}
    print(json.dumps(payload, ensure_ascii=True), flush=True)
    return 0


def _run_pdf_text_child(argv: list[str]) -> int:
    if len(argv) != 4 or argv[0] != "--read-pdf-text":
        return 2
    limit_child_memory()
    _read_pdf_native_text_in_process(argv[1], int(argv[2]), int(argv[3]))
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--ocr-pdf-page":
        raise SystemExit(_run_pdf_ocr_child(sys.argv[1:]))
    if len(sys.argv) > 1 and sys.argv[1] == "--read-pdf-text":
        raise SystemExit(_run_pdf_text_child(sys.argv[1:]))
    batch_limit = int(load_settings()["information_agent_evidence_batch_size"])
    print(json.dumps({"processed": run_information_agent_evidence_batch(limit=batch_limit)}))
