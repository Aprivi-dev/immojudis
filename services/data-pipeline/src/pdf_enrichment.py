from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

import fitz
import httpx

from src.config import DOCLING_TEXTS_DIR, DOCUMENTS_DIR, PDF_DOCUMENT_TEXTS_DIR, PDF_TEXTS_DIR, load_settings
from src.models import AuctionSale
from src.normalize import (
    clean_text,
    extract_bedrooms_count_from_text,
    extract_rooms_count_from_text,
    normalize_property_type,
)

LOGGER = logging.getLogger(__name__)
PDF_TEXT_CACHE_VERSION = "pdf_text_v2_page_level"


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

    for document in _select_documents_for_extraction(downloaded_documents):
        file_path = Path(document["file_path"])
        try:
            cached_payload = _read_document_text_cache(document, file_path) if load_settings()["incremental_enrichment"] else None
            if cached_payload:
                stats.document_cache_hits += 1
                pdf_texts.append(cached_payload)
                continue
            stats.document_cache_misses += 1
            payload = extract_pdf_document(file_path, document=document)
        except Exception as exc:
            LOGGER.warning("PDF text extraction failed for %s: %s", file_path, exc)
            stats.errors += 1
            continue
        payload.update(
            {
                "label": document.get("label", ""),
                "url": document.get("url", ""),
                "type": document.get("type", "pdf"),
                "document_type": document.get("document_type", "other"),
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
    headers = {"User-Agent": str(settings["user_agent"])}
    downloaded: list[dict[str, str]] = []
    for document in sale.documents:
        url = document.get("url")
        if not url or classify_document_type(document.get("label", ""), url) == "other":
            continue
        if _is_robots_disallowed_licitor_document(url):
            LOGGER.info("Skipping robots-disallowed Licitor document %s", url)
            continue

        filename = _document_filename(document)
        file_path = sale_dir / filename
        if not file_path.exists():
            try:
                response = httpx.get(
                    url,
                    headers=headers,
                    timeout=float(settings["request_timeout_seconds"]),
                    verify=_verify_tls(url),
                )
                response.raise_for_status()
                file_path.write_bytes(response.content)
                if stats:
                    stats.downloaded += 1
            except Exception as exc:
                LOGGER.warning("PDF download failed for %s: %s", url, exc)
                if stats:
                    stats.errors += 1
                continue

        enriched_document = dict(document)
        enriched_document["type"] = "pdf"
        enriched_document["document_type"] = classify_document_type(document.get("label", ""), url)
        enriched_document["file_path"] = str(file_path)
        downloaded.append(enriched_document)
    return downloaded


def _is_robots_disallowed_licitor_document(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"www.licitor.com", "licitor.com"}:
        return False
    path = parsed.path
    return path.startswith("/data/pub/doc/") or path.startswith("/data/pub/media/")


def _verify_tls(url: str) -> bool:
    # ponytail: public Cessions Etat PDFs currently ship an incomplete cert chain to Python/httpx.
    return urlparse(url).netloc.lower() != "cessions.immobilier-etat.gouv.fr"


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
    text = f"{label or ''} {url or ''}".lower()
    if any(pattern in text for pattern in ("diagnostic", "dpe", "erp", "amiante", "plomb", "termites", "crep")):
        return "diagnostics_techniques"
    if any(pattern in text for pattern in ("cahier des conditions", "cahier_des_conditions", "ccv")):
        return "cahier_conditions_vente"
    if "conditions de vente" in text or "conditions_de_vente" in text:
        return "conditions_vente"
    if any(pattern in text for pattern in ("pv notaire", "notaire", "notarié", "notarie")):
        return "pv_notaire"
    if any(
        pattern in text
        for pattern in (
            "pv descriptif",
            "pvd",
            "descriptif",
            "proces-verbal de constat",
            "procès-verbal de constat",
            "commissaire de justice",
            "huissier",
        )
    ):
        return "pv_huissier"
    if "proces-verbal" in text or "procès-verbal" in text:
        return "proces_verbal"
    if any(pattern in text for pattern in ("avis", "simplifie", "simplifié", "affiche", "insertion", "annonce")):
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


def _select_documents_for_extraction(documents: list[dict[str, str]]) -> list[dict[str, str]]:
    settings = load_settings()
    max_documents = max(1, int(settings["pdf_max_documents_per_sale"]))
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
    groups = (
        {"pv_huissier", "pv_notaire", "proces_verbal"},
        {"diagnostics_techniques"},
        {"cahier_conditions_vente", "conditions_vente"},
        {"annonce_vente"},
        {"bail"},
        {"cadastre"},
    )
    sorted_documents = sorted(
        documents,
        key=lambda item: (
            priority.get(str(item.get("document_type") or "other"), 9),
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
                if str(item.get("document_type") or "other") in group and _document_identity(item) not in selected_urls
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


def _document_identity(document: dict[str, str]) -> str:
    return str(document.get("url") or document.get("file_path") or document.get("label") or id(document))


def _store_document_analysis_status(
    sale: AuctionSale,
    documents: list[dict[str, str]],
    pdf_texts: list[dict[str, object]],
) -> None:
    typed_documents = [_document_profile(document) for document in documents]
    extracted_profiles = [_extracted_document_profile(payload) for payload in pdf_texts]
    type_counts = Counter(profile["document_type"] for profile in typed_documents)
    extracted_type_counts = Counter(profile["document_type"] for profile in extracted_profiles)

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
    elif not pdf_texts:
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
        "documents_extracted": len(pdf_texts),
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
    document_type = str(document.get("document_type") or classify_document_type(label, url))
    return {
        "label": label or None,
        "url": url or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": "pending",
    }


def _extracted_document_profile(payload: dict[str, object]) -> dict[str, object]:
    document_type = str(payload.get("document_type") or classify_document_type(str(payload.get("label") or ""), str(payload.get("url") or "")))
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
    document_type = str(document.get("document_type") if document else "")
    if re.search(r"sign|sign[ée]e?|anonymis|saisie-immobiliere|saisie\s+immobili[eè]re", text, re.I):
        return min(default_timeout, fast_timeout)
    profile = _profile_pdf_for_docling(path)
    if document_type in {"cahier_conditions", "cahier_conditions_vente", "conditions_vente"} and (
        profile["page_count"] >= 15 or profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])
    ):
        return min(default_timeout, fast_timeout)
    return default_timeout


def enrich_sale_from_pdf_text(sale: AuctionSale, pdf_texts: list[dict[str, str]] | list[str]) -> AuctionSale:
    texts = [item["text"] if isinstance(item, dict) else item for item in pdf_texts]
    combined = "\n\n".join(text for text in texts if text)
    if not combined:
        return sale

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
    if not sale.property_type or sale.property_type == "other":
        sale.property_type = _extract_property_type(combined) or sale.property_type
    if not sale.description:
        sale.description = _extract_description(combined)

    risk_notes = _extract_risk_notes(combined)
    if risk_notes:
        sale.risk_notes = clean_text(" | ".join(filter(None, [sale.risk_notes, risk_notes])))

    enriched_marker = "\n\n--- PDF TEXT ENRICHMENT ---\n"
    current_raw = sale.raw_text or ""
    if enriched_marker.strip() in current_raw:
        current_raw = current_raw.split(enriched_marker.strip(), 1)[0]
    sale.raw_text = clean_text(f"{current_raw}{enriched_marker}{combined[:15000]}")
    return sale


def _extract_surface_from_documents(pdf_texts: list[dict[str, str]] | list[str]) -> dict[str, Decimal | str] | None:
    document_surfaces: list[dict[str, Decimal | str | int]] = []
    for item in pdf_texts:
        if not isinstance(item, dict):
            continue
        label = clean_text(item.get("label")) or ""
        text = item.get("text") or ""
        document_type = str(item.get("document_type") or "pdf")
        if not re.search(r"diagnostic|certificat|superficie|surface", f"{label} {text[:800]}", re.I):
            continue
        surface = _extract_surface_with_evidence(text)
        if surface:
            document_surfaces.append(
                {
                    "value": surface["value"],
                    "evidence": str(surface["evidence"]),
                    "label": label,
                    "document_type": document_type,
                    "rank": _surface_document_rank(document_type, str(surface["evidence"])),
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
    }


def _surface_document_rank(document_type: str, evidence: str) -> int:
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
    if re.search(r"terrain|parcelle|contenance cadastrale|are|centiare", evidence, re.I):
        rank -= 25
    return rank


def _assign_pdf_surface(sale: AuctionSale, surface: dict[str, Decimal | str]) -> None:
    value = surface["value"]
    evidence = str(surface.get("evidence") or "")
    lowered = evidence.lower()
    if sale.habitable_surface_m2 is None and re.search(r"surface\s*habitable|m(?:2|²)\s+habitables?", lowered, re.I):
        sale.habitable_surface_m2 = value if isinstance(value, Decimal) else Decimal(str(value))
    elif sale.carrez_surface_m2 is None and "carrez" in lowered:
        sale.carrez_surface_m2 = value if isinstance(value, Decimal) else Decimal(str(value))
    elif sale.surface_m2 is None:
        sale.surface_m2 = value if isinstance(value, Decimal) else Decimal(str(value))
    if sale.surface_m2 is None:
        sale.surface_m2 = value if isinstance(value, Decimal) else Decimal(str(value))
    sale.surface_source = sale.surface_source or "pdf"
    sale.surface_confidence = sale.surface_confidence or Decimal("0.75")
    sale.surface_evidence = sale.surface_evidence or evidence


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


def _extract_surface(text: str) -> Decimal | None:
    result = _extract_surface_with_evidence(text)
    return result["value"] if result else None


def _extract_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    patterns = (
        r"(?:surface\s*(?:habitable|privative|utile|totale|carrez)?|superficie(?:\s+carrez)?)\s*:?\s*(?:de\s+)?(?:environ\s+)?([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²)",
        r"(?:surface\s+(?:habitable|privative|utile|totale|carrez)?|superficie(?:\s+carrez)?).{0,80}?\b(?:soit|est\s+de|de)\s+([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²)",
        r"\b(?:d['’]\s*)?environ\s+([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²)\b",
        r"([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²|\*)\s+(?:habitables?|de\s+surface|loi\s+carrez)",
        r"\btotal\s*:?\s*([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²|\*)",
        r"superficie\s*approximative\s*habitable\s*totale\s*:?\s*([0-9]+(?:[,.][0-9]+)?)\s*m(?:2|²|\?)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if _is_surface_false_positive(text, match.start(), match.end()):
                continue
            try:
                value = Decimal(match.group(1).replace(",", "."))
                evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
                return {"value": value, "evidence": evidence}
            except InvalidOperation:
                continue
    return None


def _is_surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 20) : min(len(text), end + 30)]
    return bool(re.search(r"\bkwh\b|kg\s*co2|\bges\b|dpe\b|performance\s+[ée]nerg[ée]tique", context, re.I))


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
    lowered = text.lower()
    if re.search(
        r"\b(?:actuellement\s+)?occup[ée]\b|"
        r"\bsuivant\s+un\s+bail\b|"
        r"\bbail\s+(?:meubl[ée]|d['’]habitation|en\s+cours)\b|"
        r"\blocataire\b|"
        r"\bloyer\s+mensuel\b",
        lowered,
    ) and not re.search(
        r"\blibre\s+de\s+toute\s+occupation\b|"
        r"\ba\s+quitt[ée]\s+les\s+lieux\b|"
        r"\bd[ée]part\s+effectif\b|"
        r"\bconstat[ée]?\s+libre\b",
        lowered,
    ):
        return "rented" if re.search(r"\bbail\b|\blocataire\b|\bloyer\b", lowered) else "occupied"
    if re.search(r"\b(libre|inoccup[ée]?)\b", lowered):
        return "vacant"
    if re.search(r"\boccup[ée]?\b", lowered):
        return "occupied"
    if re.search(r"\blou[ée]?\b|\blocataire\b|bail\b", lowered):
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


def _document_filename(document: dict[str, str]) -> str:
    url = document.get("url", "")
    label = document.get("label", "")
    suffix = Path(urlparse(url).path).suffix or ".pdf"
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
