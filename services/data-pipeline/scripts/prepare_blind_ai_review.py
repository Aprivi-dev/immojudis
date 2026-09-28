#!/usr/bin/env python3
"""Create a private capture-only packet for independent AI review."""

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
    prepare_blind_ai_packet,
    write_private_json,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Private frozen review manifest.")
    parser.add_argument("--output", type=Path, required=True, help="New private blind packet (mode 0600).")
    parser.add_argument("--sample", type=Path, default=SAMPLE_PATH)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.input.read_text(encoding="utf-8"))
        packet = prepare_blind_ai_packet(manifest, args.sample)
        write_private_json(args.output, packet)
        print(json.dumps({"captured_cases": len(packet["cases"]), "sample_sha256": packet["sample_sha256"]}))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Blind AI packet preparation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
