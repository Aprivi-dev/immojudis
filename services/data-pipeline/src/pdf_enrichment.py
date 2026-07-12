from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote, unquote, urlparse, urlsplit, urlunsplit
from xml.etree import ElementTree

import fitz
import httpx

from src.config import DOCLING_TEXTS_DIR, DOCUMENTS_DIR, PDF_DOCUMENT_TEXTS_DIR, PDF_TEXTS_DIR, load_settings
from src.models import AuctionSale
from src.normalize import (
    SURFACE_VALUE_PATTERN,
    clean_text,
    extract_bedrooms_count_from_text,
    extract_rooms_count_from_text,
    has_rented_occupancy_signal,
    no_lease_occupancy_status,
    normalize_property_type,
    normalize_status,
    parse_french_datetime,
    parse_price,
    parse_surface,
    strip_accents,
)

LOGGER = logging.getLogger(__name__)
PDF_TEXT_CACHE_VERSION = "pdf_text_v3_surface_calibration"
DOCUMENT_FACTS_VERSION = "document_facts_v1_starting_price"
DOCUMENT_TYPE_ALIASES = {
    "pv_descriptif": "pv_huissier",
    "proces_verbal_descriptif": "pv_huissier",
    "proces_verbal_de_description": "pv_huissier",
    "proces_verbal_de_constat": "pv_huissier",
    "pvd": "pv_huissier",
    "diagnostic": "diagnostics_techniques",
    "diagnostics": "diagnostics_techniques",
    "diagnostic_technique": "diagnostics_techniques",
    "cahier_conditions": "cahier_conditions_vente",
    "cahier_des_conditions": "cahier_conditions_vente",
    "cahier_des_conditions_de_vente": "cahier_conditions_vente",
    "ccv": "cahier_conditions_vente",
}
GENERIC_DOCUMENT_TYPES = {"document", "documents", "file", "fichier", "pdf", "piece_jointe", "pieces_jointes"}


@dataclass
class PdfEnrichmentStats:
    downloaded: int = 0
    errors: int = 0
    raw_text_enriched: int = 0
    document_cache_hits: int = 0
    document_cache_misses: int = 0
    documents_processed: int = 0


def enrich_sale_from_pdfs(sale: AuctionSale) -> PdfEnrichmentStats:
    stats = PdfEnrichmentStats()
    downloaded_documents = download_documents(sale, stats=stats)
    pdf_texts: list[dict[str, object]] = []

    for document in _select_documents_for_extraction(downloaded_documents, sale=sale):
        file_path = Path(document["file_path"])
        try:
            cached_payload = _read_document_text_cache(document, file_path) if load_settings()["incremental_enrichment"] else None
            if cached_payload:
                stats.document_cache_hits += 1
                pdf_texts.append(cached_payload)
                continue
            stats.document_cache_misses += 1
            payload = extract_attached_document(file_path, document=document)
        except Exception as exc:
            LOGGER.warning("PDF text extraction failed for %s: %s", file_path, exc)
            stats.errors += 1
            continue
        payload.update(
            {
                "label": document.get("label", ""),
                "url": document.get("url", ""),
                "type": document.get("type", "pdf"),
                "document_type": _canonical_document_type(
                    document.get("document_type") or document.get("type"),
                    label=document.get("label"),
                    url=document.get("url"),
                ),
                "file_path": str(file_path),
            }
        )
        _write_document_text_cache(document, file_path, payload)
        stats.documents_processed += 1
        pdf_texts.append(payload)

    if pdf_texts:
        _write_pdf_text_cache(sale, pdf_texts)
        before = sale.raw_text or ""
        enrich_sale_from_pdf_text(sale, pdf_texts)
        if len(sale.raw_text or "") > len(before):
            stats.raw_text_enriched += 1
    _store_document_analysis_status(sale, downloaded_documents, pdf_texts)

    return stats


def download_documents(
    sale: AuctionSale,
    output_root: Path = DOCUMENTS_DIR,
    stats: PdfEnrichmentStats | None = None,
) -> list[dict[str, str]]:
    sale_id = _sale_storage_id(sale)
    sale_dir = output_root / sale_id
    sale_dir.mkdir(parents=True, exist_ok=True)

    settings = load_settings()
    headers = {
        "User-Agent": str(settings["user_agent"]),
        "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
        "Referer": sale.source_url,
    }
    downloaded: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for document in sale.documents:
        url = document.get("url")
        document_type = _canonical_document_type(
            document.get("document_type") or document.get("type"),
            label=document.get("label"),
            url=url,
        )
        if not url or document_type == "other" or url in seen_urls:
            continue
        seen_urls.add(url)
        if _is_robots_disallowed_licitor_document(url):
            LOGGER.info("Skipping robots-disallowed Licitor document %s", url)
            continue

        filename = _document_filename(document)
        file_path = sale_dir / filename
        if file_path.exists() and _document_file_format(
            file_path.read_bytes(),
            url=url,
            content_type=None,
        ) is None:
            LOGGER.info("Discarding unsupported document cache entry %s", file_path)
            file_path.unlink(missing_ok=True)
        if not file_path.exists():
            download_error: Exception | None = None
            try:
                for candidate_url in _document_url_variants(url):
                    try:
                        response = httpx.get(
                            candidate_url,
                            headers=headers,
                            timeout=float(settings["request_timeout_seconds"]),
                            verify=_verify_tls(candidate_url),
                            follow_redirects=True,
                        )
                        response.raise_for_status()
                        response_headers = getattr(response, "headers", {})
                        content_type = response_headers.get("content-type", "")
                        file_format = _document_file_format(
                            response.content,
                            url=candidate_url,
                            content_type=content_type,
                        )
                        if file_format is None:
                            raise ValueError(
                                f"response is not a supported document (content-type={content_type or 'unknown'})"
                            )
                    except Exception as exc:
                        download_error = exc
                        continue
                    if candidate_url != url:
                        LOGGER.info("PDF URL Unicode variant succeeded for %s", url)
                    file_path.write_bytes(response.content)
                    if stats:
                        stats.downloaded += 1
                    download_error = None
                    break
            except Exception as exc:
                download_error = exc
            if download_error is not None:
                LOGGER.warning("PDF download failed for %s: %s", url, download_error)
                if stats:
                    stats.errors += 1
                continue

        enriched_document = dict(document)
        file_format = _document_file_format(
            file_path.read_bytes(),
            url=url,
            content_type=None,
        ) or "unknown"
        enriched_document["type"] = file_format
        enriched_document["file_format"] = file_format
        enriched_document["document_type"] = document_type
        enriched_document["file_path"] = str(file_path)
        downloaded.append(enriched_document)
    return downloaded


def _looks_like_pdf_bytes(content: bytes) -> bool:
    return b"%PDF-" in content[:1024]


def _document_file_format(content: bytes, *, url: str, content_type: str | None) -> str | None:
    if _looks_like_pdf_bytes(content):
        return "pdf"
    suffix = Path(urlparse(url).path).suffix.lower()
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if content.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") and (
        suffix == ".doc" or normalized_content_type == "application/msword"
    ):
        return "doc"
    if content.startswith(b"PK\x03\x04") and (
        suffix == ".docx"
        or normalized_content_type
        == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        return "docx"
    return None


def _document_url_variants(url: str) -> list[str]:
    variants = [url]
    for form in ("NFC", "NFD"):
        normalized = _normalize_document_url(url, form=form)
        if normalized not in variants:
            variants.append(normalized)
    return variants


def _normalize_document_url(url: str, *, form: str) -> str:
    parsed = urlsplit(url)
    safe_segment_chars = ":@-._~!$&'()*+,;="
    normalized_segments = [
        quote(unicodedata.normalize(form, unquote(segment)), safe=safe_segment_chars)
        for segment in parsed.path.split("/")
    ]
    normalized_query = unicodedata.normalize(form, parsed.query)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            "/".join(normalized_segments),
            normalized_query,
            parsed.fragment,
        )
    )


def _is_robots_disallowed_licitor_document(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"www.licitor.com", "licitor.com"}:
        return False
    path = parsed.path
    return path.startswith("/data/pub/doc/") or path.startswith("/data/pub/media/")


def _verify_tls(url: str) -> bool:
    # ponytail: public Cessions Etat PDFs currently ship an incomplete cert chain to Python/httpx.
    return urlparse(url).netloc.lower() != "cessions.immobilier-etat.gouv.fr"


def extract_attached_document(
    file: str | Path,
    document: dict[str, str] | None = None,
) -> dict[str, object]:
    path = Path(file)
    file_format = str((document or {}).get("file_format") or path.suffix.lstrip(".")).lower()
    if file_format == "pdf":
        return extract_pdf_document(path, document=document)
    if file_format == "doc":
        return _extract_legacy_word_document(path)
    if file_format == "docx":
        return _extract_docx_document(path)
    raise ValueError(f"unsupported attached document format: {file_format or 'unknown'}")


def _extract_legacy_word_document(path: Path) -> dict[str, object]:
    commands: list[tuple[list[str], str]] = []
    if shutil.which("antiword"):
        commands.append((["antiword", str(path)], "antiword"))
    if shutil.which("textutil"):
        commands.append((["textutil", "-convert", "txt", "-stdout", str(path)], "textutil"))
    if not commands:
        raise RuntimeError("legacy Word extraction requires antiword or textutil")

    last_error = ""
    for command, method in commands:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        text = clean_text(result.stdout) or ""
        if result.returncode == 0 and text:
            return _single_page_document_payload(path, text, extraction_method=method)
        last_error = clean_text(result.stderr) or f"exit code {result.returncode}"
    raise RuntimeError(f"legacy Word extraction failed: {last_error}")


