"""L'adaptateur Anthropic, contre un faux client du SDK : aucun appel réseau, aucun appel payant."""

from __future__ import annotations

import base64
import re
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pymupdf
import pytest

from src import llm_requests
from src.enrichment import anthropic_reader as reader_module
from src.enrichment.anthropic_reader import (
    HAIKU,
    SONNET,
    AnthropicDocumentReader,
    DocumentReaderRefused,
    ReaderInvalidJSON,
    ReaderOutputCut,
)
from src.llm_requests import LLMRequestStorageUnavailable, LLMRequestTransportAmbiguous
from src.pipeline_usage import LLMModelNotPriced

SCHEMA = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
# Expression du blocage de 24 heures d'une clé de requête (migration 20260920144219), en syntaxe Python.
INVALID_JSON_BLOCK = re.compile(
    r"(replicate[\s_-]+returned[\s_-]+invalid[\s_-]*json|invalid[\s_-]*json\s+from\s+llm|"
    r"validation\s+errors?\s+for\s+llmextraction|structured[\s_-]+validation)",
    re.I,
)


def _pdf(pages: int = 1) -> bytes:
    document = pymupdf.open()
    for number in range(pages):
        document.new_page().insert_text((72, 72), f"page {number + 1}")
    content = document.tobytes()
    document.close()
    return content


PDF = _pdf()


def _message(
    text: str = '{"plusieurs_lots":"non","champs":{}}', stop_reason: str = "end_turn", tokens: tuple[int, int] = (1000, 2000)
) -> Any:
    return SimpleNamespace(
        id="msg_test",
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="thinking", thinking="…"), SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=tokens[0], output_tokens=tokens[1]),
    )


class FakeMessages:
    def __init__(self, *, reply: Any = None, error: Exception | None = None) -> None:
        self.reply = reply if reply is not None else _message()
        self.error = error
        self.counted: list[dict[str, Any]] = []
        self.created: list[dict[str, Any]] = []

    def count_tokens(self, **kwargs: Any) -> Any:  # must never be called: it would send the excerpt twice
        self.counted.append(kwargs)
        raise AssertionError("count_tokens sends the document a second time")

    def create(self, **kwargs: Any) -> Any:
        self.created.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.reply


