"""antiword, textutil et Docling ouvrent des pièces reçues de tiers : aucun secret dans leur environnement."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from src import pdf_enrichment, pdf_word_documents

SECRETS = {
    "ANTHROPIC_API_KEY": "test-key-never-shown",
    "REPLICATE_API_TOKEN": "test-token-never-shown",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service-role",
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_DB_URL": "postgresql://user:secret@example.test/db",
    "POSTGRES_DB_URL": "postgresql://user:secret@example.test/db",
    "SOURCE_FETCH_RELAY_TOKEN": "relay",
    "PDF_SECRET_KEY": "even-under-an-allowed-prefix",
}
FORBIDDEN = re.compile(r"(_KEY|_TOKEN)$|^SUPABASE_|_DB_URL$")


@pytest.fixture
def job_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("PDF_DOCLING_OCR_MODE", "auto")


def _assert_no_secret(env: dict[str, str]) -> None:
    assert not [name for name in env if FORBIDDEN.search(name)]
    assert not set(SECRETS.values()) & set(env.values())


def test_the_tool_environment_is_an_allowlist(job_environment: None) -> None:
    env = pdf_word_documents.document_tool_environment()

    _assert_no_secret(env)
    # Docling reads its own settings again; PATH finds the tools.
    assert env["PATH"] == "/usr/bin" and env["PDF_DOCLING_OCR_MODE"] == "auto"


def test_antiword_runs_without_any_secret(
    job_environment: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seen: list[dict[str, Any]] = []

    def run(command: list[str], **kwargs: Any) -> Any:
        seen.append(kwargs)
        return SimpleNamespace(returncode=0, stdout="Texte du document Word.", stderr="")

    monkeypatch.setattr(pdf_word_documents.shutil, "which", lambda name: f"/usr/bin/{name}" if name == "antiword" else None)
    monkeypatch.setattr(pdf_word_documents.subprocess, "run", run)
    document = tmp_path / "piece.doc"
    document.write_bytes(b"fake")

    pdf_word_documents.extract_legacy_word_document(document)

    assert len(seen) == 1 and "env" in seen[0]
    _assert_no_secret(seen[0]["env"])


def test_docling_runs_without_any_secret(job_environment: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen: list[dict[str, Any]] = []

    def run(command: list[str], **kwargs: Any) -> Any:
        seen.append(kwargs)
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="")

    monkeypatch.setattr(pdf_enrichment.subprocess, "run", run)
    monkeypatch.setattr(pdf_enrichment, "DOCLING_TEXTS_DIR", tmp_path / "docling")
    document = tmp_path / "piece.pdf"
    document.write_bytes(b"%PDF-1.7")

    try:
        pdf_enrichment._extract_pdf_text_with_docling_subprocess(document, timeout=5)
    except Exception:
        pass  # the failed fake run is not what is checked here

    assert len(seen) == 1 and "env" in seen[0]
    _assert_no_secret(seen[0]["env"])
