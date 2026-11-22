"""Passe d'écriture de la lecture des pièces par Claude (lot V3b-1) : faux lecteurs, fausse fiche, fausse base."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pymupdf
import pytest
from psycopg.types.json import Jsonb

from src import autonomous_runner, pdf_enrichment
from src import document_vision_pass as vision
from src import document_vision_pieces as pieces
from src import document_vision_reading as reading
from src.document_reading import ReadingDocument
from src.document_vision import (
    ACCEPTED,
    CARREZ,
    HABITABLE,
    LAND,
    OCCUPANCY,
    PROMPT_VERSION,
    ROOMS,
    TRACE_READER,
    PageRef,
    Verdict,
)
from src.document_vision_pieces import FetchedPieces
from src.document_vision_reading import Reader, ReaderStats, SpendCap
from src.enrichment.anthropic_reader import HAIKU, SONNET
from src.known_enrichment import preserve_known_enrichment_payloads
from src.models import AuctionSale
from src.pipeline_usage import PipelineBudgetExhausted

TODAY = date(2026, 11, 21)
SALE_ID = "5a1e0000-0000-4000-8000-000000000001"
SOURCE_URL = "https://example.test/vente-sur-licitation"
PIECE_URL = "https://example.test/pieces/cahier-des-conditions.pdf"
OTHER_URL = "https://example.test/pieces/proces-verbal.pdf"
DB_URL = "postgresql://example.test/db"
QUOTE = "surface habitable de 62,40 m2"
DESCRIPTION = "Appartement de 3 pieces principales, surface habitable de 62,40 m2, actuellement loue par bail."
FILLER = "Le present cahier est depose au greffe du tribunal judiciaire de la ville."
OPEN_FIELDS = (HABITABLE, CARREZ, LAND, ROOMS, OCCUPANCY)
MODELS = {"primary": HAIKU, "second": SONNET}
VALUES = {
    HABITABLE: (62.4, QUOTE),
    ROOMS: (3, "3 pieces principales"),
    OCCUPANCY: ("rented", "actuellement loue par bail"),
}


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
        "url": PIECE_URL,
        "label": "Cahier des conditions de vente",
        "document_type": "cahier_conditions_vente",
        "sha256": hashlib.sha256(PDF).hexdigest(),
        "pages": [{"page": 1, "text": FILLER}, {"page": 2, "text": DESCRIPTION}],
    }
]
TEXT_AT = datetime(2026, 11, 20, 8, 0, tzinfo=UTC)


class FakeModel:
    def __init__(self, values: Mapping[str, tuple[object, str]], error: Exception | None = None) -> None:
        self.values = values
        self.error = error
        self.calls = 0

    def __call__(self, system: str, user: str, pdf: bytes, schema: Mapping[str, Any]) -> Mapping[str, object]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        fields = list(schema["properties"]["champs"]["properties"])
        champs = {
            name: {"valeur": self.values[name][0], "citation": self.values[name][1], "page": 1}
            if name in self.values
            else {"valeur": "inconnu", "citation": "", "page": 0}
            for name in fields
        }
        return {"plusieurs_lots": "non", "champs": champs}


def _readers(primary: FakeModel, second: FakeModel) -> tuple[Reader, Reader]:
    spend = SpendCap(Decimal("5"))
    return (
        Reader("principal", primary, ReaderStats(model=HAIKU), 10, spend),
        Reader("second", second, ReaderStats(model=SONNET), 10, spend),
    )


def _sale(**overrides: Any) -> AuctionSale:
    values: dict[str, Any] = {
        "id": SALE_ID,
        "source_name": "licitor",
        "source_url": SOURCE_URL,
        "title": "Appartement",
        "property_type": "apartment",
        "city": "Lyon",
        "raw_text": "Appartement a vendre aux encheres publiques.",
        "documents": [{"url": PIECE_URL, "label": "Cahier des conditions de vente"}],
        "raw_payload": {},
    }
    values.update(overrides)
    return AuctionSale(**values)


def _candidate(**overrides: Any) -> vision.Candidate:
    values: dict[str, Any] = {
        "sale_id": SALE_ID,
        "source_url": SOURCE_URL,
        "manifest": MANIFEST,
        "text_at": TEXT_AT,
        "state": {},
        "retry_due": False,
        "property_type": "apartment",
        "city": "Lyon",
        "lot_selection": None,
    }
    values.update(overrides)
    return vision.Candidate(**values)


class Store:
    """La fiche et la base de la passe, en mémoire."""

    def __init__(self, sale: AuctionSale, candidates: Sequence[vision.Candidate]) -> None:
        self.sales = {sale.source_url: sale}
        self.candidates = list(candidates)
        self.states: dict[str, dict[str, object]] = {}
        self.written: list[AuctionSale] = []
        self.excluded: set[str] = set()
        self.registry: frozenset[str] = frozenset()
        self.manifest: object = MANIFEST
        self.schema_ready = True
        self.limits: list[int] = []
        self.locks = 0

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def select(db_url: str, settings: vision.VisionSettings, limit: int) -> list[vision.Candidate]:
            self.limits.append(limit)
            return self.candidates[:limit]

        def write(sale: AuctionSale) -> bool:
            self.written.append(sale)
            self.sales[sale.source_url] = sale
            return True

        @contextmanager
        def lock(db_url: str, wait_seconds: float) -> Iterator[Any]:
            self.locks += 1

            class Handle:
                def ensure_held(self) -> None:
                    return None

            yield Handle()

        monkeypatch.setattr(vision, "_select_candidates", select)
        monkeypatch.setattr(
            vision, "_fetch_sale", lambda url: self.sales[url].model_copy(deep=True) if url in self.sales else None
        )
        monkeypatch.setattr(vision, "_write_sale", write)
        monkeypatch.setattr(vision, "_record_state", lambda db_url, url, state: self.states.__setitem__(url, state))
        monkeypatch.setattr(vision, "_is_excluded", lambda db_url, url: url in self.excluded)
        monkeypatch.setattr(vision, "_catalogue_lock", lock)
        monkeypatch.setattr(vision, "cached_sale_pdfs", lambda sale, urls: FetchedPieces({PIECE_URL: PDF}))
        monkeypatch.setattr(vision, "_registry_columns", lambda db_url, url: self.registry)
        monkeypatch.setattr(vision, "_schema_ready", lambda db_url: self.schema_ready)
        monkeypatch.setattr(vision, "_latest_manifest", lambda db_url, url: self.manifest)
        monkeypatch.setattr(vision, "_sales_of_url", lambda db_url, url: [url] if url in self.sales else [])


def _run(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    *,
    sale: AuctionSale | None = None,
    candidates: Sequence[vision.Candidate] | None = None,
    primary: FakeModel | None = None,
    second: FakeModel | None = None,
    fields: tuple[str, ...] = OPEN_FIELDS,
    **options: Any,
) -> tuple[vision.PassReport, Store]:
    store = Store(sale or _sale(), candidates if candidates is not None else [_candidate()])
    store.install(monkeypatch)
    readers = _readers(primary or FakeModel(VALUES), second or FakeModel(VALUES))
    report = vision.run_pass(DB_URL, vision.VisionSettings(mode, fields), readers=readers, today=TODAY, **options)
    return report, store


def _verdict(value: object, page: int = 2) -> Verdict:
    return Verdict(ACCEPTED, value=value, page=PageRef(1, page), quote=QUOTE)


DOCUMENTS = {1: ReadingDocument(1, "Cahier", PIECE_URL, "cahier_conditions_vente", {1: FILLER, 2: DESCRIPTION})}


SOURCE = vision.ReadingSource(DOCUMENTS, MODELS, vision.manifest_digests(MANIFEST))


def _plan(
    sale: AuctionSale,
    verdicts: Mapping[str, Verdict],
    fields: Sequence[str] = OPEN_FIELDS,
    registry: frozenset[str] = frozenset(),
) -> vision.WritePlan:
    return vision.plan_write(sale, verdicts, fields, SOURCE, registry)


# --- Réglages -------------------------------------------------------------------------------------------------------


def test_settings_are_off_by_default_and_refuse_values_outside_their_lists() -> None:
    assert vision.vision_settings({}) == vision.VisionSettings("off", ())
    settings = vision.vision_settings(
        {"document_vision_mode": "dry_run", "document_vision_fields": ("rooms_count", "habitable_surface_m2")}
    )
    assert settings == vision.VisionSettings("dry_run", (HABITABLE, ROOMS))
    for bad in (
        {"document_vision_mode": "on"},
        {"document_vision_mode": "write", "document_vision_fields": ("visit_dates",)},
        {"document_vision_mode": "write", "document_vision_fields": ("starting_price_eur",)},
        {"document_vision_mode": "write", "document_vision_fields": ("sale_date",)},
    ):
        with pytest.raises(ValueError):
            vision.vision_settings(bad)


def test_off_or_without_an_open_field_the_pass_reads_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    primary = FakeModel(VALUES)
    report, store = _run(monkeypatch, "off", primary=primary)
    assert report.stop_reason == "off" and store.limits == [] and primary.calls == 0
    report, store = _run(monkeypatch, "dry_run", primary=primary, fields=())
    assert report.stop_reason == "no_open_field" and store.limits == [] and primary.calls == 0


def test_main_stops_on_a_bad_setting_and_says_off_without_any_database(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    monkeypatch.delenv("DOCUMENT_VISION_MODE", raising=False)
    assert vision.main([]) == 0
    assert json.loads(capsys.readouterr().out) == {"skipped": "DOCUMENT_VISION_MODE is off"}
    monkeypatch.setenv("DOCUMENT_VISION_MODE", "always")
    assert vision.main([]) == 2


def test_main_runs_the_pass_with_its_bounds_and_keeps_the_urls_of_the_pieces_out_of_the_log(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger = logging.getLogger("src.pdf_enrichment")
    previous = logger.level
    monkeypatch.setenv("DOCUMENT_VISION_MODE", "dry_run")
    monkeypatch.setenv("DOCUMENT_VISION_FIELDS", "rooms_count")
    monkeypatch.setenv("SUPABASE_DB_URL", DB_URL)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen: list[tuple[Any, ...]] = []

    def run(db_url: str, settings: vision.VisionSettings, **options: Any) -> vision.PassReport:
        seen.append((settings, options, logger.level))
        return vision.PassReport(mode=settings.mode)

    monkeypatch.setattr(vision, "run_pass", run)
    try:
        assert vision.main([]) == 0
    finally:
        logger.setLevel(previous)
    assert seen == [(vision.VisionSettings("dry_run", (ROOMS,)), {"max_sales": 10, "budget_seconds": 600.0}, logging.ERROR)]


# --- À blanc ----------------------------------------------------------------------------------------------------------


def test_dry_run_counts_and_logs_what_would_be_written_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="src.document_vision_pass")
    report, store = _run(monkeypatch, "dry_run")

    assert report.read == 1
    assert report.fields == {HABITABLE: {"ecrit": 1}, ROOMS: {"ecrit": 1}, OCCUPANCY: {"ecrit": 1}}
    # Rien n'est écrit sur la fiche ; seul l'état de la lecture est tenu, pour ne pas payer deux fois.
    assert store.written == [] and store.locks == 0
    assert store.sales[SOURCE_URL].habitable_surface_m2 is None
    state = store.states[SOURCE_URL]
    assert state["mode"] == "dry_run" and state["status"] == "completed" and state["prompt_version"] == PROMPT_VERSION
    # Journal : par champ, sans citation ni URL.
    assert caplog.text.count("would_write") == 3
    assert f"sale {SALE_ID} field {HABITABLE} value 62.4 piece D1 (cahier_conditions_vente) page 2" in caplog.text
    for secret in (QUOTE, "loue par bail", SOURCE_URL, PIECE_URL):
        assert secret not in caplog.text
        assert secret not in json.dumps(report.as_dict()) and secret not in json.dumps(state, default=str)


# --- Écriture ---------------------------------------------------------------------------------------------------------


def test_write_fills_empty_cells_and_traces_them_without_any_quote(monkeypatch: pytest.MonkeyPatch) -> None:
    report, store = _run(monkeypatch, "write")

    assert report.fields == {HABITABLE: {"ecrit": 1}, ROOMS: {"ecrit": 1}, OCCUPANCY: {"ecrit": 1}}
    assert store.locks == 1 and len(store.written) == 1
    sale = store.sales[SOURCE_URL]
    assert sale.habitable_surface_m2 == Decimal("62.4") and sale.rooms_count == 3 and sale.occupancy_status == "rented"
    # La surface affichée se déduit de la surface habitable.
    assert sale.app_surface_m2 == Decimal("62.4") and sale.app_surface_kind == "habitable"
    traces = sale.raw_payload["pdf_fact_provenance"]
    trace = traces[HABITABLE]
    assert trace["reader"] == TRACE_READER and trace["prompt_version"] == PROMPT_VERSION
    assert trace["models"] == MODELS
    assert trace["document_index"] == 1 and trace["document_type"] == "cahier_conditions_vente"
    assert trace["page_number"] == 2 and trace["baseline"] is None and trace["value"] == "62.4"
    assert traces["app_surface_m2"]["derived_from"] == HABITABLE and traces["app_surface_m2"]["baseline"] is None
    assert {ROOMS, OCCUPANCY, "surface_m2", "app_surface_kind"} <= set(traces)
    # Jamais de citation dans une trace.
    assert all("evidence" not in item and "quote" not in item for item in traces.values())
    dumped = json.dumps(sale.raw_payload, default=str)
    assert QUOTE not in dumped and "loue par bail" not in dumped
    assert store.states[SOURCE_URL]["mode"] == "write"


def test_a_filled_cell_is_never_overwritten(monkeypatch: pytest.MonkeyPatch) -> None:
    report, store = _run(monkeypatch, "write", sale=_sale(rooms_count=5, occupancy_status="occupied"))

    assert report.fields[ROOMS] == {"case_remplie": 1} and report.fields[OCCUPANCY] == {"case_remplie": 1}
    sale = store.sales[SOURCE_URL]
    assert sale.rooms_count == 5 and sale.occupancy_status == "occupied"
    assert sale.habitable_surface_m2 == Decimal("62.4")
    assert ROOMS not in sale.raw_payload["pdf_fact_provenance"]


@pytest.mark.parametrize("filled", ["surface_m2", "app_surface_m2", HABITABLE, CARREZ])
def test_a_built_surface_needs_its_whole_group_empty(filled: str) -> None:
    plan = _plan(_sale(**{filled: Decimal("70")}), {HABITABLE: _verdict(Decimal("62.4")), CARREZ: _verdict(Decimal("60"))})
    assert plan.sale is None
    assert plan.outcomes == {HABITABLE: "case_remplie", CARREZ: "case_remplie"}


def test_a_field_that_is_not_open_is_counted_and_never_written() -> None:
    plan = _plan(_sale(), {HABITABLE: _verdict(Decimal("62.4")), ROOMS: _verdict(3)}, fields=(ROOMS,))
    assert plan.outcomes == {HABITABLE: "champ_ferme", ROOMS: "ecrit"}
    assert plan.sale is not None and plan.sale.habitable_surface_m2 is None and plan.sale.rooms_count == 3


def test_never_fewer_rooms_than_bedrooms() -> None:
    assert _plan(_sale(bedrooms_count=4), {ROOMS: _verdict(3)}).outcomes == {ROOMS: "moins_de_pieces_que_de_chambres"}
    # Autant de pièces que de chambres : la fiche ne garde pas ce nombre (src.room_counts), rien n'est écrit.
    assert _plan(_sale(bedrooms_count=3), {ROOMS: _verdict(3)}).outcomes == {ROOMS: "non_garde_par_la_fiche"}
    plan = _plan(_sale(bedrooms_count=2), {ROOMS: _verdict(3)})
    assert plan.outcomes == {ROOMS: "ecrit"} and plan.sale is not None and plan.sale.rooms_count == 3


def test_never_the_starting_price_nor_the_hearing_date() -> None:
    hearing = datetime(2026, 12, 15, 14, 0, tzinfo=UTC)
    sale = _sale(starting_price_eur=None, sale_date=None)
    plan = _plan(
        sale,
        {
            "starting_price_eur": _verdict(Decimal("90000")),
            "sale_date": _verdict(hearing),
            HABITABLE: _verdict(Decimal("62.4")),
        },
    )
    assert set(plan.outcomes) == {HABITABLE}
    assert plan.sale is not None and plan.sale.starting_price_eur is None and plan.sale.sale_date is None
    assert "starting_price_eur" not in vision.WRITABLE_FIELDS and "sale_date" not in vision.WRITABLE_FIELDS
    assert set(vision.NEVER_WRITTEN) == {"starting_price_eur", "sale_date"}


def test_a_surface_the_sale_does_not_keep_is_not_written() -> None:
    # Une Carrez sous 20 % de la surface habitable est une partie du bien : la fiche ne la garde pas.
    plan = _plan(_sale(), {HABITABLE: _verdict(Decimal("62.4")), CARREZ: _verdict(Decimal("10"))})
    assert plan.outcomes == {HABITABLE: "ecrit", CARREZ: "non_garde_par_la_fiche"}
    assert plan.sale is not None and plan.sale.carrez_surface_m2 is None
    assert CARREZ not in plan.sale.raw_payload["pdf_fact_provenance"]


def test_a_value_that_would_change_another_filled_fact_is_not_written() -> None:
    # 8 m² : la fiche ferait de l'appartement une pièce ou une annexe (type de bien « other ») : rien n'est écrit.
    plan = _plan(_sale(), {HABITABLE: _verdict(Decimal("8"))})
    assert plan.sale is None and plan.outcomes == {HABITABLE: "toucherait_une_case_remplie"}


def test_an_excluded_sale_is_checked_again_just_before_writing(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_sale(), [_candidate()])
    store.install(monkeypatch)
    store.excluded.add(SOURCE_URL)  # exclue après la sélection des candidates
    readers = _readers(FakeModel(VALUES), FakeModel(VALUES))
    report = vision.run_pass(DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=readers, today=TODAY)

    assert store.written == []
    assert report.fields == {HABITABLE: {"vente_exclue": 1}, ROOMS: {"vente_exclue": 1}, OCCUPANCY: {"vente_exclue": 1}}


def test_a_discarded_write_is_counted_as_not_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_sale(), [_candidate()])
    store.install(monkeypatch)
    monkeypatch.setattr(vision, "_write_sale", lambda sale: False)
    readers = _readers(FakeModel(VALUES), FakeModel(VALUES))
    report = vision.run_pass(DB_URL, vision.VisionSettings("write", (HABITABLE,)), readers=readers, today=TODAY)
    assert report.fields == {HABITABLE: {"ecriture_ecartee": 1}, ROOMS: {"champ_ferme": 1}, OCCUPANCY: {"champ_ferme": 1}}


# --- Relecture de la fiche et retrait -------------------------------------------------------------------------------


def _written_sale() -> AuctionSale:
    plan = _plan(_sale(), {HABITABLE: _verdict(Decimal("62.4")), ROOMS: _verdict(3), OCCUPANCY: _verdict("rented")})
    assert plan.sale is not None
    return plan.sale


def test_a_written_value_survives_a_complete_reread_of_the_listing() -> None:
    written = _written_sale()
    written.raw_payload[vision.STATE_KEY] = {"prompt_version": PROMPT_VERSION, "status": "completed"}
    known = {**written.model_dump(mode="json"), "raw_payload": json.loads(json.dumps(written.raw_payload, default=str))}
    # La page relue ne dit ni la surface, ni le nombre de pièces, ni l'occupation.
    reread = {
        "source_name": "licitor",
        "source_url": SOURCE_URL,
        "title": "Appartement",
        "property_type": "apartment",
        "documents": [{"url": PIECE_URL, "label": "Cahier des conditions de vente"}],
        "source_detail_status": "complete",
    }

    preserve_known_enrichment_payloads([reread], {SOURCE_URL: known})

    assert Decimal(str(reread[HABITABLE])) == Decimal("62.4")
    assert reread[ROOMS] == 3 and reread[OCCUPANCY] == "rented"
    assert Decimal(str(reread["app_surface_m2"])) == Decimal("62.4")
    assert reread["pdf_fact_provenance"][HABITABLE]["reader"] == TRACE_READER
    assert reread[vision.STATE_KEY]["prompt_version"] == PROMPT_VERSION


def test_a_value_the_listing_now_gives_is_not_replaced_on_reread() -> None:
    written = _written_sale()
    known = {**written.model_dump(mode="json"), "raw_payload": json.loads(json.dumps(written.raw_payload, default=str))}
    reread = {"source_name": "licitor", "source_url": SOURCE_URL, ROOMS: 4}
    preserve_known_enrichment_payloads([reread], {SOURCE_URL: known})
    assert reread[ROOMS] == 4


def test_withdrawal_empties_the_cells_written_by_the_reading() -> None:
    sale = _written_sale()
    assert vision.withdraw_values(sale, prompt_version="2025-01-01.1") == {"cleared": set(), "preserved": set()}

    result = vision.withdraw_values(sale, prompt_version=PROMPT_VERSION)

    assert {HABITABLE, ROOMS, OCCUPANCY, "app_surface_m2", "surface_m2"} <= result["cleared"]
    for column in (HABITABLE, ROOMS, OCCUPANCY, "app_surface_m2", "surface_m2", "app_surface_kind", "surface_scope"):
        assert getattr(sale, column) is None, column
    assert sale.title == "Appartement"
    assert vision.vision_traces(sale) == set()


def test_withdrawal_keeps_a_value_changed_since_by_another_path() -> None:
    sale = _written_sale()
    sale.rooms_count = 4
    result = vision.withdraw_values(sale)
    assert ROOMS in result["preserved"] and sale.rooms_count == 4
    assert sale.habitable_surface_m2 is None


def test_withdraw_command_by_sale_and_by_prompt_version(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_written_sale(), [])
    store.install(monkeypatch)

    class Connection:
        def __init__(self) -> None:
            self.parameters: tuple[Any, ...] = ()

        def __enter__(self) -> Connection:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def execute(self, sql: str, parameters: tuple[Any, ...]) -> Any:
            self.parameters = parameters
            return type("Rows", (), {"fetchall": lambda _self: [(SOURCE_URL,)]})()

    connection = Connection()
    monkeypatch.setattr(vision, "_connect", lambda db_url: connection)

    assert vision.withdraw(DB_URL, prompt_version=PROMPT_VERSION) == {
        "sales": 1, "cleared": 7, "preserved": 0, "not_recorded": 0, "pending": [],
    }
    assert connection.parameters == (TRACE_READER, PROMPT_VERSION, PROMPT_VERSION)
    assert store.sales[SOURCE_URL].habitable_surface_m2 is None and store.locks == 1
    # Plus rien à retirer : la fiche n'est pas réécrite.
    assert vision.withdraw(DB_URL, source_url=SOURCE_URL) == {
        "sales": 1, "cleared": 0, "preserved": 0, "not_recorded": 0, "pending": [],
    }
    assert len(store.written) == 1


def test_withdraw_by_sale_finds_the_sale_that_absorbed_the_url(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_written_sale(), [])
    store.install(monkeypatch)
    absorbed = "https://example.test/vente-absorbee"
    asked: list[str] = []

    def sales_of_url(db_url: str, url: str) -> list[str]:
        asked.append(url)
        return [SOURCE_URL] if url == absorbed else []

    monkeypatch.setattr(vision, "_sales_of_url", sales_of_url)
    result = vision.withdraw(DB_URL, source_url=absorbed)
    assert asked == [absorbed] and result["cleared"] == 7 and result["pending"] == []
    assert store.sales[SOURCE_URL].habitable_surface_m2 is None


def test_withdraw_waits_for_the_lock_sale_by_sale_and_lists_what_is_left(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.catalogue_lock import CatalogueLockTimeout

    other = "https://example.test/autre-vente"
    store = Store(_written_sale(), [])
    store.sales[other] = _written_sale().model_copy(update={"source_url": other})
    store.install(monkeypatch)
    waits: list[float] = []

    @contextmanager
    def lock(db_url: str, wait_seconds: float) -> Iterator[Any]:
        waits.append(wait_seconds)
        if len(waits) == 1:
            raise CatalogueLockTimeout("busy")

        class Handle:
            def ensure_held(self) -> None:
                return None

        yield Handle()

    monkeypatch.setattr(vision, "_catalogue_lock", lock)

    class Connection:
        def __enter__(self) -> Connection:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def execute(self, sql: str, parameters: tuple[Any, ...]) -> Any:
            return type("Rows", (), {"fetchall": lambda _self: [(SOURCE_URL,), (other,)]})()

    monkeypatch.setattr(vision, "_connect", lambda db_url: Connection())
    result = vision.withdraw(DB_URL, prompt_version=PROMPT_VERSION)

    assert waits == [600, 600]  # dix minutes par vente
    assert result["pending"] == [SOURCE_URL] and result["sales"] == 1 and result["cleared"] == 7
    assert store.sales[other].habitable_surface_m2 is None
    assert not vision.withdrawal_complete(result)


def test_withdraw_command_fails_when_a_sale_is_left_or_a_write_is_discarded(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", DB_URL)
    results = iter([
        {"sales": 1, "cleared": 0, "preserved": 0, "not_recorded": 0, "pending": [SOURCE_URL]},
        {"sales": 1, "cleared": 0, "preserved": 0, "not_recorded": 1, "pending": [SOURCE_URL]},
        {"sales": 1, "cleared": 3, "preserved": 0, "not_recorded": 0, "pending": []},
    ])
    monkeypatch.setattr(vision, "withdraw", lambda db_url, **options: next(results))
    assert vision.main(["--withdraw", "--sale", SOURCE_URL]) == 1
    assert json.loads(capsys.readouterr().out)["pending"] == [SOURCE_URL]
    assert vision.main(["--withdraw", "--prompt-version", PROMPT_VERSION]) == 1
    assert vision.main(["--withdraw", "--prompt-version", PROMPT_VERSION]) == 0


@pytest.mark.parametrize(
    "argv",
    [["--withdraw"], ["--withdraw", "--sale", SOURCE_URL, "--prompt-version", "x"], ["--sale", SOURCE_URL]],
)
def test_withdraw_takes_one_prompt_version_or_one_sale(argv: list[str]) -> None:
    with pytest.raises(SystemExit):
        vision.parse_args(argv)


# --- Reprise et état ----------------------------------------------------------------------------------------------------


def _same_state(**values: object) -> dict[str, object]:
    sold_lot = None
    return {
        "prompt_version": PROMPT_VERSION,
        "fingerprint": vision.reading_fingerprint(MANIFEST, sold_lot),
        "mode": "write",
        "text_at": (TEXT_AT - timedelta(days=1)).isoformat(),
        **values,
    }


def test_a_reading_done_on_the_same_pieces_is_not_paid_again(monkeypatch: pytest.MonkeyPatch) -> None:
    primary = FakeModel(VALUES)
    report, store = _run(
        monkeypatch, "write", primary=primary, candidates=[_candidate(state=_same_state(status="completed"))]
    )
    assert report.unchanged == 1 and primary.calls == 0 and store.written == []
    assert store.states[SOURCE_URL]["text_at"] == TEXT_AT.isoformat()


def test_a_dry_run_reading_is_done_again_once_in_write_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    primary = FakeModel(VALUES)
    state = _same_state(status="completed", mode="dry_run")
    report, store = _run(monkeypatch, "write", primary=primary, candidates=[_candidate(state=state)])
    assert report.read == 1 and primary.calls == 1 and len(store.written) == 1
    # Et l'inverse : une lecture faite en écriture vaut pour une passe à blanc.
    report, _store = _run(monkeypatch, "dry_run", candidates=[_candidate(state=_same_state(status="completed"))])
    assert report.unchanged == 1


def test_a_failed_reading_waits_12_then_24_then_72_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    sql = vision.candidates_sql(OPEN_FIELDS)
    assert "<= 1 then interval '12 hours'" in sql and "<= 2 then interval '24 hours'" in sql
    assert "else interval '72 hours'" in sql and "::integer < 4" in sql

    primary = FakeModel(VALUES)
    report, store = _run(
        monkeypatch, "write", primary=primary, candidates=[_candidate(state=_same_state(status="failed", attempts=1))]
    )
    assert report.waiting == 1 and primary.calls == 0
    assert store.states[SOURCE_URL]["status"] == "failed" and store.states[SOURCE_URL]["attempts"] == 1

    failing = FakeModel(VALUES, error=RuntimeError("model down"))
    report, store = _run(
        monkeypatch,
        "write",
        primary=failing,
        candidates=[_candidate(state=_same_state(status="failed", attempts=1), retry_due=True)],
    )
    state = store.states[SOURCE_URL]
    assert report.failed == 1 and state["status"] == "failed" and state["attempts"] == 2
    assert state["failure"] == "lecture principale en échec"

    report, store = _run(
        monkeypatch,
        "write",
        primary=failing,
        candidates=[_candidate(state=_same_state(status="failed", attempts=3), retry_due=True)],
    )
    assert report.abandoned == 1 and store.states[SOURCE_URL]["attempts"] == 4


def test_new_pieces_start_the_count_again(monkeypatch: pytest.MonkeyPatch) -> None:
    state = _same_state(status="failed", attempts=3, fingerprint="older-pieces")
    report, store = _run(
        monkeypatch, "write", primary=FakeModel(VALUES, error=RuntimeError("x")), candidates=[_candidate(state=state)]
    )
    assert store.states[SOURCE_URL]["attempts"] == 1 and report.abandoned == 0


def test_a_failed_second_reader_is_a_failed_reading_and_writes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    report, store = _run(monkeypatch, "write", second=FakeModel(VALUES, error=RuntimeError("timeout")))
    assert report.failed == 1 and store.written == []
    assert store.states[SOURCE_URL]["failure"] == "second lecteur en échec"


def test_the_shared_budget_stops_the_pass_without_touching_the_state(monkeypatch: pytest.MonkeyPatch) -> None:
    primary = FakeModel(VALUES, error=PipelineBudgetExhausted("Daily LLM budget exhausted"))
    report, store = _run(monkeypatch, "write", primary=primary, candidates=[_candidate(), _candidate()])
    assert report.stop_reason == "principal : PipelineBudgetExhausted" and primary.calls == 1
    assert store.states == {} and store.written == []


# --- Bornes -----------------------------------------------------------------------------------------------------------


def test_a_pass_reads_ten_sales_and_starts_none_it_could_not_finish(monkeypatch: pytest.MonkeyPatch) -> None:
    # Dix minutes de passe ; une vente ne commence que s'il reste ses deux délais d'appel et 90 s (450 s).
    assert vision.SALE_RESERVE_SECONDS == 120 + 240 + 90 and vision.BUDGET_SECONDS == 10 * 60
    ticks = iter([0.0, 0.0, 150.0, 150.5])
    primary = FakeModel(VALUES)
    report, store = _run(
        monkeypatch, "dry_run", primary=primary, candidates=[_candidate()] * 12, clock=lambda: next(ticks)
    )
    assert store.limits == [10]
    assert primary.calls == 2 and report.stop_reason == "budget"
    assert vision.MAX_SALES == 10
    for argv in (["--max-sales", "11"], ["--budget-minutes", "11"], ["--max-sales", "0"]):
        with pytest.raises(SystemExit):
            vision.parse_args(argv)


def test_the_runner_gives_the_pass_its_budget_and_the_time_of_a_last_sale() -> None:
    # Dix minutes de passe et une de démarrage : l'attente du verrou est dans la réserve de chaque vente.
    assert autonomous_runner.DOCUMENT_VISION_BUDGET_SECONDS == vision.PASS_TIMEOUT_SECONDS == 11 * 60
    assert vision.SALE_RESERVE_SECONDS >= vision.PRIMARY_TIMEOUT_SECONDS + vision.SECOND_TIMEOUT_SECONDS + vision.LOCK_WAIT_SECONDS
    # Délais d'appel de la passe : 2 et 4 minutes ; le banc garde les siens (5 et 10 minutes).
    assert (vision.PRIMARY_TIMEOUT_SECONDS, vision.SECOND_TIMEOUT_SECONDS) == (120.0, 240.0)
    assert (reading.PRIMARY_TIMEOUT_SECONDS, reading.SECOND_TIMEOUT_SECONDS) == (300.0, 600.0)
    assert "document_vision_exit_code" in autonomous_runner.EXTERNAL_PASS_KEYS


# --- Registre des pièces ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("registry", "field_name", "value"),
    [
        # Surface tenue, ou libérée avec mémoire d'écho : ses colonnes (held_columns de property.surface_m2).
        (frozenset({"surface_m2", "app_surface_m2", "app_surface_kind"}), HABITABLE, Decimal("62.4")),
        (frozenset({"surface_m2", "app_surface_m2", "app_surface_kind"}), CARREZ, Decimal("60")),
        (frozenset({"land_surface_m2"}), LAND, Decimal("500")),
        (frozenset({"rooms_count"}), ROOMS, 3),
        (frozenset({"occupancy_status"}), OCCUPANCY, "rented"),
    ],
)
def test_a_field_of_the_fact_registry_is_never_written(registry: frozenset[str], field_name: str, value: object) -> None:
    plan = _plan(_sale(property_type="house"), {field_name: _verdict(value)}, registry=registry)
    assert plan.sale is None and plan.outcomes == {field_name: "tenu_par_le_registre"}


def test_a_value_that_would_change_a_registry_column_is_not_written() -> None:
    # La surface habitable ferait la surface affichée, que le registre a tenue (libérée, avec sa mémoire d'écho).
    plan = _plan(_sale(), {HABITABLE: _verdict(Decimal("62.4")), ROOMS: _verdict(3)}, registry=frozenset({"surface_m2"}))
    assert plan.outcomes == {HABITABLE: "tenu_par_le_registre", ROOMS: "ecrit"}
    plan = _plan(_sale(), {HABITABLE: _verdict(Decimal("62.4"))}, registry=frozenset({"surface_scope"}))
    assert plan.sale is None and plan.outcomes == {HABITABLE: "tenu_par_le_registre"}


def test_the_pass_reads_the_registry_before_writing(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_sale(), [_candidate()])
    store.install(monkeypatch)
    store.registry = frozenset({"rooms_count"})
    readers = _readers(FakeModel(VALUES), FakeModel(VALUES))
    report = vision.run_pass(DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=readers, today=TODAY)
    assert report.fields[ROOMS] == {"tenu_par_le_registre": 1} and report.fields[HABITABLE] == {"ecrit": 1}
    assert store.sales[SOURCE_URL].rooms_count is None


# --- Pièces : cache local, aucune requête aux sites ------------------------------------------------------------------


def test_pieces_come_from_the_local_cache_of_the_pdf_reading(tmp_path: Path) -> None:
    from src.sale_local_files import document_filename, sale_storage_id

    sale = _sale(documents=[{"url": PIECE_URL, "label": "Cahier des conditions de vente"}, {"url": OTHER_URL}])
    folder = tmp_path / sale_storage_id(sale)
    folder.mkdir()
    (folder / document_filename(sale.documents[0])).write_bytes(PDF)

    fetched = pieces.cached_sale_pdfs(sale, [PIECE_URL, OTHER_URL], root=tmp_path)

    assert fetched.pdfs == {PIECE_URL: PDF}
    assert fetched.missing == {OTHER_URL: pieces.NO_PDF_NOT_CACHED}


def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the pass never downloads a piece")

    monkeypatch.setattr(pdf_enrichment, "download_documents", refuse)
    monkeypatch.setattr(pieces, "download_sale_pdfs", refuse)


def test_the_pass_reads_cached_pieces_and_counts_no_request_to_the_sites(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.sale_local_files import document_filename, sale_storage_id

    sale = _sale()
    folder = tmp_path / sale_storage_id(sale)
    folder.mkdir()
    (folder / document_filename(sale.documents[0])).write_bytes(PDF)
    store = Store(sale, [_candidate()])
    store.install(monkeypatch)
    monkeypatch.setattr(vision, "cached_sale_pdfs", lambda sale, urls: pieces.cached_sale_pdfs(sale, urls, root=tmp_path))
    _no_network(monkeypatch)
    readers = _readers(FakeModel(VALUES), FakeModel(VALUES))

    report = vision.run_pass(DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=readers, today=TODAY)

    assert report.read == 1 and store.sales[SOURCE_URL].habitable_surface_m2 == Decimal("62.4")
    summary = report.as_dict()
    assert summary["site_requests"] == 0 and summary["pieces_from_cache"] == 1 and summary["pieces_not_cached"] == 0


def test_a_sale_whose_pieces_are_not_cached_waits_without_any_call_nor_attempt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = Store(_sale(), [_candidate(state=_same_state(status="failed", attempts=2), retry_due=True)])
    store.install(monkeypatch)
    monkeypatch.setattr(vision, "cached_sale_pdfs", lambda sale, urls: pieces.cached_sale_pdfs(sale, urls, root=tmp_path))
    _no_network(monkeypatch)
    primary = FakeModel(VALUES)

    report = vision.run_pass(
        DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=_readers(primary, FakeModel(VALUES)), today=TODAY
    )

    assert primary.calls == 0 and report.waiting_pieces == 1 and report.failed == 0
    assert report.as_dict()["pieces_not_cached"] == 1 and report.as_dict()["site_requests"] == 0
    state = store.states[SOURCE_URL]
    assert state["status"] == "waiting_pieces" and state["attempts"] == 2


def test_the_candidates_come_back_when_the_pieces_are_read_again() -> None:
    # « waiting_pieces » n'est ni lue ni en échec : seul un texte des pièces réécrit (ou une autre version) la ramène.
    sql = vision.candidates_sql(OPEN_FIELDS)
    assert "->> 'text_at')::timestamptz < latest.updated_at" in sql
    assert "waiting_pieces" not in sql


# --- Relecture complète des pièces -----------------------------------------------------------------------------------


def _pdf_texts(url: str, text: str, sha256: str | None) -> list[dict[str, object]]:
    item: dict[str, object] = {
        "url": url,
        "label": "Cahier des conditions de vente",
        "document_type": "cahier_conditions_vente",
        "text": text,
        "pages": [{"page": 1, "text": text}],
        "complete": True,
        "extraction_status": "extracted",
    }
    if sha256 is not None:
        item["sha256"] = sha256
    return [item]


def test_a_written_value_survives_a_complete_reread_of_unchanged_pieces() -> None:
    from src.pdf_fact_extraction import enrich_sale_from_pdf_text

    sale = _written_sale()
    enrich_sale_from_pdf_text(sale, _pdf_texts(PIECE_URL, FILLER, hashlib.sha256(PDF).hexdigest()))

    assert sale.habitable_surface_m2 == Decimal("62.4") and sale.rooms_count == 3 and sale.occupancy_status == "rented"
    assert {HABITABLE, ROOMS, OCCUPANCY, "app_surface_m2"} <= vision.vision_traces(sale)
    # Sans empreinte connue de la pièce relue, sa présence suffit.
    enrich_sale_from_pdf_text(sale, _pdf_texts(PIECE_URL, FILLER, None))
    assert sale.habitable_surface_m2 == Decimal("62.4")


@pytest.mark.parametrize(
    ("url", "sha256"),
    [(PIECE_URL, "0" * 64), (OTHER_URL, None)],
    ids=["piece_changed", "piece_removed"],
)
def test_a_written_value_goes_when_its_piece_changes_or_leaves_the_dossier(url: str, sha256: str | None) -> None:
    from src.pdf_fact_extraction import enrich_sale_from_pdf_text

    sale = _written_sale()
    sale.documents = [{"url": url, "label": "Cahier des conditions de vente"}]
    enrich_sale_from_pdf_text(sale, _pdf_texts(url, FILLER, sha256))

    assert vision.vision_traces(sale) == set()
    assert sale.habitable_surface_m2 is None and sale.rooms_count is None and sale.occupancy_status is None


def test_a_replaced_piece_takes_the_written_values_with_it() -> None:
    from src.pdf_enrichment import _invalidate_replaced_document_facts

    sale = _written_sale()
    sale.raw_payload["document_analysis"] = {"profiles": [{"url": PIECE_URL, "sha256": "a" * 64}]}
    _invalidate_replaced_document_facts(sale, [{"url": PIECE_URL, "sha256": "b" * 64}])

    assert vision.vision_traces(sale) == set() and sale.habitable_surface_m2 is None and sale.rooms_count is None


# --- Clé de l'API et workflow -----------------------------------------------------------------------------------------


def test_only_the_reading_of_the_pieces_gets_the_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, str]] = []
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-shown")
    # Retour arrière des appels de texte sur Replicate ; avec Claude, la lecture IA reçoit aussi la clé
    # (tests/test_autonomous_execution.py).
    monkeypatch.setenv("LLM_PROVIDER", "replicate")
    monkeypatch.setattr(
        autonomous_runner, "_run_optional_pass", lambda label, command, *, env, timeout: seen.append(env) or 0
    )
    # L'environnement que le lanceur donne aux passes : celui du job, dont il retire la clé (_execute_claimed, test
    # de bout en bout dans tests/test_autonomous_execution.py).
    job_env = {"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "test-key-never-shown"}
    runner_env = {key: value for key, value in job_env.items() if key != "ANTHROPIC_API_KEY"}
    autonomous_runner._run_document_vision(runner_env)
    autonomous_runner._run_document_reading(runner_env)
    assert seen[0]["ANTHROPIC_API_KEY"] == "test-key-never-shown"
    assert "ANTHROPIC_API_KEY" not in seen[1]


def test_workflow_gives_the_key_and_the_settings_to_the_runner_step_only() -> None:
    workflows = Path(__file__).resolve().parents[3] / ".github" / "workflows"
    text = (workflows / "data-pipeline.yml").read_text(encoding="utf-8")
    key = "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}"
    mode = "DOCUMENT_VISION_MODE: ${{ vars.DOCUMENT_VISION_MODE || 'off' }}"
    fields = "DOCUMENT_VISION_FIELDS: ${{ vars.DOCUMENT_VISION_FIELDS || '' }}"
    header, *steps = text.split("\n      - name: ")
    names = ("ANTHROPIC_API_KEY:", "DOCUMENT_VISION_MODE:", "DOCUMENT_VISION_FIELDS:")
    assert not any(name in header for name in names)  # not in a job environment
    receiving = [step.splitlines()[0] for step in steps if any(name in step for name in names)]
    assert receiving == ["Run manually requested pipeline"]
    runner_step = next(step for step in steps if step.startswith("Run manually requested pipeline"))
    assert key in runner_step and mode in runner_step and fields in runner_step
    assert "python -m src.autonomous_runner" in runner_step
    # The manual runs of the same step drop the key before any other command when the text calls go to Replicate.
    assert runner_step.index("unset ANTHROPIC_API_KEY") > runner_step.index("python -m src.autonomous_runner")
    assert runner_step.index('if [ "$provider" = "replicate" ]; then') < runner_step.index("python -m src.main")
    # Never read nor shown by a command of the workflow.
    for reading_form in ("$ANTHROPIC_API_KEY", "${ANTHROPIC_API_KEY", "env.ANTHROPIC_API_KEY"):
        assert reading_form not in text


# --- Pièces revérifiées, schéma, échecs sans appel, déduction --------------------------------------------------------


def test_pieces_that_changed_since_the_reading_are_never_written(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_sale(), [_candidate()])
    store.install(monkeypatch)
    changed = json.loads(json.dumps(MANIFEST))
    changed[0]["pages"][1]["text"] = DESCRIPTION + " Modifie."
    store.manifest = changed
    primary = FakeModel(VALUES)

    report = vision.run_pass(
        DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=_readers(primary, FakeModel(VALUES)), today=TODAY
    )

    assert primary.calls == 1 and store.written == [] and report.pieces_changed == 1
    # Ni lue, ni en échec : son état ne change pas, elle revient avec son nouveau texte, sans essai compté.
    assert store.states == {} and report.failed == 0


def test_without_its_migrations_the_pass_reads_and_pays_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_sale(), [_candidate()])
    store.install(monkeypatch)
    store.schema_ready = False
    primary = FakeModel(VALUES)
    report = vision.run_pass(
        DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=_readers(primary, FakeModel(VALUES)), today=TODAY
    )
    assert report.stop_reason == "schema_missing" and store.limits == [] and primary.calls == 0
    assert store.states == {}


def test_a_registry_that_cannot_be_read_stops_the_pass_without_an_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(_sale(), [_candidate(), _candidate()])
    store.install(monkeypatch)

    def unavailable(db_url: str, url: str) -> frozenset[str]:
        raise vision.RegistryUnavailable("UndefinedFunction")

    monkeypatch.setattr(vision, "_registry_columns", unavailable)
    primary = FakeModel(VALUES)
    report = vision.run_pass(
        DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=_readers(primary, FakeModel(VALUES)), today=TODAY
    )
    assert report.stop_reason == "registry_unavailable" and primary.calls == 1
    assert store.states == {} and store.written == [] and report.failed == 0


def test_the_registry_error_is_typed_whatever_the_database_says(monkeypatch: pytest.MonkeyPatch) -> None:
    class Broken:
        def __enter__(self) -> Broken:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def execute(self, sql: str, parameters: tuple[Any, ...]) -> Any:
            raise RuntimeError("function app_private.sale_registry_columns(text) does not exist")

    monkeypatch.setattr(vision, "_connect", lambda db_url: Broken())
    with pytest.raises(vision.RegistryUnavailable):
        vision._registry_columns(DB_URL, SOURCE_URL)


@pytest.mark.parametrize(
    "fetched",
    [
        FetchedPieces({PIECE_URL: _pdf("Un autre PDF que celui dont le texte a ete lu.")}),  # PDF modifié
        None,  # téléchargement en échec : pièces non obtenues
    ],
    ids=["pdf_changed", "not_obtained"],
)
def test_a_reading_that_made_no_call_waits_for_its_pieces_without_an_attempt(
    monkeypatch: pytest.MonkeyPatch, fetched: FetchedPieces | None
) -> None:
    store = Store(_sale(), [_candidate(state=_same_state(status="failed", attempts=1), retry_due=True)])
    store.install(monkeypatch)

    def pieces_of(sale: AuctionSale, urls: Sequence[str]) -> FetchedPieces:
        if fetched is None:
            raise OSError("cache unreadable")
        return fetched

    monkeypatch.setattr(vision, "cached_sale_pdfs", pieces_of)
    primary = FakeModel(VALUES)
    report = vision.run_pass(
        DB_URL, vision.VisionSettings("write", OPEN_FIELDS), readers=_readers(primary, FakeModel(VALUES)), today=TODAY
    )
    assert primary.calls == 0 and report.waiting_pieces == 1 and report.failed == 0
    state = store.states[SOURCE_URL]
    assert state["status"] == "waiting_pieces" and state["attempts"] == 1


def test_nothing_is_written_when_the_deduction_alone_would_change_a_filled_fact() -> None:
    # Fiche écrite par d'anciennes règles : 8 m² habitables d'un appartement. La déduction actuelle, seule, en ferait
    # une pièce ou une annexe (type « other ») : écrire le nombre de pièces publierait ce changement.
    plan = _plan(_sale(habitable_surface_m2=Decimal("8")), {ROOMS: _verdict(3)})
    assert plan.sale is None and plan.outcomes == {ROOMS: "la_deduction_changerait_la_fiche"}
    # Une fiche que la déduction ne change pas s'écrit.
    assert _plan(_sale(), {ROOMS: _verdict(3)}).outcomes == {ROOMS: "ecrit"}


def test_a_value_read_by_claude_survives_the_multi_lot_guard_of_the_pdf_reading() -> None:
    from src.pdf_fact_extraction import enrich_sale_from_pdf_text

    sale = _written_sale()
    lots = "Lot 1 : appartement de 3 pieces, 62 m2. Lot 2 : appartement de 5 pieces, 98 m2."
    texts = _pdf_texts(PIECE_URL, lots, hashlib.sha256(PDF).hexdigest())
    texts[0]["complete"] = False  # passe partielle : seul l'effacement de la garde des lots s'applique
    texts[0]["extraction_status"] = "incomplete"
    enrich_sale_from_pdf_text(sale, texts)

    assert sale.raw_payload.get("pdf_multi_lot_guard") is not None
    assert sale.habitable_surface_m2 == Decimal("62.4") and sale.rooms_count == 3
    assert {HABITABLE, ROOMS} <= vision.vision_traces(sale)


def test_tesseract_never_receives_a_secret_of_the_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.pdf_ocr import tesseract_environment

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-never-shown")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://user:secret@example.test/db")
    monkeypatch.setenv("PATH", "/usr/bin")
    env = tesseract_environment("/usr/share/tessdata")
    assert "ANTHROPIC_API_KEY" not in env and "SUPABASE_DB_URL" not in env
    assert env["PATH"] == "/usr/bin" and env["TESSDATA_PREFIX"] == "/usr/share/tessdata"
    assert set(env) <= {"PATH", "LANG", "LC_ALL", "TESSDATA_PREFIX", "OMP_THREAD_LIMIT", "HOME"}


# --- Exécution réelle (PIPELINE_TEST_DB_URL, base jetable, sinon ignoré) ------------------------------------------

ROOT = Path(__file__).resolve().parents[3]


def _withdrawal_functions() -> str:
    text = (ROOT / "supabase/migrations/20261021110000_licitor_source_withdrawal.sql").read_text()
    chunks = []
    for name in ("catalogue_withdrawn_sources", "sale_is_fully_withdrawn"):
        start = text.index(f"create or replace function app_private.{name}(")
        chunks.append(text[start : text.index("$function$;", start) + len("$function$;")])
    return "\n".join(chunks)


def _connect() -> Any:
    from src.storage.supabase_client import _postgres_connect

    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    return _postgres_connect(url)


def test_the_candidates_state_and_withdrawal_queries_run_on_postgres() -> None:
    with _connect() as db:
        try:
            db.execute("create schema if not exists app_private")
            db.execute(
                """create table public.auction_sales(id uuid primary key, source_url text unique not null,
                source_name text not null, source_urls jsonb, status text not null default 'upcoming',
                sale_date timestamptz, observations jsonb not null default '[]', raw_payload jsonb,
                property_type text, city text, surface_m2 numeric, app_surface_m2 numeric,
                habitable_surface_m2 numeric, carrez_surface_m2 numeric, land_surface_m2 numeric,
                rooms_count integer, occupancy_status text, held_fields jsonb)"""
            )
            db.execute(
                """create table public.auction_extractions(source_url text not null, provider text not null,
                result jsonb, updated_at timestamptz not null)"""
            )
            db.execute(
                "create table if not exists public.document_reading_exclusions(source_url text primary key, reason text)"
            )
            db.execute(
                "create table public.auction_source_state(source_name text primary key,"
                " catalogue_withdrawn boolean not null default false)"
            )
            db.execute(_withdrawal_functions())
            complete = {"llm_fact_coverage": {"complete": True}}
            failed_due = {**complete, "document_vision": {
                "prompt_version": PROMPT_VERSION, "status": "failed", "attempts": 1,
                "read_at": (datetime.now(UTC) - timedelta(hours=13)).isoformat(), "text_at": TEXT_AT.isoformat()}}
            failed_waiting = {**complete, "document_vision": {**failed_due["document_vision"],
                              "read_at": (datetime.now(UTC) - timedelta(hours=11)).isoformat()}}
            read = {**complete, "document_vision": {"prompt_version": PROMPT_VERSION, "status": "completed",
                                                    "mode": "write", "text_at": TEXT_AT.isoformat()}}
            read_dry = {**complete, "document_vision": {**read["document_vision"], "mode": "dry_run"}}
            rows = [
                ("new", complete, None),
                ("filled", complete, 4),
                ("read", read, None),
                ("read-dry", read_dry, None),
                ("failed-due", failed_due, None),
                ("failed-waiting", failed_waiting, None),
                ("excluded", complete, None),
            ]
            for number, (name, payload, rooms) in enumerate(rows, start=1):
                url = f"https://example.test/{name}"
                db.execute(
                    """insert into public.auction_sales(id, source_url, source_name, source_urls, raw_payload,
                    rooms_count) values (%s, %s, 'licitor', '[]', %s, %s)""",
                    (f"00000000-0000-4000-8000-{number:012d}", url, Jsonb(payload), rooms),
                )
                db.execute(
                    "insert into public.auction_extractions values (%s, 'pdf_text', %s, %s)",
                    (url, Jsonb(MANIFEST), TEXT_AT),
                )
            db.execute(
                "insert into public.document_reading_exclusions(source_url, reason)"
                " values ('https://example.test/excluded', 'opposition')"
            )

            def selected(mode: str) -> list[str]:
                found = db.execute(
                    vision.candidates_sql((ROOMS,)), {"prompt_version": PROMPT_VERSION, "mode": mode, "limit": 10}
                ).fetchall()
                return sorted(str(row[1]).rsplit("/", 1)[1] for row in found)

            assert selected("write") == ["failed-due", "new", "read-dry"]
            assert selected("dry_run") == ["failed-due", "new"]

            db.execute(vision._RECORD_STATE_SQL, (Jsonb({"status": "completed"}), "https://example.test/new"))
            state = db.execute(
                "select raw_payload -> 'document_vision', raw_payload -> 'llm_fact_coverage' from public.auction_sales"
                " where source_url = 'https://example.test/new'"
            ).fetchone()
            assert state == ({"status": "completed"}, {"complete": True})

            trace = {"pdf_fact_provenance": {ROOMS: {"reader": TRACE_READER, "prompt_version": PROMPT_VERSION}}}
            db.execute(
                "update public.auction_sales set raw_payload = raw_payload || %s where source_url = %s",
                (Jsonb(trace), "https://example.test/filled"),
            )
            traced = db.execute(vision._TRACED_SALES_SQL, (TRACE_READER, PROMPT_VERSION, PROMPT_VERSION)).fetchall()
            assert traced == [("https://example.test/filled",)]
            assert db.execute(vision._TRACED_SALES_SQL, (TRACE_READER, "autre", "autre")).fetchall() == []
            assert db.execute(vision._TRACED_SALES_SQL, (TRACE_READER, None, None)).fetchall() == traced

            # Registre des pièces : les vrais champs et leurs colonnes (migration 20261116100000).
            db.execute(
                """create table public.auction_fact_fields(field_key text primary key, held_columns text[],
                value_type text, abs_tolerance numeric, rel_tolerance numeric, on_listing_change text,
                hold_enabled boolean)"""
            )
            registry = (ROOT / "supabase/migrations/20261116100000_fact_registry_tables.sql").read_text()
            start = registry.index("insert into public.auction_fact_fields (")
            db.execute(registry[start : registry.index("on conflict (field_key) do nothing;", start)])
            for role in ("anon", "authenticated", "service_role"):
                db.execute(
                    f"do $$ begin if not exists(select from pg_roles where rolname='{role}') "
                    f"then create role {role}; end if; end $$"
                )
            function = (ROOT / "supabase/migrations/20261208100100_sale_registry_columns.sql").read_text()
            db.execute(function[function.index("create or replace function") : function.index("\ncommit;")])
            held = {
                "property.surface_m2": {"state": "released", "echo": [{"value": 54}]},
                "property.rooms_count": {"state": "held", "value": 3},
            }
            db.execute(
                "update public.auction_sales set held_fields = %s where source_url = 'https://example.test/new'",
                (Jsonb(held),),
            )

            def registry_columns(url: str) -> list[str]:
                row = db.execute(vision._REGISTRY_COLUMNS_SQL, (url,)).fetchone()
                return sorted(row[0])

            assert registry_columns("https://example.test/new") == [
                "app_surface_kind", "app_surface_m2", "rooms_count", "surface_confidence", "surface_m2", "surface_source",
            ]
            assert registry_columns("https://example.test/filled") == []
        finally:
            db.rollback()