def _extract_docx_document(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    text = clean_text(" ".join(node.text or "" for node in root.iter() if node.tag.endswith("}t"))) or ""
    if not text:
        raise ValueError("DOCX document contains no extractable text")
    return _single_page_document_payload(path, text, extraction_method="docx_xml")


def _single_page_document_payload(
    path: Path,
    text: str,
    *,
    extraction_method: str,
) -> dict[str, object]:
    confidence = _page_text_confidence(text, method="pymupdf_text")
    return {
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "text": text,
        "pages": [
            {
                "page": 1,
                "text": text,
                "chars": len(text),
                "raw_text_chars": len(text),
                "method": extraction_method,
                "confidence": confidence,
            }
        ],
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "page_count": 1,
        "text_chars": len(text),
        "extraction_method": extraction_method,
        "confidence": confidence,
        "ocr_pages": 0,
    }


def extract_pdf_text(file: str | Path, document: dict[str, str] | None = None) -> str:
    return str(extract_pdf_document(file, document=document).get("text") or "")


def extract_pdf_document(file: str | Path, document: dict[str, str] | None = None) -> dict[str, object]:
    path = Path(file)
    settings = load_settings()
    pages = extract_pdf_pages(path)
    page_text = clean_text("\n".join(str(page["text"]) for page in pages if page.get("text"))) or ""
    text = page_text
    extraction_method = "pymupdf_pages"
    docling_text = ""
    if str(settings["pdf_extractor"]) == "docling":
        timeout = _adaptive_docling_timeout(path, document=document, settings=settings)
        docling_text = extract_pdf_text_with_docling(path, timeout_seconds=timeout)
        if docling_text:
            extraction_method = "docling"
            if len(docling_text) >= len(page_text):
                text = docling_text
        else:
            LOGGER.warning("Docling returned no text for %s; falling back to PyMuPDF/Tesseract", path)
    if settings["pdf_docling_enabled"] and str(settings["pdf_extractor"]) == "auto" and len(text) < int(settings["pdf_docling_threshold_chars"]):
        docling_text = extract_pdf_text_with_docling(path)
        if len(docling_text) > len(text):
            text = docling_text
            extraction_method = "docling_auto"

    sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    page_confidences = [float(page.get("confidence") or 0) for page in pages if page.get("text")]
    confidence = round(sum(page_confidences) / len(page_confidences), 3) if page_confidences else 0.0
    return {
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "text": text,
        "pages": pages,
        "sha256": sha256,
        "page_count": len(pages),
        "text_chars": len(text),
        "page_text_chars": len(page_text),
        "ocr_pages": sum(1 for page in pages if str(page.get("method") or "").startswith("ocr_")),
        "empty_pages": sum(1 for page in pages if not clean_text(page.get("text"))),
        "extraction_method": extraction_method,
        "confidence": confidence,
    }


def extract_pdf_text_with_docling(file: str | Path, timeout_seconds: float | None = None) -> str:
    path = Path(file)
    cached = _read_docling_cache(path)
    if cached is not None:
        return cached
    settings = load_settings()
    timeout = float(timeout_seconds if timeout_seconds is not None else settings["pdf_docling_timeout_seconds"] or 0)
    if timeout > 0:
        text = _extract_pdf_text_with_docling_subprocess(path, timeout)
        if text:
            _write_docling_cache(path, text)
        return text
    text = _extract_pdf_text_with_docling_direct(path)
    if text:
        _write_docling_cache(path, text)
    return text


def _extract_pdf_text_with_docling_direct(path: Path) -> str:
    try:
        _ensure_docling_available()
    except Exception as exc:
        LOGGER.warning("Docling is unavailable: %s", exc)
        return ""
    try:
        settings = load_settings()
        profile = _profile_pdf_for_docling(path)
        do_ocr = _should_docling_ocr(path, settings, profile=profile)
        chunk_pages = _docling_chunk_pages(settings, do_ocr)
        if profile["page_count"] > chunk_pages:
            text = _extract_docling_pdf_in_chunks(path, do_ocr, profile, settings)
        else:
            converter = _build_docling_converter(do_ocr, settings)
            text = _convert_docling_pdf(converter, path)
    except Exception as exc:
        LOGGER.warning("Docling extraction failed for %s: %s", path, exc)
        return ""
    return text


def _ensure_docling_available() -> None:
    for module_name in (
        "docling.datamodel.base_models",
        "docling.datamodel.pipeline_options",
        "docling.document_converter",
    ):
        importlib.import_module(module_name)


def _build_docling_converter(do_ocr: bool, settings: dict[str, object]) -> object:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions(
        do_ocr=do_ocr,
        do_table_structure=False,
        document_timeout=float(settings["pdf_docling_timeout_seconds"] or 0) or None,
        force_backend_text=True,
        generate_page_images=False,
        generate_picture_images=False,
    )
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})


def _convert_docling_pdf(converter: object, path: Path) -> str:
    result = converter.convert(str(path), raises_on_error=False)
    if not result.input.valid:
        LOGGER.warning("Docling rejected invalid PDF backend input for %s", path)
        return ""
    return clean_text(result.document.export_to_markdown()) or ""


def _extract_docling_pdf_in_chunks(
    path: Path,
    do_ocr: bool,
    profile: dict[str, float | int],
    settings: dict[str, object],
) -> str:
    chunk_pages = _docling_chunk_pages(settings, do_ocr)
    parts: list[str] = []
    converter = _build_docling_converter(do_ocr, settings)
    with tempfile.TemporaryDirectory(prefix="auction-docling-") as tmp_dir:
        tmp_root = Path(tmp_dir)
        for start in range(1, int(profile["page_count"]) + 1, chunk_pages):
            end = min(start + chunk_pages - 1, int(profile["page_count"]))
            chunk_path = _write_pdf_page_chunk(path, tmp_root, start, end)
            text = _convert_docling_pdf(converter, chunk_path)
            if text:
                parts.append(f"--- pages {start}-{end} ---\n{text}")
    return clean_text("\n\n".join(parts)) or ""


def _write_pdf_page_chunk(path: Path, output_dir: Path, start_page: int, end_page: int) -> Path:
    output_path = output_dir / f"{path.stem}-{start_page}-{end_page}.pdf"
    with fitz.open(path) as source, fitz.open() as chunk:
        chunk.insert_pdf(source, from_page=start_page - 1, to_page=end_page - 1)
        chunk.save(output_path, garbage=4, deflate=True, clean=True)
    return output_path


def _docling_chunk_pages(settings: dict[str, object], do_ocr: bool) -> int:
    key = "pdf_docling_ocr_chunk_pages" if do_ocr else "pdf_docling_chunk_pages"
    return max(1, int(settings[key]))


