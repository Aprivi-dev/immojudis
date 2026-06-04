from __future__ import annotations

import json
from pathlib import Path

import fitz
import pandas as pd

from src.config import DOCUMENTS_DIR, PROCESSED_DIR, load_settings
from src.pdf_enrichment import _docling_cache_path, classify_document_type


def build_pdf_diagnostics(documents_dir: Path = DOCUMENTS_DIR) -> list[dict[str, object]]:
    settings = load_settings()
    rows = []
    for path in sorted(documents_dir.glob("*/*.pdf")):
        profile = _profile_pdf(path)
        row = {
            "sale_id": path.parent.name,
            "file_name": path.name,
            "path": str(path),
            "document_type": classify_document_type(path.name, path.name),
            "size_mb": round(profile["size_mb"], 2),
            "page_count": profile["page_count"],
            "first_pages_text_chars": profile["first_pages_text_chars"],
            "docling_cached": _docling_cache_path(path).exists(),
            "docling_ocr_auto": _would_docling_ocr(profile, settings),
            "diagnostic_reason": _diagnostic_reason(profile, settings),
        }
        rows.append(row)
    return rows


def export_pdf_diagnostics(rows: list[dict[str, object]], output_dir: Path = PROCESSED_DIR) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "pdf_docling_diagnostics.json"
    csv_path = output_dir / "pdf_docling_diagnostics.csv"
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame(rows).to_csv(csv_path, index=False)
    return json_path, csv_path


def _profile_pdf(path: Path) -> dict[str, float | int]:
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


def _would_docling_ocr(profile: dict[str, float | int], settings: dict[str, object]) -> bool:
    if profile["page_count"] > int(settings["pdf_docling_ocr_max_pages"]):
        return False
    if profile["size_mb"] > float(settings["pdf_docling_ocr_max_size_mb"]):
        return False
    return profile["first_pages_text_chars"] < int(settings["pdf_docling_threshold_chars"])


def _diagnostic_reason(profile: dict[str, float | int], settings: dict[str, object]) -> str:
    page_count = int(profile["page_count"])
    size_mb = float(profile["size_mb"])
    text_chars = int(profile["first_pages_text_chars"])
    threshold = int(settings["pdf_docling_threshold_chars"])
    if page_count == 0:
        return "unreadable_pdf"
    if text_chars < threshold and page_count > int(settings["pdf_docling_ocr_max_pages"]):
        return "scanned_pdf_too_many_pages_for_docling_ocr"
    if text_chars < threshold and size_mb > float(settings["pdf_docling_ocr_max_size_mb"]):
        return "scanned_pdf_too_large_for_docling_ocr"
    if text_chars < threshold and page_count > int(settings["pdf_docling_ocr_chunk_pages"]):
        return "scanned_multipage_pdf_requires_chunked_docling_ocr"
    if text_chars < threshold:
        return "scanned_small_pdf_requires_docling_ocr"
    if page_count > int(settings["pdf_docling_chunk_pages"]) or size_mb > float(settings["pdf_docling_ocr_max_size_mb"]):
        return "large_text_pdf_requires_chunked_docling_layout"
    return "text_pdf_docling_low_risk"


def main() -> int:
    rows = build_pdf_diagnostics()
    json_path, csv_path = export_pdf_diagnostics(rows)
    counts = pd.Series([row["diagnostic_reason"] for row in rows]).value_counts().to_dict()
    print("PDF Docling diagnostics")
    print(f"- pdfs: {len(rows)}")
    print(f"- reasons: {counts}")
    print(f"- json: {json_path}")
    print(f"- csv: {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
