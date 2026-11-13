"""Nom des fichiers locaux d'une vente : dossier des pièces téléchargées (``DOCUMENTS_DIR``) et texte lu
(``PDF_TEXTS_DIR``).

Module feuille : la lecture des pièces, le stockage et la fraîcheur nomment les mêmes fichiers.
"""

from __future__ import annotations

import hashlib

from src.models import AuctionSale


def sale_storage_id(sale: AuctionSale) -> str:
    base = sale.external_id or sale.source_url
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]