def _extract_pdf_text_with_docling_subprocess(path: Path, timeout: float) -> str:
    DOCLING_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = _docling_cache_path(path).with_suffix(".tmp.txt")
    command = [sys.executable, "-m", "src.pdf_enrichment", "--docling-extract", str(path), str(output_path)]
    try:
        result = subprocess.run(
            command,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        LOGGER.warning("Docling extraction timed out after %.0fs for %s", timeout, path)
        return ""
    if result.returncode != 0:
        stderr = clean_text(result.stderr)[-1000:] if result.stderr else ""
        LOGGER.warning("Docling extraction subprocess failed for %s: %s", path, stderr)
        return ""
    if not output_path.exists():
        return ""
    text = clean_text(output_path.read_text(encoding="utf-8")) or ""
    output_path.unlink(missing_ok=True)
    return text


def extract_pdf_pages(file: str | Path) -> list[dict[str, object]]:
    pages: list[dict[str, object]] = []
    with fitz.open(file) as document:
        for index, page in enumerate(document, start=1):
            raw_text = page.get_text("text") or ""
            method = "pymupdf_text"
            confidence = _page_text_confidence(raw_text, method=method)
            text = raw_text
            if _should_try_ocr(raw_text):
                result = _extract_page_text_with_ocr_result(page, fallback=raw_text)
                text = str(result["text"])
                method = str(result["method"])
                confidence = float(result["confidence"])
            cleaned = clean_text(text) or ""
            pages.append(
                {
                    "page": index,
                    "text": cleaned,
                    "chars": len(cleaned),
                    "raw_text_chars": len(clean_text(raw_text) or ""),
                    "method": method,
                    "confidence": confidence,
                }
            )
    return pages


def _should_try_ocr(text: str) -> bool:
    settings = load_settings()
    if not settings["pdf_ocr_enabled"]:
        return False
    return len(clean_text(text) or "") < 80


def _extract_page_text_with_ocr(page: fitz.Page, fallback: str) -> str:
    return str(_extract_page_text_with_ocr_result(page, fallback=fallback)["text"])


def _extract_page_text_with_ocr_result(page: fitz.Page, fallback: str) -> dict[str, object]:
    settings = load_settings()
    tessdata = settings.get("pdf_ocr_tessdata")
    try:
        text_page = page.get_textpage_ocr(
            language=str(settings["pdf_ocr_language"]),
            full=True,
            tessdata=str(tessdata) if tessdata else None,
        )
        text = page.get_text("text", textpage=text_page)
        if clean_text(text):
            return {
                "text": text,
                "method": "ocr_pymupdf",
                "confidence": _page_text_confidence(text, method="ocr_pymupdf"),
            }
    except Exception as exc:
        LOGGER.debug("PDF OCR unavailable or failed: %s", exc)
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "page.png"
            pixmap = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
            pixmap.save(str(image_path))
            env = os.environ.copy()
            if tessdata:
                env["TESSDATA_PREFIX"] = str(tessdata)
            result = subprocess.run(
                ["tesseract", str(image_path), "stdout", "-l", str(settings["pdf_ocr_language"])],
                capture_output=True,
                text=True,
                timeout=60,
                env=env,
                check=False,
            )
            if result.returncode == 0 and clean_text(result.stdout):
                return {
                    "text": result.stdout,
                    "method": "ocr_tesseract",
                    "confidence": _page_text_confidence(result.stdout, method="ocr_tesseract"),
                }
            LOGGER.debug("Tesseract OCR returned %s: %s", result.returncode, result.stderr)
    except Exception as exc:
        LOGGER.debug("Tesseract OCR fallback failed: %s", exc)
    return {
        "text": fallback,
        "method": "fallback_text",
        "confidence": _page_text_confidence(fallback, method="fallback_text"),
    }


def _page_text_confidence(text: str | None, *, method: str) -> float:
    chars = len(clean_text(text) or "")
    if chars == 0:
        return 0.0
    if method == "pymupdf_text":
        base = Decimal("0.92")
    elif method == "ocr_pymupdf":
        base = Decimal("0.74")
    elif method == "ocr_tesseract":
        base = Decimal("0.70")
    else:
        base = Decimal("0.45")
    if chars < 120:
        base -= Decimal("0.18")
    elif chars < 500:
        base -= Decimal("0.08")
    return float(max(Decimal("0.1"), min(Decimal("0.98"), base)))


def classify_document_type(label: str | None, url: str | None = None) -> str:
    text = _normalize_document_classifier_text(f"{label or ''} {url or ''}")
    if any(pattern in text for pattern in ("diagnostic", "dpe", "erp", "amiante", "plomb", "termites", "crep")):
        return "diagnostics_techniques"
    if re.search(r"\bdiag(?:nostics?)?\b", text):
        return "diagnostics_techniques"
    if any(
        pattern in text
        for pattern in (
            "cahier",
            "cahier des conditions",
            "cahier_des_conditions",
            "cahier des charges",
            "cahier_des_charges",
            "ccv",
            "dossier de consultation",
            "dossier_de_consultation",
            "dossier de presentation",
            "dossier_de_presentation",
            "reglement de consultation",
        )
    ):
        return "cahier_conditions_vente"
    if "conditions de vente" in text or "conditions_de_vente" in text:
        return "conditions_vente"
    if any(pattern in text for pattern in ("pv notaire", "notaire", "notarié", "notarie")):
        return "pv_notaire"
    if any(
        pattern in text
        for pattern in (
            "pv descriptif",
            "pv description",
            "pvd",
            "descriptif",
            "proces-verbal de constat",
            "commissaire de justice",
            "huissier",
        )
    ):
        return "pv_huissier"
    if re.search(r"\bproces[-\s]+verbal\b.*\b(?:description|descriptif|constat)\b", text):
        return "pv_huissier"
    if re.search(r"\bpv\b", text):
        return "pv_huissier"
    if re.search(r"\bproces[-\s]+verbal\b", text):
        return "proces_verbal"
    if any(
        pattern in text
        for pattern in ("avis", "simplifie", "simplifié", "affiche", "insertion", "annonce", "placard", "publicite", "publicité")
    ):
        return "annonce_vente"
    if "bail" in text or "location" in text:
        return "bail"
    if any(pattern in text for pattern in ("hypothecaire", "hypothécaire", "commandement")):
        return "procedure_saisie"
    if any(pattern in text for pattern in ("cadastre", "plan", "parcelle")):
        return "cadastre"
    if ".pdf" in text:
        return "pdf"
    return "other"


def _normalize_document_classifier_text(value: object | None) -> str:
    text = clean_text(value) or ""
    normalized = unicodedata.normalize("NFKD", text)
    without_accents = "".join(char for char in normalized if not unicodedata.combining(char))
    return without_accents.lower()


def _canonical_document_type(
    document_type: object | None,
    *,
    label: object | None = None,
    url: object | None = None,
) -> str:
    classified = classify_document_type(clean_text(label), clean_text(url))
    raw = clean_text(document_type)
    if raw:
        normalized = _normalize_document_classifier_text(raw).replace("-", "_").replace(" ", "_")
        normalized = re.sub(r"_+", "_", normalized).strip("_")
        alias = DOCUMENT_TYPE_ALIASES.get(normalized)
        if alias:
            return alias
        if normalized in GENERIC_DOCUMENT_TYPES and classified != "other":
            return classified
        if normalized not in {"other", "unknown"}:
            return normalized
    return classified


PDF_DESCRIPTION_GROUP = frozenset({"pv_huissier", "pv_notaire", "proces_verbal"})
PDF_DIAGNOSTICS_GROUP = frozenset({"diagnostics_techniques"})
PDF_CONDITIONS_GROUP = frozenset({"cahier_conditions_vente", "conditions_vente"})
PDF_ANNOUNCE_GROUP = frozenset({"annonce_vente"})
PDF_BAIL_GROUP = frozenset({"bail"})
PDF_CADASTRE_GROUP = frozenset({"cadastre"})
DEFAULT_DOCUMENT_GROUPS = (
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
    PDF_CONDITIONS_GROUP,
    PDF_ANNOUNCE_GROUP,
    PDF_BAIL_GROUP,
    PDF_CADASTRE_GROUP,
)


def _select_documents_for_extraction(
    documents: list[dict[str, str]],
    *,
    sale: AuctionSale | None = None,
) -> list[dict[str, str]]:
    settings = load_settings()
    configured_max_documents = max(1, int(settings["pdf_max_documents_per_sale"]))
    required_groups = _required_document_groups_for_sale(sale)
    max_documents = max(configured_max_documents, _available_document_group_count(documents, required_groups))
    priority = {
        "pv_huissier": 0,
        "pv_notaire": 1,
        "proces_verbal": 2,
        "diagnostics_techniques": 3,
        "cahier_conditions_vente": 4,
        "conditions_vente": 5,
        "annonce_vente": 6,
        "bail": 7,
        "pdf": 8,
        "other": 9,
    }
    groups = _document_group_order(required_groups)
    sorted_documents = sorted(
        documents,
        key=lambda item: (
            priority.get(
                _canonical_document_type(
                    item.get("document_type") or item.get("type"),
                    label=item.get("label"),
                    url=item.get("url"),
                ),
                9,
            ),
            str(item.get("label") or ""),
            str(item.get("url") or ""),
        ),
    )
    selected: list[dict[str, str]] = []
    selected_urls: set[str] = set()
    for group in groups:
        candidate = next(
            (
                item
                for item in sorted_documents
                if _canonical_document_type(
                    item.get("document_type") or item.get("type"),
                    label=item.get("label"),
                    url=item.get("url"),
                )
                in group
                and _document_identity(item) not in selected_urls
            ),
            None,
        )
        if candidate is not None:
            selected.append(candidate)
            selected_urls.add(_document_identity(candidate))
            if len(selected) >= max_documents:
                return selected
    for item in sorted_documents:
        identity = _document_identity(item)
        if identity in selected_urls:
            continue
        selected.append(item)
        selected_urls.add(identity)
        if len(selected) >= max_documents:
            break
    return selected


def _required_document_groups_for_sale(sale: AuctionSale | None) -> tuple[frozenset[str], ...]:
    if sale is None:
        return ()
    groups: list[frozenset[str]] = []
    has_surface = any(
        value is not None
        for value in (
            sale.surface_m2,
            sale.habitable_surface_m2,
            sale.carrez_surface_m2,
            sale.land_surface_m2,
            sale.app_surface_m2,
        )
    )
    if not has_surface:
        groups.extend((PDF_DESCRIPTION_GROUP, PDF_DIAGNOSTICS_GROUP, PDF_CONDITIONS_GROUP))
    if sale.property_type in {"house", "apartment", "building"} and sale.rooms_count is None:
        groups.extend((PDF_DESCRIPTION_GROUP, PDF_CONDITIONS_GROUP, PDF_ANNOUNCE_GROUP))
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        groups.extend((PDF_DESCRIPTION_GROUP, PDF_CONDITIONS_GROUP, PDF_BAIL_GROUP))
    if _needs_energy_diagnostics(sale):
        groups.append(PDF_DIAGNOSTICS_GROUP)
    if sale.raw_payload.get("document_facts_version") != DOCUMENT_FACTS_VERSION:
        groups.append(PDF_CONDITIONS_GROUP)
    return _unique_document_groups(groups)


def _needs_energy_diagnostics(sale: AuctionSale) -> bool:
    if sale.property_type in {"land", "parking"}:
        return False
    if sale.raw_payload.get("source_energy_diagnostics") or sale.raw_payload.get("pdf_energy_diagnostics"):
        return False
    risk_notes = _normalize_document_classifier_text(sale.risk_notes)
    if "dpe non soumis" in risk_notes:
        return False
    return sale.property_type in {"house", "apartment", "building", "commercial", "mixed"}


def _document_group_order(required_groups: tuple[frozenset[str], ...]) -> tuple[frozenset[str], ...]:
    return _unique_document_groups((*required_groups, *DEFAULT_DOCUMENT_GROUPS))


def _available_document_group_count(
    documents: list[dict[str, str]],
    groups: tuple[frozenset[str], ...],
) -> int:
    available_types = {
        _canonical_document_type(
            document.get("document_type") or document.get("type"),
            label=document.get("label"),
            url=document.get("url"),
        )
        for document in documents
    }
    return sum(1 for group in groups if available_types & group)


def _unique_document_groups(groups: tuple[frozenset[str], ...] | list[frozenset[str]]) -> tuple[frozenset[str], ...]:
    unique: list[frozenset[str]] = []
    seen: set[frozenset[str]] = set()
    for group in groups:
        if group in seen:
            continue
        seen.add(group)
        unique.append(group)
    return tuple(unique)


def _document_identity(document: dict[str, str]) -> str:
    return str(document.get("url") or document.get("file_path") or document.get("label") or id(document))


def _store_document_analysis_status(
    sale: AuctionSale,
    documents: list[dict[str, str]],
    pdf_texts: list[dict[str, object]],
) -> None:
    typed_documents = [_document_profile(document) for document in documents]
    extracted_profiles = [_extracted_document_profile(payload) for payload in pdf_texts]
    text_profiles = [profile for profile in extracted_profiles if profile["extraction_status"] == "extracted"]
    type_counts = Counter(profile["document_type"] for profile in typed_documents)
    extracted_type_counts = Counter(profile["document_type"] for profile in text_profiles)

    required_groups = {
        "pv_descriptif": {"pv_huissier", "pv_notaire", "proces_verbal"},
        "conditions_vente": {"cahier_conditions_vente", "conditions_vente"},
        "diagnostics": {"diagnostics_techniques"},
    }
    extracted_types = set(extracted_type_counts)
    available_types = set(type_counts)
    missing_core_documents = [
        group for group, aliases in required_groups.items() if not (aliases & (extracted_types or available_types))
    ]

    if not documents and not sale.documents:
        coverage_status = "source_only"
        warning = "Aucun PDF officiel exploitable n'a été trouvé : l'analyse reste un pré-tri."
    elif not text_profiles:
        coverage_status = "documents_not_extracted"
        warning = "Des documents sont listés, mais aucun texte PDF n'a encore été extrait."
    elif missing_core_documents:
        coverage_status = "partial"
        warning = "Certaines pièces clés manquent ou n'ont pas été extraites."
    else:
        coverage_status = "rich"
        warning = "Les principales familles de documents sont disponibles pour l'analyse."

    sale.raw_payload["document_analysis"] = {
        "coverage_status": coverage_status,
        "warning": warning,
        "documents_listed": len(sale.documents or []),
        "documents_downloaded": len(documents),
        "documents_extracted": len(text_profiles),
        "document_types": dict(type_counts),
        "extracted_document_types": dict(extracted_type_counts),
        "missing_core_documents": missing_core_documents,
        "official_documents_found": bool(
            {"pv_huissier", "pv_notaire", "proces_verbal", "cahier_conditions_vente", "conditions_vente", "diagnostics_techniques"}
            & (available_types | extracted_types)
        ),
        "profiles": extracted_profiles or typed_documents,
    }


def _document_profile(document: dict[str, str]) -> dict[str, object]:
    label = str(document.get("label") or "")
    url = str(document.get("url") or "")
    document_type = _canonical_document_type(document.get("document_type") or document.get("type"), label=label, url=url)
    return {
        "label": label or None,
        "url": url or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": "pending",
    }


def _extracted_document_profile(payload: dict[str, object]) -> dict[str, object]:
    document_type = _canonical_document_type(
        payload.get("document_type") or payload.get("type"),
        label=payload.get("label"),
        url=payload.get("url"),
    )
    return {
        "label": payload.get("label") or None,
        "url": payload.get("url") or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": "extracted" if clean_text(payload.get("text")) else "empty",
        "text_chars": int(payload.get("text_chars") or len(str(payload.get("text") or ""))),
        "page_count": int(payload.get("page_count") or 0),
        "ocr_pages": int(payload.get("ocr_pages") or 0),
        "confidence": float(payload.get("confidence") or 0),
        "method": payload.get("extraction_method") or None,
    }


def _document_family(document_type: str) -> str:
    if document_type in {"pv_huissier", "pv_notaire", "proces_verbal"}:
        return "constat_et_description"
    if document_type in {"cahier_conditions_vente", "conditions_vente"}:
        return "conditions_de_vente"
    if document_type == "diagnostics_techniques":
        return "diagnostics"
    if document_type == "bail":
        return "occupation"
    if document_type == "annonce_vente":
        return "annonce"
    if document_type in {"procedure_saisie", "cadastre"}:
        return "juridique_et_perimetre"
    return "autre"


def _adaptive_docling_timeout(
    path: Path,
    document: dict[str, str] | None,
    settings: dict[str, object],
) -> float:
    default_timeout = float(settings["pdf_docling_timeout_seconds"] or 0)
    fast_timeout = float(settings["pdf_docling_fast_timeout_seconds"] or default_timeout)
    if default_timeout <= 0:
        return default_timeout

    text = f"{document.get('label', '') if document else ''} {document.get('url', '') if document else ''}".lower()
    document_type = _canonical_document_type(
        (document.get("document_type") or document.get("type")) if document else None,
        label=document.get("label") if document else None,
        url=document.get("url") if document else None,
    )
    if re.search(r"sign|sign[ée]e?|anonymis|saisie-immobiliere|saisie\s+immobili[eè]re", text, re.I):
        return min(default_timeout, fast_timeout)
    profile = _profile_pdf_for_docling(path)
    if document_type in {"cahier_conditions", "cahier_conditions_vente", "conditions_vente"} and (
        profile["page_count"] >= 15 or profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])
    ):
        return min(default_timeout, fast_timeout)
    return default_timeout


