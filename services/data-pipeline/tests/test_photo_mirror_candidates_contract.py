"""CANDIDATES_SQL est exécuté pour de vrai sur le schéma migré par le test pgTAP 478.

Le pipeline (CI Python) n'a pas le schéma Supabase : c'est ``supabase/tests/478_photo_mirror_candidates_sql.sql``
qui exécute la requête sur la base migrée. Ce test garde le lien entre les deux : le texte de la requête et les
paramètres de ce test pgTAP sont ceux de ``photo_mirror.py`` (un changement d'un côté fait échouer l'autre).
"""

import re
from pathlib import Path

from src.photo_mirror import (
    CANDIDATES_SQL,
    ENCHERES_PUBLIQUES_URL_PATTERN,
    MAX_ATTEMPTS,
    RETRY_AFTER_HOURS,
)

PGTAP = Path(__file__).resolve().parents[3] / "supabase" / "tests" / "478_photo_mirror_candidates_sql.sql"


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _numbered(sql: str) -> str:
    counter = iter(range(1, 100))
    return re.sub(r"%s", lambda _match: f"${next(counter)}", sql)


def test_the_pgtap_test_runs_the_exact_candidates_sql() -> None:
    text = _normalize(PGTAP.read_text(encoding="utf-8"))

    assert _normalize(_numbered(CANDIDATES_SQL)) in text
    assert CANDIDATES_SQL.count("%s") == 6  # le test PREPARE six paramètres


def test_the_pgtap_test_uses_the_pipeline_parameters() -> None:
    text = _normalize(PGTAP.read_text(encoding="utf-8"))

    closed = f"{MAX_ATTEMPTS}, {RETRY_AFTER_HOURS}, false, '{ENCHERES_PUBLIQUES_URL_PATTERN}', false, 100"
    opened = f"{MAX_ATTEMPTS}, {RETRY_AFTER_HOURS}, true, '{ENCHERES_PUBLIQUES_URL_PATTERN}', true, 100"
    assert closed in text and opened in text
