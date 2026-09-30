from __future__ import annotations

import hashlib
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from src.config import load_settings
from src.freshness import document_fingerprint
from src.models import AuctionSale
from src.normalize import clean_text
from src.pdf_enrichment import (
    DEFAULT_DOCUMENT_GROUPS,
    DOCUMENT_FACTS_VERSION,
    PDF_ANNOUNCE_GROUP,
    PDF_BAIL_GROUP,
    PDF_CONDITIONS_GROUP,
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
    _canonical_document_type,
    _normalize_document_classifier_text,
    _profile_pdf_for_docling,
)

# These hosts are useful when a person is sharing an auction listing, but they
# never contain an official sale attachment. Keeping them out of the PDF
# candidate set prevents a social preview or redirect page from becoming a
# document retry.
SOCIAL_DOCUMENT_HOSTS = frozenset(
    {
        "facebook.com",
        "fb.com",
        "instagram.com",
        "linkedin.com",
        "pinterest.com",
        "snapchat.com",
        "tiktok.com",
        "twitter.com",
        "x.com",
        "youtube.com",
        "youtu.be",
    }
)

DOCUMENT_SUFFIXES = frozenset({".pdf", ".doc", ".docx"})
NON_DOCUMENT_SUFFIXES = frozenset(
    {
        ".avif",
        ".bmp",
        ".css",
        ".gif",
        ".ico",
        ".jpeg",
        ".jpg",
        ".js",
        ".m4a",
        ".mp3",
        ".mp4",
        ".mpeg",
        ".png",
        ".svg",
        ".webm",
        ".webp",
        ".woff",
        ".woff2",
        ".zip",
    }
)
NON_DOCUMENT_PATH_MARKERS = (
    "/avatars/",
    "/favicon",
    "/gallery/",
    "/media/icons/",
    "/pix/",
    "/squelettes/",
    "/themes/",
)
NON_DOCUMENT_LABEL_RE = re.compile(
    r"\b(?:avatar|facebook|favicon|galerie|gallery|image|instagram|linkedin|logo|photo|"
    r"pinterest|snapchat|tiktok|twitter|youtube)\b",
    re.I,
)


def _select_documents_for_extraction(
    documents: list[dict[str, str]],
    *,
    sale: AuctionSale | None = None,
) -> list[dict[str, str]]:
    documents = [
        document
        for document in documents
        if _document_candidate_rejection_reason(document) is None
    ]
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


def _document_candidate_rejection_reason(document: dict[str, str]) -> str | None:
    """Return a deterministic reason for excluding a known non-document URL.

    This is intentionally a conservative, URL-only prefilter. A signed or
    extensionless download endpoint is retained for the network/content
    checks in ``pdf_enrichment``; only evidence that the candidate is a media
    asset, social page, or unsupported file is rejected here.
    """

    raw_url = clean_text(document.get("url"))
    label = clean_text(document.get("label")) or ""
    if not raw_url:
        # Keep legacy in-memory candidates without a URL in the selector. The
        # download layer already ignores them, and this avoids changing the
        # ordering contract for callers that add the URL later.
        return None
    try:
        parsed = urlsplit(raw_url)
        hostname = parsed.hostname
    except ValueError:
        return "invalid_url"
    if parsed.scheme not in {"http", "https"} or not hostname:
        return "invalid_url"

    hostname = hostname.rstrip(".").lower()
    if any(hostname == host or hostname.endswith(f".{host}") for host in SOCIAL_DOCUMENT_HOSTS):
        return "social_url"

    path = unquote(parsed.path or "").lower()
    suffix = Path(path).suffix
    # Official attachments frequently use signed or PHP download URLs. Keep
    # recognized document suffixes even when their path includes an asset-like
    # directory name.
    if suffix in DOCUMENT_SUFFIXES:
        return None
    if suffix in NON_DOCUMENT_SUFFIXES:
        return "non_document_asset"
    if any(marker in path for marker in NON_DOCUMENT_PATH_MARKERS):
        return "non_document_asset"
    if NON_DOCUMENT_LABEL_RE.search(label):
        return "non_document_label"
    return None


