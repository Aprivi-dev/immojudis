"""Passage des appels de texte de Replicate à Claude (22/11/2026) : ce qui ne doit pas bouger.

- Aucune empreinte ne suit le fournisseur : une lecture déjà faite par Qwen reste à jour avec Claude, sans appel.
  Seules les ventes nouvelles, ou dont le texte change, passent par le nouveau fournisseur.
- Le filtrage des noms est le même pour Claude que pour Replicate : il est fait par les appelants.
- La clé de l'API Anthropic n'est donnée qu'aux étapes des workflows qui appellent l'IA.

Faux client du SDK, aucun appel réseau ni payant.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from src import document_reading
from src.config import load_settings
from src.enrichment import anthropic_reader as reader_module
from src.enrichment import extract_structured as extraction
from src.enrichment.anthropic_reader import HAIKU, AnthropicTextClient
from src.information_agent_semantic import run_configured_semantic_analysis
from src.storage.pdf_persistence_rows import _enrichment_revision_for_sale
from tests.test_fact_fingerprint_chunk_size import _long_document_sale
from tests.test_information_agent_semantic import PERSONAL_PAGE
from tests.test_llm_grounding import CONTEXT_WITH_NAME, NAME

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"
KEY = "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}"


class FakeMessages:
    def __init__(self, text: str = "{}") -> None:
        self.text = text
        self.created: list[dict[str, Any]] = []

    def count_tokens(self, **_kwargs: Any) -> Any:
        raise AssertionError("short requests are never counted")

    def create(self, **kwargs: Any) -> Any:
        self.created.append(kwargs)
        return SimpleNamespace(
            id=f"msg_{len(self.created)}",
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text=self.text)],
            usage=SimpleNamespace(input_tokens=500, output_tokens=300),
        )

    def sent_text(self) -> str:
        return json.dumps(self.created, ensure_ascii=False)


@pytest.fixture
def no_ledger(monkeypatch: pytest.MonkeyPatch) -> None:
    """Budget sans stockage : réservation et télémétrie ne font rien, le contrôle du prix et du palier tourne."""
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(reader_module, "reserve_llm_request", lambda **_kwargs: "res-1")
    monkeypatch.setattr(reader_module, "record_llm_request_ceiling", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(reader_module, "record_llm_request", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(reader_module, "record_prediction", lambda *_args, **_kwargs: None)


def _claude(messages: FakeMessages) -> AnthropicTextClient:
    return AnthropicTextClient(model=HAIKU, client=SimpleNamespace(messages=messages))


class ReplicateLikeClient:
    """Le client Replicate tel que le voit la passe des faits : son modèle est REPLICATE_MODEL."""

    model = "test-model"

    def __init__(self) -> None:
        self.calls = 0

    def is_available(self) -> bool:
        return True

    def generate_json(self, _system: str, _user: str) -> dict[str, object]:
        self.calls += 1
        return {}


# --- Empreintes des faits (extract_structured, manifeste, cache llm_cache, révision des tâches) -----------------------


def test_facts_read_by_replicate_stay_current_with_claude_and_are_never_read_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_ledger: None
) -> None:
    sale = _long_document_sale(tmp_path, monkeypatch)  # REPLICATE_MODEL=test-model
    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "10000")
    monkeypatch.setenv("LLM_PROVIDER", "replicate")
    replicate = ReplicateLikeClient()
    extraction.enrich_sale_with_llm(sale, client=replicate, output_dir=tmp_path / "out")
    assert replicate.calls > 0 and sale.raw_payload["llm_fact_coverage"]["complete"] is True
    input_key = sale.raw_payload["llm_fact_input_key"]
    manifest = sale.raw_payload["llm_fact_context_manifest"]
    revision = _enrichment_revision_for_sale(sale, load_settings(), documents_current=True)

    monkeypatch.setenv("LLM_PROVIDER", "anthropic")

    # The stored fingerprint and manifest are current: no fact pass is planned.
    assert extraction.has_current_fact_analysis(sale) is True
    assert extraction.needs_fact_extraction(sale) is False
    without_manifest = sale.model_copy(deep=True)
    without_manifest.raw_payload.pop("llm_fact_context_manifest")
    assert extraction.has_current_fact_analysis(without_manifest) is True
    # The revision of the enrichment jobs does not move either: nothing is queued again.
    assert _enrichment_revision_for_sale(sale, load_settings(), documents_current=True) == revision
    # A pass run anyway finds every chunk in the cache: Claude is never called.
    messages = FakeMessages()
    again = sale.model_copy(deep=True)
    extraction.enrich_sale_with_llm(again, client=_claude(messages), output_dir=tmp_path / "out")
    assert messages.created == []
    assert again.raw_payload["llm_fact_input_key"] == input_key
    assert again.raw_payload["llm_fact_context_manifest"]["model"] == manifest["model"] == "test-model"


def test_a_sale_read_again_by_claude_keeps_the_fingerprint_of_its_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_ledger: None
) -> None:
    sale = _long_document_sale(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "10000")
    monkeypatch.setenv("LLM_PROVIDER", "replicate")
    extraction.enrich_sale_with_llm(sale, client=ReplicateLikeClient(), output_dir=tmp_path / "replicate")
    replicate_key = sale.raw_payload["llm_fact_input_key"]
    saved: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        extraction, "save_cached_result", lambda key, _payload, *, stage, model: saved.append((key, stage, model))
    )

    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    messages = FakeMessages()
    fresh = sale.model_copy(deep=True)
    # Empty local and durable caches (a new sale, or a text that changed): Claude reads it.
    extraction.enrich_sale_with_llm(fresh, client=_claude(messages), output_dir=tmp_path / "claude")

    assert len(messages.created) > 0
    assert fresh.raw_payload["llm_fact_input_key"] == replicate_key
    # The keys of llm_cache are those of the chunks, computed with the fingerprint model; the row names the reader.
    version = str(load_settings()["llm_fact_prompt_version"])
    chunks = extraction.load_llm_fact_context_chunks_for_sale(fresh, chunk_chars=10_000)
    expected = {extraction._fact_chunk_cache_key(chunk, "test-model", version) for chunk in chunks if chunk}
    assert {key for key, stage, _model in saved if stage == "facts"} == expected
    assert {model for _key, stage, model in saved if stage == "facts"} == {"claude-haiku-5-5"}


def test_fact_keys_are_pinned() -> None:
    """Valeurs d'origine/main (22/11/2026) : une clé qui bougerait relancerait toutes les extractions."""
    context = "Appartement de 52,3 m2 à Lyon."
    assert (
        extraction._fact_input_cache_key(context, "qwen/qwen3-7-plus", "auction_facts_v1")
        == "3d3926aff9c4bf8770d59f6e6287a3552eff81d2795e696853a7d510adf86702"
    )
    assert (
        extraction._fact_chunk_cache_key(context, "qwen/qwen3-7-plus", "auction_facts_v1")
        == "0ed1a9c1f265236c400e67cfbd58316a935478b64a8bccb20680e80403b15979"
    )


