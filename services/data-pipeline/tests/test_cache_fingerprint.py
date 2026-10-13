"""The extraction cache entry is saved only when the run changed the cached files."""

from __future__ import annotations

import os
from pathlib import Path

from scripts import cache_fingerprint

ROOT = Path(__file__).resolve().parents[1]


def _write(path: Path, content: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def test_fingerprint_is_stable_and_ignores_modification_times(tmp_path) -> None:
    pdf = _write(tmp_path / "documents" / "a.pdf", b"12345")
    _write(tmp_path / "texts" / "a.json", b"{}")
    before = cache_fingerprint.fingerprint([tmp_path / "documents", tmp_path / "texts"])

    os.utime(pdf, (1_000, 1_000))

    assert cache_fingerprint.fingerprint([tmp_path / "documents", tmp_path / "texts"]) == before


def test_fingerprint_changes_when_a_file_is_added_resized_or_removed(tmp_path) -> None:
    roots = [tmp_path / "documents"]
    _write(tmp_path / "documents" / "a.pdf", b"12345")
    start = cache_fingerprint.fingerprint(roots)

    added = _write(tmp_path / "documents" / "b.pdf", b"1")
    with_added = cache_fingerprint.fingerprint(roots)
    assert with_added != start

    added.write_bytes(b"12")
    resized = cache_fingerprint.fingerprint(roots)
    assert resized not in {start, with_added}

    added.unlink()
    assert cache_fingerprint.fingerprint(roots) == start


def test_same_file_in_another_directory_gives_another_fingerprint(tmp_path) -> None:
    _write(tmp_path / "one" / "a.json", b"{}")
    _write(tmp_path / "two" / "a.json", b"{}")

    assert cache_fingerprint.fingerprint([tmp_path / "one"]) != cache_fingerprint.fingerprint([tmp_path / "two"])


def test_missing_directories_and_symlinks_are_ignored(tmp_path) -> None:
    outside = _write(tmp_path / "outside.bin", b"x" * 50)
    cache = tmp_path / "cache"
    cache.mkdir()
    empty = cache_fingerprint.fingerprint([cache, tmp_path / "missing"])
    (cache / "link.bin").symlink_to(outside)

    assert cache_fingerprint.fingerprint([cache, tmp_path / "missing"]) == empty


def test_main_prints_the_digest(tmp_path, capsys) -> None:
    _write(tmp_path / "d" / "a.json", b"{}")

    assert cache_fingerprint.main([str(tmp_path / "d")]) == 0

    assert capsys.readouterr().out.strip() == cache_fingerprint.fingerprint([tmp_path / "d"])


def test_workflow_saves_the_cache_only_when_the_fingerprint_changed() -> None:
    workflow = (ROOT.parents[1] / ".github/workflows/data-pipeline.yml").read_text(encoding="utf-8")

    restore = workflow.index("Restore pipeline extraction cache")
    before = workflow.index("id: cache-before")
    prune = workflow.index("Bound extraction cache")
    after = workflow.index("id: cache-after")
    save = workflow.index("Save extraction checkpoints")
    assert restore < before < prune < after < save

    save_condition = workflow[save:].split("uses:", 1)[0]
    assert "steps.cache-after.outputs.digest != steps.cache-before.outputs.digest" in save_condition
    assert "scripts/cache_fingerprint.py" in workflow[before:prune]
    assert "scripts/cache_fingerprint.py" in workflow[after:save]
