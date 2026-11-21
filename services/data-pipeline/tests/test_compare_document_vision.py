"""Banc de comparaison de la lecture des pièces : faux lecteurs, faux téléchargement, fausse base."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import anthropic
import httpx2
import pymupdf
import pytest

from scripts import compare_document_vision as bench
from src.document_vision import (
    HABITABLE,
    LOT_UNCERTAIN,
    OCCUPANCY,
    ONE_LOT,
    ONE_LOT_GUARDED,
    ROOMS,
    SEVERAL_LOTS,
    VISITS,
)
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
    # Diagnostic: how the primary quotes were found, why fields are unknown, which pages were sent.
    assert report.fields[HABITABLE].quote_matches == {"exacte": 1}
    assert report.fields[VISITS].details == {"unknown:aucun_indice": 1}
    assert report.pages.with_field_words == 1 and report.pages.sent == 1 and report.pages.capped_sales == 0
    assert "### Diagnostic" in markdown
    assert "| habitable_surface_m2 | 1 | 0 | 0 | 0 |" in markdown.split("### Diagnostic")[1]


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
    assert report.fields[HABITABLE].details["lot_non_identifie:vente_plusieurs_lots"] == 1
    assert "| habitable_surface_m2 | 0 | 0 | 1 | 0 |" in bench.render_report(report)


@pytest.mark.parametrize("value", ["0", "31", "x"])
def test_sample_is_bounded_to_thirty(value: str) -> None:
    with pytest.raises(SystemExit):
        bench.parse_args(["--sample", value])


@pytest.mark.parametrize(
    ("raw_payload", "flags", "situation", "designated"),
    [
        ({}, [], ONE_LOT, False),
        ({"pdf_multi_lot_guard": {"status": "ambiguous"}}, [], ONE_LOT_GUARDED, False),
        ({}, ["multi_lot_sale"], SEVERAL_LOTS, False),
        ({"source_lot_selection": {"status": "ambiguous"}}, ["multi_lot_sale"], LOT_UNCERTAIN, False),
        ({"source_lot_selection": {"status": "selected", "lot_number": 2, "lot_count": 3}}, ["multi_lot_sale"], SEVERAL_LOTS, True),
    ],
)
def test_sale_context_reads_the_lot_situation_of_the_sale(
    raw_payload: dict[str, Any], flags: list[str], situation: str, designated: bool
) -> None:
    context = bench.sale_context(raw_payload, "apartment", "Nice", flags)
    assert context.lot_situation == situation
    assert (context.sold_lot is not None) is designated


# --- Revue privée des écarts --------------------------------------------------------------------------------------

AGREEING = {ROOMS: (3, "3 pieces principales")}


def test_private_review_lists_retained_values_that_differ_from_the_sale_and_never_reaches_the_report(
    tmp_path: Any,
) -> None:
    differences: list[dict[str, object]] = []
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row(rooms_count=4)}),
        _reader("principal", FakeModel(AGREEING)),
        _reader("second", FakeModel(AGREEING)),
        _fetch,
        sample=1,
        today=TODAY,
        private_review=differences,
    )

    assert report.fields[ROOMS].versus_sale["different"] == 1
    assert differences == [
        {
            "sale_id": SALE_ID,
            "source_url": "https://example.test/vente",
            "field": ROOMS,
            "retained_value": 3,
            "sale_value": 4,
            "quote": "3 pieces principales",
            "document": {"ref": "D1", "label": "Cahier des conditions de vente", "url": URL},
            "page": 2,
        }
    ]
    markdown = bench.render_report(report)
    assert SALE_ID not in markdown and "3 pieces principales" not in markdown and URL not in markdown

    path = tmp_path / "ecarts.jsonl"
    path.write_text("ancien contenu", encoding="utf-8")
    path.chmod(0o644)
    bench.write_private_review(path, differences)
    assert path.stat().st_mode & 0o777 == 0o600
    lines = path.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["sale_id"] for line in lines] == [SALE_ID]


def test_private_review_is_off_by_default_and_never_follows_a_symbolic_link(tmp_path: Any) -> None:
    # Same values as above, without the option: nothing is collected.
    bench.run_bench(
        FakeConnection({SALE_ID: _row(rooms_count=4)}),
        _reader("principal", FakeModel(AGREEING)),
        _reader("second", FakeModel(AGREEING)),
        _fetch,
        sample=1,
        today=TODAY,
    )
    assert bench.parse_args(["--sample", "1"]).private_review is None

    target = tmp_path / "ailleurs.txt"
    target.write_text("intact", encoding="utf-8")
    link = tmp_path / "lien.jsonl"
    link.symlink_to(target)
    with pytest.raises(OSError):
        bench.write_private_review(link, [{"sale_id": SALE_ID}])
    assert target.read_text(encoding="utf-8") == "intact"


def test_private_review_cannot_be_the_aggregated_report(tmp_path: Any) -> None:
    report = tmp_path / "report.md"
    with pytest.raises(SystemExit):
        bench.parse_args(["--sample", "1", "--output", str(report), "--private-review", str(report)])


def test_workflow_never_asks_for_the_private_review() -> None:
    workflow = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "document-vision-comparison.yml"
    assert "private-review" not in workflow.read_text(encoding="utf-8")


# --- Pages : texte, OCR, images -----------------------------------------------------------------------------------


def _image_pdf(text: str) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((72, 40), text, fontsize=8)
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 80), 0)
    pixmap.clear_with(255)
    page.insert_image(pymupdf.Rect(36, 60, 559, 800), pixmap=pixmap)
    content = document.tobytes()
    document.close()
    return content


SCANNED_HEADER = "PROCES-VERBAL DE DESCRIPTION : surface et pieces du bien, constat de l'huissier"


def test_ocr_and_unread_pages_are_read_from_the_manifest() -> None:
    manifest = [
        {
            "url": URL,
            "pages": [
                {"page": 1, "text": FILLER, "method": "pymupdf_text"},
                {"page": 2, "text": DESCRIPTION, "method": "ocr_tesseract"},
                {"page": 3, "text": FILLER, "method": "ocr_picture_no_text"},
                {"page": 4, "text": "", "method": "fallback_text", "status": "failed"},
                {"page": 5, "text": "", "method": "blank_page", "status": "blank_excluded"},
                {"page": 6, "text": "", "method": "ocr_picture_no_text", "status": "picture_page_excluded"},
            ],
        }
    ]
    documents = bench.documents_from_manifest(manifest)
    assert bench.ocr_read_pages(manifest, documents) == frozenset({bench.PageRef(1, 2)})
    assert bench.unread_page_count(manifest, documents) == 1


def test_image_pages_are_pages_mostly_covered_by_an_image_and_not_read_by_ocr() -> None:
    pdfs = {1: _pdf(FILLER, DESCRIPTION), 2: _image_pdf(SCANNED_HEADER)}
    pages = [bench.PageRef(1, 1), bench.PageRef(1, 2), bench.PageRef(2, 1), bench.PageRef(3, 1)]
    assert bench.image_pages(pdfs, pages, frozenset()) == frozenset({bench.PageRef(2, 1)})
    assert bench.image_pages(pdfs, pages, frozenset({bench.PageRef(2, 1)})) == frozenset()


def test_tesseract_reader_returns_nothing_when_ocr_reads_nothing_new() -> None:
    # Without Tesseract (or on a blank image), the OCR keeps the text layer: nothing new, no text.
    read = bench.tesseract_page_reader({1: _image_pdf(SCANNED_HEADER)})
    assert read(bench.PageRef(1, 1)) is None
    assert read(bench.PageRef(1, 9)) is None and read(bench.PageRef(2, 1)) is None


def test_bench_reads_a_cited_image_page_by_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    scanned = _image_pdf(SCANNED_HEADER)
    manifest = [{"url": URL, "sha256": hashlib.sha256(scanned).hexdigest(), "pages": [{"page": 1, "text": SCANNED_HEADER}]}]
    read: list[bench.PageRef] = []

    def reader(pdfs: Mapping[int, bytes]) -> Any:
        def read_page(ref: bench.PageRef) -> str:
            read.append(ref)
            return DESCRIPTION

        return read_page

    monkeypatch.setattr(bench, "tesseract_page_reader", reader)
    values = {HABITABLE: (62.4, PRIVATE_QUOTE)}
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row(result=manifest, habitable_surface_m2=None)}),
        _reader("principal", FakeModel(values)),
        _reader("second", FakeModel(values)),
        lambda row, urls: {URL: scanned},
        sample=1,
        today=TODAY,
    )
    assert report.fields[HABITABLE].statuses["accepted"] == 1
    assert report.fields[HABITABLE].quote_matches == {"ocr_du_banc": 1}
    assert read == [bench.PageRef(1, 1)]