@pytest.mark.parametrize("provider", ["anthropic", "replicate"])
def test_the_fingerprint_model_is_replicate_model_whatever_the_provider(
    monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    from src.config import fact_fingerprint_model

    monkeypatch.setenv("LLM_PROVIDER", provider)
    monkeypatch.delenv("REPLICATE_MODEL", raising=False)
    assert fact_fingerprint_model(load_settings()) == "qwen/qwen3-7-plus"


# --- Empreinte de la lecture des pièces (offre Analyse) -----------------------------------------------------------------


@pytest.mark.parametrize("provider", ["anthropic", "replicate"])
def test_document_reading_fingerprint_does_not_name_the_provider(monkeypatch: pytest.MonkeyPatch, provider: str) -> None:
    monkeypatch.setenv("LLM_PROVIDER", provider)
    manifest = [
        {
            "url": "https://example.test/pv.pdf",
            "label": "PV descriptif",
            "document_type": "pv_huissier",
            "pages": [{"page": 1, "text": "Le bien est occupé par le locataire suivant bail du 1er mars 2020."}],
        }
    ]
    # Valeur d'origin/main (22/11/2026) : la lecture faite par Qwen reste « same_input » avec Claude.
    assert document_reading.input_fingerprint(manifest) == "9cf15659d629dbacd45523bf0d0baa705c0c0c0038a3086e931bdea93992ee96"


# --- Filtrage des noms : le même texte part chez Claude ---------------------------------------------------------------


def test_fact_pass_sends_claude_the_filtered_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, no_ledger: None) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_FACT_MAX_CHUNKS", "0")

    def load_contexts(sale: Any, **_: object) -> list[str]:
        sale.raw_payload["llm_fact_context_coverage"] = {"total_chunks": 1, "selected_chunks": 1, "complete": True}
        return [CONTEXT_WITH_NAME]

    monkeypatch.setattr(extraction, "load_llm_fact_context_chunks_for_sale", load_contexts)
    monkeypatch.setattr(extraction, "load_cached_result", lambda *_a, **_kw: None)
    monkeypatch.setattr(extraction, "save_cached_result", lambda *_a, **_kw: None)
    messages = FakeMessages()
    sale = extraction.AuctionSale(source_name="test", source_url="https://example.test/sale", raw_text="Maison.")

    extraction.enrich_sale_with_llm(sale, client=_claude(messages), output_dir=tmp_path)

    assert len(messages.created) == 1
    assert NAME not in messages.sent_text() and "un occupant" in messages.sent_text()


