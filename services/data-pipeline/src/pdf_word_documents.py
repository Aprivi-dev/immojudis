"""Text extraction for attached Word documents (.doc through antiword/textutil, .docx through its XML)."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import zipfile
from collections.abc import Mapping
from pathlib import Path
from xml.etree import ElementTree

from src.config import load_settings
from src.normalize import clean_text
from src.pdf_page_analysis import page_text_confidence
from src.pdf_progress import PDF_TEXT_CACHE_VERSION

# Environnement des outils qui ouvrent une pièce reçue d'un tiers (antiword, textutil, Docling) : une liste blanche,
# sur le modèle de ``photo_mirror.image_decoder_environment``. Docling relit ses réglages (PDF_*, DOCLING_*) et ses
# caches de modèles ; aucune clé, aucun jeton ni aucune adresse de base n'y entre.
DOCUMENT_TOOL_ENVIRONMENT = (
    "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "HOME", "TMPDIR", "TESSDATA_PREFIX", "ANTIWORDHOME",
    "OMP_THREAD_LIMIT", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "PYTHONFAULTHANDLER",
    "HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "TRANSFORMERS_CACHE", "XDG_CACHE_HOME",
)
DOCUMENT_TOOL_ENVIRONMENT_PREFIXES = ("PDF_", "DOCLING_")
# Refusé même s'il entre par un préfixe permis.
_SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|_DB_URL)$|^SUPABASE_|_KEY_|_TOKEN_", re.I)


def document_tool_environment(parent: Mapping[str, str] | None = None) -> dict[str, str]:
    """L'environnement d'un outil qui ouvre une pièce : la liste blanche ci-dessus, aucun secret par construction."""
    source = os.environ if parent is None else parent
    return {
        name: value
        for name, value in source.items()
        if (name in DOCUMENT_TOOL_ENVIRONMENT or name.startswith(DOCUMENT_TOOL_ENVIRONMENT_PREFIXES))
        and not _SECRET_NAME.search(name)
    }


def extract_legacy_word_document(path: Path) -> dict[str, object]:
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
            env=document_tool_environment(),
        )
        text = clean_text(result.stdout) or ""
        if result.returncode == 0 and text:
            return single_page_document_payload(path, text, extraction_method=method)
        last_error = clean_text(result.stderr) or f"exit code {result.returncode}"
    raise RuntimeError(f"legacy Word extraction failed: {last_error}")


def extract_docx_document(path: Path) -> dict[str, object]:
    max_chars = int(load_settings()["document_max_extracted_text_chars"])
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > max_chars * 4:
            raise ValueError("DOCX XML exceeds the extraction limit")
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    text = clean_text(" ".join(node.text or "" for node in root.iter() if node.tag.endswith("}t"))) or ""
    if not text:
        raise ValueError("DOCX document contains no extractable text")
    if len(text) > max_chars:
        raise ValueError("DOCX text exceeds the extraction limit")
    return single_page_document_payload(path, text, extraction_method="docx_xml")


def single_page_document_payload(
    path: Path,
    text: str,
    *,
    extraction_method: str,
) -> dict[str, object]:
    confidence = page_text_confidence(text, method="pymupdf_text")
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
