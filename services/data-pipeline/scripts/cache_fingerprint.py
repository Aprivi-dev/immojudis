#!/usr/bin/env python3
"""Fingerprint (names + sizes) of the directories saved to the GitHub Actions cache.

The workflow computes it right after the cache is restored and again after the
pruning: the new cache entry is saved only when the two differ, so a run that
added nothing does not write another copy of the same content (the repository
cache is limited to 10 GB). Modification times are ignored on purpose. Standard
library only, so it can run before dependencies are installed.

    python scripts/cache_fingerprint.py data/documents data/raw/pdf_texts
"""

from __future__ import annotations

import argparse
import hashlib
import os
from collections.abc import Iterable
from pathlib import Path


def fingerprint(roots: Iterable[Path]) -> str:
    """SHA-256 over the sorted relative path and size of every regular file."""
    entries: list[str] = []
    for root in (Path(root) for root in roots):
        if not root.is_dir():
            continue
        for current, _directories, names in os.walk(root, followlinks=False):
            for name in names:
                path = Path(current) / name
                try:
                    if path.is_symlink():
                        continue
                    size = path.stat().st_size
                except OSError:
                    continue
                entries.append(f"{root.as_posix()}/{path.relative_to(root).as_posix()}\t{size}")
    digest = hashlib.sha256()
    for entry in sorted(entries):
        digest.update(entry.encode("utf-8", "surrogateescape") + b"\n")
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directories", nargs="+", type=Path)
    args = parser.parse_args(argv)
    print(fingerprint(args.directories))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