def test_document_reading_sends_claude_the_filtered_pages(no_ledger: None) -> None:
    messages = FakeMessages('{"points": []}')
    documents = [
        document_reading.ReadingDocument(
            index=1,
            label="PV de Monsieur Jean DUPONT",
            url="https://example.test/pv.pdf",
            document_type="pv_huissier",
            pages={1: CONTEXT_WITH_NAME},
        )
    ]

    result = document_reading.read_sale_documents(documents, generate_json=_claude(messages).generate_json_once)

    assert result.status == "completed" and len(messages.created) == 1
    assert NAME not in messages.sent_text()


def test_agent_evidence_sends_claude_the_filtered_reply(monkeypatch: pytest.MonkeyPatch, no_ledger: None) -> None:
    messages = FakeMessages('{"facts": []}')
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-shown")
    monkeypatch.setattr(reader_module.anthropic, "Anthropic", lambda **_kwargs: SimpleNamespace(messages=messages))

    result = run_configured_semantic_analysis(
        [{"page": 1, "text": PERSONAL_PAGE}], {"information_agent_evidence_semantic_enabled": True}
    )

    assert result.status == "completed" and result.model == "claude-haiku-5-5"
    assert len(messages.created) == 1
    sent = messages.sent_text()
    for personal in ("Pierre Martin", "Jean Dupont", "DUPONT", "06 12 34 56 78", "jean.dupont@cabinet-dupont.fr"):
        assert personal not in sent, personal
    # The Replicate output caps are not applied to Claude: its answer includes its adaptive thinking.
    assert messages.created[0]["max_tokens"] == 16_000


ANTHROPIC_FOOTER = [{"metadata": {"ai_provider_id": "anthropic"}}]


def _evidence_worker_requests(
    monkeypatch: pytest.MonkeyPatch,
    content: bytes,
    filename: str,
    mime_type: str,
    *,
    outbound: list[dict[str, Any]] = ANTHROPIC_FOOTER,
) -> dict[str, Any]:
    """Le vrai worker des pièces reçues, stockage simulé, lecture sémantique et vision allumées.

    ``outbound`` : le dernier message sortant du dossier, tel que le rend la base. Rend la fin d'analyse écrite.
    """
    import hashlib

    import httpx

    from src import information_agent_evidence as evidence

    job = {"id": "extraction-a", "asset_id": "asset-a", "case_id": "case-a", "message_id": "message-a",
           "sale_id": "sale-a", "attempts": 1}
    asset = {"id": "asset-a", "case_id": "case-a", "message_id": "message-a", "sale_id": "sale-a",
             "storage_bucket": "information-agent-evidence", "storage_path": f"case-a/message-a/{filename}",
             "original_filename": filename, "mime_type": mime_type, "size_bytes": len(content),
             "sha256": hashlib.sha256(content).hexdigest()}

    finished: dict[str, Any] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/information_agent_evidence_assets"):
            return httpx.Response(200, json=[asset])
        if path.endswith(f"/information-agent-evidence/case-a/message-a/{filename}"):
            return httpx.Response(200, content=content)
        if path.endswith("/information_agent_cases") and request.method == "GET":
            return httpx.Response(200, json=[{"status": "replied"}])
        if path.endswith("/auction_sales"):
            return httpx.Response(200, json=[{}])
        if path.endswith("/information_agent_fact_candidates"):
            return httpx.Response(201, json=[])
        if path.endswith("/information_agent_evidence_extractions") and request.method == "PATCH":
            finished.update(json.loads(request.content))
            return httpx.Response(204)
        if path.endswith("/information_agent_evidence_extractions") or path.endswith("/information_agent_cases"):
            return httpx.Response(204)
        if path.endswith("/information_agent_messages") and request.method == "GET":
            assert request.url.params["direction"] == "eq.outbound" and request.url.params["case_id"] == "eq.case-a"
            return httpx.Response(200, json=outbound)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    monkeypatch.setattr(
        evidence,
        "load_settings",
        lambda: {
            "information_agent_evidence_ocr_enabled": False,
            "information_agent_evidence_semantic_enabled": True,
            "information_agent_evidence_vision_enabled": True,
        },
    )
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        evidence._process_job(client, "https://local.example.test", "fixture-key", job)
    return finished


