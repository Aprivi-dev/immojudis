"""Le client de texte et d'image Anthropic (``LLM_PROVIDER=anthropic``), contre un faux client du SDK.

Aucun appel réseau, aucun appel payant : le faux client note les requêtes et rend des réponses fabriquées.
"""

from __future__ import annotations

import base64
import re
import time
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest

from src.enrichment import anthropic_reader as reader_module
from src.enrichment import llm_client
from src.enrichment.anthropic_reader import (
    HAIKU,
    AnthropicTextClient,
    ReaderInvalidJSON,
    ReaderOutputCut,
)
from src.enrichment.llm_client import (
    JSON_FINAL_REMINDER,
    JSON_RETRY_INSTRUCTION,
    LLMClientUnavailable,
    LLMProviderOutputRefused,
    ReplicateClient,
    create_llm_client,
)
from src.llm_requests import LLMRequestTransportAmbiguous
from src.llm_task_deadline import LLMTaskDeadlineExceeded, llm_task_deadline_scope
from src.pipeline_usage import LLMModelNotPriced

# Expression du blocage de 24 heures d'une clé de requête (migration 20260920144219), en syntaxe Python.
INVALID_JSON_BLOCK = re.compile(
    r"(replicate[\s_-]+returned[\s_-]+invalid[\s_-]*json|invalid[\s_-]*json\s+from\s+llm|"
    r"validation\s+errors?\s+for\s+llmextraction|structured[\s_-]+validation)",
    re.I,
)
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode("ascii")


def _message(text: str = '{"facts": []}', stop_reason: str = "end_turn", tokens: tuple[int, int] = (800, 1200)) -> Any:
    return SimpleNamespace(
        id="msg_text",
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="thinking", thinking="…"), SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=tokens[0], output_tokens=tokens[1]),
    )


class FakeMessages:
    def __init__(self, *replies: Any, error: Exception | None = None, counted_tokens: int = 30_000) -> None:
        self.replies = list(replies) or [_message()]
        self.error = error
        self.counted_tokens = counted_tokens
        self.counted: list[dict[str, Any]] = []
        self.created: list[dict[str, Any]] = []

    def count_tokens(self, **kwargs: Any) -> Any:
        self.counted.append(kwargs)
        return SimpleNamespace(input_tokens=self.counted_tokens)

    def create(self, **kwargs: Any) -> Any:
        self.created.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]