def enrich_sale_from_pdf_text(sale: AuctionSale, pdf_texts: list[dict[str, object]] | list[str]) -> AuctionSale:
    texts = [str(item.get("text") or "") if isinstance(item, dict) else item for item in pdf_texts]
    combined = "\n\n".join(text for text in texts if text)
    if not combined:
        return sale

    if sale.land_surface_m2 is None:
        land_surface = _extract_land_surface_from_documents(pdf_texts) or _extract_land_surface_with_evidence(combined)
        if land_surface:
            _assign_pdf_land_surface(sale, land_surface)
    if sale.surface_m2 is None:
        surface = _extract_surface_from_documents(pdf_texts) or _extract_surface_with_evidence(combined)
        if surface:
            _assign_pdf_surface(sale, surface)
    if sale.rooms_count is None:
        sale.rooms_count = _extract_rooms_count(combined)
    if sale.bedrooms_count is None:
        sale.bedrooms_count = extract_bedrooms_count_from_text(combined)
    if not sale.occupancy_status:
        sale.occupancy_status = _extract_occupancy_status(combined)
    if sale.sale_date is None:
        sale_date = _extract_sale_date_from_documents(pdf_texts) or _extract_sale_date_with_evidence(combined)
        if sale_date:
            _assign_pdf_sale_date(sale, sale_date)
    starting_price = _extract_starting_price_from_documents(pdf_texts)
    if starting_price:
        _reconcile_pdf_starting_price(sale, starting_price)
    if not sale.visit_dates:
        visit_dates = _extract_visit_dates_from_documents(pdf_texts) or _extract_visit_dates_with_evidence(combined)
        if visit_dates:
            sale.visit_dates = list(visit_dates["visit_dates"])
            sale.raw_payload["pdf_visit_dates_extraction"] = visit_dates
    if not sale.property_type or sale.property_type == "other":
        sale.property_type = _extract_property_type(combined) or sale.property_type
    if not sale.description:
        sale.description = _extract_description(combined)

    energy_diagnostics = _extract_energy_diagnostics_from_documents(pdf_texts) or _extract_energy_diagnostics_with_evidence(combined)
    if energy_diagnostics:
        sale.raw_payload["pdf_energy_diagnostics"] = energy_diagnostics

    risk_notes = _extract_risk_notes(combined)
    if energy_diagnostics:
        risk_notes = _merge_pdf_risk_notes(risk_notes, _energy_diagnostic_risk_note(energy_diagnostics))
    if risk_notes:
        sale.risk_notes = clean_text(" | ".join(filter(None, [sale.risk_notes, risk_notes])))

    enriched_marker = "\n\n--- PDF TEXT ENRICHMENT ---\n"
    current_raw = sale.raw_text or ""
    if enriched_marker.strip() in current_raw:
        current_raw = current_raw.split(enriched_marker.strip(), 1)[0]
    sale.raw_text = clean_text(f"{current_raw}{enriched_marker}{combined[:15000]}")
    sale.raw_payload["document_facts_version"] = DOCUMENT_FACTS_VERSION
    return sale


def _extract_surface_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    document_surfaces: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        text = str(item.get("text") or "")
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        for surface in _document_surface_candidates(item, text):
            document_surfaces.append(
                {
                    "value": surface["value"],
                    "evidence": str(surface["evidence"]),
                    "label": label,
                    "url": clean_text(item.get("url")) or "",
                    "document_type": document_type,
                    "rank": _surface_document_rank(
                        document_type,
                        str(surface["evidence"]),
                        surface_scope=clean_text(surface.get("surface_scope")),
                    ),
                    "surface_scope": surface.get("surface_scope"),
                    "page_number": surface.get("page_number"),
                    "page_confidence": surface.get("page_confidence"),
                    "extraction_method": surface.get("extraction_method") or item.get("extraction_method"),
                }
            )
    if not document_surfaces:
        return None
    document_surfaces.sort(key=lambda item: int(item["rank"]), reverse=True)
    best = document_surfaces[0]
    evidence = str(best["evidence"])
    label = str(best.get("label") or "")
    if label and label not in evidence:
        evidence = f"{label}: {evidence}"
    return {
        "value": best["value"],
        "evidence": evidence,
        "document_type": str(best.get("document_type") or "pdf"),
        "document_label": label,
        "document_url": str(best.get("url") or ""),
        "page_number": best.get("page_number"),
        "page_confidence": best.get("page_confidence"),
        "extraction_method": best.get("extraction_method"),
        "surface_scope": best.get("surface_scope"),
    }


def _extract_land_surface_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    document_surfaces: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        text = str(item.get("text") or "")
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        for surface in _document_land_surface_candidates(item, text):
            document_surfaces.append(
                {
                    "value": surface["value"],
                    "evidence": str(surface["evidence"]),
                    "label": label,
                    "url": clean_text(item.get("url")) or "",
                    "document_type": document_type,
                    "rank": _land_surface_document_rank(document_type),
                    "page_number": surface.get("page_number"),
                    "page_confidence": surface.get("page_confidence"),
                    "extraction_method": surface.get("extraction_method") or item.get("extraction_method"),
                }
            )
    if not document_surfaces:
        return None
    document_surfaces.sort(key=lambda item: int(item["rank"]), reverse=True)
    best = document_surfaces[0]
    evidence = str(best["evidence"])
    label = str(best.get("label") or "")
    if label and label not in evidence:
        evidence = f"{label}: {evidence}"
    return {
        "value": best["value"],
        "evidence": evidence,
        "document_type": str(best.get("document_type") or "pdf"),
        "document_label": label,
        "document_url": str(best.get("url") or ""),
        "page_number": best.get("page_number"),
        "page_confidence": best.get("page_confidence"),
        "extraction_method": best.get("extraction_method"),
    }


