"""Banc de comparaison de la lecture des pièces : faux lecteurs, faux téléchargement, fausse base."""

from __future__ import annotations

import hashlib
import json
import logging
from collections import Counter
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
    CARREZ,
    FIELDS,
    HABITABLE,
    LAND,
    LOT_UNCERTAIN,
    OCCUPANCY,
    OCCUPANCY_VALUES,
    ONE_LOT,
    ONE_LOT_GUARDED,
    ROOMS,
    SEVERAL_LOTS,
    VISITS,
    parse_claim,
    response_schema,
)
from src.enrichment.anthropic_reader import (
    HAIKU,
    SONNET,
    DocumentReaderRefused,
    ReaderInvalidJSON,
    ReaderOutputCut,
)
from src.llm_requests import LLMRequestDeterministicCooldown, LLMRequestTransportAmbiguous
from src.pdf_enrichment import NetworkFailure, PdfEnrichmentStats
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


def _fetch(row: Mapping[str, Any], urls: Sequence[str]) -> bench.FetchedPieces:
    return bench.FetchedPieces({URL: PDF} if URL in urls else {})


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


WORD_URL = "https://example.test/cahier.docx"
RICH_PAGE = (
    "Surface habitable de 50 m2 ; 3 pieces ; le bien est loue par bail ; visite le 3 decembre ; superficie Carrez "
    "de 49 m2 ; terrain d'une contenance de 300 m2. " + FILLER
)


