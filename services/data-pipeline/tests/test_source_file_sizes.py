"""Size budget for the Python sources (P6-05).

No file under ``src/`` may exceed ``MAX_SOURCE_LINES`` lines, except the files
listed in ``TEMPORARY_EXCEPTIONS``. An exception is a ceiling, not a licence:

* the file may not grow past the recorded ``max_lines``;
* once it shrinks to the limit, its entry must be deleted;
* after ``until`` the entry is no longer honoured, so the file has to be split
  (or the date consciously renewed in a reviewed change).
"""

from __future__ import annotations

import ast
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PIPELINE_ROOT / "src"
MAX_SOURCE_LINES = 1500

# path (relative to the pipeline root) -> (ceiling in lines, honoured until)
# Recorded on 2026-10-10 from the sizes measured that day.
TEMPORARY_EXCEPTIONS: dict[str, tuple[int, date]] = {
    "src/storage/supabase_client.py": (4526, date(2027, 3, 31)),
    "src/enrichment/extract_structured.py": (3000, date(2027, 3, 31)),
    "src/outcome_ingestion/repository.py": (2745, date(2027, 3, 31)),
    "src/main.py": (2254, date(2027, 3, 31)),
    "src/normalize.py": (2120, date(2027, 3, 31)),
    "src/extraction_profiles.py": (1836, date(2027, 3, 31)),
    "src/sources/notaires.py": (1736, date(2027, 3, 31)),
    "src/information_agent_evidence.py": (1650, date(2027, 3, 31)),
    "src/queued_runner.py": (1586, date(2027, 3, 31)),
}


def _line_counts() -> dict[str, int]:
    return {
        path.relative_to(PIPELINE_ROOT).as_posix(): len(path.read_text(encoding="utf-8").splitlines())
        for path in SRC_ROOT.rglob("*.py")
    }


def test_no_source_file_exceeds_the_limit_outside_the_exception_list() -> None:
    oversized = {
        path: lines
        for path, lines in _line_counts().items()
        if lines > MAX_SOURCE_LINES and path not in TEMPORARY_EXCEPTIONS
    }

    assert oversized == {}, f"files over {MAX_SOURCE_LINES} lines must be split: {oversized}"


@pytest.mark.parametrize("path", sorted(TEMPORARY_EXCEPTIONS))
def test_exceptions_are_ceilings_that_only_shrink(path: str) -> None:
    ceiling, until = TEMPORARY_EXCEPTIONS[path]
    lines = _line_counts().get(path)

    assert lines is not None, f"{path} no longer exists: remove its exception"
    assert lines > MAX_SOURCE_LINES, f"{path} is back under {MAX_SOURCE_LINES} lines: remove its exception"
    assert lines <= ceiling, f"{path} grew from {ceiling} to {lines} lines: split instead of growing it"
    assert date.today() <= until, f"the exception for {path} expired on {until}: split the file"


@pytest.mark.parametrize(
    "module",
    [
        "column_sets",
        "fact_claim_rows",
        "known_sale_projection",
        "pdf_checkpoint_rules",
        "pdf_persistence_rows",
        "postgrest_helpers",
        "postgrest_payload",
        "sale_row_builders",
    ],
)
def test_extracted_storage_modules_import_on_their_own(module: str) -> None:
    """supabase_client re-exports them, so they must never import it back (cycle)."""
    completed = subprocess.run(
        [sys.executable, "-c", f"import src.storage.{module}"],
        cwd=PIPELINE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    tree = ast.parse((PIPELINE_ROOT / "src/storage" / f"{module}.py").read_text(encoding="utf-8"))
    imported = {
        name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for name in [getattr(node, "module", None) or "", *(alias.name for alias in node.names)]
    }
    assert not any("supabase_client" in name for name in imported)