def _claude_sdk(monkeypatch: pytest.MonkeyPatch, messages: FakeMessages) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-shown")
    monkeypatch.setattr(reader_module.anthropic, "Anthropic", lambda **_kwargs: SimpleNamespace(messages=messages))


def test_a_pdf_from_a_professional_reaches_claude_as_filtered_text_never_as_a_document(
    monkeypatch: pytest.MonkeyPatch, no_ledger: None
) -> None:
    import base64

    from tests.test_information_agent_evidence import _pdf_bytes

    pdf = _pdf_bytes("Le bien est occupe par Monsieur Pierre Martin. Surface habitable : 87 m2")
    messages = FakeMessages('{"facts": []}')
    _claude_sdk(monkeypatch, messages)

    _evidence_worker_requests(monkeypatch, pdf, "piece.pdf", "application/pdf")

    assert len(messages.created) == 1  # the text reading; no vision call for a PDF
    blocks = messages.created[0]["messages"][0]["content"]
    assert [block["type"] for block in blocks] == ["text"]
    sent = messages.sent_text()
    assert "87 m2" in sent and "Pierre Martin" not in sent
    assert base64.b64encode(pdf).decode()[:64] not in sent and "%PDF" not in sent


def test_only_a_photo_reaches_claude_as_it_is(monkeypatch: pytest.MonkeyPatch, no_ledger: None) -> None:
    from tests.test_information_agent_evidence import _pixmap_png

    messages = FakeMessages('{"description": "Une façade claire.", "observations": []}')
    _claude_sdk(monkeypatch, messages)

    _evidence_worker_requests(monkeypatch, _pixmap_png(), "photo.png", "image/png")

    images = [
        block for request in messages.created for block in request["messages"][0]["content"] if block["type"] == "image"
    ]
    # The photo goes inside the request (base64, re-encoded without EXIF), never as an uploaded file.
    assert len(images) == 1 and images[0]["source"]["type"] == "base64"
    assert images[0]["source"]["media_type"] == "image/jpeg"


# --- Prestataire nommé dans le pied = prestataire qui lit la réponse --------------------------------------------------


@pytest.mark.parametrize(
    "outbound",
    [
        [],  # no outbound message recorded
        [{"metadata": {}}],  # the 15 messages sent before 22/11/2026: their footer named Replicate
        [{"metadata": {"ai_provider_id": "replicate"}}],
    ],
)
@pytest.mark.parametrize(("filename", "mime_type"), [("piece.pdf", "application/pdf"), ("photo.png", "image/png")])
def test_a_reply_to_a_message_that_named_another_provider_is_never_read_by_claude(
    monkeypatch: pytest.MonkeyPatch, outbound: list[dict[str, Any]], filename: str, mime_type: str
) -> None:
    from src.enrichment import llm_client
    from tests.test_information_agent_evidence import _pdf_bytes, _pixmap_png

    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setattr(llm_client, "create_llm_client", lambda: pytest.fail("no AI call: the footer named another provider"))
    content = _pdf_bytes("Surface habitable : 87 m2") if mime_type == "application/pdf" else _pixmap_png()

    finished = _evidence_worker_requests(monkeypatch, content, filename, mime_type, outbound=outbound)

    assert finished["metadata"]["semantic"]["error_code"] == "AI_PROVIDER_MISMATCH"
    assert "vérification manuelle nécessaire" in finished["summary"]
    if mime_type == "image/png":
        assert finished["metadata"]["photo_semantic"]["error_code"] == "AI_PROVIDER_MISMATCH"