def _extract_starting_price_from_documents(
    pdf_texts: list[dict[str, object]] | list[str],
) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        if document_type in {"diagnostics_techniques", "bail", "cadastre"}:
            continue

        item_candidate_count = len(candidates)
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                extracted = _extract_starting_price_with_evidence(str(page.get("text") or ""))
                if not extracted:
                    continue
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
        if len(candidates) == item_candidate_count:
            extracted = _extract_starting_price_with_evidence(str(item.get("text") or ""))
            if extracted:
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
    if not candidates:
        return None
    candidates.sort(key=_starting_price_document_rank, reverse=True)
    return candidates[0]


def _starting_price_document_rank(item: dict[str, object]) -> tuple[int, float, int]:
    document_type = str(item.get("document_type") or "")
    document_score = {
        "cahier_conditions_vente": 100,
        "conditions_vente": 95,
        "annonce_vente": 70,
        "pv_huissier": 55,
        "pv_notaire": 55,
        "proces_verbal": 45,
        "pdf": 40,
    }.get(document_type, 30)
    page_confidence = float(item.get("page_confidence") or 0)
    page_number = int(item.get("page_number") or 0)
    return document_score, page_confidence, page_number


def _document_surface_candidates(item: dict[str, object], text: str) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    pages = item.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_text = str(page.get("text") or "")
            if not page_text:
                continue
            surface = _extract_surface_with_evidence(page_text)
            if surface:
                surface["surface_scope"] = _surface_measurement_scope(
                    f"{page_text}\n{text}",
                    str(surface["evidence"]),
                )
                surface["page_number"] = page.get("page")
                surface["page_confidence"] = page.get("confidence")
                surface["extraction_method"] = page.get("method")
                candidates.append(surface)
    if not candidates:
        surface = _extract_surface_with_evidence(text)
        if surface:
            surface["surface_scope"] = _surface_measurement_scope(text, str(surface["evidence"]))
            candidates.append(surface)
    return candidates


def _document_land_surface_candidates(item: dict[str, object], text: str) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    pages = item.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            page_text = str(page.get("text") or "")
            if not page_text:
                continue
            surface = _extract_land_surface_with_evidence(page_text)
            if surface:
                surface["page_number"] = page.get("page")
                surface["page_confidence"] = page.get("confidence")
                surface["extraction_method"] = page.get("method")
                candidates.append(surface)
    if not candidates:
        surface = _extract_land_surface_with_evidence(text)
        if surface:
            candidates.append(surface)
    return candidates


def _extract_energy_diagnostics_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                page_text = str(page.get("text") or "")
                diagnostic = _extract_energy_diagnostics_with_evidence(page_text)
                if not diagnostic:
                    continue
                diagnostic.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(diagnostic)
        if not candidates:
            diagnostic = _extract_energy_diagnostics_with_evidence(str(item.get("text") or ""))
            if diagnostic:
                diagnostic.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(diagnostic)
    if not candidates:
        return None
    candidates.sort(key=_energy_diagnostic_rank, reverse=True)
    return candidates[0]


def _extract_visit_dates_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                extracted = _extract_visit_dates_with_evidence(str(page.get("text") or ""))
                if not extracted:
                    continue
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
        if not candidates:
            extracted = _extract_visit_dates_with_evidence(str(item.get("text") or ""))
            if extracted:
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
    if not candidates:
        return None
    candidates.sort(key=lambda item: len(item.get("visit_dates") or []), reverse=True)
    return candidates[0]


def _extract_sale_date_from_documents(pdf_texts: list[dict[str, object]] | list[str]) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        document_type = _canonical_document_type(
            item.get("document_type") or item.get("type"),
            label=label,
            url=clean_text(item.get("url")) or "",
        )
        item_candidate_count = len(candidates)
        pages = item.get("pages")
        if isinstance(pages, list):
            for page in pages:
                if not isinstance(page, dict):
                    continue
                extracted = _extract_sale_date_with_evidence(str(page.get("text") or ""))
                if not extracted:
                    continue
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": page.get("page"),
                        "page_confidence": page.get("confidence"),
                        "extraction_method": page.get("method") or item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
        if len(candidates) == item_candidate_count:
            extracted = _extract_sale_date_with_evidence(str(item.get("text") or ""))
            if extracted:
                extracted.update(
                    {
                        "document_label": label,
                        "document_url": clean_text(item.get("url")) or "",
                        "document_type": document_type,
                        "page_number": None,
                        "page_confidence": None,
                        "extraction_method": item.get("extraction_method"),
                    }
                )
                candidates.append(extracted)
    if not candidates:
        return None
    candidates.sort(key=_sale_date_extraction_rank, reverse=True)
    return candidates[0]


def _energy_diagnostic_rank(item: dict[str, object]) -> tuple[int, int]:
    document_type = str(item.get("document_type") or "")
    document_score = {"diagnostics_techniques": 3, "pv_huissier": 2, "pv_notaire": 2, "pdf": 1}.get(document_type, 0)
    field_score = sum(
        1
        for key in ("dpe_class", "ges_class", "energy_consumption_kwh_m2_year", "emissions_kg_co2_m2_year")
        if item.get(key) is not None
    )
    return document_score, field_score


def _surface_document_rank(document_type: str, evidence: str, *, surface_scope: str | None = None) -> int:
    rank = {
        "diagnostics_techniques": 80,
        "pv_huissier": 75,
        "pv_notaire": 70,
        "annonce_vente": 60,
        "cahier_conditions_vente": 55,
        "conditions_vente": 50,
        "pdf": 40,
    }.get(document_type, 30)
    if re.search(r"carrez|surface\s*habitable|superficie\s+privative", evidence, re.I):
        rank += 15
    elif re.search(r"surface\s+de\s+r[ée]f[ée]rence", evidence, re.I):
        rank += 10
    if re.search(r"terrain|parcelle|contenance cadastrale|are|centiare", evidence, re.I):
        rank -= 25
    if surface_scope == "partial":
        rank -= 40
    return rank


def _land_surface_document_rank(document_type: str) -> int:
    return {
        "pv_huissier": 80,
        "pv_notaire": 75,
        "cahier_conditions_vente": 70,
        "conditions_vente": 65,
        "diagnostics_techniques": 60,
        "annonce_vente": 45,
        "pdf": 40,
    }.get(document_type, 30)


def _assign_pdf_surface(sale: AuctionSale, surface: dict[str, object]) -> None:
    value = surface["value"]
    evidence = str(surface.get("evidence") or "")
    lowered = evidence.lower()
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    if _is_land_surface_evidence(evidence):
        _assign_pdf_land_surface(sale, surface)
        return
    if sale.habitable_surface_m2 is None and re.search(r"surface\s*habitable|m(?:2|²)\s+habitables?", lowered, re.I):
        sale.habitable_surface_m2 = decimal_value
    elif sale.carrez_surface_m2 is None and "carrez" in lowered:
        sale.carrez_surface_m2 = decimal_value
    elif sale.surface_m2 is None:
        sale.surface_m2 = decimal_value
    if sale.surface_m2 is None:
        sale.surface_m2 = decimal_value
    surface_scope = clean_text(surface.get("surface_scope"))
    if surface_scope == "partial":
        sale.surface_scope = "partial"
        if "partial_surface_measurement" not in sale.quality_flags:
            sale.quality_flags.append("partial_surface_measurement")
    sale.surface_source = sale.surface_source or "pdf"
    sale.surface_confidence = sale.surface_confidence or (
        Decimal("0.45") if surface_scope == "partial" else Decimal("0.75")
    )
    sale.surface_evidence = sale.surface_evidence or evidence
    sale.raw_payload["surface_extraction"] = {
        "source": "pdf",
        "value_m2": float(decimal_value),
        "document_label": clean_text(surface.get("document_label")),
        "document_url": clean_text(surface.get("document_url")),
        "document_type": clean_text(surface.get("document_type")),
        "page_number": surface.get("page_number"),
        "page_confidence": surface.get("page_confidence"),
        "extraction_method": clean_text(surface.get("extraction_method")),
        "surface_scope": surface_scope,
        "evidence": evidence,
    }


def _assign_pdf_land_surface(sale: AuctionSale, surface: dict[str, object]) -> None:
    value = surface["value"]
    evidence = str(surface.get("evidence") or "")
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    if sale.land_surface_m2 is None:
        sale.land_surface_m2 = decimal_value
    if sale.property_type == "land" and sale.surface_m2 is None:
        sale.surface_m2 = decimal_value
    sale.surface_source = sale.surface_source or "pdf"
    sale.surface_evidence = sale.surface_evidence or evidence
    extraction = {
        "source": "pdf",
        "kind": "land_surface_m2",
        "value_m2": float(decimal_value),
        "document_label": clean_text(surface.get("document_label")),
        "document_url": clean_text(surface.get("document_url")),
        "document_type": clean_text(surface.get("document_type")),
        "page_number": surface.get("page_number"),
        "page_confidence": surface.get("page_confidence"),
        "extraction_method": clean_text(surface.get("extraction_method")),
        "evidence": evidence,
    }
    sale.raw_payload["land_surface_extraction"] = extraction
    if sale.property_type == "land":
        sale.raw_payload["surface_extraction"] = {**extraction, "kind": "surface_m2"}


