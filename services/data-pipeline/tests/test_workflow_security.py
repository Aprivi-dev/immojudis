"""Least-privilege GitHub workflows (P4-06)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"
SECRET = re.compile(r"\$\{\{\s*secrets\.")


@dataclass
class Step:
    name: str
    env: str = ""
    run: str = ""
    uses: str = ""
    text: str = ""


@dataclass
class Job:
    name: str
    env: str = ""
    steps: list[Step] = field(default_factory=list)


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _block(lines: list[str], start: int, indent: int) -> tuple[str, int]:
    """Text of the lines nested deeper than ``indent`` after ``start``."""
    collected: list[str] = []
    index = start + 1
    while index < len(lines) and (not lines[index].strip() or _indent(lines[index]) > indent):
        collected.append(lines[index])
        index += 1
    return "\n".join(collected), index


def parse_jobs(text: str) -> list[Job]:
    lines = text.splitlines()
    jobs: list[Job] = []
    try:
        start = next(i for i, line in enumerate(lines) if line.rstrip() == "jobs:")
    except StopIteration:
        return jobs
    body, _ = _block(lines, start, 0)
    job_lines = body.splitlines()
    index = 0
    while index < len(job_lines):
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", job_lines[index])
        if not match:
            index += 1
            continue
        job = Job(match.group(1))
        block, index = _block(job_lines, index, 2)
        rows = block.splitlines()
        position = 0
        while position < len(rows):
            line = rows[position]
            if re.match(r"^    env:\s*$", line):
                job.env, position = _block(rows, position, 4)
            elif re.match(r"^    steps:\s*$", line):
                steps_text, position = _block(rows, position, 4)
                job.steps = _parse_steps(steps_text)
            else:
                position += 1
        jobs.append(job)
    return jobs


def _parse_steps(text: str) -> list[Step]:
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r"^      - ", line)]
    steps: list[Step] = []
    for number, start in enumerate(starts):
        end = starts[number + 1] if number + 1 < len(starts) else len(lines)
        rows = lines[start:end]
        rows[0] = "        " + rows[0].strip()[2:]  # "- key: value" -> "key: value" at step-field indent
        step = Step(name="", text="\n".join(rows))
        position = 0
        while position < len(rows):
            line = rows[position]
            name = re.match(r"^        name:\s*(.*)$", line)
            uses = re.match(r"^        uses:\s*(.*)$", line)
            if name:
                step.name = name.group(1).strip()
            if uses:
                step.uses = uses.group(1).strip()
            if re.match(r"^        env:\s*$", line):
                step.env, position = _block(rows, position, 8)
                continue
            run = re.match(r"^        run:\s*(.*)$", line)
            if run:
                inline = run.group(1).strip()
                block, position = _block(rows, position, 8)
                step.run = (inline + "\n" + block).strip()
                continue
            position += 1
        steps.append(step)
    return steps


def _workflows() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.yml"))


@pytest.mark.parametrize("path", _workflows(), ids=lambda path: path.name)
def test_every_workflow_declares_read_only_contents_at_workflow_level(path: Path) -> None:
    text = path.read_text(encoding="utf-8")

    assert re.search(r"^permissions:\n(?:  #.*\n)*  contents: read\n", text, re.M), path.name


@pytest.mark.parametrize("path", _workflows(), ids=lambda path: path.name)
def test_secrets_are_never_in_the_environment_of_pip_and_apt_steps(path: Path) -> None:
    offenders = []
    for job in parse_jobs(path.read_text(encoding="utf-8")):
        for step in job.steps:
            installs = "pip install" in step.run or "apt-get" in step.run
            if installs and (SECRET.search(step.env) or SECRET.search(job.env)):
                offenders.append(f"{job.name}/{step.name}")
    assert offenders == []


@pytest.mark.parametrize(
    "name",
    [
        "data-pipeline.yml",
        "recompute-existing-sales.yml",
        "information-agent-evidence.yml",
        "dvf-import.yml",
        "reference-data-import.yml",
        "valuation-model-training.yml",
    ],
)
def test_pipeline_workflows_keep_secrets_out_of_the_job_environment(name: str) -> None:
    jobs = parse_jobs((WORKFLOWS / name).read_text(encoding="utf-8"))

    assert jobs
    assert [job.name for job in jobs if SECRET.search(job.env)] == []


def test_data_pipeline_secrets_reach_only_the_business_steps() -> None:
    jobs = {job.name: job for job in parse_jobs((WORKFLOWS / "data-pipeline.yml").read_text(encoding="utf-8"))}
    steps = {step.name: step for step in jobs["run"].steps}

    pipeline = steps["Run manually requested pipeline"].env
    for secret in (
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_DB_URL",
        "REPLICATE_API_TOKEN",
        "SUPABASE_URL",
        "SOURCE_FETCH_RELAY_TOKEN",
    ):
        assert f"{secret}: ${{{{ secrets.{secret} }}}}" in pipeline, secret
    receiving = {name for name, step in steps.items() if SECRET.search(step.env)}
    assert receiving == {
        "Run manually requested pipeline",
        "Finalize unfinished run",
        "Report source coverage and enrichment backlog",
    }
    benchmark = {step.name: step for step in jobs["model-benchmark"].steps}
    assert [name for name, step in benchmark.items() if SECRET.search(step.env)] == [
        "Compare existing and candidate models"
    ]


def test_recompute_secrets_reach_only_the_recompute_steps() -> None:
    jobs = parse_jobs((WORKFLOWS / "recompute-existing-sales.yml").read_text(encoding="utf-8"))
    receiving = {step.name for step in jobs[0].steps if SECRET.search(step.env)}

    assert receiving == {
        "Validate recompute without writing",
        "Validate catalogue readiness without writing",
        "Publish recomputed sales",
        "Publish catalogue readiness",
        "Refresh unresolved procedure source pages",
        "Repair and verify persisted sale procedures",
        "Report or delete sales with insufficient information",
    }
    for step in jobs[0].steps:
        if step.name in receiving:
            assert "SUPABASE_URL" in step.env and "SUPABASE_SERVICE_ROLE_KEY" in step.env


def test_information_agent_always_runs_main_with_secrets_on_its_two_business_steps() -> None:
    text = (WORKFLOWS / "information-agent-evidence.yml").read_text(encoding="utf-8")
    steps = {step.name: step for step in parse_jobs(text)[0].steps}

    checkout = steps["Check out repository"].text
    assert re.search(r"^\s+ref: main$", checkout, re.M)
    assert "INFORMATION_AGENT_EVIDENCE_REF" not in text
    assert "github.sha" not in checkout
    assert {name for name, step in steps.items() if SECRET.search(step.env)} == {
        "Check for queued evidence",
        "Analyze queued attachments",
    }
    assert "REPLICATE_API_TOKEN" in steps["Analyze queued attachments"].env
    assert "REPLICATE_API_TOKEN" not in steps["Check for queued evidence"].env


def test_dvf_and_training_secrets_reach_only_their_python_step() -> None:
    for name, step_name in (
        ("dvf-import.yml", "Download and import DVF resources"),
        ("reference-data-import.yml", "Import reference data"),
        ("valuation-model-training.yml", "Train, validate and publish"),
    ):
        steps = parse_jobs((WORKFLOWS / name).read_text(encoding="utf-8"))[0].steps
        assert [step.name for step in steps if SECRET.search(step.env)] == [step_name], name