def test_with_the_replicate_rollback_an_old_reply_is_read_again(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.enrichment import llm_client
    from tests.test_information_agent_evidence import _pdf_bytes

    calls: list[str] = []

    class Replicate:
        model = "qwen/qwen3-7-plus"
        fact_max_tokens = 1_024
        max_retries = 0

        def generate_json(self, _system: str, _user: str) -> dict[str, object]:
            raise AssertionError("one attempt only")

        def generate_json_once(self, _system: str, _user: str) -> dict[str, object]:
            calls.append("text")
            return {"facts": []}

    monkeypatch.setenv("LLM_PROVIDER", "replicate")
    monkeypatch.setattr(llm_client, "create_llm_client", Replicate)

    finished = _evidence_worker_requests(
        monkeypatch, _pdf_bytes("Surface habitable : 87 m2"), "piece.pdf", "application/pdf", outbound=[{"metadata": {}}]
    )

    assert calls == ["text"] and finished["metadata"]["semantic"]["status"] == "completed"


# --- Workflows : la clé aux seules étapes qui appellent l'IA ---------------------------------------------------------


def _steps(workflow: str) -> tuple[str, list[str]]:
    header, *steps = (WORKFLOWS / workflow).read_text(encoding="utf-8").split("\n      - name: ")
    return header, steps


@pytest.mark.parametrize(
    ("workflow", "ai_steps"),
    [
        ("data-pipeline.yml", ["Run manually requested pipeline"]),
        ("information-agent-evidence.yml", ["Analyze queued attachments"]),
        ("fact-chunk-trial.yml", ["Run the read-only chunk trial"]),
        ("document-reading-trial.yml", ["Run the read-only reading trial"]),
    ],
)
def test_the_anthropic_key_goes_to_the_ai_steps_only(workflow: str, ai_steps: list[str]) -> None:
    header, steps = _steps(workflow)
    assert "ANTHROPIC_API_KEY" not in header  # never in the job environment
    receiving = [step.splitlines()[0] for step in steps if "ANTHROPIC_API_KEY:" in step]
    assert receiving == ai_steps
    assert all(KEY in step for step in steps if step.splitlines()[0] in ai_steps)
    # The single rollback setting, the same default as the pipeline and the footer of the agent's messages.
    assert "LLM_PROVIDER: ${{ vars.LLM_PROVIDER || 'anthropic' }}" in header
    # The Replicate token stays with the same steps, for the rollback (and with the Replicate model benchmark).
    assert set(ai_steps) <= {step.splitlines()[0] for step in steps if "REPLICATE_API_TOKEN:" in step}


def test_every_workflow_and_the_site_fall_on_the_same_provider_without_any_setting() -> None:
    """Le pied des messages (Vercel) et le traitement réel (workflows) lisent LLM_PROVIDER chacun de leur côté."""
    import re

    from src.config import DEFAULT_LLM_PROVIDER

    site = (WORKFLOWS.parents[1] / "src/lib/information-agent-ai-provider.ts").read_text(encoding="utf-8")
    site_default = re.search(r'DEFAULT_INFORMATION_AGENT_AI_PROVIDER_ID = "([a-z]+)"', site)
    assert site_default is not None and site_default.group(1) == DEFAULT_LLM_PROVIDER == "anthropic"
    values = {
        path.name: re.findall(r"^\s+LLM_PROVIDER:\s*(.+?)\s*$", path.read_text(encoding="utf-8"), re.MULTILINE)
        for path in sorted(WORKFLOWS.glob("*.yml"))
    }
    values = {name: found for name, found in values.items() if found}
    assert set(values) == {
        "data-pipeline.yml",
        "document-reading-trial.yml",
        "fact-chunk-trial.yml",
        "information-agent-evaluation-trial.yml",
        "information-agent-evidence.yml",
    }
    for name, found in values.items():
        assert found == [f"${{{{ vars.LLM_PROVIDER || '{DEFAULT_LLM_PROVIDER}' }}}}"], name


def test_manual_publication_check_runs_without_the_key() -> None:
    _header, steps = _steps("data-pipeline.yml")
    step = next(step for step in steps if step.startswith("Run manually requested pipeline"))
    check = step[step.index('if [ "$REQUESTED_PUBLICATION_CHECK" = "true" ]; then') :]
    assert check.index("unset ANTHROPIC_API_KEY") < check.index("python -m src.verify_publication")
