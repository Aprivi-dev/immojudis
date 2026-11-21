"""L'adaptateur Anthropic, contre un faux client du SDK : aucun appel réseau, aucun appel payant."""

from __future__ import annotations

import base64
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest

from src.enrichment import anthropic_reader as reader_module
from src.enrichment.anthropic_reader import HAIKU, SONNET, AnthropicDocumentReader, DocumentReaderRefused
from src.llm_requests import LLMRequestTransportAmbiguous
from src.pipeline_usage import LLMModelNotPriced

PDF = b"%PDF-1.7 test"
SCHEMA = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}


def _message(text: str = '{"plusieurs_lots":"non","champs":{}}', stop_reason: str = "end_turn") -> Any:
    return SimpleNamespace(
        id="msg_test",
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="thinking", thinking="…"), SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=1000, output_tokens=2000),
    )


class FakeMessages:
    def __init__(self, *, tokens: int = 1000, reply: Any = None, error: Exception | None = None) -> None:
        self.tokens = tokens
        self.reply = reply if reply is not None else _message()
        self.error = error
        self.counted: list[dict[str, Any]] = []
        self.created: list[dict[str, Any]] = []

    def count_tokens(self, **kwargs: Any) -> Any:
        self.counted.append(kwargs)
        return SimpleNamespace(input_tokens=self.tokens)

    def create(self, **kwargs: Any) -> Any:
        self.created.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.reply


@pytest.fixture
def ledger(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    calls: dict[str, list[Any]] = {"reserve": [], "budget": [], "record": [], "release": [], "prediction": []}
    monkeypatch.setattr(reader_module, "reserve_llm_request", lambda **kwargs: calls["reserve"].append(kwargs) or "res-1")

    real_reserve = reader_module.reserve_prediction

    def reserve_prediction(model: str, **kwargs: Any) -> str | None:
        # The real budget check runs (price grid, tier limit); without storage it reserves nothing.
        calls["budget"].append({"model": model, **kwargs})
        return real_reserve(model, **kwargs)

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
    # Token counting sends the same request, without max_tokens.
    assert messages.counted[0] == {key: value for key, value in sent.items() if key != "max_tokens"}


def test_reservation_uses_the_exact_input_count_and_max_tokens_which_bounds_thinking(
    ledger: dict[str, list[Any]],
) -> None:
    _reader(FakeMessages(tokens=12_345), SONNET).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert ledger["reserve"][0]["provider"] == "anthropic"
    assert ledger["reserve"][0]["model"] == "claude-sonnet-5-5"
    assert len(ledger["reserve"][0]["request_key"]) == 64
    assert ledger["budget"] == [{"model": "claude-sonnet-5-5", "input_token_ceiling": 12_345, "output_token_ceiling": 16_000}]


def test_success_records_billed_tokens_and_real_cost(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages())
    reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    args, kwargs = ledger["record"][-1]
    assert args == ("res-1",)
    assert kwargs["status"] == "succeeded" and kwargs["prediction_id"] == "msg_test"
    assert (kwargs["input_tokens_estimate"], kwargs["output_tokens_estimate"]) == (1000, 2000)
    # 1 000 × 0.10 + 2 000 × 0.50 per million.
    assert reader.usage[-1].cost_usd == Decimal("0.0011")
    assert ledger["prediction"][-1][0][0]["metrics"] == {"input_token_count": 1000, "output_token_count": 2000}


def test_haiku_prompt_over_100000_tokens_is_refused_before_any_paid_call(ledger: dict[str, list[Any]]) -> None:
    messages = FakeMessages(tokens=100_001)

    with pytest.raises(LLMModelNotPriced, match="100000"):
        _reader(messages).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert messages.created == []
    assert ledger["release"] and ledger["release"][0][0] == ("res-1",)


def test_refusal_gives_no_value(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages(reply=_message(text="", stop_reason="refusal")))

    with pytest.raises(DocumentReaderRefused):
        reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert ledger["record"][-1][1]["status"] == "failed"
    assert reader.usage[-1].succeeded is False and reader.usage[-1].output_tokens == 2000


def test_cut_response_is_never_read_in_part(ledger: dict[str, list[Any]]) -> None:
    reader = _reader(FakeMessages(reply=_message(text='{"plusieurs', stop_reason="max_tokens")))

    with pytest.raises(ValueError, match="max_tokens"):
        reader.generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert ledger["record"][-1][1]["status"] == "failed"


def test_connection_error_is_ambiguous_and_never_retried(ledger: dict[str, list[Any]]) -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    messages = FakeMessages(error=anthropic.APITimeoutError(request=request))

    with pytest.raises(LLMRequestTransportAmbiguous):
        _reader(messages).generate_json_with_pdf("s", "u", PDF, SCHEMA)

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
    error = error_class("error", response=httpx2.Response(status_code, request=request), body=None)

    with pytest.raises(error_class):
        _reader(FakeMessages(error=error)).generate_json_with_pdf("s", "u", PDF, SCHEMA)

    assert ledger["record"][-1][1]["status"] == recorded


def test_oversized_or_empty_pdf_is_refused_before_counting() -> None:
    messages = FakeMessages()
    with pytest.raises(ValueError):
        _reader(messages).generate_json_with_pdf("s", "u", b"", SCHEMA)
    with pytest.raises(ValueError):
        _reader(messages).generate_json_with_pdf("s", "u", b"x" * (32 * 1024 * 1024 + 1), SCHEMA)
    assert messages.counted == []


def test_missing_api_key_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        AnthropicDocumentReader(model=HAIKU)
