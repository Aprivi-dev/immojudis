from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

import fitz
import httpx

from src.config import load_settings
from src.normalize import clean_text
from src.pdf_enrichment import classify_document_type

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_PAGES = 100
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
PDF_OCR_TOTAL_TIMEOUT_SECONDS = 30
PDF_OCR_LANGUAGE = "fra+eng"
PROCESSOR_VERSION = "evidence_v1"
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
class EvidenceFact:
    fact_key: str
    value: str | int | float
    display_value: str
    evidence_excerpt: str
    confidence: float
    source_page: int
    unit: str | None = None

    def as_json(self) -> dict[str, object]:
        proposed_value: dict[str, object] = {"value": self.value}
        if self.unit:
            proposed_value["unit"] = self.unit
        return {
            "fact_key": self.fact_key,
            "proposed_value": proposed_value,
            "display_value": self.display_value,
            "evidence_excerpt": self.evidence_excerpt,
            "confidence": self.confidence,
            "source_page": self.source_page,
        }


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


def run_information_agent_evidence_batch(*, limit: int = 5) -> int:
    settings = load_settings()
    supabase_url = str(settings.get("supabase_url") or "").rstrip("/")
    service_key = str(settings.get("supabase_service_role_key") or "")
    if not supabase_url or not service_key:
        return 0

    bounded_limit = max(1, min(10, int(limit)))
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=30.0), trust_env=False) as client:
        jobs = _claim_jobs(client, supabase_url, service_key, bounded_limit)
        for job in jobs:
            _process_job(client, supabase_url, service_key, job)
    return len(jobs)


def analyze_evidence_bytes(
    content: bytes,
    *,
    filename: str,
    declared_mime_type: str,
    ocr_enabled: bool = True,
) -> EvidenceAnalysis:
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

    if detected == "application/pdf":
        return _analyze_pdf(content, filename=filename, detected_mime_type=detected, ocr_enabled=ocr_enabled)
    if detected == "text/plain":
        return _analyze_text(content, filename=filename, detected_mime_type=detected)
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
    if b"\x00" not in content[:4096]:
        try:
            content[:8192].decode("utf-8")
            return "text/plain"
        except UnicodeDecodeError:
            try:
                content[:8192].decode("latin-1")
                return "text/plain"
            except UnicodeDecodeError:
                return None
    return None


def extract_evidence_facts(pages: list[dict[str, object]]) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    for page in pages:
        page_number = int(page.get("page") or 1)
        text = clean_text(page.get("text")) or ""
        if not text:
            continue
        facts.extend(_surface_facts(text, page_number))
        facts.extend(_rooms_facts(text, page_number))
        facts.extend(_occupancy_facts(text, page_number))
        facts.extend(_starting_price_facts(text, page_number))
        facts.extend(_diagnostic_facts(text, page_number))
        facts.extend(_visit_facts(text, page_number))
    return _deduplicate_facts(facts)


def _analyze_pdf(
    content: bytes,
    *,
    filename: str,
    detected_mime_type: str,
    ocr_enabled: bool,
) -> EvidenceAnalysis:
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
        if document.page_count > MAX_PAGES:
            return _unsupported(
                "PAGE_LIMIT_EXCEEDED",
                f"Le PDF dépasse la limite de {MAX_PAGES} pages.",
                detected_mime_type,
            )
        pages: list[dict[str, object]] = []
        ocr_candidates: list[tuple[int, fitz.Page, str]] = []
        for index, page in enumerate(document, start=1):
            raw_text = page.get_text("text") or ""
            page_data: dict[str, object] = {
                "page": index,
                "text": raw_text,
                "chars": 0,
                "method": "pymupdf_text",
                "confidence": 0.92 if raw_text else 0.0,
            }
            if ocr_enabled and len(clean_text(raw_text) or "") < 80:
                if _pdf_page_ocr_allowed(page):
                    ocr_candidates.append((index - 1, page, raw_text))
                else:
                    page_data["method"] = "ocr_skipped_dimensions"
                    page_data["confidence"] = 0.2 if raw_text else 0.0
            cleaned = (clean_text(str(page_data["text"]) or "") or "")[:MAX_PAGE_TEXT_CHARS]
            page_data["text"] = cleaned
            page_data["chars"] = len(cleaned)
            if not cleaned:
                page_data["confidence"] = 0.0
            pages.append(page_data)

        if ocr_candidates:
            _apply_pdf_ocr_candidates(content, pages, ocr_candidates)

    return _completed_analysis(
        filename=filename,
        detected_mime_type=detected_mime_type,
        pages=pages,
        is_encrypted=False,
    )


