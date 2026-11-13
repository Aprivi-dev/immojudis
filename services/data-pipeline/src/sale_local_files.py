"""Nom des fichiers locaux d'une vente : dossier des pièces téléchargées (``DOCUMENTS_DIR``) et texte lu
(``PDF_TEXTS_DIR``).

Module feuille : la lecture des pièces, le stockage et la fraîcheur nomment les mêmes fichiers.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from urllib.parse import urlparse

from src.models import AuctionSale


def sale_storage_id(sale: AuctionSale) -> str:
    base = sale.external_id or sale.source_url
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]


def document_filename(document: dict[str, str]) -> str:
    """Nom d'une pièce téléchargée dans le dossier ``sale_storage_id`` de sa vente."""
    url = document.get("url", "")
    label = document.get("label", "")
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in {".pdf", ".doc", ".docx"}:
        suffix = ".pdf"
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", Path(label or "document").stem).strip("-") or "document"
    return f"{digest}-{stem}{suffix}"