def _reconcile_pdf_starting_price(sale: AuctionSale, extraction: dict[str, object]) -> None:
    value = extraction.get("value")
    if not isinstance(value, Decimal):
        value = parse_price(value)
    if value is None or value <= 0:
        return

    source_value = sale.starting_price_eur
    if source_value is None:
        sale.starting_price_eur = value
        status = "extracted"
    elif source_value == value:
        status = "corroborated"
    elif _should_replace_starting_price_with_document(source_value, value):
        sale.starting_price_eur = value
        status = "resolved"
        if "starting_price_conflict_resolved" not in sale.quality_flags:
            sale.quality_flags.append("starting_price_conflict_resolved")
    else:
        status = "conflict_unresolved"
        if "starting_price_conflict" not in sale.quality_flags:
            sale.quality_flags.append("starting_price_conflict")

    sale.raw_payload["starting_price_extraction"] = {
        "version": DOCUMENT_FACTS_VERSION,
        "source": "pdf",
        "status": status,
        "value_eur": float(value),
        "rejected_source_price_eur": (
            float(source_value) if status == "resolved" and source_value is not None else None
        ),
        "selected_value_eur": float(sale.starting_price_eur) if sale.starting_price_eur is not None else None,
        "document_label": clean_text(extraction.get("document_label")),
        "document_url": clean_text(extraction.get("document_url")),
        "document_type": clean_text(extraction.get("document_type")),
        "page_number": extraction.get("page_number"),
        "page_confidence": extraction.get("page_confidence"),
        "extraction_method": clean_text(extraction.get("extraction_method")),
        "evidence": clean_text(extraction.get("evidence")),
    }


def _should_replace_starting_price_with_document(current: Decimal, documented: Decimal) -> bool:
    if current <= 0:
        return True
    return current < Decimal("1000") and documented >= Decimal("3000") and documented / current >= Decimal("20")


def _assign_pdf_sale_date(sale: AuctionSale, sale_date: dict[str, object]) -> None:
    parsed = sale_date.get("value")
    if not isinstance(parsed, datetime):
        return
    sale.sale_date = parsed
    sale.raw_payload["pdf_sale_date_extraction"] = {key: value for key, value in sale_date.items() if key != "value"}
    if sale.status in {"", "unknown"}:
        sale.status = normalize_status(None, parsed)


def _write_pdf_text_cache(sale: AuctionSale, pdf_texts: list[dict[str, str]]) -> Path:
    PDF_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = PDF_TEXTS_DIR / f"{_sale_storage_id(sale)}.json"
    payload = [
        {
            "label": item["label"],
            "url": item["url"],
            "type": item["type"],
            "document_type": item["document_type"],
            "file_path": item["file_path"],
            "text": item["text"],
            "pages": item.get("pages", []),
            "cache_version": item.get("cache_version"),
            "sha256": item.get("sha256"),
            "page_count": item.get("page_count"),
            "text_chars": item.get("text_chars"),
            "page_text_chars": item.get("page_text_chars"),
            "ocr_pages": item.get("ocr_pages"),
            "empty_pages": item.get("empty_pages"),
            "extraction_method": item.get("extraction_method"),
            "confidence": item.get("confidence"),
        }
        for item in pdf_texts
    ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _extract_starting_price_with_evidence(text: str) -> dict[str, object] | None:
    if not clean_text(text):
        return None
    value_pattern = r"(?P<price>[0-9][0-9\s.\u00a0]*(?:,[0-9]{1,2})?)"
    patterns = (
        rf"\bmise\s+[àa]\s+prix\s*[:\-]\s*{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\bmise\s+[àa]\s+prix\b.{{0,260}}?"
        rf"(?:ci[\s-]*apr[eè]s\s+indiqu[eé]e?s?|adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot)"
        rf".{{0,140}}?{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\badjudication\b.{{0,180}}?\bsur\s+la\s+mise\s+[àa]\s+prix\b"
        rf".{{0,180}}?{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            context = clean_text(text[max(0, match.start() - 180) : min(len(text), match.end() + 220)]) or ""
            normalized_context = strip_accents(context).lower()
            if re.search(
                r"\b(?:caution|cheque\s+de\s+banque|minimum\s+de)\b|"
                r"\b10\s*%\s+du\s+montant\s+de\s+la\s+mise\s+a\s+prix\b",
                normalized_context,
            ) and not re.search(
                r"\b(?:adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot|ci[\s-]*apres\s+indique)\b",
                normalized_context,
            ):
                continue
            value = parse_price(match.group("price"))
            if value is None or value <= 0:
                continue
            return {"value": value, "evidence": context}
    return None


def _extract_surface(text: str) -> Decimal | None:
    result = _extract_surface_with_evidence(text)
    return result["value"] if result else None


def _extract_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    patterns = (
        rf"(?:surface|superficie)\s+de\s+r[ée]f[ée]rence\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"surface\s+(?:privative\s+)?(?:loi\s+)?carrez(?:\s+totale)?\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:surface\s*(?:habitable|privative|utile|totale|carrez|au\s+sol\s+totale)?|superficie(?:\s+(?:carrez|habitable|privative))?)\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:surface\s+(?:habitable|privative|utile|totale|carrez)?|superficie(?:\s+carrez)?).{{0,80}}?\b(?:soit|est\s+de|de)\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:mesurage\s+(?:loi\s+)?carrez|loi\s+carrez|surface\s+(?:privative\s+)?(?:loi\s+)?carrez|superficie\s+(?:privative\s+)?(?:loi\s+)?carrez)\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"\b(?:d['’]\s*)?environ\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\*)\s+(?:habitables?|de\s+surface|loi\s+carrez)",
        rf"\btotal\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\*)",
        rf"superficie\s*approximative\s*habitable\s*totale\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\?)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if _is_surface_false_positive(text, match.start(), match.end()):
                continue
            value = parse_surface(match.group(1))
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            return {"value": value, "evidence": evidence}
    return None


def _extract_land_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    m2_patterns = (
        rf"\b(?:surface|superficie)\s+(?:du\s+|de\s+la\s+)?(?:terrain|parcelle|jardin|cadastrale)\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\b(?:terrain|parcelles?|jardin)\b.{{0,140}}?\b(?:surface|superficie|contenance)\b.{{0,60}}?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\bcontenance(?:\s+(?:totale|cadastrale))?\b.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b.{{0,80}}\b(?:de\s+terrain|terrain|parcelles?|jardin)\b",
    )
    for pattern in m2_patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if not _has_land_surface_context(text, match.start(), match.end()):
                continue
            if _land_surface_match_is_built(text, match):
                continue
            value = parse_surface(match.group(1))
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            return {"value": value, "evidence": evidence}

    unit_patterns = (
        r"\b(?P<ha>\d{1,5})\s*(?:ha|hectares?)\s*(?:(?P<a>\d{1,5})\s*(?:a|ares?))?\s*(?:(?P<ca>\d{1,2})\s*(?:ca|centiares?))?\b",
        r"\b(?P<a>\d{1,5})\s*(?:a|ares?)\s*(?:(?P<ca>\d{1,2})\s*(?:ca|centiares?))?\b",
    )
    unit_candidates: list[dict[str, Decimal | str | int]] = []
    for pattern in unit_patterns:
        for match in re.finditer(pattern, text, re.I):
            if not _has_land_surface_context(text, match.start(), match.end()):
                continue
            value = _cadastral_units_to_square_meters(match)
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            unit_candidates.append(
                {
                    "value": value,
                    "evidence": evidence,
                    "rank": _land_unit_candidate_rank(text, match.start(), match.end()),
                }
            )
    if unit_candidates:
        unit_candidates.sort(key=lambda item: int(item["rank"]), reverse=True)
        best = unit_candidates[0]
        if len(unit_candidates) == 1 or int(best["rank"]) >= 40:
            return {"value": best["value"], "evidence": best["evidence"]}
    return None


def _land_surface_match_is_built(text: str, match: re.Match[str]) -> bool:
    value_start = match.start(1)
    before_value = text[max(0, value_start - 100) : value_start]
    if not re.search(
        r"\b(?:habitable|carrez|privative|utile|b[âa]tie|surface\s+de\s+r[ée]f[ée]rence)\b",
        before_value,
        re.I,
    ):
        return False
    return not re.search(r"\b(?:terrain|parcelle|jardin|cadastrale)\b", before_value[-70:], re.I)


def _land_unit_candidate_rank(text: str, start: int, end: int) -> int:
    before = _normalize_document_classifier_text(text[max(0, start - 120) : start])
    after = _normalize_document_classifier_text(text[end : min(len(text), end + 100)])
    context = f"{before} {after}"
    rank = 0
    if re.search(r"\b(?:parcelle|terrain|jardin)\b", before[-90:]):
        rank += 60
    if re.search(r"\b(?:parcelle|terrain|jardin)\b", after[:70]):
        rank += 40
    if re.search(r"\b(?:contenance|total|totale)\b", context):
        rank += 45
    if re.search(r"\bjouissance\s+(?:exclusive|privative)\b", before):
        rank += 20
    if re.search(r"\b(?:section|cadastre|cadastree|tableau)\b", context):
        rank -= 15
    return rank


