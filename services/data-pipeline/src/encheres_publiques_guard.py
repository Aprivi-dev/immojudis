"""Fail-closed access checks for Encheres Publiques document URLs."""

from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import urlsplit

from src.config import EncheresPubliquesAccessNotAuthorized, require_encheres_publiques_access

ENCHERES_PUBLIQUES_ROOT_DOMAIN = "encheres-publiques.com"

__all__ = [
    "EncheresPubliquesAccessNotAuthorized",
    "is_encheres_publiques_url",
    "require_encheres_publiques_documents_access",
    "require_encheres_publiques_sale_access",
    "require_encheres_publiques_url_access",
]


def is_encheres_publiques_url(value: object) -> bool:
    """Return whether an absolute HTTP URL belongs to the EP domain."""

    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme.lower() not in {"http", "https"}:
        return False
    hostname = (parsed.hostname or "").rstrip(".").lower()
    return hostname == ENCHERES_PUBLIQUES_ROOT_DOMAIN or hostname.endswith(
        f".{ENCHERES_PUBLIQUES_ROOT_DOMAIN}"
    )


def require_encheres_publiques_url_access(
    url: object,
    settings: Mapping[str, object],
) -> None:
    """Require explicit EP authorization when a document target is EP-owned."""

    if is_encheres_publiques_url(url):
        require_encheres_publiques_access(settings)


def require_encheres_publiques_documents_access(
    documents: object,
    settings: Mapping[str, object],
) -> None:
    """Check every document URL before local cache or network work begins."""

    if not isinstance(documents, list):
        return
    for document in documents:
        if isinstance(document, Mapping):
            require_encheres_publiques_url_access(document.get("url"), settings)


def require_encheres_publiques_sale_access(
    *,
    source_name: object,
    source_url: object = None,
    source_urls: object = None,
    documents: object,
    settings: Mapping[str, object],
) -> None:
    """Check a sale source, aliases, and all attached document origins."""

    normalized_source = str(source_name or "").strip().casefold().replace("-", "_").replace(" ", "_")
    if normalized_source == "encheres_publiques":
        require_encheres_publiques_access(settings)
    require_encheres_publiques_url_access(source_url, settings)
    if isinstance(source_urls, str):
        require_encheres_publiques_url_access(source_urls, settings)
    elif isinstance(source_urls, (list, tuple, set, frozenset)):
        for url in source_urls:
            require_encheres_publiques_url_access(url, settings)
    require_encheres_publiques_documents_access(documents, settings)
