"""Département d'une vente quand la source ne le donne pas.

Ordre de confiance : code postal (traité par ``normalize``), puis code INSEE d'un géocodage accepté.
Chaque déduction est inscrite dans ``raw_payload['department_inference']`` avec sa source. Le
tribunal n'est jamais une source : il peut couvrir une commune d'un département voisin, et une
valeur absente reste absente plutôt que d'être écrite comme un fait.
"""

from __future__ import annotations

import re
from typing import Any

_INSEE_CODE = re.compile(r"^(?:\d{5}|2[AB]\d{3})$")


def department_from_citycode(citycode: object) -> str | None:
    """``"33063"`` -> ``"33"`` ; ``"2A004"`` -> ``"2A"`` ; ``"97411"`` -> ``"974"``."""
    code = str(citycode or "").strip().upper()
    if not _INSEE_CODE.fullmatch(code):
        return None
    if code[:2] in {"2A", "2B"}:
        return code[:2]
    return code[:3] if code[:2] in {"97", "98"} else code[:2]


def department_from_geocode_evidence(raw_payload: dict[str, Any] | None) -> str | None:
    """Département du code INSEE d'un géocodage BAN accepté, sinon ``None``."""
    evidence = raw_payload.get("geocode") if isinstance(raw_payload, dict) else None
    if not isinstance(evidence, dict):
        return None
    if evidence.get("provider") != "ban_geoplateforme" or evidence.get("accepted") is not True:
        return None
    return department_from_citycode(evidence.get("citycode"))