def _extract_energy_diagnostics_with_evidence(text: str) -> dict[str, object] | None:
    if not clean_text(text):
        return None
    if not re.search(r"\b(?:dpe|diagnostic\s+de\s+performance\s+energetique|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique|ges|gaz\s+a\s+effet\s+de\s+serre|gaz\s+à\s+effet\s+de\s+serre|kwh|co2)\b", text, re.I):
        return None
    dpe_match = _first_energy_class_match(
        text,
        (
            r"\b(?:dpe|classe\s+energie|classe\s+energetique|etiquette\s+energie|performance\s+energetique)\s*[:=-]?\s*(?:classe\s*)?([A-G])\b",
            r"\bdiagnostic\s+de\s+performance\s+[ée]nerg[ée]tique.{0,80}?\b(?:classe\s*)?([A-G])\b",
        ),
    )
    ges_match = _first_energy_class_match(
        text,
        (
            r"\b(?:ges|emissions?\s+de\s+gaz\s+a\s+effet\s+de\s+serre|emissions?\s+de\s+gaz\s+à\s+effet\s+de\s+serre|gaz\s+a\s+effet\s+de\s+serre|gaz\s+à\s+effet\s+de\s+serre)\s*[:=-]?\s*(?:classe\s*)?([A-G])\b",
        ),
    )
    consumption_match = re.search(
        r"\b(?:consommation\s+(?:energetique|énergétique)|conso(?:mmation)?\s*(?:5\s+usages)?|energie\s+primaire).{0,80}?([0-9]+(?:[,.][0-9]+)?)\s*kwh(?:ep)?\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
        text,
        re.I | re.S,
    )
    if consumption_match is None:
        consumption_match = re.search(
            r"\b([0-9]+(?:[,.][0-9]+)?)\s*kwh(?:ep)?\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
            text,
            re.I,
        )
    emissions_match = re.search(
        r"\b(?:emissions?\s+(?:de\s+)?(?:gaz\s+a\s+effet\s+de\s+serre|gaz\s+à\s+effet\s+de\s+serre|ges)|ges).{0,100}?([0-9]+(?:[,.][0-9]+)?)\s*kg\s*(?:co2|co₂)\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
        text,
        re.I | re.S,
    )
    if emissions_match is None:
        emissions_match = re.search(
            r"\b([0-9]+(?:[,.][0-9]+)?)\s*kg\s*(?:co2|co₂)\s*/?\s*m(?:2|²)\s*/?\s*(?:an|a|annee|année)?\b",
            text,
            re.I,
        )
    if not any((dpe_match, ges_match, consumption_match, emissions_match)):
        return None
    starts = [match.start() for match in (dpe_match, ges_match, consumption_match, emissions_match) if match]
    ends = [match.end() for match in (dpe_match, ges_match, consumption_match, emissions_match) if match]
    evidence = clean_text(text[max(0, min(starts) - 120) : min(len(text), max(ends) + 180)]) or ""
    return {
        "dpe_class": dpe_match.group(1).upper() if dpe_match else None,
        "ges_class": ges_match.group(1).upper() if ges_match else None,
        "energy_consumption_kwh_m2_year": _decimal_to_int_or_float(_parse_decimal_number(consumption_match.group(1)) if consumption_match else None),
        "emissions_kg_co2_m2_year": _decimal_to_int_or_float(_parse_decimal_number(emissions_match.group(1)) if emissions_match else None),
        "evidence": evidence,
    }


def _first_energy_class_match(text: str, patterns: tuple[str, ...]) -> re.Match[str] | None:
    for pattern in patterns:
        match = re.search(pattern, strip_accents(text), re.I | re.S)
        if match and match.group(1).upper() in {"A", "B", "C", "D", "E", "F", "G"}:
            return match
    return None


def _parse_decimal_number(value: str) -> Decimal | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return Decimal(text.replace(",", "."))
    except Exception:
        return None


def _decimal_to_int_or_float(value: Decimal | None) -> int | float | None:
    if value is None:
        return None
    return int(value) if value == value.to_integral_value() else float(value)


def _extract_sale_date_with_evidence(text: str) -> dict[str, object] | None:
    candidates: list[dict[str, object]] = []
    for chunk in _visit_candidate_chunks(text):
        for phrase in _sale_date_candidate_phrases(chunk):
            parsed = parse_french_datetime(phrase)
            if parsed is None:
                continue
            candidates.append(
                {
                    "value": parsed,
                    "sale_date": parsed.isoformat(),
                    "evidence": clean_text(phrase) or clean_text(chunk) or "",
                }
            )
    if not candidates:
        return None
    candidates.sort(key=_sale_date_extraction_rank, reverse=True)
    return candidates[0]


def _sale_date_candidate_phrases(text: str) -> list[str]:
    value = clean_text(text) or ""
    if not value:
        return []
    normalized = _normalize_document_classifier_text(value)
    if re.search(r"\b(?:visites?|rendez[-\s]?vous)\b", normalized) and not re.search(
        r"\b(?:audience|date\s+d['’ ]audience|date\s+de\s+la\s+vente|vente\s+aux\s+encheres)\b",
        normalized,
    ):
        return []

    patterns = (
        r"\b(?:audience\s+d['’]\s*adjudication|audience\s+des?\s+cri[eé]es?|"
        r"date\s+d['’]\s*audience|date\s+de\s+(?:la\s+)?vente|"
        r"vente\s+aux\s+ench[eè]res(?:\s+publiques?)?|adjudication)\b[^.;\n]{0,180}",
        r"\bvente\s+(?:fix[eé]e?\s*)?(?:au|aura\s+lieu\s+le|le|:)\s*[^.;\n]{0,160}",
        r"\bsera\s+(?:proc[eé]d[eé]\s+)?vendu[^.;\n]{0,160}",
    )
    phrases: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, value, flags=re.I):
            phrase = clean_text(match.group(0)) or ""
            if not phrase or not _has_sale_date_signal(phrase):
                continue
            phrase_normalized = _normalize_document_classifier_text(phrase)
            if re.search(r"\b(?:prix\s+d['’ ]adjudication|frais|mise\s+a\s+prix)\b", phrase_normalized):
                continue
            if phrase not in phrases:
                phrases.append(phrase)
    return phrases


def _has_sale_date_signal(text: str) -> bool:
    normalized = _normalize_document_classifier_text(text)
    month_pattern = (
        r"janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre"
    )
    return bool(
        re.search(rf"\b\d{{1,2}}\s+(?:{month_pattern})\s+\d{{4}}\b", normalized)
        or re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", normalized)
    )


def _sale_date_extraction_rank(item: dict[str, object]) -> tuple[int, int, int]:
    document_type = str(item.get("document_type") or "")
    document_score = {
        "annonce_vente": 90,
        "cahier_conditions_vente": 85,
        "conditions_vente": 80,
        "pv_huissier": 65,
        "pv_notaire": 65,
        "proces_verbal": 60,
        "pdf": 40,
        "diagnostics_techniques": 10,
    }.get(document_type, 30)
    evidence = _normalize_document_classifier_text(item.get("evidence"))
    label_score = 0
    if re.search(r"\b(?:audience\s+d['’ ]adjudication|date\s+de\s+la\s+vente|date\s+d['’ ]audience)\b", evidence):
        label_score += 25
    elif re.search(r"\b(?:vente\s+aux\s+encheres|adjudication)\b", evidence):
        label_score += 15
    if re.search(r"\b(?:visites?|rendez[-\s]?vous|diagnostic|dpe|ges)\b", evidence):
        label_score -= 20
    page_score = 1 if item.get("page_number") is not None else 0
    return document_score, label_score, page_score


def _extract_visit_dates_with_evidence(text: str) -> dict[str, object] | None:
    candidates: list[str] = []
    for chunk in _visit_candidate_chunks(text):
        visit = _normalize_visit_candidate(chunk)
        if visit and visit not in candidates:
            candidates.append(visit)
    if not candidates:
        return None
    first = candidates[0]
    normalized_text = _normalize_document_classifier_text(text)
    index = normalized_text.find(_normalize_document_classifier_text(first))
    start = max(0, index - 120) if index >= 0 else 0
    end = min(len(text), (index if index >= 0 else 0) + len(first) + 160)
    evidence = clean_text(text[start:end]) or first
    return {
        "visit_dates": candidates,
        "evidence": evidence,
    }


def _visit_candidate_chunks(text: str) -> list[str]:
    lines = [clean_text(line) for line in re.split(r"[\n\r]+", text) if clean_text(line)]
    if len(lines) <= 1:
        lines = [clean_text(part) for part in re.split(r"(?<=[.;])\s+", text) if clean_text(part)]
    chunks: list[str] = []
    for line in lines:
        if not line:
            continue
        if len(line) > 500:
            chunks.extend(part for part in (clean_text(item) for item in re.split(r"(?<=[.;])\s+", line)) if part)
        else:
            chunks.append(line)
    return chunks


def _normalize_visit_candidate(text: str) -> str | None:
    value = clean_text(text)
    if not value:
        return None
    normalized = _normalize_document_classifier_text(value)
    if "visite virtuelle" in normalized or "aucune visite virtuelle" in normalized:
        return None
    if not re.search(r"\b(?:visites?|rendez[-\s]?vous)\b", normalized):
        return None
    if not re.search(
        r"\b(?:visite\s+(?:sur\s+place|libre|groupee|obligatoire|prevue)|date\s+des\s+visites?|rendez[-\s]?vous|sur\s+rendez[-\s]?vous|"
        r"(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b)",
        normalized,
    ):
        return None
    value = re.sub(r"^(?:conditions?\s+de\s+)?visites?\s*:\s*", "", value, flags=re.I).strip()
    value = re.sub(r"^date\s+des\s+visites?\s*:\s*", "", value, flags=re.I).strip()
    return value.rstrip(" .;")


def _cadastral_units_to_square_meters(match: re.Match[str]) -> Decimal | None:
    groups = match.groupdict()
    hectares = int(groups.get("ha") or 0)
    ares = int(groups.get("a") or 0)
    centiares = int(groups.get("ca") or 0)
    total = hectares * 10000 + ares * 100 + centiares
    return Decimal(total) if total > 0 else None


def _has_land_surface_context(text: str, start: int, end: int) -> bool:
    context = _normalize_document_classifier_text(text[max(0, start - 180) : min(len(text), end + 180)])
    return bool(
        re.search(
            r"\b(?:terrain|parcelles?|cadastr(?:e|ee|al|ale)|contenance|surface\s+cadastrale|superficie\s+cadastrale|jardin)\b",
            context,
        )
    )


def _is_land_surface_evidence(evidence: str) -> bool:
    text = _normalize_document_classifier_text(evidence)
    if re.search(r"\b(?:habitable|habitables|carrez|loi\s+carrez|surface\s+privative|surface\s+de\s+reference|batie|bati)\b", text):
        return False
    return bool(
        re.search(
            r"\b(?:surface|superficie)\s+(?:du\s+|de\s+la\s+)?(?:terrain|parcelle|jardin|cadastrale)\b|"
            r"\b(?:terrain|parcelles?|jardin)\b.{0,100}\b(?:surface|superficie|contenance)\b|"
            r"\bcontenance(?:\s+(?:totale|cadastrale))?\b.{0,100}\b(?:m\s*(?:2|²)|ha|ares?|centiares?)\b",
            text,
        )
    )