def _manifest_item(url: str, document_type: str, pages: dict[int, str], content: bytes | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {
        "url": url,
        "document_type": document_type,
        "pages": [{"page": number, "text": text} for number, text in pages.items()],
    }
    if content is not None:
        item["sha256"] = hashlib.sha256(content).hexdigest()
    return item


def _bench_one(
    manifest: list[dict[str, Any]],
    fetched: Mapping[str, bytes],
    primary: FakeModel | None = None,
    missing: Mapping[str, str] | None = None,
) -> bench.BenchReport:
    def fetch(row: Mapping[str, Any], urls: Sequence[str]) -> bench.FetchedPieces:
        return bench.FetchedPieces({url: content for url, content in fetched.items() if url in urls}, missing or {})

    return bench.run_bench(
        FakeConnection({SALE_ID: _row(result=manifest)}),
        _reader("principal", primary or FakeModel({})),
        _reader("second", FakeModel({})),
        fetch,
        sample=1,
        today=TODAY,
    )


def test_selection_only_keeps_pages_of_pieces_whose_pdf_is_available() -> None:
    # Défaut du banc V2 en production (21/11/2026) : les pages étaient choisies avant le téléchargement. Une pièce
    # sans PDF (document Word, ou pièce non téléchargée) aux pages plus riches prenait toutes les places, seules ses
    # pages étaient demandées, et la vente sortait en « pièces modifiées ou illisibles ».
    manifest = [
        _manifest_item(WORD_URL, "cahier_conditions_vente", {number: RICH_PAGE for number in range(1, 13)}),
        _manifest_item(URL, "cahier_conditions_vente", {1: FILLER, 2: DESCRIPTION}, PDF),
    ]
    primary = FakeModel({HABITABLE: (62.4, PRIVATE_QUOTE)})

    report = _bench_one(manifest, {URL: PDF}, primary, {WORD_URL: bench.NO_PDF_WORD})

    assert report.processed == 1 and not report.skipped
    assert primary.calls[0]["pages"] == [DESCRIPTION]
    assert report.pages.unusable == {bench.NO_PDF_WORD: 12}
    assert report.pages.missing_pieces == {bench.NO_PDF_WORD: 1}
    markdown = bench.render_report(report)
    assert "pièce sans PDF : Word 12, pièce sans PDF : HTML ou autre format 0" in markdown
    assert "PDF modifié depuis la lecture 0, PDF illisible 0, page hors bornes 0." in markdown
    assert "non obtenues (ventes comparées ou non), par motif : pièce sans PDF : Word 1, " in markdown


def test_a_pdf_that_changed_since_its_text_was_read_is_not_sent() -> None:
    report = _bench_one(MANIFEST, {URL: _pdf("autre version", DESCRIPTION)})
    assert report.skipped == {"aucune page utilisable (PDF modifié depuis la lecture)": 1}


def test_sale_without_any_usable_page_says_why() -> None:
    no_pdf = _bench_one(MANIFEST, {})
    assert no_pdf.skipped == {"aucune page utilisable (pièce sans PDF : autre motif)": 1}
    relay = _bench_one(MANIFEST, {}, missing={URL: bench.NO_PDF_RELAY})
    assert relay.skipped == {"aucune page utilisable (pièce sans PDF : relais SOURCE_FETCH_RELAY non disponible)": 1}
    # The piece is counted even though the sale is not compared.
    assert relay.pages.missing_pieces == {bench.NO_PDF_RELAY: 1}

    one_page = _pdf(DESCRIPTION)
    beyond = [_manifest_item(URL, "pv_huissier", {1: FILLER, 2: DESCRIPTION}, one_page)]
    assert _bench_one(beyond, {URL: one_page}).skipped == {"aucune page utilisable (page hors bornes)": 1}

    broken = b"%PDF-1.7 tronque"
    unreadable = [_manifest_item(URL, "pv_huissier", {1: DESCRIPTION}, broken)]
    report = _bench_one(unreadable, {URL: broken})
    assert report.skipped == {"aucune page utilisable (PDF illisible)": 1}


def test_pages_beyond_the_pdf_are_left_out_and_counted() -> None:
    one_page = _pdf(DESCRIPTION)
    manifest = [_manifest_item(URL, "pv_huissier", {1: DESCRIPTION, 7: RICH_PAGE}, one_page)]
    primary = FakeModel({})
    report = _bench_one(manifest, {URL: one_page}, primary)
    assert report.processed == 1 and primary.calls[0]["pages"] == [DESCRIPTION]
    assert report.pages.unusable == {bench.PAGE_OUT_OF_RANGE: 1}


def test_without_a_fingerprint_a_pdf_shorter_than_the_text_read_is_another_pdf() -> None:
    one_page = _pdf(DESCRIPTION)
    manifest = [_manifest_item(URL, "pv_huissier", {1: DESCRIPTION, 7: RICH_PAGE})]  # pas d'empreinte
    report = _bench_one(manifest, {URL: one_page})
    assert report.skipped == {"aucune page utilisable (PDF modifié depuis la lecture)": 1}


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
        private_review=differences.append,
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
    with bench.open_private_review(path) as handle:
        assert path.stat().st_mode & 0o777 == 0o600 and path.read_text(encoding="utf-8") == ""
        bench.write_difference(handle, differences[0])
        # Written as it comes: the line is on disk before the file is closed.
        assert [json.loads(line)["sale_id"] for line in path.read_text(encoding="utf-8").splitlines()] == [SALE_ID]


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
        bench.open_private_review(link)
    assert target.read_text(encoding="utf-8") == "intact"


def test_private_review_cannot_be_the_aggregated_report(tmp_path: Any) -> None:
    report = tmp_path / "report.md"
    with pytest.raises(SystemExit):
        bench.parse_args(["--sample", "1", "--output", str(report), "--private-review", str(report)])


def test_workflow_never_asks_for_the_private_review() -> None:
    workflow = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "document-vision-comparison.yml"
    assert "private-review" not in workflow.read_text(encoding="utf-8")


# --- Liste des écarts (artefact) ----------------------------------------------------------------------------------


def test_differences_list_public_data_only_never_the_quote_or_the_text_of_the_piece() -> None:
    differences: list[dict[str, object]] = []
    private: list[dict[str, object]] = []
    report = bench.run_bench(
        FakeConnection({SALE_ID: _row(rooms_count=4)}),
        _reader("principal", FakeModel(AGREEING)),
        _reader("second", FakeModel(AGREEING)),
        _fetch,
        sample=1,
        today=TODAY,
        private_review=private.append,
        differences=differences.append,
    )

    assert report.fields[ROOMS].versus_sale["different"] == 1
    assert differences == [
        {
            "sale_id": SALE_ID,
            "field": ROOMS,
            "retained_value": 3,
            "sale_value": 4,
            "document_index": 1,
            "document_type": "cahier",
            "page": 2,
        }
    ]
    # Neither the quote, nor any text of the piece (not even its label), nor its URL, unlike the private review.
    written = json.dumps(differences, ensure_ascii=False)
    assert "3 pieces principales" not in written and "Cahier" not in written and "pieces" not in written
    assert URL not in written and "example.test" not in written
    assert private and private[0]["quote"] == "3 pieces principales"
    # Off by default.
    assert bench.parse_args(["--sample", "1"]).differences is None


def test_differences_give_the_visit_days_of_the_sale_never_its_free_text() -> None:
    row = dict(zip((*bench.SALE_COLUMNS, *bench.SALE_VALUE_COLUMNS, "result"), _row(), strict=True))
    row[VISITS] = ["le 3 décembre 2026 à 10h, rendez-vous avec M. Martin au 06 12 34 56 78"]
    documents = {doc.index: doc for doc in bench.documents_from_manifest(MANIFEST)}
    result = bench.SaleResult({}, {}, documents, bench.PageStats())
    verdict = bench.Verdict("accepted", value=frozenset({date(2026, 12, 10)}), page=bench.PageRef(1, 2), quote="visite")

    entry = bench.public_difference(row, VISITS, verdict, result)

    assert entry == {
        "sale_id": SALE_ID,
        "field": VISITS,
        "retained_value": ["2026-12-10"],
        "sale_value": ["2026-12-03"],
        "document_index": 1,
        "document_type": "cahier",
        "page": 2,
    }


SIGNED_URL = "https://documents.test/pv-dupont.pdf?token=secret#x"


def test_differences_file_never_carries_the_url_of_the_piece(tmp_path: Any) -> None:
    # A signed URL (token) or a name in the file name: the URL is found again in the database, never in the artifact.
    manifest = [{**MANIFEST[0], "url": SIGNED_URL, "label": "PV de description Dupont", "document_type": "pv_huissier"}]
    path = tmp_path / "ecarts.jsonl"
    with bench.open_private_review(path) as handle:
        report = bench.run_bench(
            FakeConnection({SALE_ID: _row(rooms_count=4, result=manifest)}),
            _reader("principal", FakeModel(AGREEING)),
            _reader("second", FakeModel(AGREEING)),
            lambda row, urls: bench.FetchedPieces({SIGNED_URL: PDF} if SIGNED_URL in urls else {}),
            sample=1,
            today=TODAY,
            differences=lambda entry: bench.write_difference(handle, entry),
        )

    assert report.fields[ROOMS].versus_sale["different"] == 1
    written = path.read_text(encoding="utf-8")
    assert [json.loads(line)["document_type"] for line in written.splitlines()] == ["proces_verbal"]
    for fragment in (SIGNED_URL, "documents.test", "dupont", "Dupont", "token", "secret", "pv-"):
        assert fragment not in written, fragment


@pytest.mark.parametrize(
    ("document_type", "published"),
    [
        ("cahier_conditions_vente", "cahier"),
        ("conditions_vente", "cahier"),
        ("pv_huissier", "proces_verbal"),
        ("proces_verbal", "proces_verbal"),
        ("diagnostics_techniques", "diagnostic"),
        ("bail", "autre"),
        ("PV de M. Dupont", "autre"),
    ],
)
def test_differences_give_a_document_type_from_a_closed_list(document_type: str, published: str) -> None:
    assert bench.difference_document_type(document_type) == published


# Type de valeur de chaque champ dans la liste des écarts : jamais un texte libre. Un champ ajouté à FIELDS sans
# entrée ici fait échouer le test ; un champ texte n'a pas sa place dans l'artefact.
_VALUE_KINDS = {
    HABITABLE: "number",
    CARREZ: "number",
    LAND: "number",
    ROOMS: "integer",
    OCCUPANCY: "occupancy",
    VISITS: "dates",
}
FREE_TEXT = "M. Dupont, 06 12 34 56 78, 3 rue des Lilas"


def test_every_field_of_the_differences_has_a_value_type_without_free_text() -> None:
    assert set(FIELDS) == set(_VALUE_KINDS), "nouveau champ : lui donner un type sans texte libre"
    schemas = response_schema(FIELDS)["properties"]["champs"]["properties"]
    for name in FIELDS:
        value = schemas[name]["properties"]["valeur"]
        for option in value.get("anyOf", [value]):
            if option["type"] == "string":
                # A string is always an enumeration: « inconnu », or an occupancy state.
                allowed = {"inconnu"} | (OCCUPANCY_VALUES if _VALUE_KINDS[name] == "occupancy" else set())
                assert set(option["enum"]) <= allowed, name
            elif option["type"] == "array":
                assert _VALUE_KINDS[name] == "dates", name
            else:
                assert option["type"] in {"number", "integer"} and _VALUE_KINDS[name] in {"number", "integer"}, name
        # Whatever the reader writes, a free text never becomes a retained value.
        page = bench.PageRef(1, 1)
        for raw in (FREE_TEXT, [FREE_TEXT]):
            claim = parse_claim(name, {"valeur": raw, "citation": "une citation", "page": 1}, [page])
            assert claim.status == "invalid", name

    # And what reaches the file has that type.
    row = dict(zip((*bench.SALE_COLUMNS, *bench.SALE_VALUE_COLUMNS, "result"), _row(), strict=True))
    row.update({HABITABLE: 62, CARREZ: 61, LAND: 300, ROOMS: 4, OCCUPANCY: "vacant", VISITS: [FREE_TEXT]})
    retained = {
        HABITABLE: Decimal("62.4"),
        CARREZ: Decimal("61.8"),
        LAND: Decimal("850"),
        ROOMS: 3,
        OCCUPANCY: "rented",
        VISITS: frozenset({date(2026, 12, 10)}),
    }
    documents = {doc.index: doc for doc in bench.documents_from_manifest(MANIFEST)}
    result = bench.SaleResult({}, {}, documents, bench.PageStats())
    for name in FIELDS:
        verdict = bench.Verdict("accepted", value=retained[name], page=bench.PageRef(1, 2), quote=FREE_TEXT)
        entry = json.loads(json.dumps(bench.public_difference(row, name, verdict, result), default=str))
        for value in (entry["retained_value"], entry["sale_value"]):
            kind = _VALUE_KINDS[name]
            if kind == "dates":
                assert isinstance(value, list) and all(date.fromisoformat(day) for day in value), name
            elif kind == "occupancy":
                assert value in OCCUPANCY_VALUES, name
            else:
                assert isinstance(value, (int, float)) or Decimal(value) > 0, name
        assert "Dupont" not in json.dumps(entry, ensure_ascii=False), name


def test_differences_file_is_written_for_the_owner_only(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.storage import supabase_client

    path = tmp_path / "ecarts.jsonl"
    path.write_text("ancien contenu", encoding="utf-8")
    path.chmod(0o644)
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://banc.test/base")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "cle-de-test")

    def refuse(url: str) -> Any:
        raise RuntimeError("pas de base dans ce test")

    monkeypatch.setattr(supabase_client, "connect", refuse)
    # main() quiets the download log: its level is restored for the other tests.
    logger = logging.getLogger("src.pdf_enrichment")
    previous = logger.level
    try:
        with pytest.raises(RuntimeError):
            bench.main(["--sample", "1", "--output", str(tmp_path / "report.md"), "--differences", str(path)])
    finally:
        logger.setLevel(previous)
    # Opened before the database, like the private review: 0600, emptied.
    assert path.stat().st_mode & 0o777 == 0o600 and path.read_text(encoding="utf-8") == ""


def test_differences_file_is_another_file_than_the_report_and_the_private_review(tmp_path: Any) -> None:
    report, review = tmp_path / "report.md", tmp_path / "review.jsonl"
    for argv in (
        ["--output", str(report), "--differences", str(report)],
        ["--output", str(report), "--private-review", str(review), "--differences", str(review)],
    ):
        with pytest.raises(SystemExit):
            bench.parse_args(["--sample", "1", *argv])
    assert bench.parse_args(["--sample", "1", "--differences", str(tmp_path / "ecarts.jsonl")]).differences


def test_workflow_uploads_the_differences_in_their_own_artifact_kept_seven_days() -> None:
    workflow = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "document-vision-comparison.yml"
    text = workflow.read_text(encoding="utf-8")
    assert '--differences "$RUNNER_TEMP/document-vision-differences.jsonl"' in text
    upload = text.split("name: document-vision-differences", 1)[1]
    assert "path: ${{ runner.temp }}/document-vision-differences.jsonl" in upload
    assert "retention-days: 7" in upload
    # The aggregated report keeps its own artifact and retention.
    assert "name: document-vision-report" in text and "retention-days: 30" in text


def test_workflow_gives_the_relay_to_the_bench_step_only_as_the_pipeline_does() -> None:
    workflows = Path(__file__).resolve().parents[3] / ".github" / "workflows"
    text = (workflows / "document-vision-comparison.yml").read_text(encoding="utf-8")
    pipeline = (workflows / "data-pipeline.yml").read_text(encoding="utf-8")
    url = "SOURCE_FETCH_RELAY_URL: ${{ vars.SOURCE_FETCH_RELAY_URL }}"
    token = "SOURCE_FETCH_RELAY_TOKEN: ${{ secrets.SOURCE_FETCH_RELAY_TOKEN }}"
    # Same origin as the pipeline: the address is a variable, the token a secret.
    assert url in pipeline and token in pipeline
    header, *steps = text.split("\n      - name: ")
    names = ("SOURCE_FETCH_RELAY_URL:", "SOURCE_FETCH_RELAY_TOKEN:")
    assert not any(name in header for name in names)  # not in the job environment
    receiving = [step.splitlines()[0] for step in steps if any(name in step for name in names)]
    assert receiving == ["Run the read-only comparison"]
    bench_step = next(step for step in steps if step.startswith("Run the read-only comparison"))
    assert url in bench_step and token in bench_step
    # Never shown: no command of the workflow reads them.
    assert "$SOURCE_FETCH_RELAY" not in text and "env.SOURCE_FETCH_RELAY" not in text


# --- Pièces sans PDF : pourquoi -----------------------------------------------------------------------------------

RELAYED_URL = "https://cessions.immobilier-etat.gouv.fr/documents/cahier.pdf"


@pytest.mark.parametrize(
    ("address", "token", "available"),
    [
        ("https://relais.test/fetch", "jeton", True),
        ("https://relais.test/fetch", "", False),
        ("", "jeton", False),
        ("", "", False),
        ("http://relais.test/fetch", "jeton", False),
    ],
)
def test_relay_is_available_only_with_an_https_address_and_a_token(
    monkeypatch: pytest.MonkeyPatch, address: str, token: str, available: bool
) -> None:
    monkeypatch.setenv("SOURCE_FETCH_RELAY_URL", address)
    monkeypatch.setenv("SOURCE_FETCH_RELAY_TOKEN", token)
    assert bench.relay_configured(RELAYED_URL) is available
    # Another host never goes through the relay.
    assert bench.relay_configured(URL) is False


def _stats(**lists: Any) -> PdfEnrichmentStats:
    return PdfEnrichmentStats(**lists)


@pytest.mark.parametrize(
    ("url", "options", "stats", "reason"),
    [
        (URL, {"file_format": "docx"}, _stats(), bench.NO_PDF_WORD),
        (URL, {"file_format": "doc"}, _stats(), bench.NO_PDF_WORD),
        (URL, {"selected": False}, _stats(), bench.NO_PDF_CAP),
        (URL, {"selected": False, "selectable_alone": False}, _stats(), bench.NO_PDF_OTHER),
        (URL, {"document_type": "other"}, _stats(), bench.NO_PDF_OTHER),
        (URL, {}, _stats(blocked_document_urls=[URL]), bench.NO_PDF_ROBOTS),
        (URL, {}, _stats(permanent_document_failures=[{"url": URL, "reason": "robots_disallowed"}]), bench.NO_PDF_ROBOTS),
        (URL, {}, _stats(permanent_document_failures=[{"url": URL, "reason": "unsupported_response"}]), bench.NO_PDF_HTML),
        (URL, {}, _stats(permanent_document_failures=[{"url": URL, "reason": "not_found"}]), bench.NO_PDF_OTHER),
        (URL, {}, _stats(network_failures=[NetworkFailure(URL, "timeout", False)]), bench.NO_PDF_NETWORK),
        (URL, {}, _stats(network_failures=[NetworkFailure("https://example.test", "robots.txt timeout", True)]), bench.NO_PDF_NETWORK),
        (URL, {}, _stats(network_failures=[NetworkFailure("https://other.test", "timeout", True)]), bench.NO_PDF_OTHER),
        (URL, {}, _stats(), bench.NO_PDF_OTHER),
        # Cessions Etat answers 403 to the runner: without the relay, that is the cause.
        (RELAYED_URL, {}, _stats(permanent_document_failures=[{"url": RELAYED_URL, "reason": "access_denied"}]), bench.NO_PDF_RELAY),
        (RELAYED_URL, {"relay_available": True}, _stats(permanent_document_failures=[{"url": RELAYED_URL, "reason": "access_denied"}]), bench.NO_PDF_OTHER),
    ],
)
def test_missing_piece_reason_says_why_the_bench_did_not_get_the_pdf(
    url: str, options: dict[str, Any], stats: PdfEnrichmentStats, reason: str
) -> None:
    arguments: dict[str, Any] = {
        "file_format": None,
        "selected": True,
        "selectable_alone": True,
        "document_type": "cahier_conditions_vente",
        "relay_available": False,
        **options,
    }
    assert bench.missing_piece_reason(url, stats=stats, **arguments) == reason


def test_download_names_the_piece_cut_by_the_limit_of_pieces_per_sale(monkeypatch: pytest.MonkeyPatch) -> None:
    from src import pdf_document_selection, pdf_enrichment

    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    monkeypatch.delenv("SOURCE_FETCH_RELAY_URL", raising=False)
    urls = [f"https://example.test/pv-{number}.pdf" for number in range(1, 8)]
    documents = [
        {"url": url, "label": f"Proces-verbal {number}", "document_type": "pv_huissier"}
        for number, url in enumerate(urls, 1)
    ]
    row = dict(zip((*bench.SALE_COLUMNS, *bench.SALE_VALUE_COLUMNS, "result"), _row(documents=documents), strict=True))

    def download(sale: Any, output_root: Path, stats: PdfEnrichmentStats) -> list[dict[str, str]]:
        selected = pdf_document_selection.select_documents_for_extraction(sale.documents, sale=sale)
        downloaded = []
        for document in selected:
            if document["url"] == urls[1]:
                stats.blocked_document_urls.append(document["url"])
                continue
            path = output_root / Path(document["url"]).name
            path.write_bytes(PDF)
            downloaded.append({"url": document["url"], "file_path": str(path), "file_format": "pdf"})
        return downloaded

    monkeypatch.setattr(pdf_enrichment, "download_documents", download)

    fetched = bench.download_sale_pdfs(row, urls)

    assert sorted(fetched.pdfs) == sorted(set(urls) - {urls[1], urls[6]})
    assert fetched.missing == {urls[1]: bench.NO_PDF_ROBOTS, urls[6]: bench.NO_PDF_CAP}


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
    unreadable: Counter[str] = Counter()
    assert bench.image_pages(pdfs, pages, frozenset(), unreadable) == frozenset({bench.PageRef(2, 1)})
    assert bench.image_pages(pdfs, pages, frozenset({bench.PageRef(2, 1)}), unreadable) == frozenset()
    assert unreadable == Counter()


def test_a_piece_that_pymupdf_cannot_open_is_skipped_and_counted_by_type() -> None:
    unreadable: Counter[str] = Counter()
    pdfs = {1: b"pas un PDF", 2: _image_pdf(SCANNED_HEADER)}
    pages = [bench.PageRef(1, 1), bench.PageRef(2, 1)]
    assert bench.image_pages(pdfs, pages, frozenset(), unreadable) == frozenset({bench.PageRef(2, 1)})
    assert bench.tesseract_page_reader(pdfs, unreadable)(bench.PageRef(1, 1)) is None
    assert sum(unreadable.values()) == 2 and len(unreadable) == 1
    kind = next(iter(unreadable))
    report = bench.BenchReport(sample=1, unreadable=unreadable)
    assert f"par type d'erreur : {kind} 2." in bench.render_report(report)


def test_tesseract_reader_returns_the_ocr_text_alone_never_the_text_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    # Without Tesseract (or on a blank image), the OCR reads nothing: no text.
    read = bench.tesseract_page_reader({1: _image_pdf(SCANNED_HEADER)}, Counter())
    assert read(bench.PageRef(1, 1)) is None
    assert read(bench.PageRef(1, 9)) is None and read(bench.PageRef(2, 1)) is None

    fallbacks: list[str] = []

    def ocr(page: Any, fallback: str, *, settings: Mapping[str, object]) -> dict[str, object]:
        fallbacks.append(fallback)
        return {"text": "Surface habitable lue par OCR", "method": "ocr_tesseract", "status": "extracted"}

    monkeypatch.setattr(bench, "extract_page_text_with_ocr_result", ocr)
    text = bench.tesseract_page_reader({1: _image_pdf(SCANNED_HEADER)}, Counter())(bench.PageRef(1, 1))
    assert text == "Surface habitable lue par OCR" and SCANNED_HEADER not in text
    assert fallbacks == [""]


def test_bench_reads_a_cited_image_page_by_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    scanned = _image_pdf(SCANNED_HEADER)
    manifest = [{"url": URL, "sha256": hashlib.sha256(scanned).hexdigest(), "pages": [{"page": 1, "text": SCANNED_HEADER}]}]
    read: list[bench.PageRef] = []

    def reader(pdfs: Mapping[int, bytes], unreadable: Counter[str]) -> Any:
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
        lambda row, urls: bench.FetchedPieces({URL: scanned}),
        sample=1,
        today=TODAY,
    )
    assert report.fields[HABITABLE].statuses["accepted"] == 1
    assert report.fields[HABITABLE].quote_matches == {"ocr_du_banc": 1}
    assert read == [bench.PageRef(1, 1)]


def test_report_shows_the_prompt_version() -> None:
    assert f"- Version du prompt : {bench.PROMPT_VERSION}." in bench.render_report(bench.BenchReport(sample=1))


def test_second_reader_gets_the_page_before_the_cited_one_when_the_sold_lot_is_designated() -> None:
    title = "Designation des biens mis en vente aux encheres publiques. DEUXIEME LOT"
    description = "Un appartement de 3 pieces principales, au deuxieme etage de l'immeuble."
    pdf = _pdf(title, description)
    manifest = [_manifest_item(URL, "cahier_conditions_vente", {1: title, 2: description}, pdf)]
    selection = {"status": "selected", "lot_number": 2, "lot_count": 2}
    row = _row(result=manifest, raw_payload={"source_lot_selection": selection}, quality_flags=["multi_lot_sale"])
    primary = FakeModel({ROOMS: (3, "Un appartement de 3 pieces principales")})
    second = FakeModel({})

    bench.run_bench(
        FakeConnection({SALE_ID: row}),
        _reader("principal", primary),
        _reader("second", second),
        lambda row, urls: bench.FetchedPieces({URL: pdf}),
        sample=1,
        today=TODAY,
    )

    assert primary.calls[0]["pages"] == [description]
    # La page citée et celle qui la précède, où se trouve le titre du lot vendu.
    assert second.calls[0]["pages"] == [title, description]
