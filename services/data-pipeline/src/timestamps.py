"""Lecture d'un horodatage à fuseau (texte ISO 8601 stocké, reçu d'une source ou de la base)."""

from __future__ import annotations

from datetime import UTC, datetime


def aware_timestamp(value: object) -> datetime | None:
    """L'instant de ``value`` (``datetime`` ou texte ISO 8601, « Z » compris), rendu en UTC.

    Une date sans fuseau donne ``None`` : on ne sait pas quel instant elle désigne, et elle ne se compare pas à
    un instant. Un texte illisible ou une valeur d'un autre type donnent aussi ``None``.
    """
    if isinstance(value, datetime):
        candidate = value
    elif isinstance(value, str):
        try:
            candidate = datetime.fromisoformat(value)
        except ValueError:
            return None
    else:
        return None
    if candidate.tzinfo is None or candidate.utcoffset() is None:
        return None
    return candidate.astimezone(UTC)
