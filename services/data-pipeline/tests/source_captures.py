"""Pages de sites tiers capturées le 02/10/2026, lues par les tests des parseurs.

Le dépôt est public : ces pages (annonces entières, avec les coordonnées de professionnels) n'y sont plus.
Elles vivent dans le dépôt privé ``Aprivi-dev/immojudis-interne``, au même chemin
``docs/audits/sources-2026-10-02/``. La CI les y prend avant de lancer pytest et pose
``REQUIRE_SOURCE_CAPTURES=1`` : leur absence y est une erreur. En local, sans elles, les tests qui les lisent
sont sautés ; pour les lancer, copier ou lier le dossier du dépôt privé au même chemin (ignoré par git).
Le job hebdomadaire à l'horloge décalée, qui ne lit aucun secret, les saute aussi.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

SOURCE_CAPTURES = Path(__file__).resolve().parents[3] / "docs/audits/sources-2026-10-02"


def require_source_captures() -> Path:
    """Rend le dossier des captures ; sans lui, saute le test (ou le module), sauf en CI où c'est une erreur."""
    if SOURCE_CAPTURES.is_dir():
        return SOURCE_CAPTURES
    if os.environ.get("REQUIRE_SOURCE_CAPTURES") == "1":
        raise FileNotFoundError(f"REQUIRE_SOURCE_CAPTURES=1 mais {SOURCE_CAPTURES} est absent")
    pytest.skip(
        "pages capturées absentes (dépôt privé immojudis-interne, docs/audits/sources-2026-10-02)",
        allow_module_level=True,
    )
