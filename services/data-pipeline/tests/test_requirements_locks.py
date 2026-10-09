"""Hashed lockfiles stay aligned with the requirements they pin (P4-06)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]

PAIRS = [
    ("requirements.txt", "requirements.lock"),
    ("requirements-dev.txt", "requirements-dev.lock"),
    ("requirements-valuation.txt", "requirements-valuation.lock"),
]

_PIN = re.compile(r"^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?==([^\s;#\\]+)")


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _PIN.match(line.strip())
        if match:
            pins[_normalize(match.group(1))] = match.group(2)
    return pins


def _lock_entries(path: Path) -> dict[str, tuple[str, int]]:
    """Map each locked package to (version, number of sha256 hashes)."""
    entries: dict[str, tuple[str, int]] = {}
    current: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _PIN.match(line)
        if match and not line.startswith(" "):
            current = _normalize(match.group(1))
            entries[current] = (match.group(2), 0)
        elif current and line.strip().startswith("--hash=sha256:"):
            version, count = entries[current]
            entries[current] = (version, count + 1)
    return entries


def _direct_requirements(path: Path) -> dict[str, str]:
    pins = _pins(path)
    for line in path.read_text(encoding="utf-8").splitlines():
        include = re.match(r"^-r\s+(\S+)", line.strip())
        if include:
            pins = {**_direct_requirements(path.parent / include.group(1)), **pins}
    return pins


@pytest.mark.parametrize(("source", "lock"), PAIRS)
def test_lock_pins_every_direct_requirement_to_the_same_version(source: str, lock: str) -> None:
    locked = _lock_entries(ROOT / lock)
    direct = _direct_requirements(ROOT / source)

    assert direct, f"no pinned requirement found in {source}"
    mismatches = {
        name: (version, locked.get(name, ("missing", 0))[0])
        for name, version in direct.items()
        if locked.get(name, (None, 0))[0] != version
    }
    assert mismatches == {}


@pytest.mark.parametrize(("source", "lock"), PAIRS)
def test_every_locked_package_is_pinned_and_hashed(source: str, lock: str) -> None:
    text = (ROOT / lock).read_text(encoding="utf-8")
    entries = _lock_entries(ROOT / lock)

    assert entries
    assert all(count >= 1 for _version, count in entries.values()), "a locked package has no hash"
    assert all(entry[0] for entry in entries.values())
    # --require-hashes rejects unpinned, editable, URL and VCS requirements.
    requirement_lines = [
        line for line in text.splitlines() if line and not line.startswith((" ", "#")) and not line.startswith("--")
    ]
    assert all(" @ " not in line and not line.startswith(("-e", "git+")) for line in requirement_lines)
    assert len(requirement_lines) == len(entries)


def test_dev_and_valuation_locks_extend_the_runtime_lock_without_drifting() -> None:
    runtime = _lock_entries(ROOT / "requirements.lock")
    for lock in ("requirements-dev.lock", "requirements-valuation.lock"):
        extended = _lock_entries(ROOT / lock)
        assert {name: runtime[name][0] for name in runtime} == {name: extended[name][0] for name in runtime}, lock


def test_collector_and_pipeline_use_the_same_pydantic() -> None:
    pipeline = _pins(ROOT / "requirements.txt")["pydantic"]
    collector = _pins(REPOSITORY / "services" / "licitor-collector" / "requirements.txt")["pydantic"]

    assert pipeline == collector


def test_python_version_is_3_12_everywhere_it_is_pinned() -> None:
    assert (ROOT / ".python-version").read_text(encoding="utf-8").strip() == "3.12"
    versions: dict[str, set[str]] = {}
    for workflow in (REPOSITORY / ".github" / "workflows").glob("*.yml"):
        content = workflow.read_text(encoding="utf-8")
        found = set(re.findall(r'python-version:\s*"?(\d+\.\d+)"?\s*$', content, re.M))
        for matrix in re.findall(r"python-version:\s*\[([^\]]*)\]", content):
            found.update(re.findall(r"\d+\.\d+", matrix))
        if found:
            versions[workflow.name] = found
    assert versions, "no workflow sets up Python"
    assert {name: found for name, found in versions.items() if found != {"3.12"}} == {}


def test_workflows_install_python_dependencies_only_from_hashed_lockfiles() -> None:
    offenders: list[str] = []
    for workflow in sorted((REPOSITORY / ".github" / "workflows").glob("*.yml")):
        for line in workflow.read_text(encoding="utf-8").splitlines():
            if "pip install" not in line or "--dry-run" in line:
                continue
            if re.search(r"pip install\s+(?:-q\s+)?(?!--require-hashes)", line) and "pip install --upgrade" not in line:
                offenders.append(f"{workflow.name}: {line.strip()}")
            elif "--require-hashes" in line and ".lock" not in line:
                offenders.append(f"{workflow.name}: {line.strip()}")
    assert offenders == []
