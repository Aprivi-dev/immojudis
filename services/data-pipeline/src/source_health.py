"""Make a broken or empty source visible in GitHub Actions without hiding publication.

``src.main`` exits with ``SOURCE_WARNING_EXIT_CODE`` when the run itself worked
(nothing failed to publish) but at least one enabled source returned no listing
or raised an error. Workflows treat that code as a warning: later steps still
run and the failing sources appear as ``::warning::`` annotations.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

SOURCE_WARNING_EXIT_CODE = 2
_MAX_REASON_CHARS = 200


def failed_sources(
    enabled: Iterable[str],
    listings_by_source: Mapping[str, int],
    errors_by_source: Mapping[str, Sequence[str]],
) -> dict[str, str]:
    """Return ``{source: reason}`` for enabled sources with errors or no listing."""
    failed: dict[str, str] = {}
    for name in enabled:
        errors = [str(error) for error in errors_by_source.get(name) or () if str(error).strip()]
        if errors:
            first = " ".join(errors[0].split())[:_MAX_REASON_CHARS]
            failed[name] = f"{len(errors)} erreur(s), première : {first}"
        elif int(listings_by_source.get(name, 0) or 0) == 0:
            failed[name] = "0 annonce collectée"
    return failed


def _escape_workflow_command(value: str) -> str:
    """Escape data for a GitHub Actions workflow command (%, CR and LF)."""
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def warning_annotations(failed: Mapping[str, str]) -> list[str]:
    return [
        f"::warning::{_escape_workflow_command(f'Source {name} en échec ({reason})')}"
        for name, reason in failed.items()
    ]
