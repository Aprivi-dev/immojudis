"""Département d'une vente quand la source ne le donne pas.

Ordre de confiance : code postal (traité par ``normalize``), code INSEE d'un géocodage accepté,
tribunal rattaché au référentiel national. Chaque déduction est inscrite dans
``raw_payload['department_inference']`` avec sa source ; une déduction par le tribunal pose en plus
le drapeau ``department_from_tribunal`` (un tribunal peut couvrir une commune d'un département
voisin : le département n'est alors qu'une indication).
"""

from __future__ import annotations

import re
from typing import Any

_INSEE_CODE = re.compile(r"^(?:\d{5}|2[AB]\d{3})$")
DEPARTMENT_FROM_TRIBUNAL_FLAG = "department_from_tribunal"


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


def department_from_court_evidence(raw_payload: dict[str, Any] | None, tribunal_code: str | None) -> str | None:
    """Département du tribunal que la preuve de rattachement attribue à ``tribunal_code``."""
    if not isinstance(raw_payload, dict) or not tribunal_code:
        return None
    for key in ("tribunal_assignment", "tribunal_label_assignment"):
        evidence = raw_payload.get(key)
        if not isinstance(evidence, dict) or evidence.get("court_code") != tribunal_code:
            continue
        department = str(evidence.get("court_department") or "").strip().upper()
        if re.fullmatch(r"\d{2}|2[AB]|97\d", department):
            return department
    return None