def _document_candidate_rejections(documents: list[dict[str, str]]) -> list[dict[str, str]]:
    rejections: list[dict[str, str]] = []
    seen: set[str] = set()
    for document in documents:
        reason = _document_candidate_rejection_reason(document)
        if reason is None:
            continue
        url = clean_text(document.get("url")) or ""
        identity = url or str(document.get("label") or "")
        if identity in seen:
            continue
        seen.add(identity)
        rejections.append({"url": url, "reason": reason})
    return rejections


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
    *,
    blocked_document_urls: list[str] | None = None,
    permanent_document_failures: list[dict[str, str]] | None = None,
) -> None:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    if not isinstance(sale.raw_payload, dict):
        sale.raw_payload = raw_payload
    sale_documents = sale.documents
    malformed_input = (
        not isinstance(sale_documents, list)
        or any(not isinstance(document, dict) or not clean_text(document.get("url")) for document in sale_documents)
        or not isinstance(documents, list)
        or any(not isinstance(document, dict) for document in documents)
        or not isinstance(pdf_texts, list)
        or any(not isinstance(payload, dict) for payload in pdf_texts)
        or (blocked_document_urls is not None and not isinstance(blocked_document_urls, list))
        or (permanent_document_failures is not None and not isinstance(permanent_document_failures, list))
    )
    if malformed_input:
        checked_at = datetime.now(UTC).isoformat()
        try:
            input_fingerprint = document_fingerprint(sale_documents if isinstance(sale_documents, list) else [])
        except (TypeError, ValueError):
            input_fingerprint = ""
        raw_payload["document_analysis"] = {
            "last_successful_check_at": raw_payload.get("document_analysis", {}).get("last_successful_check_at")
            if isinstance(raw_payload.get("document_analysis"), dict)
            else None,
            "checked_at": checked_at,
            "input_fingerprint": input_fingerprint,
            "failed_documents": 1,
            "failed_document_urls": [],
            "blocked_documents": 0,
            "blocked_document_urls": [],
            "permanent_document_failures": [],
            "skipped_documents": 0,
            "skipped_document_urls": [],
            "coverage_status": "documents_not_extracted",
            "warning": "Le manifeste ou le cache PDF est malformé ; aucune preuve documentaire n'est certifiée.",
            "documents_listed": len(sale_documents) if isinstance(sale_documents, list) else 0,
            "documents_downloaded": len(documents) if isinstance(documents, list) else 0,
            "documents_extracted": 0,
            "profiles": [],
            "cache_proof": {
                "version": 1,
                "verified_at": checked_at,
                "input_fingerprint": input_fingerprint,
                "documents": [],
            },
        }
        return

    if not isinstance(raw_payload.get("document_analysis"), dict):
        raw_payload["document_analysis"] = {}
    typed_documents = [_document_profile(document) for document in documents]
    extracted_profiles = [_extracted_document_profile(payload) for payload in pdf_texts]
    text_profiles = [profile for profile in extracted_profiles if profile["extraction_status"] == "extracted"]
    visual_blank_documents = sum(bool(profile["visual_blank_pages"]) for profile in text_profiles)
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
        group for group, aliases in required_groups.items() if not (aliases & extracted_types)
    ]

    candidate_rejections = _document_candidate_rejections(sale_documents)
    selected_documents = _select_documents_for_extraction(sale_documents, sale=sale)
    selected_urls = {
        str(document.get("url"))
        for document in selected_documents
        if document.get("url")
    }
    blocked_urls = list(dict.fromkeys(
        str(url)
        for url in (blocked_document_urls or [])
        if str(url) in selected_urls
    ))
    blocked_url_set = set(blocked_urls)
    permanent_failures = [
        {
            "url": str(item.get("url")),
            "reason": str(item.get("reason") or "permanent_document_failure"),
        }
        for item in (permanent_document_failures or [])
        if isinstance(item, dict)
        and item.get("url")
        and str(item.get("url")) in selected_urls
    ]
    permanent_failures = list({item["url"]: item for item in permanent_failures}.values())
    permanent_url_set = {item["url"] for item in permanent_failures}
    empty_document_urls = list(dict.fromkeys(
        str(profile.get("url"))
        for payload, profile in zip(pdf_texts, extracted_profiles, strict=False)
        if isinstance(payload, dict)
        and profile.get("url")
        and str(profile.get("url")) in selected_urls
        and profile.get("extraction_status") == "empty"
        and payload.get("complete") is True
        and not payload.get("failed_pages")
    ))
    terminal_document_urls = list(dict.fromkeys(
        [*empty_document_urls, *(item["url"] for item in permanent_failures)]
    ))

    if blocked_urls:
        coverage_status = "partial"
        warning = (
            "Certaines pièces sont bloquées par la politique robots.txt et restent indisponibles pour l'analyse."
        )
    elif permanent_failures:
        coverage_status = "partial"
        warning = (
            "Certaines URL de pièces sont durablement indisponibles ou ne renvoient pas un document exploitable."
        )
    elif not documents and not sale_documents:
        coverage_status = "source_only"
        warning = "Aucun PDF officiel exploitable n'a été trouvé : l'analyse reste un pré-tri."
    elif empty_document_urls and not text_profiles:
        coverage_status = "partial"
        warning = (
            "Certaines pièces PDF sont vides après une extraction complète ; elles restent indisponibles "
            "pour l'analyse et ne seront pas certifiées comme des faits documentaires."
        )
    elif not text_profiles:
        coverage_status = "documents_not_extracted"
        warning = "Des documents sont listés, mais aucun texte PDF n'a encore été extrait."
        if candidate_rejections:
            warning += " Certaines URL sociales ou de médias ont été écartées automatiquement."
    elif missing_core_documents:
        coverage_status = "partial"
        warning = "Certaines pièces clés manquent ou n'ont pas été extraites."
    else:
        coverage_status = "rich"
        warning = "Les principales familles de documents sont disponibles pour l'analyse."
    if empty_document_urls and text_profiles:
        if coverage_status == "rich":
            coverage_status = "partial"
        warning += (
            " Certaines pièces PDF sont vides après une extraction complète ; "
            "elles restent indisponibles pour l'analyse."
        )
    if visual_blank_documents:
        if coverage_status == "rich":
            coverage_status = "partial"
        warning += (
            " Certaines pages presque vides ont été écartées après échec OCR ; "
            "leurs originaux restent disponibles pour vérification."
        )

    extracted_urls = {str(profile.get("url") or "") for profile in text_profiles}
    failed_document_urls = list(dict.fromkeys(
        str(document.get("url")) for document in selected_documents
        if document.get("url")
        and str(document["url"]) not in extracted_urls
        and str(document["url"]) not in blocked_url_set
        and str(document["url"]) not in permanent_url_set
        and str(document["url"]) not in set(empty_document_urls)
    ))
    failed_documents = len(failed_document_urls)
    checked_at = datetime.now(UTC).isoformat()
    cache_proof_documents = []
    for payload, profile in zip(pdf_texts, extracted_profiles, strict=False):
        if not isinstance(payload, dict):
            continue
        text = clean_text(payload.get("text")) or ""
        cache_proof_documents.append(
            {
                "url": profile.get("url"),
                "sha256": str(payload.get("sha256") or ""),
                "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest() if text else "",
                "text_chars": len(text),
                "text_present": bool(text),
                "extraction_status": profile.get("extraction_status"),
                "complete": payload.get("complete") is True,
                "failed_pages": payload.get("failed_pages") or [],
            }
        )
    previous = sale.raw_payload.get("document_analysis") or {}
    last_successful_check_at = checked_at if not failed_documents else previous.get("last_successful_check_at")
    sale.raw_payload["document_analysis"] = {
        "last_successful_check_at": last_successful_check_at,
        "checked_at": checked_at,
        "input_fingerprint": document_fingerprint(sale_documents),
        "failed_documents": failed_documents,
        "failed_document_urls": failed_document_urls,
        "empty_document_urls": empty_document_urls,
        "terminal_document_urls": terminal_document_urls,
        "blocked_documents": len(blocked_urls),
        "blocked_document_urls": blocked_urls,
        "blocked_document_reasons": [
            {
                "url": url,
                "reason": "robots.txt disallows fetching this Licitor document",
            }
            for url in blocked_urls
        ],
        "permanent_document_failures": permanent_failures,
        "skipped_documents": len(candidate_rejections),
        "skipped_document_urls": [item["url"] for item in candidate_rejections if item["url"]],
        "skipped_document_reasons": candidate_rejections,
        "coverage_status": coverage_status,
        "warning": warning,
        "documents_listed": len(sale_documents or []),
        "documents_downloaded": len(documents),
        "documents_extracted": len(text_profiles),
        "visual_blank_documents": visual_blank_documents,
        "document_types": dict(type_counts),
        "extracted_document_types": dict(extracted_type_counts),
        "missing_core_documents": missing_core_documents,
        # This is deliberately derived from the current PDF payloads, never
        # copied from an older ``profiles`` manifest.  The text itself stays
        # in the local cache; the persisted marker records enough provenance
        # for freshness gates to prove that text and bytes were both present.
        "cache_proof": {
            "version": 1,
            "verified_at": checked_at,
            "input_fingerprint": document_fingerprint(sale_documents),
            "documents": cache_proof_documents,
        },
        "official_documents_found": bool(
            {
                "pv_huissier",
                "pv_notaire",
                "proces_verbal",
                "cahier_conditions_vente",
                "conditions_vente",
                "diagnostics_techniques",
            }
            & (available_types | extracted_types)
        ),
        "profiles": extracted_profiles or typed_documents,
    }


