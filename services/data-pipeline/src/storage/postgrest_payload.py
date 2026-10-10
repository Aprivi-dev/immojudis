"""Payload sanitising applied before any PostgREST or Postgres write."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

POSTGREST_MAX_PAYLOAD_DEPTH = 64


def _sanitize_postgrest_payload(
    value: Any,
    *,
    _path: str = "root",
    _active_paths: dict[int, str] | None = None,
    _depth: int = 0,
) -> Any:
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if not isinstance(value, (list, dict)):
        return value

    if _depth > POSTGREST_MAX_PAYLOAD_DEPTH:
        raise ValueError(
            f"PostgREST payload exceeds maximum nesting depth {POSTGREST_MAX_PAYLOAD_DEPTH} at {_path}"
        )

    active_paths = _active_paths if _active_paths is not None else {}
    value_id = id(value)
    first_path = active_paths.get(value_id)
    if first_path is not None:
        raise ValueError(
            f"PostgREST payload cycle detected at {_path}; container first seen at {first_path}"
        )
    active_paths[value_id] = _path
    try:
        if isinstance(value, list):
            return [
                _sanitize_postgrest_payload(
                    item,
                    _path=f"{_path}[{index}]",
                    _active_paths=active_paths,
                    _depth=_depth + 1,
                )
                for index, item in enumerate(value)
            ]
        return {
            key: _sanitize_postgrest_payload(
                item,
                _path=f"{_path}[{key!r}]",
                _active_paths=active_paths,
                _depth=_depth + 1,
            )
            for key, item in value.items()
        }
    finally:
        del active_paths[value_id]