def _analyze_text(content: bytes, *, filename: str, detected_mime_type: str) -> EvidenceAnalysis:
    text = content.decode("utf-8", errors="replace")[:MAX_EXTRACTED_TEXT_CHARS]
    cleaned = clean_text(text) or ""
    pages = [{"page": 1, "text": cleaned, "chars": len(cleaned), "method": "plain_text", "confidence": 0.98}]
    return _completed_analysis(
        filename=filename,
        detected_mime_type=detected_mime_type,
        pages=pages,
        is_encrypted=False,
    )


def _analyze_image(
    content: bytes,
    *,
    filename: str,
    detected_mime_type: str,
    ocr_enabled: bool,
) -> EvidenceAnalysis:
    text = ""
    method = "image_metadata"
    confidence = 0.0
    metadata: dict[str, object] = {}
    try:
        with fitz.open(stream=content, filetype=detected_mime_type.split("/")[-1]) as image_document:
            if image_document.page_count:
                rectangle = image_document[0].rect
                metadata = {"width": round(rectangle.width), "height": round(rectangle.height)}
    except Exception:
        metadata = {}
    if ocr_enabled:
        text = _ocr_image_bytes(content, detected_mime_type)
        if text:
            method = "ocr_tesseract"
            confidence = 0.7
    cleaned = (clean_text(text) or "")[:MAX_PAGE_TEXT_CHARS]
    pages = [
        {
            "page": 1,
            "text": cleaned,
            "chars": len(cleaned),
            "method": method,
            "confidence": confidence,
            **metadata,
        }
    ]
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


