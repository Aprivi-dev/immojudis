#!/usr/bin/env python3
"""Prepare a private human review manifest or evaluate its aggregate quality."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from src.real_extraction_review import (  # noqa: E402
    SAMPLE_PATH,
    evaluate_real_review,
    prepare_manifest,
    write_private_json,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", type=Path, default=SAMPLE_PATH)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--prepare", type=Path, help="Create a private, unannotated review manifest (mode 0600).")
    action.add_argument("--input", type=Path, help="Evaluate a completed private review manifest.")
    parser.add_argument("--output", type=Path, help="Create a private aggregate JSON report (mode 0600).")
    args = parser.parse_args(argv)

    try:
        if args.prepare:
            if args.output:
                parser.error("--output is only valid with --input")
            manifest = prepare_manifest(args.sample)
            write_private_json(args.prepare, manifest)
            print(json.dumps({"prepared_cases": len(manifest["cases"]), "sample_sha256": manifest["sample_sha256"]}))
            return 0
        manifest = json.loads(args.input.read_text(encoding="utf-8"))
        report = evaluate_real_review(manifest, args.sample)
        if args.output:
            write_private_json(args.output, report)
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (FileExistsError, FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"Real extraction review failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
