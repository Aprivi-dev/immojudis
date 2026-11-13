"""Values the pipeline shares with the TypeScript application, read from the .ts files themselves.

Each pair must change together: a test fails as soon as one side moves without the other.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.cache_invalidation import BATCH_SIZE
from src.config import SOURCE_NAMES
from src.document_reading import MAX_QUOTE_CHARS, THEMES
from src.information_agent_review_signals import MIN_STATEMENT_CHARS, REVIEW_REASON_LABELS
from src.information_sufficiency import COURT_REGISTRY_FALLBACK

REPO = Path(__file__).resolve().parents[3]

# Sources the admin can no longer start (``SCROLL_SOURCES`` of src/lib) but the pipeline still knows: withdrawn
# from the catalogue on 09 and 10/11/2026.
ADMIN_OMITTED_SOURCES = frozenset({"vench", "petites_affiches"})


def _typescript(relative: str) -> str:
    return (REPO / relative).read_text(encoding="utf-8")


def _block(source: str, opening: str) -> str:
    """Text between ``opening`` and the first line that closes it at the start of a line."""
    start = source.index(opening) + len(opening)
    end = re.compile(r"^[\]}]", re.M).search(source, start)
    assert end is not None, opening
    return source[start : end.start()]


def test_a_flush_batch_is_the_largest_the_revalidation_route_accepts() -> None:
    route = _typescript("src/app/api/pipeline/revalidate-sale/route.ts")
    match = re.search(r"^const MAX_SALES_PER_CALL = (\d+);$", route, re.M)
    assert match is not None
    assert BATCH_SIZE == int(match.group(1))


def test_the_document_reading_themes_are_those_the_sale_page_shows() -> None:
    page = _typescript("src/lib/document-reading.ts")
    block = _block(page, "export const DOCUMENT_READING_THEMES: Record<DocumentReadingTheme, string> = {")
    assert re.findall(r"^\s+([a-z_]+):", block, re.M) == list(THEMES)


def test_the_sale_page_never_cuts_a_quote_the_pipeline_verified() -> None:
    page = _typescript("src/lib/document-reading.ts")
    match = re.search(r"const quote = text\(point\.quote, (\d+)\);", page)
    assert match is not None
    assert MAX_QUOTE_CHARS <= int(match.group(1))


def test_the_admin_starts_every_pipeline_source_but_the_withdrawn_ones() -> None:
    # The list moves between files of src/lib: it is found by its definition, which must be unique.
    definition = re.compile(r"^(?:export )?const SCROLL_SOURCES = \[$", re.M)
    sources = [path.read_text(encoding="utf-8") for path in sorted((REPO / "src" / "lib").glob("*.ts"))]
    (admin,) = [source for source in sources if definition.search(source)]
    block = _block(admin, definition.search(admin).group(0))
    choices = re.findall(r'^\s+"([a-z_]+)",$', block, re.M)

    assert ADMIN_OMITTED_SOURCES <= set(SOURCE_NAMES)
    assert len(choices) == len(set(choices))
    assert set(choices) == {"all"} | (set(SOURCE_NAMES) - ADMIN_OMITTED_SOURCES)


def test_a_short_statement_has_the_same_length_for_the_ai_reading_and_the_typescript_rules() -> None:
    rules = _typescript("src/lib/information-agent-inbound/review-signals.ts")
    match = re.search(r"^const MIN_STATEMENT_CHARS = (\d+);$", rules, re.M)
    assert match is not None
    assert MIN_STATEMENT_CHARS == int(match.group(1))
    # The label of the reason states the same length (both label lists are compared by a vitest test).
    assert REVIEW_REASON_LABELS["short_citation"] == f"phrase de moins de {MIN_STATEMENT_CHARS} caractères"


def test_the_court_registry_origin_is_the_one_the_application_writes() -> None:
    fallback = _typescript("src/lib/information-agent/court-registry-fallback.ts")
    match = re.search(r'^export const INFORMATION_AGENT_COURT_REGISTRY_FALLBACK = "([a-z_]+)";$', fallback, re.M)
    assert match is not None
    assert COURT_REGISTRY_FALLBACK == match.group(1)
