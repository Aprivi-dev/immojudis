"""Essai en lecture seule de la lecture des pièces candidate (scripts/document_reading_trial.py)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from scripts import document_reading_trial as trial
from scripts.fact_chunk_trial import CallCapReached, CallUsage
from src.pipeline_usage import PipelineBudgetExhausted

FILLER = " Le présent paragraphe décrit les lieux sans rien signaler de particulier." * 30
ASBESTOS = "La toiture est en plaques de fibrociment contenant de l'amiante."
OCCUPIED = "Le logement est occupé par sa propriétaire, Madame Claire DURAND, et sa famille."
SALE_A = "aaaaaaaa-0000-4000-8000-000000000001"
SALE_B = "bbbbbbbb-0000-4000-8000-000000000002"
# The profiles of the module as shipped, before the fixture below adds a candidate.
SHIPPED_PROFILES = dict(trial.PROFILES)
# A candidate next to the production profile: another prompt, fewer points, a smaller output cap.
NARROW = replace(trial.PRODUCTION_PROFILE, version="document_reading_v5", system_prompt="Consigne candidate.",
                 max_points=14, max_output_tokens=3_000)


@pytest.fixture(autouse=True)
def _one_candidate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(trial, "PROFILES", {"production": trial.PRODUCTION_PROFILE, "narrow": NARROW})


def _manifest() -> list[dict[str, Any]]:
    return [
        {"label": "PV descriptif", "url": "https://example.test/pv.pdf", "document_type": "pv_huissier",
         "pages": [{"page": 1, "text": OCCUPIED + FILLER}, {"page": 2, "text": ASBESTOS + FILLER}]},
    ]


def _row(sale_id: str) -> tuple[Any, ...]:
    facts = {
        "physical_risks": [f"risk_type: asbestos; description: Toiture amiantée; evidence: quote: {ASBESTOS}"],
        "investment_facts": [{"statement": "Occupé par Madame Claire DURAND"}, {"statement": "Mise à prix de 20 000 €"}],
    }
    stored = [{"theme": "occupation", "importance": "attention", "title": "Occupation", "explanation": None,
               "quote": OCCUPIED, "document_index": 1, "page": 1}]
    return (sale_id, f"https://example.test/{sale_id}", "house", "Lyon", None, facts, _manifest(), stored,
            "document_reading_v2", True)


class FakeConnection:
    def __init__(self, rows: dict[str, tuple[Any, ...]]) -> None:
        self.rows = rows
        self.statements: list[str] = []
        self.read_only = False
        self.closed = False
        self.rollbacks = 0

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> FakeConnection:
        self.statements.append(sql)
        if sql == trial.CANDIDATES_SQL:
            self._result: list[tuple[Any, ...]] = [(sale_id, 1) for sale_id in self.rows]
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


class FakeClient:
    model = "test-model"

    def __init__(self, answers: list[Any], *, cap: int = 100) -> None:
        self.answers = list(answers)
        self.cap = cap
        self.calls_made = 0
        self.usage: list[CallUsage] = []
        self.max_tokens = 512
        self.prompts: list[tuple[str, str, int]] = []

    def generate_json_once(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        answer = self.answers.pop(0) if self.answers else {"points": []}
        if isinstance(answer, PipelineBudgetExhausted):
            raise answer
        if self.calls_made >= self.cap:
            raise CallCapReached(f"plafond de {self.cap} appels atteint")
        self.calls_made += 1
        self.prompts.append((system_prompt, user_prompt, self.max_tokens))
        self.usage.append(CallUsage(succeeded=not isinstance(answer, Exception), input_tokens=11_000,
                                    output_tokens=900, input_tokens_estimate=11_000, output_tokens_estimate=900))
        if isinstance(answer, Exception):
            raise answer
        return answer


def _points() -> dict[str, Any]:
    return {"points": [
        {"theme": "diagnostics", "importance": "alerte", "title": "Amiante en toiture", "explanation": "À désamianter.",
         "document": "D1", "page": 2, "quote": ASBESTOS},
        {"theme": "conditions_vente", "importance": "info", "title": "Inventé", "document": "D1", "page": 1,
         "quote": "Cette phrase ne figure dans aucune page du dossier."},
    ]}


def test_trial_reads_each_sale_with_each_profile_and_never_writes() -> None:
    connection = FakeConnection({SALE_A: _row(SALE_A), SALE_B: _row(SALE_B)})
    client = FakeClient([_points(), _points(), _points(), RuntimeError("provider down")])

    report = trial.run_trial(connection, client, options=trial.TrialOptions(sales=5, profiles=("narrow", "production")))

    assert all(statement.lstrip().lower().startswith("select") for statement in connection.statements)
    assert connection.rollbacks >= 2 and client.calls_made == 4
    first, second = report.results
    assert (first.documents, first.pages, first.stored_version, first.stored_truncated) == (1, 2, "document_reading_v2", True)
    narrow = first.profiles["narrow"]
    assert (narrow.status, narrow.raw_points, len(narrow.points), narrow.rejections) == (
        "completed", 2, 1, {"quote_not_found": 1},
    )
    assert narrow.points[0]["title"] == "Amiante en toiture" and narrow.pages_read == 2 and not narrow.truncated
    assert second.profiles["production"].status == "failed" and second.profiles["production"].error == "RuntimeError"
    # Each profile is sent with its own prompt and output cap.
    assert [(prompt[0], prompt[2]) for prompt in client.prompts[:2]] == [
        ("Consigne candidate.", 3_000),
        (trial.PRODUCTION_PROFILE.system_prompt, 4_000),
    ]
    # The model reads filtered pages: no private name reaches it.
    assert all("DURAND" not in prompt[1] for prompt in client.prompts)

    markdown = trial.render_report(report)
    assert "| `aaaaaaaa` | 1 / 2 | 1 (0) tronquée | 2 | 2 → 1 (0) | quote_not_found 1 |" in markdown
    assert "failed (RuntimeError)" in markdown
    assert "- narrow : 2 lecture(s) sur 2 ; 2 points gardés sur 4 rendus" in markdown


def test_details_carry_facts_stored_and_trial_points_without_private_names() -> None:
    connection = FakeConnection({SALE_A: _row(SALE_A)})
    report = trial.run_trial(connection, FakeClient([_points()]), options=trial.TrialOptions(profiles=("narrow",)))

    lines = trial.render_details(report).splitlines()
    assert lines[0] == "::group::Détail des lectures" and lines[-1] == "::endgroup::"
    assert "DURAND" not in "\n".join(lines)
    detail = json.loads(lines[1].removeprefix("READING_DETAIL "))
    assert detail["sale_id"] == SALE_A
    assert detail["facts"]["physical_risks"] == ["risk_type: asbestos; description: Toiture amiantée"]
    assert len(detail["facts"]["investment_facts"]) == 2 and detail["facts"]["legal_risks"] == []
    assert detail["stored"]["version"] == "document_reading_v2" and len(detail["stored"]["points"]) == 1
    assert detail["trials"]["narrow"]["points"][0]["quote"] == ASBESTOS
    # The dropped point is shown with its reason and what the model wrote.
    assert detail["trials"]["narrow"]["rejected"] == [{
        "reason": "quote_not_found", "theme": "conditions_vente", "importance": "info", "title": "Inventé",
        "document": "D1", "page": "1", "quote": "Cette phrase ne figure dans aucune page du dossier.",
    }]


def test_the_production_profile_is_the_control_and_the_only_profile_without_a_candidate() -> None:
    assert SHIPPED_PROFILES == {"production": trial.PRODUCTION_PROFILE}
    assert trial.CANDIDATE_PROFILES == {}


def test_sale_prefixes_select_the_sales_and_the_call_cap_stops_the_trial() -> None:
    connection = FakeConnection({SALE_A: _row(SALE_A), SALE_B: _row(SALE_B)})
    client = FakeClient([_points()])
    options = trial.TrialOptions(sale_prefixes=("bbbbbbbb",), max_calls=1, profiles=("narrow", "production"))

    report = trial.run_trial(connection, client, options=options)

    assert report.selected == [SALE_B] and client.calls_made == 1
    assert list(report.results[0].profiles) == ["narrow"]
    assert report.stop_reason == "plafond de 1 appels atteint"


def test_trial_waits_for_the_hourly_budget_then_reads_the_same_sale_again() -> None:
    connection = FakeConnection({SALE_A: _row(SALE_A)})
    hourly = PipelineBudgetExhausted("Hourly LLM request budget exhausted")
    client = FakeClient([hourly, _points()])
    waits: list[float] = []

    report = trial.run_trial(connection, client, options=trial.TrialOptions(profiles=("narrow",)),
                             clock=lambda: 0.0, sleep=waits.append)

    result = report.results[0].profiles["narrow"]
    assert waits == [trial.HOURLY_WAIT_SECONDS] and result.budget_waits == 1
    assert result.status == "completed" and report.stop_reason is None


def test_a_daily_budget_refusal_stops_the_trial() -> None:
    connection = FakeConnection({SALE_A: _row(SALE_A), SALE_B: _row(SALE_B)})
    client = FakeClient([PipelineBudgetExhausted("Daily LLM request budget exhausted")])
    waits: list[float] = []

    report = trial.run_trial(connection, client, options=trial.TrialOptions(profiles=("narrow",)),
                             clock=lambda: 0.0, sleep=waits.append)

    assert waits == [] and len(report.results) == 1
    assert report.stop_reason is not None and report.stop_reason.startswith("budget refusé")


def test_options_are_bounded() -> None:
    for argv in (["--profiles", "v9"], ["--sale-prefixes", "xyz"], ["--sale-prefixes", "' or 1=1"],
                 ["--max-calls", "0"], ["--sales", "99"]):
        with pytest.raises(SystemExit):
            trial.parse_args(argv)
    options = trial.parse_args(["--profiles", "production", "--sale-prefixes", "af8649b4,75b07f3b"])
    assert options.profiles == ("production",) and options.sale_prefixes == ("af8649b4", "75b07f3b")
    assert trial.parse_args([]) == trial.TrialOptions()


def test_main_opens_a_read_only_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                           capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://example.invalid/db")
    monkeypatch.setenv("REPLICATE_API_TOKEN", "token")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    connection = FakeConnection({})
    from src.storage import supabase_client

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda *_a, **_kw: connection)

    assert trial.main(["--sales", "2", "--max-calls", "4"]) == 0

    assert connection.read_only is True and connection.closed is True
    assert "Ventes candidates" in capsys.readouterr().out
    assert "plafond d'appels : 4" in summary.read_text(encoding="utf-8")