@pytest.fixture
def ledger(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    calls: dict[str, list[Any]] = {"steps": [], "reserve": [], "ceiling": [], "budget": [], "record": [], "release": []}

    def reserve(**kwargs: Any) -> str:
        calls["steps"].append("reserve")
        calls["reserve"].append(kwargs)
        return f"res-{len(calls['reserve'])}"

    def ceiling(reservation_id: str | None, **kwargs: Any) -> None:
        calls["steps"].append("ceiling")
        calls["ceiling"].append((reservation_id, kwargs))

    real_reserve = reader_module.reserve_prediction

    def reserve_prediction(model: str, **kwargs: Any) -> str | None:
        # The real check runs (price grid, tier limit); without storage it reserves nothing.
        calls["steps"].append("budget")
        calls["budget"].append({"model": model, **kwargs})
        return real_reserve(model, **kwargs)

    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(reader_module, "reserve_llm_request", reserve)
    monkeypatch.setattr(reader_module, "record_llm_request_ceiling", ceiling)
    monkeypatch.setattr(reader_module, "reserve_prediction", reserve_prediction)
    monkeypatch.setattr(reader_module, "record_llm_request", lambda *args, **kwargs: calls["record"].append((args, kwargs)))
    monkeypatch.setattr(reader_module, "release_llm_request", lambda *args, **kwargs: calls["release"].append((args, kwargs)))
    monkeypatch.setattr(reader_module, "record_prediction", lambda *args, **kwargs: None)
    return calls


def _client(messages: FakeMessages, **kwargs: Any) -> AnthropicTextClient:
    return AnthropicTextClient(model=HAIKU, client=SimpleNamespace(messages=messages), **kwargs)


# --- Règles d'appel de Haiku 5.5 -------------------------------------------------------------------------------------


def test_text_call_uses_adaptive_thinking_explicit_effort_and_no_sampling_parameter(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages()

    assert _client(messages).generate_json("système", "question") == {"facts": []}

    sent = messages.created[0]
    assert sent["model"] == "claude-haiku-5-5" and sent["system"] == "système"
    assert sent["thinking"] == {"type": "adaptive"}
    assert sent["output_config"] == {"effort": "medium"}
    assert sent["max_tokens"] == 16_000
    for forbidden in ("temperature", "top_p", "top_k", "budget_tokens"):
        assert forbidden not in sent and forbidden not in sent["thinking"]
    # One user turn, no prefilled assistant turn; the JSON reminder of the Replicate prompts ends it.
    assert [turn["role"] for turn in sent["messages"]] == ["user"]
    assert sent["messages"][0]["content"] == [{"type": "text", "text": f"question{JSON_FINAL_REMINDER}"}]
    # The call is bounded by a timeout; a short text is never counted by the API.
    assert sent["timeout"] > 0 and messages.counted == []


def test_each_call_is_reserved_in_the_shared_budget_under_the_anthropic_provider(ledger: dict[str, list[Any]]) -> None:
    client = _client(FakeMessages(), max_calls_per_hour=120)
    client.generate_json_once("s", "u")

    assert ledger["steps"] == ["reserve", "ceiling", "budget"]
    reservation = ledger["reserve"][0]
    assert reservation["provider"] == "anthropic" and reservation["model"] == "claude-haiku-5-5"
    assert reservation["request_kind"] == "fact_extraction" and reservation["max_calls_per_hour"] == 120
    assert len(reservation["request_key"]) == 64
    expected_input = reader_module.input_token_ceiling(0, "s", f"u{JSON_FINAL_REMINDER}")
    assert ledger["ceiling"] == [("res-1", {"input_tokens": expected_input, "output_tokens": 16_000})]
    assert ledger["budget"][0]["ceiling_in_ledger"] is True
    # Billed tokens replace the ceilings once the answer is read.
    args, kwargs = ledger["record"][-1]
    assert args == ("res-1",) and kwargs["status"] == "succeeded" and kwargs["prediction_id"] == "msg_text"
    assert (kwargs["input_tokens_estimate"], kwargs["output_tokens_estimate"]) == (800, 1200)


def test_the_same_request_has_the_same_key_and_another_text_another_key(ledger: dict[str, list[Any]]) -> None:
    client = _client(FakeMessages())
    client.generate_json_once("s", "u")
    client.generate_json_once("s", "u")
    client.generate_json_once("s", "autre")

    keys = [reservation["request_key"] for reservation in ledger["reserve"]]
    assert keys[0] == keys[1] != keys[2]


def test_refusal_is_the_provider_refusal_of_the_queue_and_gives_no_value(ledger: dict[str, list[Any]]) -> None:
    with pytest.raises(LLMProviderOutputRefused, match="Anthropic refused") as refused:
        _client(FakeMessages(_message(text="", stop_reason="refusal"))).generate_json("s", "u")

    assert refused.value.request_kind == "fact_extraction"
    assert ledger["record"][-1][1]["status"] == "failed" and ledger["record"][-1][1]["error_message"] == "refusal"


def test_cut_response_is_never_read_in_part_nor_asked_again(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages(_message(text='{"facts": [', stop_reason="max_tokens"))

    with pytest.raises(ReaderOutputCut, match="max_tokens"):
        _client(messages).generate_json("s", "u")

    assert len(messages.created) == 1
    assert ledger["record"][-1][1]["status"] == "failed"


def test_invalid_json_is_asked_again_once_by_generate_json_only(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages(_message(text="pas du JSON"), _message(text='{"ok": true}'))

    assert _client(messages).generate_json("s", "u") == {"ok": True}

    assert len(messages.created) == 2
    retry_text = messages.created[1]["messages"][0]["content"][0]["text"]
    assert retry_text == f"u{JSON_RETRY_INSTRUCTION}{JSON_FINAL_REMINDER}"
    assert [reservation["attempt_number"] for reservation in ledger["reserve"]] == [1, 2]
    # The failed answer is recorded with the message that blocks the same request for 24 hours.
    assert INVALID_JSON_BLOCK.search(ledger["record"][0][1]["error_message"])

    once = FakeMessages(_message(text="pas du JSON"))
    with pytest.raises(ReaderInvalidJSON):
        _client(once).generate_json_once("s", "u")
    assert len(once.created) == 1


def test_connection_error_is_ambiguous_and_never_retried(ledger: dict[str, list[Any]]) -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    messages = FakeMessages(error=anthropic.APITimeoutError(request=request))

    with pytest.raises(LLMRequestTransportAmbiguous):
        _client(messages).generate_json("s", "u")

    assert len(messages.created) == 1
    assert ledger["record"][-1][1]["status"] == "ambiguous"


@pytest.mark.parametrize(
    ("error_class", "status_code", "recorded"),
    [
        (anthropic.RateLimitError, 429, "rate_limited"),
        (anthropic.BadRequestError, 400, "failed"),
        (anthropic.InternalServerError, 500, "ambiguous"),
    ],
)
def test_status_errors_are_recorded_by_their_typed_class(
    ledger: dict[str, list[Any]], error_class: type[anthropic.APIStatusError], status_code: int, recorded: str
) -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    messages = FakeMessages(error=error_class("error", response=httpx2.Response(status_code, request=request), body=None))

    with pytest.raises(error_class):
        _client(messages).generate_json("s", "u")

    assert len(messages.created) == 1
    assert ledger["record"][-1][1]["status"] == recorded


def test_any_other_error_after_the_send_is_ambiguous_and_raised(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages(error=anthropic.APIResponseValidationError(
        response=httpx2.Response(200, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")), body=None
    ))

    with pytest.raises(anthropic.APIResponseValidationError):
        _client(messages).generate_json("s", "u")

    assert len(messages.created) == 1
    kwargs = ledger["record"][-1][1]
    # The call may have been billed: its ceilings stay (None), it is never retried.
    assert kwargs["status"] == "ambiguous" and kwargs["input_tokens_estimate"] is None


# --- Palier de prix au-delà de 100 000 jetons d'entrée ---------------------------------------------------------------


def test_a_long_text_over_the_byte_ceiling_is_counted_by_the_api_then_read_at_the_lower_tier(
    ledger: dict[str, list[Any]],
) -> None:
    # 120 000 bytes: the prudent ceiling passes 100 000, the real count (30 000 tokens) does not.
    messages = FakeMessages(counted_tokens=30_000)

    _client(messages).generate_json_once("s", "é" * 60_000)

    assert len(messages.counted) == 1 and messages.counted[0]["model"] == "claude-haiku-5-5"
    assert ledger["ceiling"][0][1]["input_tokens"] == 30_000 + reader_module.REQUEST_OVERHEAD_TOKENS
    assert len(messages.created) == 1


def test_a_failed_token_count_is_a_typed_pipeline_refusal_before_any_reservation(ledger: dict[str, list[Any]]) -> None:
    class CountFails(FakeMessages):
        def count_tokens(self, **kwargs: Any) -> Any:
            raise anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages/count_tokens"))

    messages = CountFails()

    with pytest.raises(reader_module.InputTokensUncounted) as refused:
        _client(messages).generate_json("s", "é" * 60_000)

    assert isinstance(refused.value, LLMModelNotPriced)
    assert messages.created == [] and ledger["reserve"] == []


def test_a_text_over_100000_tokens_is_refused_before_any_reservation(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages(counted_tokens=99_000)

    with pytest.raises(LLMModelNotPriced, match="100000"):
        _client(messages).generate_json("s", "é" * 60_000)

    assert messages.created == [] and ledger["reserve"] == []


# --- Images -----------------------------------------------------------------------------------------------------------


def test_images_go_first_as_base64_blocks_and_are_reserved_at_their_ceiling(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages(_message(text='{"description": "une façade", "observations": []}'))

    result = _client(messages).generate_json_with_images("système photo", "décris", [f"data:image/png;base64,{PNG}"])

    assert result["description"] == "une façade"
    content = messages.created[0]["messages"][0]["content"]
    assert content[0] == {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}}
    assert content[1] == {"type": "text", "text": f"décris{JSON_FINAL_REMINDER}"}
    assert ledger["reserve"][0]["request_kind"] == "vision_analysis"
    text_ceiling = reader_module.input_token_ceiling(0, "système photo", f"décris{JSON_FINAL_REMINDER}")
    assert ledger["ceiling"][0][1]["input_tokens"] == text_ceiling + llm_client.VISION_IMAGE_TOKEN_CEILING


@pytest.mark.parametrize(
    "images",
    [
        [],
        ["http://example.test/a.png"],
        # An address would make Anthropic fetch the image itself from a third party: only data: images are joined.
        ["https://example.test/a.png"],
        ["data:image/bmp;base64,AAAA"],
        [f"data:image/png;base64,{PNG}"] * 5,
    ],
)
def test_invalid_images_are_refused_before_any_reservation(ledger: dict[str, list[Any]], images: list[str]) -> None:
    messages = FakeMessages()
    with pytest.raises(ValueError):
        _client(messages).generate_json_with_images("s", "u", images)
    assert messages.created == [] and ledger["reserve"] == []


# --- Disponibilité et échéances ---------------------------------------------------------------------------------------


def test_without_a_key_the_client_exists_but_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)

    client = create_llm_client()

    assert isinstance(client, AnthropicTextClient) and client.is_available() is False
    with pytest.raises(LLMClientUnavailable, match="ANTHROPIC_API_KEY"):
        client.generate_json("s", "u")


def test_no_call_starts_without_the_time_to_read_its_answer_in_a_bounded_pass(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages()

    with llm_task_deadline_scope(time.monotonic() + 30, require_answer_time=True):
        with pytest.raises(LLMTaskDeadlineExceeded):
            _client(messages).generate_json("s", "u")

    assert messages.created == [] and ledger["reserve"] == []


def test_a_single_call_budget_bounds_the_request_timeout(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages()

    with llm_task_deadline_scope(time.monotonic() + 25):
        _client(messages).generate_json_once("s", "u")

    assert 0 < messages.created[0]["timeout"] <= 25


# --- Réglage du fournisseur -------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "  ", "anthropic", " Anthropic "])
def test_anthropic_is_the_default_provider_and_the_model_comes_from_its_setting(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv("LLM_PROVIDER", raising=False)
    else:
        monkeypatch.setenv("LLM_PROVIDER", value)
    monkeypatch.delenv("ANTHROPIC_TEXT_MODEL", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-shown")

    client = create_llm_client()

    assert isinstance(client, AnthropicTextClient)
    assert client.model == "claude-haiku-5-5" and client.is_available()
    assert client.max_calls_per_hour == 120

    monkeypatch.setenv("ANTHROPIC_TEXT_MODEL", "claude-sonnet-5-5")
    assert create_llm_client().model == "claude-sonnet-5-5"


def test_replicate_rollback_keeps_the_replicate_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", " Replicate ")
    monkeypatch.delenv("REPLICATE_MODEL", raising=False)

    client = create_llm_client()

    assert type(client) is ReplicateClient and client.model == "qwen/qwen3-7-plus"


def test_an_unknown_provider_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    with pytest.raises(LLMClientUnavailable, match="openai"):
        create_llm_client()


# --- Aucun fichier déposé chez Anthropic, aucun service annexe (politique de confidentialité) ------------------------


class GuardedMessages(FakeMessages):
    """``messages`` du faux SDK : les lots (``messages.batches``) font échouer le test."""

    @property
    def batches(self) -> Any:
        raise AssertionError("no message batch: every request is sent on its own")


class NoSideServiceSDK:
    """Faux client du SDK : API Files (``files``, ``beta.files``), skills, exécution de code (``beta``) et modèles
    distants font échouer le test dès qu'on y touche ; seul ``messages.create`` (et ``count_tokens``) est permis."""

    def __init__(self, messages: FakeMessages) -> None:
        self.messages = messages

    @property
    def files(self) -> Any:
        raise AssertionError("the Files API must never be used: every text, page and photo goes with its request")

    @property
    def beta(self) -> Any:
        raise AssertionError("no beta service (Files, skills, code execution) may be used")

    @property
    def skills(self) -> Any:
        raise AssertionError("no skill may be used")


# Clés qu'une requête peut porter : ni outils (exécution de code), ni conteneur (skills), ni serveurs MCP, ni
# options bêta, ni région de traitement (``inference_geo`` : la politique dit seulement « données stockées aux
# États-Unis »).
ALLOWED_REQUEST_KEYS = {"model", "max_tokens", "system", "messages", "thinking", "output_config", "timeout"}


def test_no_file_batch_skill_or_code_execution_is_ever_used(ledger: dict[str, list[Any]]) -> None:
    from tests.test_anthropic_reader import PDF, SCHEMA

    text = GuardedMessages()
    AnthropicTextClient(model=HAIKU, client=NoSideServiceSDK(text)).generate_json("s", "é" * 60_000)
    AnthropicTextClient(model=HAIKU, client=NoSideServiceSDK(text)).generate_json_with_images(
        "s", "u", [f"data:image/png;base64,{PNG}"]
    )
    pdf = GuardedMessages(_message(text='{"plusieurs_lots": "non", "champs": {}}'))
    reader = reader_module.AnthropicDocumentReader(model=HAIKU, client=NoSideServiceSDK(pdf))
    reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    requests = text.created + pdf.created
    assert len(requests) == 3
    assert all(set(request) <= ALLOWED_REQUEST_KEYS for request in requests)
    # Pages and photos travel inside the request (base64), never as a file reference.
    sent = [block for request in requests for block in request["messages"][0]["content"]]
    assert [block["source"]["type"] for block in sent if "source" in block] == ["base64", "base64"]
    assert "file_id" not in repr(requests)


def test_no_module_that_calls_anthropic_names_a_side_service() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    side_services = re.compile(
        r"\.files\b|file_id|files-api|\.beta\b|\bbetas\b|batches|code_execution|\bskills?\b|"
        r"\bcontainer\b|mcp_servers|inference_geo"
    )
    checked = 0
    for path in [*(root / "src").rglob("*.py"), *(root / "scripts").rglob("*.py")]:
        source = path.read_text(encoding="utf-8")
        if "import anthropic" in source or "anthropic_reader" in source:
            checked += 1
            assert not side_services.search(source), (path, side_services.search(source))
    assert checked >= 3
