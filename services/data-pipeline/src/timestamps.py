"""Lecture d'un horodatage (texte ISO 8601 stocké, reçu d'une source ou de la base) et d'un créneau de vente.

Deux règles pour une date sans fuseau, selon qui l'a écrite :

- ``aware_timestamp`` : une date venue d'une source ne désigne aucun instant sans son fuseau, elle donne ``None`` ;
- ``assumed_utc_timestamp`` : une date que le pipeline ou la base ont écrite sans fuseau est en UTC.
"""

from __future__ import annotations

from datetime import UTC, datetime


def _parsed(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _has_offset(value: datetime) -> bool:
    return value.tzinfo is not None and value.utcoffset() is not None


def aware_timestamp(value: object) -> datetime | None:
    """L'instant de ``value`` (``datetime`` ou texte ISO 8601, « Z » compris), rendu en UTC.

    Une date sans fuseau donne ``None`` : on ne sait pas quel instant elle désigne, et elle ne se compare pas à
    un instant. Un texte illisible ou une valeur d'un autre type donnent aussi ``None``.
    """
    candidate = _parsed(value)
    if candidate is None or not _has_offset(candidate):
        return None
    return candidate.astimezone(UTC)


def assumed_utc_timestamp(value: object) -> datetime | None:
    """L'instant de ``value`` (``datetime`` ou texte ISO 8601), rendu en UTC ; une date sans fuseau y est en UTC.

    Pour les horodatages que le pipeline écrit lui-même (colonnes de la base, caches, traces dans
    ``raw_payload``) : ils sont produits en UTC, et un fuseau absent n'y est qu'un oubli d'écriture. Une date
    reçue d'une source se lit avec ``aware_timestamp``. Un texte illisible ou une valeur d'un autre type donnent
    ``None``.
    """
    candidate = _parsed(value)
    if candidate is None:
        return None
    if not _has_offset(candidate):
        candidate = candidate.replace(tzinfo=UTC)
    return candidate.astimezone(UTC)


def sale_window(schedule: object) -> tuple[datetime, datetime] | None:
    """(ouverture, clôture) d'un créneau de vente ``{"opens_at": …, "closes_at": …}``, s'il est exploitable.

    Un créneau ne compte que si ses deux bornes portent un fuseau et que la clôture suit l'ouverture ; sinon
    ``None``. Les bornes gardent le décalage écrit par la source : la procédure de vente les republie telles quelles.
    """
    if not isinstance(schedule, dict):
        return None
    start = _parsed(schedule.get("opens_at"))
    end = _parsed(schedule.get("closes_at"))
    if start is None or end is None or not _has_offset(start) or not _has_offset(end) or end <= start:
        return None
    return start, end
