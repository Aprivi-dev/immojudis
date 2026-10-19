"""Département d'une commune dont le nom est unique en France (table ``reference_communes``).

Dernier recours de ``infer_missing_department`` quand ni le géocodage ni le code postal ne donnent le
département : une annonce de Petites Affiches peut n'avoir que la ville. Un nom qui désigne plusieurs
communes (« Saint-Martin », « La Chapelle ») ne donne rien. La table est celle que remplit
``python -m src.reference_data communes`` ; elle est lue une fois par processus, en lecture seule, et son
absence (pas de ``SUPABASE_DB_URL``, base injoignable) laisse simplement le département vide.
"""

from __future__ import annotations

import logging
import threading

from src.config import load_settings
from src.reference_data.names import normalize_commune_name

LOGGER = logging.getLogger(__name__)

UNIQUE_COMMUNE_NAMES_QUERY = """
    select name_normalized, min(department_code)
    from public.reference_communes
    group by name_normalized
    having count(*) = 1
"""

_LOCK = threading.Lock()
_INDEX: dict[str, str] | None = None


def load_unique_commune_departments() -> dict[str, str]:
    """``{nom normalisé: département}`` des noms portés par une seule commune ; vide si la base manque."""
    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        return {}
    from src.storage.supabase_client import connect

    with connect(db_url) as connection:
        connection.execute("set transaction read only")
        rows = connection.execute(UNIQUE_COMMUNE_NAMES_QUERY).fetchall()
    return {str(name): str(department) for name, department in rows if name and department}


def unique_department_for_commune(city: object) -> str | None:
    """Département de la commune ``city`` si son nom normalisé n'en désigne qu'une en France, sinon ``None``."""
    key = normalize_commune_name(str(city) if city else None)
    if not key:
        return None
    return _index().get(key)


def reset_cache() -> None:
    global _INDEX
    with _LOCK:
        _INDEX = None


def _index() -> dict[str, str]:
    global _INDEX
    with _LOCK:
        if _INDEX is None:
            try:
                _INDEX = load_unique_commune_departments()
            except Exception as exc:  # une table de référence absente ne doit jamais bloquer une collecte
                LOGGER.warning("reference_communes unavailable, no department inferred from the city name: %s", exc)
                _INDEX = {}
        return _INDEX
