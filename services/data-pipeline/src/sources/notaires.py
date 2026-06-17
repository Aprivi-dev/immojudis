from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlencode

from src.config import AQUITAINE_DEPARTMENTS, load_settings
from src.normalize import clean_text
from src.raw_models import validate_raw_sales
from src.sources.common import PoliteHttpClient, ScrapeResult, unique_dicts


BASE_URL = "https://www.immobilier.notaires.fr"
API_URL = f"{BASE_URL}/pub-services/inotr-www-annonces/v1/annonces"
TRANSACTION_TYPES = ("VAE", "VNI")
LOGGER = logging.getLogger(__name__)


def scrape_notaires_aquitaine(max_pages: int | None = None) -> list[dict[str, Any]]:
    return scrape_notaires_aquitaine_result(max_pages=max_pages).sales


def scrape_notaires_aquitaine_result(max_pages: int | None = None) -> ScrapeResult:
    settings = load_settings()
    client = PoliteHttpClient(
        base_url=BASE_URL,
        user_agent=str(settings["user_agent"]),
        delay_seconds=float(settings["request_delay_seconds"]),
        timeout_seconds=float(settings["request_timeout_seconds"]),
    )
    max_pages = max_pages or int(settings["notaires_max_pages"])

    errors: list[str] = []
    raw_sales: list[dict[str, Any]] = []
    for transaction_type in TRANSACTION_TYPES:
        for page in range(1, max_pages + 1):
            url = _api_url(page, transaction_type)
            try:
                payload = client.get(url)
            except Exception as exc:
                LOGGER.error("Notaires API fetch failed for %s: %s", url, exc)
                errors.append(f"{url}: {exc}")
                continue
            for sale in parse_notaires_json(payload):
                if sale.get("department") in AQUITAINE_DEPARTMENTS:
                    raw_sales.append(sale)

    return ScrapeResult(validate_raw_sales("notaires", unique_dicts(raw_sales, "source_url"), errors), errors)


def parse_notaires_json(payload: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []
    rows = data.get("annonceResumeDto") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []

    sales: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict) or item.get("typeTransaction") not in TRANSACTION_TYPES:
            continue
        source_url = clean_text(item.get("urlDetailAnnonceFr")) or _fallback_source_url(item)
        raw_text = "\n".join(
            filter(
                None,
                (
                    clean_text(item.get("reference")),
                    clean_text(item.get("descriptionFr")),
                    clean_text(item.get("communeNom")),
                    clean_text(item.get("departementNom")),
                    clean_text(item.get("typeTransaction")),
                ),
            )
        )
        sales.append(
            {
                "source_name": "notaires",
                "source_url": source_url,
                "external_id": str(item.get("annonceId") or item.get("id") or source_url),
                "department": clean_text(item.get("inseeDepartement")),
                "city": clean_text(item.get("communeNom") or item.get("localiteNom")),
                "postal_code": clean_text(item.get("codePostal")),
                "property_type": clean_text(item.get("typeBien")),
                "title": _title(item),
                "description": clean_text(item.get("descriptionFr")),
                "surface_m2": item.get("surface"),
                "land_surface_m2": item.get("surfaceTerrain"),
                "rooms_count": item.get("nbPieces"),
                "bedrooms_count": item.get("nbChambres"),
                "starting_price_eur": item.get("prixAffiche") or item.get("premiereOffrePossible"),
                "sale_date": item.get("seanceDate") or item.get("dateDebutEncheres") or item.get("dateFinEncheres"),
                "lawyer_contact": clean_text(item.get("telephone")),
                "status": "past" if item.get("bienVendu") == "OUI" else "upcoming",
                "documents": [],
                "raw_text": raw_text,
                "raw_image_url": clean_text(item.get("urlPhotoPrincipale")),
                "source_blocks": {
                    "type_transaction": clean_text(item.get("typeTransaction")),
                    "reference": clean_text(item.get("reference")),
                },
            }
        )
    return sales


def _api_url(page: int, transaction_type: str) -> str:
    params = {"page": page, "parPage": 24, "typeTransactions": transaction_type}
    if transaction_type == "VAE":
        params["isProchainesVae"] = "true"
    return f"{API_URL}?{urlencode(params)}"


def _title(item: dict[str, Any]) -> str | None:
    description = clean_text(item.get("descriptionFr"))
    if description:
        return description.split("\n", 1)[0][:180]
    parts = [clean_text(item.get("typeBien")), clean_text(item.get("communeNom") or item.get("localiteNom"))]
    return " - ".join(part for part in parts if part) or clean_text(item.get("reference"))


def _fallback_source_url(item: dict[str, Any]) -> str:
    marker = item.get("annonceId") or item.get("id") or "unknown"
    return f"{BASE_URL}/fr/annonces-immobilieres-liste?typeTransaction=VENTE,VNI,VAE#annonce-{marker}"
