"""Point au centre de la commune, sans réseau, pour les ventes que le géocodage BAN n'a jamais essayées.

Pourquoi : la finalisation automatique ne géocode plus par BAN (appels en série, trop lents pour le budget d'un
run) ; la BAN n'est appelée que par les tâches d'enrichissement, et seulement pour une vente qui a une tâche (pièces,
synthèse, faits). Une fiche Vench sans pièce et dont la synthèse est à jour n'en a jamais : 223 fiches visibles
(« 27100 Le Vaudreuil ») restaient sans aucun essai de géocodage, donc sans point sur la carte.

Ici, le centre de la commune vient de la table ``reference_communes`` (geo.api.gouv.fr, importée par
``python -m src.reference_data communes``), lue une fois par processus. La commune n'est retenue que si elle est
sans ambiguïté : le nom de la commune parmi celles du code postal, ou, sans code postal, un nom unique dans le
département. Le point est marqué ``geo_precision = municipality`` (approximatif pour l'application) et sa preuve
est écrite dans ``raw_payload['geocode']`` (fournisseur ``reference_communes``). Une adresse précise obtenue
ensuite par la BAN le remplace (voir ``src.geocode.geocode_sale``).
"""

from __future__ import annotations

import logging
import re
import threading
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from src.config import load_settings
from src.models import AuctionSale
from src.reference_data.names import normalize_commune_name

LOGGER = logging.getLogger(__name__)

PROVIDER = "reference_communes"
GEO_PRECISION = "municipality"

COMMUNES_QUERY = """
    select code_insee, name_normalized, department_code, postal_codes, latitude, longitude
    from public.reference_communes
    where latitude is not null and longitude is not null
"""

_TRAILING_DEPARTMENT = re.compile(r"\s*\((?:\d{2}|2[AB]|97\d)\)\s*$", re.IGNORECASE)
_LOCK = threading.Lock()
_INDEX: _Index | None = None


class _Index:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.by_postal_code: dict[str, list[dict[str, Any]]] = {}
        self.by_department_name: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in rows:
            for postal_code in row["postal_codes"]:
                self.by_postal_code.setdefault(postal_code, []).append(row)
            self.by_department_name.setdefault((row["department_code"], row["name_normalized"]), []).append(row)


def load_communes() -> list[dict[str, Any]]:
    """Communes avec centre, lues dans ``reference_communes`` ; vide sans base (aucun point n'est alors posé)."""
    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        return []
    from src.storage.supabase_client import connect

    with connect(db_url) as connection:
        connection.execute("set transaction read only")
        rows = connection.execute(COMMUNES_QUERY).fetchall()
    return [
        {
            "code_insee": str(code),
            "name_normalized": str(name),
            "department_code": str(department),
            "postal_codes": [str(value) for value in postal_codes or []],
            "latitude": float(latitude),
            "longitude": float(longitude),
        }
        for code, name, department, postal_codes, latitude, longitude in rows
    ]


def reset_cache() -> None:
    global _INDEX
    with _LOCK:
        _INDEX = None


def _index() -> _Index:
    global _INDEX
    with _LOCK:
        if _INDEX is None:
            try:
                _INDEX = _Index(load_communes())
            except Exception as exc:  # une table de référence absente ne doit jamais bloquer une collecte
                LOGGER.warning("reference_communes unavailable, no municipality point placed: %s", exc)
                _INDEX = _Index([])
        return _INDEX


def find_commune(city: object, postal_code: object, department: object) -> dict[str, Any] | None:
    """La commune de ``city`` si elle est sans ambiguïté, sinon ``None`` (jamais une supposition)."""
    name = normalize_commune_name(_TRAILING_DEPARTMENT.sub("", str(city or "")))
    if not name:
        return None
    index = _index()
    postal = str(postal_code or "").strip()
    if re.fullmatch(r"\d{5}", postal):
        matches = [row for row in index.by_postal_code.get(postal, []) if row["name_normalized"] == name]
    else:
        dept = str(department or "").strip().upper()
        matches = index.by_department_name.get((dept, name), []) if dept else []
    return matches[0] if len(matches) == 1 else None


def is_municipality_point(sale: AuctionSale) -> bool:
    """Le point de la vente est un centre de commune (``geo_precision = municipality``), pas une adresse."""
    return (
        sale.latitude is not None
        and sale.longitude is not None
        and isinstance(sale.raw_payload, dict)
        and sale.raw_payload.get("geo_precision") == GEO_PRECISION
    )


def locate_sale_by_municipality(sale: AuctionSale) -> bool:
    """Pose le centre de la commune sur une vente sans point ; renvoie vrai si un point a été posé."""
    if sale.latitude is not None or sale.longitude is not None or not isinstance(sale.raw_payload, dict):
        return False
    commune = find_commune(sale.city, sale.postal_code, sale.department)
    if commune is None:
        return False
    sale.latitude = Decimal(str(commune["latitude"]))
    sale.longitude = Decimal(str(commune["longitude"]))
    sale.raw_payload["geo_precision"] = GEO_PRECISION
    sale.raw_payload["geocode"] = {
        "provider": PROVIDER,
        "accepted": True,
        "type": "municipality",
        "attempted_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "citycode": commune["code_insee"],
        "city": sale.city,
        "postcode": sale.postal_code,
        "latitude": commune["latitude"],
        "longitude": commune["longitude"],
    }
    return True


_Placeholder = tuple[Decimal, Decimal, dict[str, Any]]


def take_municipality_placeholder(sale: AuctionSale) -> _Placeholder | None:
    """Retire le point communal posé ici pour laisser la BAN chercher mieux ; le renvoie avec sa preuve.

    L'appelant le remet (``restore_municipality_placeholder``) si la BAN ne donne rien : une vente ne perd pas
    son point approximatif parce qu'une tentative d'adresse a échoué.
    """
    evidence = sale.raw_payload.get("geocode") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(evidence, dict) or evidence.get("provider") != PROVIDER:
        return None
    if sale.latitude is None or sale.longitude is None:
        return None
    placeholder = (sale.latitude, sale.longitude, evidence)
    sale.latitude = sale.longitude = None
    sale.raw_payload.pop("geocode", None)
    sale.raw_payload.pop("geo_precision", None)
    return placeholder


def restore_municipality_placeholder(sale: AuctionSale, placeholder: _Placeholder) -> None:
    """Remet le point communal si la BAN n'en a posé aucun ; une trace BAN (refus, cache négatif) reste."""
    if sale.latitude is not None or sale.longitude is not None:
        return
    latitude, longitude, evidence = placeholder
    sale.latitude, sale.longitude = latitude, longitude
    sale.raw_payload["geo_precision"] = GEO_PRECISION
    sale.raw_payload.setdefault("geocode", evidence)
