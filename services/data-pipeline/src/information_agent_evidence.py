from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
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
PROCESSOR_VERSION = "evidence_v1"
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
        for index, page in enumerate(document, start=1):
            raw_text = page.get_text("text") or ""
            text = raw_text
            method = "pymupdf_text"
            confidence = 0.92
            if ocr_enabled and len(clean_text(raw_text) or "") < 80:
                text, method, confidence = _ocr_pdf_page(page, raw_text)
            cleaned = (clean_text(text) or "")[:MAX_PAGE_TEXT_CHARS]
            pages.append(
                {
                    "page": index,
                    "text": cleaned,
                    "chars": len(cleaned),
                    "method": method,
                    "confidence": confidence if cleaned else 0.0,
                }
            )

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


def _ocr_pdf_page(page: fitz.Page, fallback: str) -> tuple[str, str, float]:
    try:
        text_page = page.get_textpage_ocr(language="fra+eng", full=True)
        text = page.get_text("text", textpage=text_page)
        if clean_text(text):
            return text, "ocr_pymupdf", 0.74
    except Exception:
        pass
    return fallback, "fallback_text", 0.45 if clean_text(fallback) else 0.0


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
    if not extraction_id or not asset_id:
        return
    try:
        asset = _fetch_asset(client, base_url, key, asset_id)
        content = _download_asset(client, base_url, key, asset)
        analysis = analyze_evidence_bytes(
            content,
            filename=str(asset.get("original_filename") or "piece-jointe"),
            declared_mime_type=str(asset.get("mime_type") or ""),
            ocr_enabled=bool(load_settings().get("pdf_ocr_enabled")),
        )
        if analysis.status == "completed" and analysis.facts:
            sale = _fetch_sale(client, base_url, key, str(job.get("sale_id") or ""))
            _insert_fact_candidates(client, base_url, key, job, analysis.facts, sale)
        _finish_job(client, base_url, key, extraction_id, analysis)
        _mark_case_for_review(client, base_url, key, str(job.get("case_id") or ""))
    except Exception as exc:
        _fail_job(client, base_url, key, extraction_id, attempts, str(exc))


def _fetch_asset(client: httpx.Client, base_url: str, key: str, asset_id: str) -> dict[str, Any]:
    response = client.get(
        f"{base_url}/rest/v1/information_agent_evidence_assets",
        headers=_headers(key),
        params={
            "select": "id,storage_bucket,storage_path,original_filename,mime_type,size_bytes,sha256",
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
        params={"on_conflict": "message_id,fact_key,display_value"},
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
        params={"id": f"eq.{extraction_id}", "status": "eq.processing"},
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
) -> None:
    now = datetime.now(UTC)
    response = client.patch(
        f"{base_url}/rest/v1/information_agent_evidence_extractions",
        headers={**_headers(key), "Prefer": "return=minimal"},
        params={"id": f"eq.{extraction_id}"},
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


if __name__ == "__main__":
    batch_limit = max(1, min(10, int(os.getenv("INFORMATION_AGENT_EVIDENCE_BATCH_SIZE", "5"))))
    print(json.dumps({"processed": run_information_agent_evidence_batch(limit=batch_limit)}))
