"""scripts/fact_chunk_trial.py: read-only comparison of a larger fact chunk size, without any network call."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts import fact_chunk_trial as trial
from src.enrichment import extract_structured as extraction
from src.enrichment import llm_client
from src.enrichment.llm_client import ReplicateClient
from src.pdf_enrichment import sale_storage_id
from tests.test_fact_fingerprint_chunk_size import _long_document_sale

STORED_FACTS = {
    "property_type": "apartment",
    "surface_m2": 60.37,
    "rooms_count": 3,
    "legal_risks": ["Hypothèque inscrite"],
    "servitudes": ["Servitude de passage"],
}


class PipelineClient:
    """Answers the production extraction at 10 000 (one fact on the first chunk only)."""

    model = "test-model"

    def __init__(self) -> None:
        self.calls = 0

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, object]:
        self.calls += 1
        return dict(STORED_FACTS) if self.calls == 1 else {}


class FakeTrialClient:
    """Scripted answers; records usage as the metered client does."""

    model = "test-model"

    def __init__(self, answers: list[Any], *, output_tokens: int = 1_500, cap: int = 8_192) -> None:
        self.answers = list(answers)
        self.calls_made = 0
        self.usage: list[trial.CallUsage] = []
        self.prompts: list[str] = []
        self.output_tokens = output_tokens
        self.cap = cap

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        self.calls_made += 1
        self.prompts.append(user_prompt)
        answer = self.answers.pop(0) if self.answers else {}
        failed = isinstance(answer, Exception)
        self.usage.append(
            trial.CallUsage(
                succeeded=not failed,
                input_tokens=9_000,
                output_tokens=self.output_tokens,
                input_tokens_estimate=len(user_prompt) // 4,
                output_tokens_estimate=self.output_tokens,
                truncated=self.output_tokens >= self.cap * trial.TRUNCATION_RATIO,
            )
        )
        if failed:
            raise answer
        return answer


class FakeConnection:
    def __init__(self, rows: dict[str, tuple[Any, ...]], *, usage: tuple[Any, ...] = (6_524, 5_200.0, 1_260.0)):
        self.rows = rows
        self.usage = usage
        self.statements: list[str] = []
        self.read_only = False
        self.closed = False
        self.rollbacks = 0

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> FakeConnection:
        self.statements.append(sql)
        if sql == trial.CANDIDATES_SQL:
            self._result: list[tuple[Any, ...]] = [
                (sale_id, row[trial.SALE_COLUMNS.index("raw_payload")]["llm_fact_coverage"]["total_chunks"])
                for sale_id, row in self.rows.items()
            ]
        elif sql == trial.USAGE_SQL:
            self._result = [self.usage]
        elif sql == trial.SALE_SQL:
            assert params is not None
            self._result = [self.rows[params[0]]] if params[0] in self.rows else []
        else:  # pragma: no cover - any other statement is a test failure
            raise AssertionError(sql)
        return self

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._result

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._result[0] if self._result else None

    def rollback(self) -> None:
        self.rollbacks += 1

    def close(self) -> None:
        self.closed = True


def _stored_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ids: tuple[str, ...]) -> dict[str, tuple[Any, ...]]:
    """Rows as the database holds them after a real production extraction at 10 000."""
    sale = _long_document_sale(tmp_path, monkeypatch)
    monkeypatch.setenv("LLM_FACT_CHUNK_CHARS", "10000")
    extraction.enrich_sale_with_llm(sale, client=PipelineClient(), output_dir=tmp_path / "out")
    assert sale.raw_payload["llm_fact_coverage"]["complete"] is True
    pdf_result = json.loads((tmp_path / f"{sale_storage_id(sale)}.json").read_text(encoding="utf-8"))
    rows = {}
    for sale_id in ids:
        values = sale.model_dump(mode="json")
        values["id"] = sale_id
        rows[sale_id] = (*(values.get(column) for column in trial.SALE_COLUMNS), pdf_result)
    return rows


def _settings() -> dict[str, Any]:
    return {**extraction.load_settings(), "enable_encheres_publiques_benchmark": False}


def test_trial_reextracts_with_larger_chunks_and_compares_to_stored_facts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = _stored_rows(tmp_path, monkeypatch, ("sale-a", "sale-b"))
    stored_chunks = rows["sale-a"][trial.SALE_COLUMNS.index("raw_payload")]["llm_fact_coverage"]["total_chunks"]
    connection = FakeConnection(rows)
    # Sale A: the larger chunk finds a different surface and one more risk. Sale B: one invalid JSON answer.
    client = FakeTrialClient(
        [
            {**STORED_FACTS, "surface_m2": 61.0, "legal_risks": ["Hypothèque inscrite", "Bail en cours"]},
            {},
            ValueError("Replicate returned invalid JSON after retry: Expecting ',' delimiter: line 355"),
            {},
        ]
    )
    options = trial.TrialOptions(sales=10, chunk_chars=25_000, max_tokens=8_192, max_calls=120)

    report = trial.run_trial(connection, client, options=options, settings=_settings())

    # Read-only: selects only, the transaction is rolled back.
    assert all(statement.lstrip().lower().startswith("select") for statement in connection.statements)
    assert connection.rollbacks >= 1
    first, second = report.results
    assert first.stored_chunks == stored_chunks == first.rebuilt_chunks_10k
    assert first.same_input is True
    assert first.trial_chunks == 2 < stored_chunks
    assert len(first.usage) == 2 and first.complete
    assert first.trial is not None
    assert first.trial["surface_m2"] == 61.0 and first.stored["surface_m2"] == 60.37
    assert first.trial["legal_risks"] == 2 and first.stored["legal_risks"] == 1
    assert first.trial["property_type"] == first.stored["property_type"] == "apartment"
    assert second.complete is False and second.trial is None
    assert second.failures["json_invalide"] == 1
    assert client.calls_made == 4
    assert all("<<<UNTRUSTED_SOURCE_DATA:" in prompt for prompt in client.prompts)

    markdown = trial.render_report(report)
    assert "## Essai des morceaux de faits : 25000 caractères contre 10 000" in markdown
    assert f"Appels (ventes comparées) : {stored_chunks} à 10 000 (stocké) ; 2 dans l'essai." in markdown
    assert "surface_m2 0/1" in markdown and "property_type 1/1" in markdown
    assert "legal_risks 1 → 2" in markdown
    assert "1 JSON invalide(s)" in markdown
    assert "moyenne de 6524 appels" in markdown
    assert "| `sale-a` |" in markdown and "60.37 → 61.0" in markdown


def test_trial_stops_cleanly_at_the_call_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rows = _stored_rows(tmp_path, monkeypatch, ("sale-a", "sale-b", "sale-c"))
    client = FakeTrialClient([], output_tokens=8_100)
    options = trial.TrialOptions(sales=3, chunk_chars=25_000, max_tokens=8_192, max_calls=3)

    report = trial.run_trial(FakeConnection(rows), client, options=options, settings=_settings())

    assert client.calls_made == 2 <= options.max_calls
    assert [result.sale_id for result in report.results] == ["sale-a"]
    assert report.not_processed == ["sale-b", "sale-c"]
    assert report.stop_reason is not None and "plafond d'appels" in report.stop_reason
    markdown = trial.render_report(report)
    assert "Non traitées : `sale-b`, `sale-c`" in markdown
    assert "2 réponse(s) tronquée(s) au plafond" in markdown


def test_trial_stops_at_the_time_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rows = _stored_rows(tmp_path, monkeypatch, ("sale-a",))
    ticks = iter([0.0, 0.0, 10_000.0])
    client = FakeTrialClient([])
    options = trial.TrialOptions(sales=1, budget_minutes=60)

    report = trial.run_trial(
        FakeConnection(rows), client, options=options, settings=_settings(), clock=lambda: next(ticks)
    )

    assert client.calls_made == 1
    assert report.results[0].complete is False
    assert report.stop_reason == "durée maximale de 60 min atteinte"


def test_pick_varied_spreads_the_sizes_deterministically() -> None:
    candidates = [(f"id-{size:02d}", size) for size in range(4, 41)]

    picked = trial.pick_varied(list(reversed(candidates)), 5)

    assert [size for _, size in picked] == [4, 13, 22, 31, 40]
    assert trial.pick_varied(candidates[:3], 10) == candidates[:3]


def test_metered_client_caps_predictions_and_captures_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_client, "record_llm_request", lambda *_a, **_kw: None)
    from src.storage import supabase_client

    events: list[dict[str, Any]] = []
    monkeypatch.setattr(supabase_client, "record_llm_usage_event", events.append)
    payloads: list[dict[str, Any]] = []

    def create(self: ReplicateClient, prompt: str, system_prompt: str | None = None, **_: Any) -> dict[str, Any]:
        payloads.append(self._input_payload(prompt, system_prompt=system_prompt))
        return {"id": f"p{len(payloads)}", "status": "succeeded",
                "metrics": {"input_token_count": 9_100, "output_token_count": 8_190}}

    monkeypatch.setattr(ReplicateClient, "_create_prediction", create)
    monkeypatch.setattr(ReplicateClient, "_wait_for_output", lambda self, prediction: '{"rooms_count": 3}')
    client = trial.MeteredReplicateClient(
        api_token="token", model="qwen/qwen3-7-plus", fact_max_tokens=8_192
    ).start_meter(1)

    assert client.generate_json(extraction.SYSTEM_PROMPT, "texte") == {"rooms_count": 3}
    with pytest.raises(trial.CallCapReached):
        client.generate_json(extraction.SYSTEM_PROMPT, "texte")

    assert client.calls_made == 1 and len(payloads) == 1
    assert payloads[0]["max_tokens"] == 8_192
    usage = client.usage[0]
    assert (usage.input_tokens, usage.output_tokens, usage.truncated) == (9_100, 8_190, True)
    assert usage.cost_usd is not None and usage.cost_usd > 0
    assert len(events) == 1  # the pipeline telemetry still records the call


def test_main_opens_a_read_only_connection_and_writes_the_step_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://example.invalid/db")
    monkeypatch.setenv("REPLICATE_API_TOKEN", "token")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    connection = FakeConnection({})
    from src.storage import supabase_client

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda *_a, **_kw: connection)

    assert trial.main(["--sales", "2", "--chunk-chars", "25000", "--max-tokens", "8192", "--max-calls", "5"]) == 0

    assert connection.read_only is True and connection.closed is True
    assert "Ventes candidates" in capsys.readouterr().out
    assert "plafond d'appels : 5" in summary.read_text(encoding="utf-8")


def test_options_are_bounded() -> None:
    with pytest.raises(SystemExit):
        trial.parse_args(["--chunk-chars", "1000"])
    with pytest.raises(SystemExit):
        trial.parse_args(["--max-calls", "0"])
    assert trial.parse_args([]) == trial.TrialOptions()