def _document_profile(document: dict[str, str]) -> dict[str, object]:
    label = str(document.get("label") or "")
    url = str(document.get("url") or "")
    document_type = _canonical_document_type(
        document.get("document_type") or document.get("type"), label=label, url=url
    )
    return {
        "label": label or None,
        "url": url or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": "pending",
    }


def _extracted_document_profile(payload: dict[str, object]) -> dict[str, object]:
    if not isinstance(payload, dict):
        return {
            "label": None,
            "url": None,
            "document_type": "other",
            "family": "autre",
            "extraction_status": "failed",
            "sha256": None,
            "text_chars": 0,
            "page_count": 0,
            "ocr_pages": 0,
            "confidence": 0.0,
            "method": None,
            "complete": False,
            "failed_pages": [],
            "blank_pages": [],
            "visual_blank_pages": [],
        }
    document_type = _canonical_document_type(
        payload.get("document_type") or payload.get("type"),
        label=payload.get("label"),
        url=payload.get("url"),
    )
    extraction_status = str(payload.get("extraction_status") or "").strip().lower()
    if payload.get("complete") is False or payload.get("failed_pages"):
        extraction_status = "incomplete"
    if extraction_status not in {"extracted", "incomplete", "failed", "empty"}:
        extraction_status = "extracted" if clean_text(payload.get("text")) else "empty"
    if extraction_status == "extracted" and not clean_text(payload.get("text")):
        extraction_status = "empty"
    try:
        text_chars = int(payload.get("text_chars") or len(str(payload.get("text") or "")))
    except (OverflowError, TypeError, ValueError):
        text_chars = 0
    try:
        page_count = int(payload.get("page_count") or 0)
    except (OverflowError, TypeError, ValueError):
        page_count = 0
    try:
        ocr_pages = int(payload.get("ocr_pages") or 0)
    except (OverflowError, TypeError, ValueError):
        ocr_pages = 0
    try:
        confidence = float(payload.get("confidence") or 0)
    except (OverflowError, TypeError, ValueError):
        confidence = 0.0
    return {
        "label": payload.get("label") or None,
        "url": payload.get("url") or None,
        "document_type": document_type,
        "family": _document_family(document_type),
        "extraction_status": extraction_status,
        "sha256": payload.get("sha256"),
        "text_chars": text_chars,
        "page_count": page_count,
        "ocr_pages": ocr_pages,
        "confidence": confidence,
        "method": payload.get("extraction_method") or None,
        # Missing completion metadata is not proof of a complete document;
        # old profiles remain useful for diagnostics but cannot satisfy a
        # current PDF/fact gate.
        "complete": payload.get("complete") is True and extraction_status == "extracted",
        "failed_pages": payload.get("failed_pages") or [],
        "blank_pages": payload.get("blank_pages") or [],
        "visual_blank_pages": payload.get("visual_blank_pages") or [],
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
