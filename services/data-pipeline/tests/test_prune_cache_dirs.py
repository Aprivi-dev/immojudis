"""The extraction cache saved by GitHub Actions stays bounded (P3-05)."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from scripts import prune_cache_dirs

ROOT = Path(__file__).resolve().parents[1]

NOW = 1_800_000_000.0
DAY = 86_400


def _file(path: Path, size: int, age_days: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    os.utime(path, (NOW - age_days * DAY, NOW - age_days * DAY))
    return path


def test_files_older_than_the_limit_are_removed_and_recent_ones_kept(tmp_path) -> None:
    old = _file(tmp_path / "documents" / "sale-1" / "old.pdf", 10, 15)
    edge = _file(tmp_path / "documents" / "sale-1" / "edge.pdf", 10, 13.9)
    fresh = _file(tmp_path / "pdf_texts" / "fresh.json", 10, 1)

    report = prune_cache_dirs.prune(
        [tmp_path / "documents", tmp_path / "pdf_texts"], max_age_days=14, max_total_bytes=10**9, now=NOW
    )

    assert not old.exists()
    assert edge.exists() and fresh.exists()
    assert (report.expired_files, report.evicted_files, report.kept_files) == (1, 0, 2)


def test_total_size_is_capped_by_evicting_the_oldest_files_first(tmp_path) -> None:
    oldest = _file(tmp_path / "a" / "1.bin", 400, 10)
    middle = _file(tmp_path / "b" / "2.bin", 400, 5)
    newest = _file(tmp_path / "a" / "3.bin", 400, 1)

    report = prune_cache_dirs.prune([tmp_path / "a", tmp_path / "b"], max_age_days=14, max_total_bytes=800, now=NOW)

    assert not oldest.exists()
    assert middle.exists() and newest.exists()
    assert report.evicted_files == 1
    assert report.kept_bytes == 800


def test_eviction_stops_as_soon_as_the_cap_is_met(tmp_path) -> None:
    files = [_file(tmp_path / f"{index}.bin", 100, 10 - index) for index in range(5)]

    prune_cache_dirs.prune([tmp_path], max_age_days=14, max_total_bytes=300, now=NOW)

    assert [path.exists() for path in files] == [False, False, True, True, True]


def test_a_zero_cap_empties_the_cache_and_empty_directories_disappear(tmp_path) -> None:
    _file(tmp_path / "documents" / "sale-1" / "a.pdf", 10, 1)

    prune_cache_dirs.prune([tmp_path / "documents"], max_age_days=14, max_total_bytes=0, now=NOW)

    assert (tmp_path / "documents").is_dir()
    assert list((tmp_path / "documents").iterdir()) == []


def test_missing_directories_and_symlinks_are_ignored(tmp_path) -> None:
    outside = _file(tmp_path / "outside" / "keep.bin", 10, 100)
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "link.bin").symlink_to(outside)

    report = prune_cache_dirs.prune([cache, tmp_path / "missing"], max_age_days=1, max_total_bytes=0, now=NOW)

    assert outside.exists()
    assert report.expired_files == report.evicted_files == 0


def test_command_line_reports_what_it_did(tmp_path, capsys) -> None:
    _file(tmp_path / "d" / "old.bin", 2 * 1024 * 1024, 30)
    os.utime(tmp_path / "d" / "old.bin", (1, 1))
    _file(tmp_path / "d" / "new.bin", 1024, 0)
    os.utime(tmp_path / "d" / "new.bin")

    assert prune_cache_dirs.main(["--max-age-days", "14", "--max-total-mb", "300", str(tmp_path / "d")]) == 0

    out = capsys.readouterr().out
    assert "expired 1 file(s) (2.0 MB)" in out
    assert "kept 1 file(s)" in out
    assert not (tmp_path / "d" / "old.bin").exists()


def test_command_line_rejects_negative_limits(tmp_path) -> None:
    with pytest.raises(SystemExit):
        prune_cache_dirs.main(["--max-age-days", "-1", str(tmp_path)])


def test_workflow_prunes_before_saving_with_a_stable_daily_key() -> None:
    workflow = (ROOT.parents[1] / ".github/workflows/data-pipeline.yml").read_text(encoding="utf-8")

    assert "scripts/prune_cache_dirs.py --max-age-days 14 --max-total-mb 300" in workflow
    assert workflow.index("Bound extraction cache") < workflow.index("Save extraction checkpoints")
    keys = re.findall(r"key: (immojudis-(?:data-pipeline|justice-reference)-\$\{\{ runner\.os \}\}-[^\n]*)", workflow)
    assert keys, "cache keys not found"
    for key in keys:
        assert "steps.date.outputs.day" in key
        assert "run_id" not in key and "run_attempt" not in key
    assert 'echo "day=$(date -u +%Y-%m-%d)"' in workflow
