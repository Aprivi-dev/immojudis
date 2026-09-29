"""Trusted AGRASC operator URL families.

The AGRASC catalogue links to several public operators.  Keep the URL
classification in one small module so source validation and detail fetching
cannot silently drift apart.
"""
from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

from src.sources.common import is_allowed_origin_url

TROCADERO_ORIGIN = "https://lesnotairesdutrocadero.fr"
AGORA_MARKETPLACE_ORIGIN = "https://www.agorastore.fr"
AGORA_IMMO_ORIGINS = ("https://www.agorastore-immo.fr", "https://agorastore-immo.fr")
AGORA_SELLER_PATH = "/ventes-occasions/vendeur/agrascimmo"
AGORA_IMMO_SELLER_PATH = "/ventes-immobilieres/vendeur/agrascimmo"
# Legacy AGRASC links include category segments before the product slug, e.g.
# ``/vente-occasion/immobilier/appartement/appartement-115-m-paris-75-407453.aspx``.
AGORA_PRODUCT_PATH_RE = re.compile(r"/vente-occasion/(?:[^/]+/)*[^/]+-\d+\.aspx$", re.I)

OperatorUrlKind = Literal["immo_interactif", "agorastore_product", "trocadero_offer", "agorastore_seller"]


def classify_agrasc_operator_url(url: str) -> OperatorUrlKind | None:
    """Return the supported operator family for an AGRASC-linked URL.

    The two newly observed hosts are constrained to the exact public paths
    emitted by AGRASC.  This keeps a card from accidentally authorising an
    arbitrary page on a shared marketplace or notarial domain.
    """
    parsed = urlsplit(url)
    path = parsed.path.rstrip("/").lower() or "/"
    if is_allowed_origin_url(url, ("https://www.immo-interactif.fr", "https://immo-interactif.fr")):
        marker = path.rsplit("/", 1)[-1]
        return "immo_interactif" if re.fullmatch(r"\d+", marker) else None
    if is_allowed_origin_url(url, AGORA_IMMO_ORIGINS):
        if path == AGORA_IMMO_SELLER_PATH:
            return "agorastore_seller"
        return "agorastore_product" if re.search(r"-\d+\.aspx$", path) else None
    if is_allowed_origin_url(url, (TROCADERO_ORIGIN,)):
        return "trocadero_offer" if path.startswith("/appel_d_offre/") else None
    if is_allowed_origin_url(url, (AGORA_MARKETPLACE_ORIGIN,)):
        if AGORA_PRODUCT_PATH_RE.fullmatch(path):
            return "agorastore_product"
        return "agorastore_seller" if path == AGORA_SELLER_PATH else None
    return None


def is_allowed_agrasc_source_url(url: str) -> bool:
    """Return whether a URL can be retained as an AGRASC source identity."""
    # Official AGRASC pages are catalogue identities, including legacy paths
    # emitted by older cards.  Operator domains must pass the same path-aware
    # classification used by the fetcher below.
    if is_allowed_origin_url(url, ("https://agrasc.gouv.fr",)):
        return True
    return classify_agrasc_operator_url(url) is not None
