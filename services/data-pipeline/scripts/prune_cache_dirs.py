#!/usr/bin/env python3
"""Bound the directories saved to the GitHub Actions cache.

Removes files older than ``--max-age-days`` (by modification time), then, if the
remaining files exceed ``--max-total-mb``, removes the oldest ones first until
the total fits. Empty directories left behind are removed. Standard library
only, so it can run before dependencies are installed.

    python scripts/prune_cache_dirs.py --max-age-days 14 --max-total-mb 300 \
        data/documents data/raw/pdf_texts
"""

from __future__ import annotations

import argparse
import os
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

MEGABYTE = 1024 * 1024


@dataclass
class PruneReport:
    kept_files: int = 0
    kept_bytes: int = 0
    expired_files: int = 0
    expired_bytes: int = 0
    evicted_files: int = 0
    evicted_bytes: int = 0


def _regular_files(roots: Iterable[Path]) -> list[tuple[float, int, Path]]:
    files: list[tuple[float, int, Path]] = []
    for root in roots:
        if not root.is_dir():
            continue
        for current, _directories, names in os.walk(root, followlinks=False):
            for name in names:
                path = Path(current) / name
                try:
                    if path.is_symlink():
                        continue
                    stat = path.stat()
                except OSError:
                    continue
                files.append((stat.st_mtime, stat.st_size, path))
    return files


def _remove_empty_directories(roots: Iterable[Path]) -> None:
    for root in roots:
        if not root.is_dir():
            continue
        for current, _directories, _names in os.walk(root, topdown=False):
            path = Path(current)
            if path == root:
                continue
            try:
                path.rmdir()
            except OSError:
                pass


def prune(
    roots: Iterable[Path],
    *,
    max_age_days: float,
    max_total_bytes: int,
    now: float | None = None,
) -> PruneReport:
    roots = [Path(root) for root in roots]
    cutoff = (time.time() if now is None else now) - max_age_days * 86_400
    report = PruneReport()

    remaining: list[tuple[float, int, Path]] = []
    for modified, size, path in _regular_files(roots):
        if modified < cutoff:
            try:
                path.unlink()
            except OSError:
                remaining.append((modified, size, path))
                continue
            report.expired_files += 1
            report.expired_bytes += size
        else:
            remaining.append((modified, size, path))

    total = sum(size for _modified, size, _path in remaining)
    # Oldest first; the path breaks ties so the result is deterministic.
    remaining.sort(key=lambda item: (item[0], str(item[2])))
    index = 0
    while total > max_total_bytes and index < len(remaining):
        modified, size, path = remaining[index]
        index += 1
        try:
            path.unlink()
        except OSError:
            continue
        total -= size
        report.evicted_files += 1
        report.evicted_bytes += size

    survivors = [item for item in _regular_files(roots)]
    report.kept_files = len(survivors)
    report.kept_bytes = sum(size for _modified, size, _path in survivors)
    _remove_empty_directories(roots)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directories", nargs="+", type=Path)
    parser.add_argument("--max-age-days", type=float, default=14)
    parser.add_argument("--max-total-mb", type=float, default=300)
    args = parser.parse_args(argv)
    if args.max_age_days < 0 or args.max_total_mb < 0:
        parser.error("limits must be non-negative")
    report = prune(
        args.directories,
        max_age_days=args.max_age_days,
        max_total_bytes=int(args.max_total_mb * MEGABYTE),
    )
    print(
        "Cache pruning: "
        f"expired {report.expired_files} file(s) ({report.expired_bytes / MEGABYTE:.1f} MB), "
        f"evicted {report.evicted_files} file(s) over the {args.max_total_mb:g} MB cap "
        f"({report.evicted_bytes / MEGABYTE:.1f} MB), "
        f"kept {report.kept_files} file(s) ({report.kept_bytes / MEGABYTE:.1f} MB)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