@pytest.fixture
def ledger(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    calls: dict[str, list[Any]] = {"steps": [], "reserve": [], "ceiling": [], "budget": [], "record": [], "release": [], "prediction": []}

    def reserve(**kwargs: Any) -> str:
        calls["steps"].append("reserve")
        calls["reserve"].append(kwargs)
        return "res-1"

    def ceiling(reservation_id: str | None, **kwargs: Any) -> None:
        calls["steps"].append("ceiling")
        calls["ceiling"].append((reservation_id, kwargs))

    real_reserve = reader_module.reserve_prediction

    def reserve_prediction(model: str, **kwargs: Any) -> str | None:
        # The real budget check runs (price grid, tier limit); without storage it reserves nothing.
        calls["steps"].append("budget")
        calls["budget"].append({"model": model, **kwargs})
        return real_reserve(model, **kwargs)

    monkeypatch.setattr(reader_module, "reserve_llm_request", reserve)
    monkeypatch.setattr(reader_module, "record_llm_request_ceiling", ceiling)
    monkeypatch.setattr(reader_module, "reserve_prediction", reserve_prediction)
    monkeypatch.setattr(reader_module, "record_llm_request", lambda *args, **kwargs: calls["record"].append((args, kwargs)))
    monkeypatch.setattr(reader_module, "release_llm_request", lambda *args, **kwargs: calls["release"].append((args, kwargs)))
    monkeypatch.setattr(reader_module, "record_prediction", lambda *args, **kwargs: calls["prediction"].append((args, kwargs)))
    return calls


def _reader(messages: FakeMessages, model: str = HAIKU) -> AnthropicDocumentReader:
    return AnthropicDocumentReader(model=model, client=SimpleNamespace(messages=messages))


def test_pdf_goes_first_as_a_base64_document_with_adaptive_thinking_explicit_effort_and_no_sampling(
    ledger: dict[str, list[Any]],
) -> None:
    messages = FakeMessages()

    result = _reader(messages).generate_json_with_pdf("système", "question", PDF, SCHEMA)

    assert result == {"plusieurs_lots": "non", "champs": {}}
    sent = messages.created[0]
    content = sent["messages"][0]["content"]
    assert content[0] == {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(PDF).decode()},
    }
    assert content[1] == {"type": "text", "text": "question"}
    assert sent["model"] == "claude-haiku-5-5" and sent["system"] == "système"
    assert sent["thinking"] == {"type": "adaptive"}
    assert sent["output_config"] == {"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}}
    assert sent["max_tokens"] == 16_000
    for forbidden in ("temperature", "top_p", "top_k", "budget_tokens"):
        assert forbidden not in sent and forbidden not in sent["thinking"]
    assert sent["messages"][-1]["role"] == "user"  # no prefilled assistant turn
    # The document is sent once: no token counting call.
    assert messages.counted == []


def test_ceilings_are_written_to_the_ledger_before_the_budget_check(ledger: dict[str, list[Any]]) -> None:
    _reader(FakeMessages(), SONNET).generate_json_with_pdf("s", "u", _pdf(3), SCHEMA)

    assert ledger["steps"] == ["reserve", "ceiling", "budget"]
    assert ledger["reserve"][0]["provider"] == "anthropic" and ledger["reserve"][0]["model"] == "claude-sonnet-5-5"
    assert len(ledger["reserve"][0]["request_key"]) == 64
    expected_input = reader_module.input_token_ceiling(3, "s", "u", SCHEMA)
    assert expected_input >= 3 * 4_600
    assert ledger["ceiling"] == [("res-1", {"input_tokens": expected_input, "output_tokens": 16_000})]
    assert ledger["budget"] == [
        {
            "model": "claude-sonnet-5-5",
            "input_token_ceiling": expected_input,
            "output_token_ceiling": 16_000,
            "ceiling_in_ledger": True,
        }
    ]


def test_a_ledger_write_failure_blocks_the_call(monkeypatch: pytest.MonkeyPatch, ledger: dict[str, list[Any]]) -> None:
    def fail(*args: Any, **kwargs: Any) -> None:
        raise LLMRequestStorageUnavailable("down")

    monkeypatch.setattr(reader_module, "record_llm_request_ceiling", fail)
    messages = FakeMessages()

    with pytest.raises(LLMRequestStorageUnavailable):
        _reader(messages).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert messages.created == [] and ledger["release"][0][0] == ("res-1",)


def test_ceiling_write_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_requests, "load_settings", lambda: {"supabase_db_url": "postgresql://local.invalid/db"})
    monkeypatch.setattr(llm_requests, "_storage_mode", lambda settings: "postgres")
    written: list[dict[str, Any]] = []

    def finalize(settings: Any, payload: dict[str, Any]) -> None:
        written.append(payload)
        raise RuntimeError("connection lost")

    monkeypatch.setattr(llm_requests, "_finalize_via_postgres", finalize)

    with pytest.raises(LLMRequestStorageUnavailable):
        llm_requests.record_llm_request_ceiling("res-1", input_tokens=50_000, output_tokens=16_000)

    assert written[0]["p_request_status"] == "reserved"
    assert (written[0]["p_input_tokens_estimate"], written[0]["p_output_tokens_estimate"]) == (50_000, 16_000)


def test_success_replaces_the_ceilings_with_billed_tokens_and_real_cost(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages())
    reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    args, kwargs = ledger["record"][-1]
    assert args == ("res-1",)
    assert kwargs["status"] == "succeeded" and kwargs["prediction_id"] == "msg_test"
    assert (kwargs["input_tokens_estimate"], kwargs["output_tokens_estimate"]) == (1000, 2000)
    # 1 000 × 0.10 + 2 000 × 0.50 per million.
    assert reader.usage[-1].cost_usd == Decimal("0.0011")
    assert ledger["prediction"][-1][0][0]["metrics"] == {"input_token_count": 1000, "output_token_count": 2000}


