"""Cache local du texte lu dans une pièce, par contenu de fichier.

La lecture des pièces l'écrit et le relit, la préparation en avance (``document_prefetch``) le consulte, et le
stockage le reconstitue depuis les pages enregistrées en base. Le dossier et le réglage OCR viennent de
l'appelant, comme pour le cache de pages de ``pdf_progress``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from src.normalize import clean_text
from src.pdf_page_analysis import page_requires_retry, page_text_confidence
from src.pdf_progress import PDF_TEXT_CACHE_VERSION


def _document_text_cache_path(document: dict[str, str], file_path: Path, cache_root: Path) -> Path:
    stat = file_path.stat()
    base = "|".join(
        [
            document.get("url", ""),
            str(stat.st_size),
            hashlib.sha256(file_path.read_bytes()).hexdigest(),
        ]
    )
    digest = hashlib.sha256(base.encode("utf-8")).hexdigest()[:24]
    return cache_root / f"{digest}.json"


def read_document_text_cache(
    document: dict[str, str], file_path: Path, *, cache_root: Path, ocr_enabled: bool
) -> dict[str, object] | None:
    try:
        path = _document_text_cache_path(document, file_path, cache_root)
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
    if str(payload.get("extraction_status") or "").strip().lower() in {"incomplete", "failed"}:
        return None
    if any(page_requires_retry(page, ocr_enabled=ocr_enabled) for page in pages):
        return None
    return payload


def write_document_text_cache(
    document: dict[str, str], file_path: Path, payload: dict[str, object], *, cache_root: Path
) -> Path:
    cache_root.mkdir(parents=True, exist_ok=True)
    path = _document_text_cache_path(document, file_path, cache_root)
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
                "confidence": page_text_confidence(text, method="fallback_text"),
                "status": "extracted",
                "retryable": False,
            }
        ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