def _jpeg_dimensions(content: bytes) -> tuple[int, int] | None:
    if len(content) < 4 or content[:2] != b"\xff\xd8":
        return None
    offset = 2
    while offset + 4 <= len(content):
        if content[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(content) and content[offset] == 0xFF:
            offset += 1
        if offset >= len(content):
            return None
        marker = content[offset]
        offset += 1
        if marker in {0xD8, 0xD9}:
            continue
        if marker == 0xDA:
            return None
        if marker in range(0xD0, 0xD8):
            continue
        segment_length = int.from_bytes(content[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(content):
            return None
        # SOF markers carry precision, height and width after the length.
        if marker in {
            *range(0xC0, 0xC4),
            *range(0xC5, 0xC8),
            *range(0xC9, 0xCC),
            *range(0xCD, 0xD0),
        }:
            if segment_length < 7:
                return None
            height = int.from_bytes(content[offset + 3 : offset + 5], "big")
            width = int.from_bytes(content[offset + 5 : offset + 7], "big")
            return width, height
        offset += segment_length
    return None


def _webp_dimensions(content: bytes) -> tuple[int, int] | None:
    if len(content) < 16 or content[:4] != b"RIFF" or content[8:12] != b"WEBP":
        return None
    offset = 12
    while offset + 8 <= len(content):
        chunk_type = content[offset : offset + 4]
        chunk_size = int.from_bytes(content[offset + 4 : offset + 8], "little")
        payload_start = offset + 8
        payload_end = payload_start + chunk_size
        if payload_end > len(content):
            return None
        payload = content[payload_start:payload_end]
        if chunk_type == b"VP8X" and len(payload) >= 10:
            width = 1 + int.from_bytes(payload[4:7], "little")
            height = 1 + int.from_bytes(payload[7:10], "little")
            return width, height
        if chunk_type == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
            width = int.from_bytes(payload[6:8], "little") & 0x3FFF
            height = int.from_bytes(payload[8:10], "little") & 0x3FFF
            return width, height
        if chunk_type == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
            width = 1 + (payload[1] | ((payload[2] & 0x3F) << 8))
            height = 1 + ((payload[2] >> 6) | (payload[3] << 2) | ((payload[4] & 0x0F) << 10))
            return width, height
        offset = payload_end + (chunk_size & 1)
    return None


def _isobmff_dimensions(content: bytes) -> tuple[int, int] | None:
    # HEIC/HEIF stores the decoded dimensions in an ``ispe`` box. Parsing the
    # small header avoids opening the image before the allocation guard runs.
    marker = b"ispe"
    dimensions: tuple[int, int] | None = None
    search_from = 0
    while True:
        offset = content.find(marker, search_from)
        if offset < 0:
            return dimensions
        if offset + 16 > len(content):
            return None
        width = int.from_bytes(content[offset + 8 : offset + 12], "big")
        height = int.from_bytes(content[offset + 12 : offset + 16], "big")
        if width <= 0 or height <= 0:
            return None
        if dimensions is None:
            dimensions = (width, height)
        else:
            # A container may expose thumbnails and primary images. Guard the
            # largest declared dimensions before any decoder is opened.
            dimensions = (max(dimensions[0], width), max(dimensions[1], height))
        search_from = offset + len(marker)


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
) -> EvidenceAnalysis:
    facts = extract_evidence_facts(pages)
    combined_parts = [
        f"--- page {page['page']} ---\n{page.get('text') or ''}"
        for page in pages
        if page.get("text")
    ]
    combined = "\n\n".join(combined_parts)[:MAX_EXTRACTED_TEXT_CHARS]
    kind = classify_document_type(filename, combined[:4000])
    text_chars = sum(int(page.get("chars") or 0) for page in pages)
    summary = (
        f"{_document_kind_label(kind)} · {len(pages)} page(s) · "
        f"{text_chars} caractère(s) extrait(s) · {len(facts)} information(s) candidate(s)."
    )
    safe_pages = [{key: value for key, value in page.items() if key != "text"} for page in pages]
    return EvidenceAnalysis(
        status="completed",
        detected_mime_type=detected_mime_type,
        document_kind=kind,
        page_count=len(pages),
        is_encrypted=is_encrypted,
        summary=summary,
        extracted_text=combined or None,
        pages=safe_pages,
        facts=facts,
    )


def _apply_pdf_ocr_candidates(
    content: bytes,
    pages: list[dict[str, object]],
    candidates: list[tuple[int, fitz.Page, str]],
) -> None:
    """Run OCR in bounded subprocesses while keeping ordinary text extraction."""
    try:
        with tempfile.TemporaryDirectory(prefix="immojudis-evidence-pdf-") as temp_dir:
            source_path = Path(temp_dir) / "evidence.pdf"
            source_path.write_bytes(content)
            deadline = _monotonic() + PDF_OCR_TOTAL_TIMEOUT_SECONDS
            for page_index, page, fallback in candidates:
                remaining = deadline - _monotonic()
                if remaining <= 0:
                    text, method, confidence = _ocr_fallback(fallback, "ocr_total_timeout")
                else:
                    text, method, confidence = _ocr_pdf_page(
                        page,
                        fallback,
                        source_path=source_path,
                        timeout_seconds=min(PDF_OCR_PAGE_TIMEOUT_SECONDS, remaining),
                    )
                cleaned = (clean_text(text) or "")[:MAX_PAGE_TEXT_CHARS]
                pages[page_index].update(
                    {
                        "text": cleaned,
                        "chars": len(cleaned),
                        "method": method,
                        "confidence": confidence if cleaned else 0.0,
                    }
                )
    except Exception:
        # Text extraction has already succeeded. If staging or the isolated OCR
        # worker fails, retain that text and make the skipped OCR visible.
        for page_index, _page, fallback in candidates:
            if pages[page_index].get("method") == "pymupdf_text":
                pages[page_index]["method"] = "ocr_unavailable"
                pages[page_index]["confidence"] = 0.45 if fallback else 0.0


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
                return _ocr_fallback(fallback, "fallback_text")
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
        popen_kwargs: dict[str, object] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.DEVNULL,
            "text": True,
            "cwd": str(Path(__file__).resolve().parents[1]),
        }
        if os.name == "posix":
            popen_kwargs["start_new_session"] = True
        process = subprocess.Popen(command, **popen_kwargs)
        try:
            stdout, _stderr = process.communicate(timeout=max(float(timeout_seconds), 0.01))
        except subprocess.TimeoutExpired:
            _terminate_process_group(process)
            return _ocr_fallback(fallback, "ocr_timeout")
        if process.returncode != 0:
            return _ocr_fallback(fallback, "fallback_text")
        payload = json.loads(stdout or "{}")
        text = payload.get("text") if isinstance(payload, dict) else None
        if isinstance(text, str) and clean_text(text):
            return text, "ocr_pymupdf", 0.74
    except Exception:
        if process is not None:
            _terminate_process_group(process)
        pass
    finally:
        if temporary_source is not None:
            temporary_source.cleanup()
    return _ocr_fallback(fallback, "fallback_text")


def _ocr_pdf_page_in_process(source_path: str, page_number: int) -> dict[str, str]:
    with fitz.open(source_path) as document:
        page = document.load_page(page_number)
        text_page = page.get_textpage_ocr(language=PDF_OCR_LANGUAGE, full=True)
        return {"text": page.get_text("text", textpage=text_page) or ""}


def _terminate_process_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        process.kill()
    try:
        process.communicate(timeout=1)
    except Exception:
        process.kill()


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
    try:
        with tempfile.TemporaryDirectory(prefix="immojudis-evidence-") as temp_dir:
            path = Path(temp_dir) / f"evidence{suffix}"
            path.write_bytes(content)
            result = subprocess.run(
                [executable, str(path), "stdout", "-l", "fra+eng"],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            return result.stdout if result.returncode == 0 else ""
    except Exception:
        return ""


def _surface_facts(text: str, page: int) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    patterns = (
        ("land_surface_m2", r"(?:terrain|parcelle|contenance)[^\d]{0,45}(\d{1,8}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", 0.88),
        ("surface_m2", r"(?:surface(?:\s+(?:habitable|carrez|privative|utile))?)[^\d]{0,45}(\d{1,6}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", 0.9),
    )
    for fact_key, pattern, confidence in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if not match:
            continue
        value = float(match.group(1).replace(",", "."))
        if value <= 0:
            continue
        facts.append(
            EvidenceFact(
                fact_key=fact_key,
                value=value,
                display_value=f"{value:g} m²",
                evidence_excerpt=_excerpt(text, match.start()),
                confidence=confidence,
                source_page=page,
                unit="m2",
            )
        )
    return facts


def _rooms_facts(text: str, page: int) -> list[EvidenceFact]:
    match = re.search(r"(?<!\d)(\d{1,2})(?!\d)\s+pi[eè]ces?\b", text, re.IGNORECASE)
    if not match:
        return []
    value = int(match.group(1))
    if value < 1 or value > 100:
        return []
    return [EvidenceFact("rooms_count", value, f"{value} pièce(s)", _excerpt(text, match.start()), 0.86, page)]


def _occupancy_facts(text: str, page: int) -> list[EvidenceFact]:
    patterns = (
        ("vacant", r"\b(?:libre de toute occupation|libre|vacant|inoccup[eé])\b"),
        ("rented", r"\b(?:lou[eé]|location|bail en cours|locataire)\b"),
        ("owner_occupied", r"\boccup[eé]\s+par\s+(?:le|la|les)\s+propri[eé]taire"),
        ("squatted", r"\b(?:squat|occupant sans droit ni titre)\b"),
        ("occupied", r"\boccup[eé]\b"),
    )
    for value, pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            labels = {
                "vacant": "Libre / vacant",
                "rented": "Loué",
                "owner_occupied": "Occupé par le propriétaire",
                "squatted": "Occupé sans droit ni titre",
                "occupied": "Occupé",
            }
            return [EvidenceFact("occupancy_status", value, labels[value], _excerpt(text, match.start()), 0.82, page)]
    return []


def _starting_price_facts(text: str, page: int) -> list[EvidenceFact]:
    match = re.search(
        r"mise\s+[àa]\s+prix[^\d]{0,30}(\d{1,3}(?:[ .\u202f]\d{3})*(?:[.,]\d{1,2})?)\s*(?:€|euros?)",
        text,
        re.IGNORECASE,
    )
    if not match:
        return []
    raw = re.sub(r"[ .\u202f]", "", match.group(1)).replace(",", ".")
    value = float(raw)
    if value <= 0 or value > 1_000_000_000:
        return []
    return [
        EvidenceFact(
            "starting_price_eur",
            value,
            f"{value:,.0f} €".replace(",", " "),
            _excerpt(text, match.start()),
            0.94,
            page,
            "EUR",
        )
    ]


def _diagnostic_facts(text: str, page: int) -> list[EvidenceFact]:
    match = re.search(r"(?:DPE|diagnostic de performance [ée]nerg[ée]tique)[^A-G]{0,30}([A-G])\b", text, re.IGNORECASE)
    if not match:
        return []
    value = match.group(1).upper()
    return [EvidenceFact("energy_diagnostics", value, f"DPE {value}", _excerpt(text, match.start()), 0.88, page)]


def _visit_facts(text: str, page: int) -> list[EvidenceFact]:
    match = re.search(r"\bvisite(?:s)?\b.{0,180}", text, re.IGNORECASE)
    if not match:
        return []
    excerpt = _excerpt(text, match.start(), radius=220)
    return [EvidenceFact("visit_information", excerpt, excerpt[:500], excerpt, 0.72, page)]


def _deduplicate_facts(facts: list[EvidenceFact]) -> list[EvidenceFact]:
    unique: dict[tuple[str, str], EvidenceFact] = {}
    for fact in facts:
        key = (fact.fact_key, str(fact.value).strip().lower())
        current = unique.get(key)
        if current is None or fact.confidence > current.confidence:
            unique[key] = fact
    return list(unique.values())[:30]


def _excerpt(text: str, position: int, *, radius: int = 160) -> str:
    start = max(0, position - radius)
    end = min(len(text), position + radius)
    return (clean_text(text[start:end]) or "")[:1000]


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


def _claim_jobs(client: httpx.Client, base_url: str, key: str, limit: int) -> list[dict[str, Any]]:
    response = client.post(
        f"{base_url}/rest/v1/rpc/claim_information_agent_evidence_extractions",
        headers=_headers(key),
        json={"p_limit": limit},
    )
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, list) else []


def _process_job(
    client: httpx.Client,
    base_url: str,
    key: str,
    job: dict[str, Any],
) -> None:
    extraction_id = str(job.get("id") or "")
    asset_id = str(job.get("asset_id") or "")
    attempts = int(job.get("attempts") or 1)
    locked_at = str(job.get("locked_at") or "") or None
    if not extraction_id or not asset_id:
        return
    try:
        asset = _fetch_asset(client, base_url, key, asset_id)
        if any(
            not job.get(field)
            or not asset.get(field)
            or str(asset[field]) != str(job[field])
            for field in ("case_id", "message_id", "sale_id")
        ):
            raise RuntimeError("Evidence asset association mismatch")
        content = _download_asset(client, base_url, key, asset)
        analysis = analyze_evidence_bytes(
            content,
            filename=str(asset.get("original_filename") or "piece-jointe"),
            declared_mime_type=str(asset.get("mime_type") or ""),
            ocr_enabled=bool(load_settings().get("pdf_ocr_enabled")),
        )
        if analysis.status == "completed" and analysis.facts:
            case_status = _fetch_case_status(client, base_url, key, str(job.get("case_id") or ""))
            if case_status in FACT_CANDIDATE_CASE_STATUSES:
                sale = _fetch_sale(client, base_url, key, str(job.get("sale_id") or ""))
                _insert_fact_candidates(client, base_url, key, job, analysis.facts, sale)
        _finish_job(
            client,
            base_url,
            key,
            extraction_id,
            analysis,
            attempts=attempts,
            locked_at=locked_at,
        )
        _mark_case_for_review(client, base_url, key, str(job.get("case_id") or ""))
    except Exception as exc:
        _fail_job(
            client,
            base_url,
            key,
            extraction_id,
            attempts,
            str(exc),
            locked_at=locked_at,
        )


def _fetch_asset(client: httpx.Client, base_url: str, key: str, asset_id: str) -> dict[str, Any]:
    response = client.get(
        f"{base_url}/rest/v1/information_agent_evidence_assets",
        headers=_headers(key),
        params={
            "select": "id,case_id,message_id,sale_id,storage_bucket,storage_path,original_filename,mime_type,size_bytes,sha256",
            "id": f"eq.{asset_id}",
            "limit": "1",
        },
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Evidence asset not found")
    return rows[0]


def _download_asset(client: httpx.Client, base_url: str, key: str, asset: dict[str, Any]) -> bytes:
    bucket = quote(str(asset.get("storage_bucket") or ""), safe="")
    path = quote(str(asset.get("storage_path") or ""), safe="/")
    response = client.get(f"{base_url}/storage/v1/object/{bucket}/{path}", headers=_headers(key))
    response.raise_for_status()
    content = response.content
    if len(content) != int(asset.get("size_bytes") or 0):
        raise RuntimeError("Evidence download size mismatch")
    expected_sha256 = str(asset.get("sha256") or "")
    if not expected_sha256 or hashlib.sha256(content).hexdigest() != expected_sha256:
        raise RuntimeError("Evidence download checksum mismatch")
    return content


def _fetch_sale(client: httpx.Client, base_url: str, key: str, sale_id: str) -> dict[str, Any]:
    response = client.get(
        f"{base_url}/rest/v1/auction_sales",
        headers=_headers(key),
        params={
            "select": "surface_m2,land_surface_m2,rooms_count,occupancy_status,starting_price_eur",
            "id": f"eq.{sale_id}",
            "limit": "1",
        },
    )
    response.raise_for_status()
    rows = response.json()
    return rows[0] if isinstance(rows, list) and rows else {}


def _fetch_case_status(client: httpx.Client, base_url: str, key: str, case_id: str) -> str:
    if not case_id:
        return ""
    response = client.get(
        f"{base_url}/rest/v1/information_agent_cases",
        headers=_headers(key),
        params={"select": "status", "id": f"eq.{case_id}", "limit": "1"},
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Information-agent case not found")
    return str(rows[0].get("status") or "")


def _insert_fact_candidates(
    client: httpx.Client,
    base_url: str,
    key: str,
    job: dict[str, Any],
    facts: list[EvidenceFact],
    sale: dict[str, Any],
) -> None:
    payload = []
    for fact in facts:
        item = fact.as_json()
        payload.append(
            {
                "case_id": job["case_id"],
                "message_id": job["message_id"],
                "sale_id": job["sale_id"],
                "evidence_asset_id": job["asset_id"],
                "fact_key": fact.fact_key,
                "proposed_value": item["proposed_value"],
                "display_value": fact.display_value[:500],
                "evidence_excerpt": fact.evidence_excerpt[:2000],
                "confidence": fact.confidence,
                "extraction_method": "document_ocr_v1",
                "source_page": fact.source_page,
                "source_locator": f"page:{fact.source_page}",
                "status": "conflict" if _conflicts_with_sale(fact, sale) else "pending",
                "metadata": {"processor_version": PROCESSOR_VERSION},
            }
        )
    response = client.post(
        f"{base_url}/rest/v1/information_agent_fact_candidates",
        headers={**_headers(key), "Prefer": "resolution=ignore-duplicates,return=minimal"},
        params={"on_conflict": "message_id,fact_key,evidence_asset_id,source_page,display_value"},
        content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    response.raise_for_status()


def _conflicts_with_sale(fact: EvidenceFact, sale: dict[str, Any]) -> bool:
    existing = sale.get(fact.fact_key)
    if existing is None or fact.fact_key in {"visit_information", "energy_diagnostics"}:
        return False
    if isinstance(existing, (int, float)) and isinstance(fact.value, (int, float)):
        return abs(float(existing) - float(fact.value)) > 0.01
    return str(existing).strip().lower() != str(fact.value).strip().lower()


def _finish_job(
    client: httpx.Client,
    base_url: str,
    key: str,
    extraction_id: str,
    analysis: EvidenceAnalysis,
    *,
    attempts: int | None = None,
    locked_at: str | None = None,
) -> None:
    now = datetime.now(UTC).isoformat()
    payload = {
        "status": analysis.status,
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
        "locked_at": None,
        "completed_at": now,
    }
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_evidence_extractions",
        headers={**_headers(key), "Prefer": "return=minimal"},
        params=_processing_lease_params(extraction_id, attempts=attempts, locked_at=locked_at),
        json=payload,
    )
    response.raise_for_status()


def _fail_job(
    client: httpx.Client,
    base_url: str,
    key: str,
    extraction_id: str,
    attempts: int,
    message: str,
    *,
    locked_at: str | None = None,
) -> None:
    now = datetime.now(UTC)
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_evidence_extractions",
        headers={**_headers(key), "Prefer": "return=minimal"},
        params=_processing_lease_params(extraction_id, attempts=attempts, locked_at=locked_at),
        json={
            "status": "failed",
            "error_code": "WORKER_ERROR",
            "error_message": message[:2000],
            "locked_at": None,
            "available_at": (now + timedelta(minutes=min(30, 2**attempts))).isoformat(),
            "completed_at": now.isoformat() if attempts >= 3 else None,
        },
    )
    response.raise_for_status()


def _processing_lease_params(
    extraction_id: str,
    *,
    attempts: int | None,
    locked_at: str | None,
) -> dict[str, str]:
    params = {
        "id": f"eq.{extraction_id}",
        "status": "eq.processing",
    }
    if attempts is not None:
        params["attempts"] = f"eq.{attempts}"
    if locked_at:
        params["locked_at"] = f"eq.{locked_at}"
    return params


def _mark_case_for_review(client: httpx.Client, base_url: str, key: str, case_id: str) -> None:
    if not case_id:
        return
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_cases",
        headers={**_headers(key), "Prefer": "return=minimal"},
        params={"id": f"eq.{case_id}", "status": "in.(replied,review)"},
        json={"status": "review"},
    )
    response.raise_for_status()


def _headers(key: str) -> dict[str, str]:
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _run_pdf_ocr_child(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] != "--ocr-pdf-page":
        return 2
    try:
        payload = _ocr_pdf_page_in_process(argv[1], int(argv[2]))
    except Exception as exc:
        payload = {"error": str(exc)[:300]}
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--ocr-pdf-page":
        raise SystemExit(_run_pdf_ocr_child(sys.argv[1:]))
    batch_limit = max(1, min(10, int(os.getenv("INFORMATION_AGENT_EVIDENCE_BATCH_SIZE", "5"))))
    print(json.dumps({"processed": run_information_agent_evidence_batch(limit=batch_limit)}))