def test_a_haiku_request_billed_above_100000_tokens_costs_the_higher_tier(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages(reply=_message(tokens=(120_000, 2_000))))
    reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    # 120 000 × 0.50 + 2 000 × 2.50 per million.
    assert reader.usage[-1].cost_usd == Decimal("0.065")
    # The ledger prices every row at the lower tier: the request is noted in equivalent tokens.
    kwargs = ledger["record"][-1][1]
    assert (kwargs["input_tokens_estimate"], kwargs["output_tokens_estimate"]) == (600_000, 10_000)


def test_haiku_excerpt_over_100000_tokens_is_refused_before_any_reservation(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages()

    with pytest.raises(LLMModelNotPriced, match="100000"):
        _reader(messages).generate_json_with_pdf("s", "u", _pdf(22), SCHEMA)

    assert messages.created == [] and ledger["reserve"] == []


def test_refusal_gives_no_value(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages(reply=_message(text="", stop_reason="refusal")))

    with pytest.raises(DocumentReaderRefused):
        reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert ledger["record"][-1][1]["status"] == "failed"
    assert reader.usage[-1].succeeded is False and reader.usage[-1].output_tokens == 2000


def test_cut_response_is_never_read_in_part(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages(reply=_message(text='{"plusieurs', stop_reason="max_tokens")))

    with pytest.raises(ReaderOutputCut, match="max_tokens"):
        reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert ledger["record"][-1][1]["status"] == "failed"


def test_invalid_json_is_recorded_with_the_message_that_blocks_the_same_request_for_24_hours(
    ledger: dict[str, list[Any]],
) -> None:
    with pytest.raises(ReaderInvalidJSON):
        _reader(FakeMessages(reply=_message(text="pas du JSON"))).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    kwargs = ledger["record"][-1][1]
    assert kwargs["status"] == "failed"
    assert INVALID_JSON_BLOCK.search(kwargs["error_message"])


def test_connection_error_is_ambiguous_keeps_its_ceilings_and_is_never_retried(ledger: dict[str, list[Any]]) -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    messages = FakeMessages(error=anthropic.APITimeoutError(request=request))

    with pytest.raises(LLMRequestTransportAmbiguous):
        _reader(messages).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert len(messages.created) == 1
    kwargs = ledger["record"][-1][1]
    assert kwargs["status"] == "ambiguous"
    # None keeps the ceilings written at reservation (the call may have been billed).
    assert kwargs["input_tokens_estimate"] is None and kwargs["output_tokens_estimate"] is None


@pytest.mark.parametrize(
    ("error_class", "status_code", "recorded", "tokens"),
    [
        (anthropic.RateLimitError, 429, "rate_limited", 0),
        (anthropic.BadRequestError, 400, "failed", 0),
        (anthropic.InternalServerError, 500, "ambiguous", None),
    ],
)
def test_status_errors_are_recorded_by_their_typed_class(
    ledger: dict[str, list[Any]],
    error_class: type[anthropic.APIStatusError],
    status_code: int,
    recorded: str,
    tokens: int | None,
) -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    error = error_class("error", response=httpx2.Response(status_code, request=request), body=None)

    with pytest.raises(error_class):
        _reader(FakeMessages(error=error)).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    kwargs = ledger["record"][-1][1]
    assert kwargs["status"] == recorded
    # A clear refusal by the API is not billed: its ceilings are cleared; a 5xx may have been.
    assert kwargs["input_tokens_estimate"] == tokens and kwargs["output_tokens_estimate"] == tokens


def test_oversized_or_empty_pdf_is_refused_before_any_reservation(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages()
    with pytest.raises(ValueError):
        _reader(messages).generate_json_with_pdf("s", "u", b"", SCHEMA)
    with pytest.raises(ValueError):
        _reader(messages).generate_json_with_pdf("s", "u", b"x" * (32 * 1024 * 1024 + 1), SCHEMA)
    assert ledger["reserve"] == [] and messages.created == []


def test_missing_api_key_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        AnthropicDocumentReader(model=HAIKU)
