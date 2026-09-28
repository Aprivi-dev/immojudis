#!/usr/bin/env python3
"""Evaluate the reproducible extraction corpus and emit machine-readable JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SERVICE_DIR = SCRIPT_DIR.parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from src.extraction_corpus import DEFAULT_CORPUS_PATH, evaluate_corpus  # noqa: E402
from tests.extraction_corpus_runtime import run_fixture  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS_PATH)
    parser.add_argument("--output", type=Path, default=None, help="Write the same JSON report to this path.")
    args = parser.parse_args(argv)

    try:
        report = evaluate_corpus(args.corpus, run_fixture)
    except ValueError as exc:
        print(f"Extraction corpus evaluation failed: {exc}", file=sys.stderr)
        return 2

    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    sys.stdout.write(encoded)
    return 1 if report["fixture_errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