def _is_surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 160) : min(len(text), end + 60)]
    matched = text[start:end]
    if re.search(r"\b(?:habitable|carrez|privative|surface\s+de\s+r[ée]f[ée]rence)\b", matched, re.I):
        return False
    if re.search(r"\b(?:surface|superficie)\s+de\s+r[ée]f[ée]rence\b", context, re.I):
        return False
    if re.search(r"\bkwh\b|kg\s*co2|\bges\b|performance\s+[ée]nerg[ée]tique", context, re.I):
        return True
    prefix = text[max(0, start - 120) : start]
    return bool(
        re.search(
            r"\b(?:mur|paroi|plafond|toiture|fa[çc]ade|isolant|isolation|plancher|baie|fen[eê]tre|porte|garage|cave|parking)\b",
            prefix,
            re.I,
        )
    )


def _surface_measurement_scope(text: str, evidence: str) -> str:
    context = _normalize_document_classifier_text(f"{evidence} {text}")
    if re.search(
        r"\b(?:mesurage|calcul\s+de\s+superficie).{0,80}\b(?:incomplet|partiel|pas\s+pu|n(?:'|’)ont\s+pu)\b|"
        r"\bn(?:'|’)ont\s+pu\s+[eê]tre\s+r[ée]alis[ée]s?\s+dans\s+leur\s+int[ée]gralit[ée]\b|"
        r"\bpi[eè]ces?\s+(?:non\s+)?(?:mesur[ée]es?|accessibles?)\b",
        context,
    ):
        return "partial"
    evidence_text = _normalize_document_classifier_text(evidence)
    if "carrez" in evidence_text and len(re.findall(r"\bencombrement\s+trop\s+important\b", context)) >= 2:
        return "partial"
    return "total"


def _extract_rooms_count(text: str) -> int | None:
    rooms = extract_rooms_count_from_text(text)
    if rooms is not None:
        return rooms
    patterns = (
        r"\bnombre\s+de\s+pi[eè]ces?\s*(?:principales?)?\s*:?\s*([1-9][0-9]?)\b",
        r"\b([1-9][0-9]?)\s*pi[eè]ces?\s*(?:principales?)?\b",
        r"\b(?:type\s+)?[TF]\s*([1-9])\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            if _is_rooms_false_positive(text, match.start(), match.end()):
                continue
            return int(match.group(1))
    if re.search(r"\bstudio\b", text, re.I):
        return 1
    return None


def _is_rooms_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 50) : min(len(text), end + 50)]
    return bool(re.search(r"\barticle\b|\bpage\b|\blot\s+n", context, re.I))


def _extract_occupancy_status(text: str) -> str | None:
    lowered = strip_accents(text).lower()
    no_lease_status = no_lease_occupancy_status(lowered)
    if re.search(r"sans\s+droit\s+ni\s+titre|squatt?\w*", lowered):
        return "squatted"
    if re.search(
        r"\b(?:actuellement\s+)?occupe(?:e?s?|s)?\b|"
        r"\bsuivant\s+un\s+bail\b|"
        r"\bbail\s+(?:meuble|d['’]habitation|en\s+cours)\b|"
        r"\blocataire\b|"
        r"\bloyer\s+mensuel\b",
        lowered,
    ) and not re.search(
        r"\blibre\s+de\s+toute\s+occupation\b|"
        r"\ba\s+quitte\s+les\s+lieux\b|"
        r"\bdepart\s+effectif\b|"
        r"\bconstate(?:e?s?|s)?\s+libre\b",
        lowered,
    ):
        if no_lease_status:
            return no_lease_status
        return "rented" if has_rented_occupancy_signal(lowered) else "occupied"
    if re.search(r"\b(libre|inoccupe(?:e?s?|s)?)\b", lowered):
        return "vacant"
    if no_lease_status:
        return no_lease_status
    if re.search(r"\boccupe(?:e?s?|s)?\b", lowered):
        return "occupied"
    if has_rented_occupancy_signal(lowered):
        return "rented"
    return None


def _extract_property_type(text: str) -> str | None:
    match = re.search(r"\b(appartement|maison|immeuble|terrain|local commercial|commerce|garage|studio)\b", text, re.I)
    if not match:
        return None
    return normalize_property_type(match.group(1))


def _extract_description(text: str) -> str | None:
    match = re.search(r"(?:description|désignation)\s*:?\s*(.{80,1200}?)(?:\n[A-ZÉÈÀÂÎÔÛÇ ]{5,}\s*:|\Z)", text, re.I | re.S)
    if match:
        return clean_text(match.group(1))
    return clean_text(text[:800])


def _extract_risk_notes(text: str) -> str | None:
    notes = []
    checks = {
        "amiante": r"\bamiante\b",
        "plomb": r"\bplomb\b",
        "termites": r"\btermites?\b",
        "risques naturels": r"risques?\s+(?:naturels?|miniers?|technologiques?)|ERP\b",
        "DPE": r"\bDPE\b|diagnostic de performance énergétique",
        "servitude": r"\bservitudes?\b",
    }
    for label, pattern in checks.items():
        if re.search(pattern, text, re.I):
            notes.append(label)
    return ", ".join(notes) if notes else None


def _energy_diagnostic_risk_note(diagnostics: dict[str, object]) -> str | None:
    dpe_class = clean_text(diagnostics.get("dpe_class"))
    if dpe_class in {"F", "G"}:
        return f"DPE {dpe_class}"
    return None


def _merge_pdf_risk_notes(*values: str | None) -> str | None:
    seen: set[str] = set()
    notes: list[str] = []
    for value in values:
        for item in (clean_text(part) for part in str(value or "").split(",")):
            if item and item not in seen:
                seen.add(item)
                notes.append(item)
    return ", ".join(notes) if notes else None


def _document_filename(document: dict[str, str]) -> str:
    url = document.get("url", "")
    label = document.get("label", "")
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in {".pdf", ".doc", ".docx"}:
        suffix = ".pdf"
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", Path(label or "document").stem).strip("-") or "document"
    return f"{digest}-{stem}{suffix}"


def _document_text_cache_path(document: dict[str, str], file_path: Path) -> Path:
    stat = file_path.stat()
    base = "|".join(
        [
            document.get("url", ""),
            str(stat.st_size),
            hashlib.sha256(file_path.read_bytes()).hexdigest(),
        ]
    )
    digest = hashlib.sha256(base.encode("utf-8")).hexdigest()[:24]
    return PDF_DOCUMENT_TEXTS_DIR / f"{digest}.json"


def _read_document_text_cache(document: dict[str, str], file_path: Path) -> dict[str, str] | None:
    try:
        path = _document_text_cache_path(document, file_path)
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not clean_text(payload.get("text")):
        return None
    if payload.get("cache_version") != PDF_TEXT_CACHE_VERSION:
        return None
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        return None
    return payload


def _write_document_text_cache(document: dict[str, str], file_path: Path, payload: dict[str, object]) -> Path:
    PDF_DOCUMENT_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _document_text_cache_path(document, file_path)
    payload["cache_version"] = PDF_TEXT_CACHE_VERSION
    if not isinstance(payload.get("pages"), list) and clean_text(payload.get("text")):
        text = clean_text(payload.get("text")) or ""
        payload["pages"] = [
            {
                "page": 1,
                "text": text,
                "chars": len(text),
                "raw_text_chars": len(text),
                "method": "legacy_text",
                "confidence": _page_text_confidence(text, method="fallback_text"),
            }
        ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def sale_storage_id(sale: AuctionSale) -> str:
    base = sale.external_id or sale.source_url
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]


def _sale_storage_id(sale: AuctionSale) -> str:
    return sale_storage_id(sale)


def _docling_cache_path(file: Path) -> Path:
    try:
        digest = hashlib.sha256(file.read_bytes()).hexdigest()[:16]
    except OSError:
        digest = hashlib.sha256(str(file.resolve()).encode("utf-8")).hexdigest()[:16]
    return DOCLING_TEXTS_DIR / f"{digest}.txt"


def _read_docling_cache(file: Path) -> str | None:
    path = _docling_cache_path(file)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _write_docling_cache(file: Path, text: str) -> Path:
    DOCLING_TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _docling_cache_path(file)
    path.write_text(text, encoding="utf-8")
    return path


def _should_docling_ocr(
    path: Path,
    settings: dict[str, object],
    profile: dict[str, float | int] | None = None,
) -> bool:
    mode = str(settings.get("pdf_docling_ocr_mode") or "auto").lower()
    if mode in {"0", "false", "no", "off", "never"}:
        return False
    if mode in {"1", "true", "yes", "on", "always"}:
        return True

    profile = profile or _profile_pdf_for_docling(path)
    if profile["page_count"] > int(settings["pdf_docling_ocr_max_pages"]):
        LOGGER.info(
            "Skipping Docling OCR for %s: %s pages exceeds limit",
            path,
            profile["page_count"],
        )
        return False
    if profile["size_mb"] > float(settings["pdf_docling_ocr_max_size_mb"]):
        LOGGER.info(
            "Skipping Docling OCR for %s: %.1f MB exceeds limit",
            path,
            profile["size_mb"],
        )
        return False
    return profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])


def _profile_pdf_for_docling(path: Path) -> dict[str, float | int]:
    size_mb = path.stat().st_size / 1024 / 1024
    try:
        with fitz.open(path) as document:
            page_count = document.page_count
            first_pages_text_chars = sum(
                len(document[index].get_text("text") or "") for index in range(min(page_count, 5))
            )
    except Exception:
        return {"size_mb": size_mb, "page_count": 0, "first_pages_text_chars": 0}
    return {
        "size_mb": size_mb,
        "page_count": page_count,
        "first_pages_text_chars": first_pages_text_chars,
    }


def _run_docling_extract_cli(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] != "--docling-extract":
        return 2
    input_path = Path(argv[2])
    output_path = Path(argv[3])
    text = _extract_pdf_text_with_docling_direct(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")
    return 0 if text else 1


if __name__ == "__main__":
    raise SystemExit(_run_docling_extract_cli(sys.argv))
