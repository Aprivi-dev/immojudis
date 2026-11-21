"""Banc de comparaison de la lecture des pièces : faux lecteurs, faux téléchargement, fausse base."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal
from typing import Any

import anthropic
import httpx2
import pymupdf
import pytest

from scripts import compare_document_vision as bench
from src.document_vision import HABITABLE, OCCUPANCY, ROOMS, VISITS
from src.enrichment.anthropic_reader import (
    HAIKU,
    SONNET,
    DocumentReaderRefused,
    ReaderInvalidJSON,
    ReaderOutputCut,
)
from src.llm_requests import LLMRequestDeterministicCooldown, LLMRequestTransportAmbiguous
from src.pipeline_usage import PipelineBudgetExhausted

TODAY = date(2026, 11, 21)
SALE_ID = "5a1e0000-0000-4000-8000-000000000001"
URL = "https://example.test/cahier.pdf"
DESCRIPTION = "Appartement de 3 pieces principales, surface habitable de 62,40 m2, actuellement loue par bail."
FILLER = "Le present cahier est depose au greffe du tribunal judiciaire de la ville."
PRIVATE_QUOTE = "surface habitable de 62,40 m2"


def _pdf(*texts: str) -> bytes:
    document = pymupdf.open()
    for text in texts:
        document.new_page(width=595, height=842).insert_text((72, 72), text, fontsize=8)
    content = document.tobytes()
    document.close()
    return content


PDF = _pdf(FILLER, DESCRIPTION)
MANIFEST = [
    {
        "url": URL,
        "label": "Cahier des conditions de vente",
        "document_type": "cahier_conditions_vente",
        "sha256": hashlib.sha256(PDF).hexdigest(),
        "pages": [{"page": 1, "text": FILLER}, {"page": 2, "text": DESCRIPTION}],
    }
]


def _row(**overrides: Any) -> tuple[Any, ...]:
    values: dict[str, Any] = dict.fromkeys((*bench.SALE_COLUMNS, *bench.SALE_VALUE_COLUMNS))
    values.update(
        id=SALE_ID,
        source_name="licitor",
        source_url="https://example.test/vente",
        documents=[{"url": URL, "label": "Cahier"}],
        raw_payload={},
        quality_flags=[],
        habitable_surface_m2=62,
        rooms_count=4,
        occupancy_status=None,
        visit_dates=[],
        result=MANIFEST,
    )
    values.update(overrides)
    return tuple(values[column] for column in (*bench.SALE_COLUMNS, *bench.SALE_VALUE_COLUMNS, "result"))


class FakeConnection:
    def __init__(self, rows: dict[str, tuple[Any, ...]]) -> None:
        self.rows = rows
        self.statements: list[str] = []
        self.read_only = False
        self.read_only_at_each_query: list[bool] = []

    def execute(self, sql: str, parameters: tuple[Any, ...] = ()) -> Any:
        self.read_only_at_each_query.append(self.read_only is True)
        self.statements.append(sql)
        rows = self.rows

        class Cursor:
            def fetchall(self) -> list[tuple[str]]:
                return [(sale_id,) for sale_id in rows]

            def fetchone(self) -> tuple[Any, ...] | None:
                return rows.get(str(parameters[0]))

        return Cursor()

    def rollback(self) -> None:
        return None


def _answer(fields: Sequence[str], values: Mapping[str, tuple[object, str]]) -> dict[str, object]:
    champs = {
        name: {"valeur": values[name][0], "citation": values[name][1], "page": 1}
        if name in values
        else {"valeur": "inconnu", "citation": "", "page": 0}
        for name in fields
    }
    return {"plusieurs_lots": "non", "champs": champs}


class FakeModel:
    def __init__(self, values: Mapping[str, tuple[object, str]], error: Exception | None = None) -> None:
        self.values = values
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def __call__(self, system: str, user: str, pdf: bytes, schema: Mapping[str, Any]) -> Mapping[str, object]:
        fields = list(schema["properties"]["champs"]["properties"])
        with pymupdf.open(stream=pdf, filetype="pdf") as document:
            pages = [page.get_text().strip() for page in document]
        self.calls.append({"fields": fields, "pages": pages, "user": user})
        if self.error is not None:
            raise self.error
        return _answer(fields, self.values)


def _reader(
    role: str, model: FakeModel, max_calls: int = 30, spend: bench.SpendCap | None = None
) -> bench.Reader:
    stats = bench.ReaderStats(model=HAIKU if role == "principal" else SONNET)
    return bench.Reader(role, model, stats, max_calls, spend or bench.SpendCap(Decimal("3")))


def _fetch(row: Mapping[str, Any], urls: Sequence[str]) -> dict[str, bytes]:
    return {URL: PDF} if URL in urls else {}


PRIMARY_VALUES = {
    HABITABLE: (62.4, PRIVATE_QUOTE),
    ROOMS: (3, "3 pieces principales"),
    OCCUPANCY: ("rented", "actuellement loue par bail"),
}


def test_bench_compares_fields_and_reports_aggregates_only() -> None:
    primary = FakeModel(PRIMARY_VALUES)
    second = FakeModel({HABITABLE: (62.4, PRIVATE_QUOTE), ROOMS: (4, "3 pieces principales")})
    connection = FakeConnection({SALE_ID: _row()})

    report = bench.run_bench(
        connection, _reader("principal", primary), _reader("second", second), _fetch, sample=5, today=TODAY
    )

    assert report.processed == 1
    assert report.fields[HABITABLE].statuses["accepted"] == 1
    assert report.fields[HABITABLE].versus_sale["same"] == 1
    assert report.fields[ROOMS].statuses["disagreement"] == 1
    assert report.fields[OCCUPANCY].reasons["second_inconnu"] == 1
    assert report.fields[VISITS].statuses["unknown"] == 1
    # The primary reader reads the pages about the fields only; the second one rereads the cited page only.
    assert primary.calls[0]["pages"] == [DESCRIPTION]
    assert second.calls[0]["pages"] == [DESCRIPTION]
    assert second.calls[0]["fields"] == [HABITABLE, ROOMS, OCCUPANCY]
    # Read-only: only selects reach the database.
    assert all(statement.strip().lower().startswith("select") for statement in connection.statements)

    markdown = bench.render_report(report)
    assert SALE_ID not in markdown and SALE_ID[:8] not in markdown
    assert PRIVATE_QUOTE not in markdown and URL not in markdown and "loue" not in markdown
    assert "| habitable_surface_m2 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |" in markdown


def test_second_reader_is_not_called_without_a_candidate() -> None:
    second = FakeModel({})
    bench.run_bench(
        FakeConnection({SALE_ID: _row()}),
        _reader("principal", FakeModel({})),
        _reader("second", second),
        _fetch,
        sample=1,
        today=TODAY,
    )
    assert second.calls == []


def test_budget_refusal_stops_the_bench_cleanly_without_counting_the_sale() -> None:
    primary = FakeModel({}, error=PipelineBudgetExhausted("Daily LLM budget exhausted"))
    other = "5a1e0000-0000-4000-8000-000000000002"
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row(), other: _row(id=other)}),
        _reader("principal", primary),
        _reader("second", FakeModel({})),
        _fetch,
        sample=2,
        today=TODAY,
    )
    assert report.stop_reason == "principal : PipelineBudgetExhausted"
    assert report.processed == 0 and len(primary.calls) == 1


def test_call_cap_stops_the_bench() -> None:
    other = "5a1e0000-0000-4000-8000-000000000002"
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row(), other: _row(id=other)}),
        _reader("principal", FakeModel({}), max_calls=1),
        _reader("second", FakeModel({})),
        _fetch,
        sample=2,
        today=TODAY,
    )
    assert report.processed == 1 and "plafond de 1 appels" in str(report.stop_reason)


_REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (DocumentReaderRefused(), "refus"),
        (ReaderOutputCut("stopped on max_tokens"), "max_tokens"),
        (anthropic.BadRequestError("bad", response=httpx2.Response(400, request=_REQUEST), body=None), "400"),
        (LLMRequestTransportAmbiguous("timeout"), "délai"),
        (ReaderInvalidJSON("Invalid JSON from LLM"), "json_invalide"),
        (anthropic.RateLimitError("slow", response=httpx2.Response(429, request=_REQUEST), body=None), "limite_de_débit"),
        (LLMRequestDeterministicCooldown("blocked for 24 hours after invalid JSON"), "bloquée_24h"),
        (RuntimeError("unexpected"), "autre"),
    ],
)
def test_reader_failure_skips_the_sale_and_is_counted_by_kind(error: Exception, kind: str) -> None:
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row()}),
        _reader("principal", FakeModel({}, error=error)),
        _reader("second", FakeModel({})),
        _fetch,
        sample=1,
        today=TODAY,
    )
    assert report.skipped["lecture principale en échec"] == 1
    assert report.readers["principal"].failures == {kind: 1}
    # Only this sale is skipped: the bench goes on.
    assert report.stop_reason is None
    markdown = bench.render_report(report)
    assert f"échecs : {kind} 1" in markdown
    # The error message never reaches the report.
    assert str(error) not in markdown or not str(error)


def test_connection_is_read_only_before_the_first_query() -> None:
    connection = FakeConnection({SALE_ID: _row()})
    bench.run_bench(
        connection, _reader("principal", FakeModel({})), _reader("second", FakeModel({})), _fetch, sample=1, today=TODAY
    )
    assert connection.read_only is True
    assert connection.read_only_at_each_query and all(connection.read_only_at_each_query)


def test_spending_cap_stops_the_bench_before_a_call_that_could_exceed_it() -> None:
    spend = bench.SpendCap(Decimal("0.02"))
    primary = FakeModel({})
    bench.run_bench(
        FakeConnection({SALE_ID: _row()}),
        _reader("principal", primary, spend=spend),
        _reader("second", FakeModel({}), spend=spend),
        _fetch,
        sample=1,
        today=TODAY,
    )
    # A Haiku call of one page may cost up to about 0.0085 USD: the first fits, a second would not after it.
    assert len(primary.calls) == 1
    spend_after_one = spend.committed
    assert Decimal(0) < spend_after_one <= Decimal("0.02")

    tight = bench.SpendCap(Decimal("0.001"))
    stopped = bench.run_bench(
        FakeConnection({SALE_ID: _row()}),
        _reader("principal", FakeModel({}), spend=tight),
        _reader("second", FakeModel({}), spend=tight),
        _fetch,
        sample=1,
        today=TODAY,
    )
    assert stopped.stop_reason == "principal : plafond de dépense de 0.001 $ atteint"
    assert stopped.processed == 0 and tight.committed == 0


@pytest.mark.parametrize("value", ["0", "-1", "5.01", "abc"])
def test_spending_cap_is_bounded_by_the_shared_daily_budget(value: str) -> None:
    with pytest.raises(SystemExit):
        bench.parse_args(["--sample", "1", "--max-usd", value])
    assert bench.parse_args(["--sample", "1"]).max_usd == Decimal("3")


def test_document_download_logs_no_url(monkeypatch: pytest.MonkeyPatch) -> None:
    logger = logging.getLogger("src.pdf_enrichment")
    previous = logger.level
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    try:
        assert bench.main(["--sample", "1"]) == 2  # stops early: no database configured
        assert logger.level == logging.ERROR
    finally:
        logger.setLevel(previous)


def test_a_pdf_that_changed_since_its_text_was_read_is_not_sent() -> None:
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row()}),
        _reader("principal", FakeModel({})),
        _reader("second", FakeModel({})),
        lambda row, urls: {URL: _pdf("autre version", DESCRIPTION)},
        sample=1,
        today=TODAY,
    )
    assert report.skipped["pièces modifiées ou illisibles depuis leur lecture"] == 1


def test_multi_lot_sale_without_identified_lot_rejects_values() -> None:
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row(quality_flags=["multi_lot_sale"])}),
        _reader("principal", FakeModel(PRIMARY_VALUES)),
        _reader("second", FakeModel(PRIMARY_VALUES)),
        _fetch,
        sample=1,
        today=TODAY,
    )
    assert report.fields[HABITABLE].reasons["lot_non_identifie"] == 1


@pytest.mark.parametrize("value", ["0", "31", "x"])
def test_sample_is_bounded_to_thirty(value: str) -> None:
    with pytest.raises(SystemExit):
        bench.parse_args(["--sample", value])
