from __future__ import annotations

import re
from collections.abc import Iterable

from bs4 import Tag


def html_image_candidates(node: Tag) -> list[str]:
    """Return likely highest-resolution image URLs before lazy-load fallbacks."""
    candidates: list[tuple[float, int, str]] = []
    sequence = 0

    for attribute in ("data-srcset", "srcset"):
        value = node.get(attribute)
        if not isinstance(value, str):
            continue
        for url, quality in _parse_srcset(value):
            candidates.append((quality, sequence, url))
            sequence += 1

    for attribute in ("data-original", "data-lazy-src", "data-src", "src"):
        value = node.get(attribute)
        if isinstance(value, str) and value.strip():
            candidates.append((0, sequence, value.strip()))
            sequence += 1

    ordered = sorted(candidates, key=lambda candidate: (-candidate[0], candidate[1]))
    return _unique(candidate[2] for candidate in ordered)


def _parse_srcset(value: str) -> list[tuple[str, float]]:
    parsed: list[tuple[str, float]] = []
    for item in value.split(","):
        parts = item.strip().split()
        if not parts:
            continue
        quality = 1.0
        if len(parts) > 1:
            descriptor = parts[-1].lower()
            match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(w|x)", descriptor)
            if match:
                quality = float(match.group(1)) * (1000 if match.group(2) == "x" else 1)
        parsed.append((parts[0], quality))
    return parsed


def _unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
