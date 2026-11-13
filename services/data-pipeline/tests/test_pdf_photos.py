"""Photos des pièces jointes : sélection, plafond, dédoublonnage, retraits. Aucun réseau, aucune base."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from src import pdf_photos, source_withdrawal
from src.pdf_photos import (
    CANDIDATES_SQL,
    ENCHERES_PUBLIQUES_URL_PATTERN,
    MAX_ATTEMPTS,
    MAX_PHOTOS_PER_SALE,
    PHOTO_DOCUMENT_TYPES,
    RETRY_AFTER_HOURS,
    Candidate,
    DocumentPhoto,
    Extraction,
    PassLimits,
    PdfDownloader,
    PhotoRow,
    PostgresDocumentPhotoStore,
    ScanResult,
    check_pdf_prefix,
    parse_extraction,
    pass_enabled,
    photo_paths,
    process_document,
    public_url,
    run_pdf_photos,
    select_new_photos,
)
from src.photo_mirror import ImageRejected, MirrorFailure, RetryableFailure

SALE_ID = "f91d4624-09d6-4d25-b676-811ea30f6df9"
DOCUMENT_URL = "https://cessions.example.test/documents/2_Condition_de_vente_-_Cahier_des_charges_250330002.pdf"
SUPABASE_URL = "https://project.supabase.co"
SETTINGS: dict[str, object] = {
    "user_agent": "TestBot/1.0 (+https://example.test/contact)",
    "supabase_db_url": "",
    "supabase_url": SUPABASE_URL,
    "enable_encheres_publiques_benchmark": False,
    "encheres_publiques_access_authorized": False,
}
PGTAP = Path(__file__).resolve().parents[3] / "supabase" / "tests" / "869_sale_document_photos.sql"
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 8


def _sha(letter: str) -> str:
    return letter * 64


def _photo(letter: str, position: int = 1, *, single: bool = False) -> DocumentPhoto:
    return DocumentPhoto(
        sha256=_sha(letter),
        page=position,
        position=position,
        width=1046,
        height=657,
        single=single,
        data_640=WEBP,
        data_1600=WEBP,
    )


def _candidate(**changes: Any) -> Candidate:
    values: dict[str, Any] = {
        "sale_id": SALE_ID,
        "sale_source_name": "cessions_etat",
        "observations": [],
        "sale_source_url": "https://cessions.example.test/vente/250330002",
        "document_url": DOCUMENT_URL,
        "label": "2_Condition_de_vente_-_Cahier_des_charges",
        "document_type": "cahier_conditions_vente",
        "previous_attempts": 0,
    }
    values.update(changes)
    return Candidate(**values)


class FakeStore:
    def __init__(self, *, stored: int = 0, known: set[str] | None = None, queued: bool = False) -> None:
        self.stored = stored
        self.known = set(known or ())
        self.queued = queued
        self.inserted: list[PhotoRow] = []
        self.scans: list[ScanResult] = []
        self.candidates: list[Candidate] = []
        self.selected_with: list[tuple[int, bool]] = []
        self.rows: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self.withdrawn_scans: list[tuple[str, str]] = []
        self.hidden_deleted = 0
        self.stale_calls = 0
        self.closed = False

    def try_lock(self) -> bool:
        return True

    def select_candidates(self, max_sales: int, *, include_encheres_publiques: bool) -> list[Candidate]:
        self.selected_with.append((max_sales, include_encheres_publiques))
        return list(self.candidates)

    def known_hashes(self, sale_id: str) -> set[str]:
        return set(self.known)

    def stored_count(self, sale_id: str) -> int:
        return self.stored

    def paths_queued_for_deletion(self, paths: list[str]) -> bool:
        return self.queued

    def insert_photo(self, row: PhotoRow) -> bool:
        if row.image_sha256 in self.known:
            return False
        self.known.add(row.image_sha256)
        self.stored += 1
        self.inserted.append(row)
        return True

    def save_scan(self, result: ScanResult) -> None:
        self.scans.append(result)

    def stored_rows(self) -> list[dict[str, Any]]:
        return list(self.rows)

    def delete_rows(self, ids: list[str]) -> int:
        self.deleted.extend(ids)
        return len(ids)

    def mark_scans_withdrawn(self, keys: list[tuple[str, str]]) -> None:
        self.withdrawn_scans.extend(keys)

    def delete_hidden_rows(self, limit: int) -> int:
        return self.hidden_deleted

    def delete_stale_rows(self, limit: int) -> int:
        self.stale_calls += 1
        return 0

    def close(self) -> None:
        self.closed = True


class FakeStorage:
    def __init__(self, *, fail_on: str | None = None) -> None:
        self.uploads: list[str] = []
        self.removed: list[str] = []
        self.fail_on = fail_on

    def upload(self, path: str, data: bytes) -> None:
        if self.fail_on and path.endswith(self.fail_on):
            raise RuntimeError("storage down")
        self.uploads.append(path)

    def remove(self, paths: list[str]) -> None:
        self.removed.extend(paths)


class FakeDownloader:
    def __init__(self, outcome: bytes | Exception = b"%PDF-1.7\n...") -> None:
        self.outcome = outcome
        self.downloads: list[str] = []

    def precheck(self, url: str) -> None:
        return None

    def download(self, url: str, *, pass_deadline: float) -> bytes:
        self.downloads.append(url)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def _extraction(*photos: DocumentPhoto) -> Extraction:
    return Extraction(pages=29, images=14, rejected={"low_contrast": 2, "mostly_white": 3}, photos=tuple(photos))


def _process(
    candidate: Candidate | None = None,
    *,
    store: FakeStore | None = None,
    storage: FakeStorage | None = None,
    downloader: FakeDownloader | None = None,
    extraction: Extraction | Exception | None = None,
) -> tuple[ScanResult, FakeStore, FakeStorage, FakeDownloader]:
    store = store or FakeStore()
    storage = storage or FakeStorage()
    downloader = downloader or FakeDownloader()
    outcome = extraction if extraction is not None else _extraction(_photo("a", 6), _photo("b", 7))

    def extract(data: bytes) -> Extraction:
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    result = process_document(
        candidate or _candidate(),
        downloader=downloader,  # type: ignore[arg-type]
        storage=storage,
        store=store,
        settings=SETTINGS,
        pass_deadline=1e12,
        extract=extract,
    )
    return result, store, storage, downloader


# --------------------------------------------------------------------------------------------------
# Sélection
# --------------------------------------------------------------------------------------------------


def test_photo_bearing_types_never_include_the_diagnostics() -> None:
    assert PHOTO_DOCUMENT_TYPES == ("pv_huissier", "cahier_conditions_vente", "proces_verbal", "conditions_vente")
    assert "diagnostics_techniques" not in PHOTO_DOCUMENT_TYPES


def test_the_selection_sql_reads_upcoming_public_sales_nearest_first() -> None:
    sql = re.sub(r"\s+", " ", CANDIDATES_SQL)

    assert "coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')" in sql
    assert "not s.catalogue_quarantined" in sql
    assert "app_private.sale_catalogue_projection_is_live(" in sql
    assert "join public.auction_documents d on d.source_url = s.source_url" in sql
    assert "d.document_type = any (%s::text[])" in sql
    # A document is read once: no scan row yet, or an old failure with attempts left.
    assert "scan.id is null" in sql and "scan.status = 'failed'" in sql
    # Undated sales count as ending within a week; nearest sale dates first.
    assert "coalesce(s.sale_date, now() + interval '7 days') as due_at" in sql
    assert "order by min(pending.due_at), pending.sale_id limit %s" in sql
    # The cap: a sale that already has its 12 document photos is not selected again.
    assert "photo.status = 'stored' ) < %s" in sql
    # Encheres Publiques stays closed (document host and sale source).
    assert "(%s or d.document_url !~* %s)" in sql and "<> 'encheres_publiques'" in sql
    assert CANDIDATES_SQL.count("%s") == 9


def test_the_store_passes_the_pipeline_parameters_in_order() -> None:
    executed: list[tuple[str, tuple[Any, ...]]] = []

    class Connection:
        autocommit = False

        def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
            executed.append((sql, params))
            row = (SALE_ID, "cessions_etat", [], "https://cessions.example.test/v", DOCUMENT_URL, "Cahier", "cahier_conditions_vente", 1)
            return type("Cursor", (), {"fetchall": lambda self: [row]})()

    store = PostgresDocumentPhotoStore("postgresql://test", connect=lambda _url: Connection())
    candidates = store.select_candidates(3, include_encheres_publiques=False)

    sql, params = executed[0]
    assert sql == CANDIDATES_SQL
    assert params == (
        list(PHOTO_DOCUMENT_TYPES),
        MAX_ATTEMPTS,
        RETRY_AFTER_HOURS,
        MAX_PHOTOS_PER_SALE,
        False,
        ENCHERES_PUBLIQUES_URL_PATTERN,
        False,
        3,
        list(PHOTO_DOCUMENT_TYPES),
    )
    assert candidates == [
        Candidate(
            sale_id=SALE_ID,
            sale_source_name="cessions_etat",
            observations=[],
            sale_source_url="https://cessions.example.test/v",
            document_url=DOCUMENT_URL,
            label="Cahier",
            document_type="cahier_conditions_vente",
            previous_attempts=1,
        )
    ]


def _numbered(sql: str) -> str:
    counter = iter(range(1, 100))
    return re.sub(r"%s", lambda _match: f"${next(counter)}", sql)


def test_the_pgtap_test_runs_the_exact_candidates_sql_with_the_pipeline_parameters() -> None:
    text = re.sub(r"\s+", " ", PGTAP.read_text(encoding="utf-8")).strip()

    assert re.sub(r"\s+", " ", _numbered(CANDIDATES_SQL)).strip() in text
    types = "array[" + ", ".join(f"'{kind}'" for kind in PHOTO_DOCUMENT_TYPES) + "]"
    closed = (
        f"{types}, {MAX_ATTEMPTS}, {RETRY_AFTER_HOURS}, {MAX_PHOTOS_PER_SALE}, false, "
        f"'{ENCHERES_PUBLIQUES_URL_PATTERN}', false, 10, {types}"
    )
    assert closed in text


# --------------------------------------------------------------------------------------------------
# Un document
# --------------------------------------------------------------------------------------------------


def test_photos_are_stored_under_the_documents_prefix_with_their_public_url() -> None:
    result, store, storage, downloader = _process()

    assert (result.status, result.photos_stored, result.attempts) == ("done", 2, 1)
    assert (result.pages, result.images) == (29, 14)
    assert downloader.downloads == [DOCUMENT_URL]
    first = store.inserted[0]
    assert first.path_640 == f"documents/{SALE_ID}/{'a' * 16}-640.webp"
    assert first.path_1600 == f"documents/{SALE_ID}/{'a' * 16}-1600.webp"
    assert first.public_url == f"{SUPABASE_URL}/storage/v1/object/public/sale-photos/{first.path_1600}"
    assert (first.page_number, first.position, first.document_url) == (6, 6, DOCUMENT_URL)
    assert storage.uploads == [first.path_640, first.path_1600, *(store.inserted[1].path_640, store.inserted[1].path_1600)]
    assert storage.removed == []


def test_a_narrow_photo_has_a_single_file() -> None:
    result, store, storage, _ = _process(extraction=_extraction(_photo("c", 2, single=True)))

    assert result.photos_stored == 1
    row = store.inserted[0]
    assert row.path_640 == row.path_1600 and storage.uploads == [row.path_640]


def test_the_cap_and_the_dedupe_apply_across_the_documents_of_a_sale() -> None:
    # 10 photos already kept for the sale, one of them is the first image of this document.
    store = FakeStore(stored=10, known={_sha("a")})
    photos = [_photo(letter, index) for index, letter in enumerate("abcde", start=1)]

    result, store, _, _ = _process(store=store, extraction=_extraction(*photos))

    assert [row.image_sha256[0] for row in store.inserted] == ["b", "c"]
    assert result.photos_stored == 2 and store.stored == MAX_PHOTOS_PER_SALE


def test_a_full_sale_stores_nothing_but_the_document_is_marked_read() -> None:
    result, store, storage, _ = _process(store=FakeStore(stored=MAX_PHOTOS_PER_SALE))

    assert (result.status, result.photos_stored) == ("done", 0)
    assert store.inserted == [] and storage.uploads == []


def test_select_new_photos_skips_known_and_repeated_images() -> None:
    photos = (_photo("a"), _photo("b"), _photo("b"), _photo("c"), _photo("d"))

    assert [photo.sha256[0] for photo in select_new_photos(photos, {_sha("a")}, 2)] == ["b", "c"]
    assert select_new_photos(photos, set(), 0) == [] and select_new_photos(photos, set(), -3) == []


def test_a_path_still_queued_for_deletion_defers_the_document() -> None:
    result, store, storage, _ = _process(store=FakeStore(queued=True))

    assert (result.status, result.reason, result.attempts) == ("deferred", "path_queued_for_deletion", 0)
    assert store.inserted == [] and storage.uploads == []


def test_a_diagnostic_mislabelled_in_the_database_is_skipped_without_download() -> None:
    candidate = _candidate(label="Diagnostics techniques (DPE, amiante)", document_url="https://example.test/diag.pdf")

    result, _, _, downloader = _process(candidate)

    assert (result.status, result.reason) == ("skipped", "document_type")
    assert downloader.downloads == []


def test_a_vague_label_keeps_the_type_recorded_in_the_database() -> None:
    candidate = _candidate(label="Pièce n° 3", document_url="https://example.test/file/123", document_type="pv_huissier")

    result, _, _, downloader = _process(candidate)

    assert result.status == "done" and downloader.downloads == ["https://example.test/file/123"]


def test_a_withdrawn_sale_is_never_downloaded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"cessions_etat"}))

    result, _, _, downloader = _process()

    assert (result.status, result.reason) == ("withdrawn", "source_withdrawn")
    assert downloader.downloads == []


def test_encheres_publiques_documents_need_the_access_gate() -> None:
    result, _, _, downloader = _process(_candidate(sale_source_name="Encheres Publiques"))

    assert (result.status, result.reason) == ("blocked", "ep_not_authorized")
    assert downloader.downloads == []


def test_download_failures_are_recorded_for_a_retry_or_for_good() -> None:
    retry, _, _, _ = _process(downloader=FakeDownloader(RetryableFailure("network_error")))
    gone, _, _, _ = _process(downloader=FakeDownloader(MirrorFailure("gone", "http_404", permanent=True, http_status=404)))

    assert (retry.status, retry.reason, retry.attempts) == ("failed", "network_error", 1)
    assert (gone.status, gone.reason, gone.http_status) == ("gone", "http_404", 404)


def test_a_document_the_extractor_rejects_uses_up_its_attempts() -> None:
    result, store, storage, _ = _process(extraction=ImageRejected("encrypted"))

    assert (result.status, result.reason, result.attempts) == ("failed", "encrypted", MAX_ATTEMPTS)
    assert store.inserted == [] and storage.uploads == []


def test_a_storage_failure_removes_the_files_of_the_photo_being_copied_only() -> None:
    storage = FakeStorage(fail_on=f"{'b' * 16}-1600.webp")

    result, store, storage, _ = _process(storage=storage)

    assert (result.status, result.reason) == ("failed", "unexpected_RuntimeError")
    # The first photo is recorded and keeps its files; the second loses its half-copied file.
    assert [row.image_sha256[0] for row in store.inserted] == ["a"]
    assert storage.removed == [f"documents/{SALE_ID}/{'b' * 16}-640.webp"]


# --------------------------------------------------------------------------------------------------
# Le passage
# --------------------------------------------------------------------------------------------------


def test_the_switch_off_only_applies_withdrawals(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PDF_PHOTOS_ENABLED", "false")
    store = FakeStore()
    store.hidden_deleted = 2
    store.candidates = [_candidate()]

    summary = run_pdf_photos(PassLimits(), settings=SETTINGS, store=store, storage=FakeStorage())

    assert summary.stop_reason == "disabled" and summary.hidden_deleted == 2
    assert store.selected_with == [] and store.scans == [] and store.stale_calls == 0


def test_withdrawals_delete_the_photos_of_a_withdrawn_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PDF_PHOTOS_ENABLED", "off")
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset({"licitor"}))
    store = FakeStore()
    store.rows = [
        {"id": "1", "sale_id": SALE_ID, "document_url": "https://www.licitor.com/doc.pdf", "source_name": "x", "observations": []},
        {"id": "2", "sale_id": SALE_ID, "document_url": DOCUMENT_URL, "source_name": "licitor", "observations": []},
        {"id": "3", "sale_id": SALE_ID, "document_url": DOCUMENT_URL, "source_name": "cessions_etat", "observations": []},
    ]

    summary = run_pdf_photos(PassLimits(), settings=SETTINGS, store=store, storage=FakeStorage())

    assert store.deleted == ["1", "2"] and summary.withdrawn_deleted == 2
    assert store.withdrawn_scans == [(SALE_ID, DOCUMENT_URL), (SALE_ID, "https://www.licitor.com/doc.pdf")]


def test_a_pass_records_each_document_and_skips_the_deferred_one(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PDF_PHOTOS_ENABLED", raising=False)
    store = FakeStore()
    store.candidates = [_candidate(), _candidate(document_url="https://cessions.example.test/pv.pdf", label="PV descriptif")]
    calls: list[bytes] = []

    def extract(data: bytes) -> Extraction:
        calls.append(data)
        return _extraction(_photo("a", 1)) if len(calls) == 1 else _extraction(_photo("b", 1))

    summary = run_pdf_photos(
        PassLimits(max_sales=3),
        settings=SETTINGS,
        store=store,
        storage=FakeStorage(),
        downloader=FakeDownloader(),  # type: ignore[arg-type]
        extract=extract,
    )

    assert store.selected_with == [(3, False)] and store.stale_calls == 1
    assert [scan.status for scan in store.scans] == ["done", "done"]
    assert (summary.documents_processed, summary.photos_stored, summary.sales_selected) == (2, 2, 1)
    assert summary.rejected_images == {"low_contrast": 4, "mostly_white": 6}
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["pdf_photos", "pdf_photos"]


def test_the_pass_requires_the_supabase_url_when_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PDF_PHOTOS_ENABLED", raising=False)
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        run_pdf_photos(PassLimits(), settings={**SETTINGS, "supabase_url": ""}, store=FakeStore())


def test_a_budget_already_spent_stops_before_any_download(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PDF_PHOTOS_ENABLED", raising=False)
    store = FakeStore()
    store.candidates = [_candidate()]
    ticks = iter([0.0, 1000.0, 1000.0, 1000.0])
    downloader = FakeDownloader()

    summary = run_pdf_photos(
        PassLimits(budget_seconds=10),
        settings=SETTINGS,
        store=store,
        storage=FakeStorage(),
        downloader=downloader,  # type: ignore[arg-type]
        clock=lambda: next(ticks),
    )

    assert summary.stop_reason == "budget" and downloader.downloads == [] and store.scans == []


# --------------------------------------------------------------------------------------------------
# Morceaux
# --------------------------------------------------------------------------------------------------


def test_the_switch_is_on_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PDF_PHOTOS_ENABLED", raising=False)
    assert pass_enabled()
    for value, expected in (("true", True), ("", True), ("false", False), ("0", False), ("no", False), (" OFF ", False)):
        monkeypatch.setenv("PDF_PHOTOS_ENABLED", value)
        assert pass_enabled() is expected


def test_the_pdf_downloader_asks_for_a_pdf_and_checks_its_first_bytes() -> None:
    downloader = PdfDownloader(politeness=None, user_agent="x", settings=SETTINGS)
    accept, max_bytes, check, timeout = downloader.request_options()

    assert accept.startswith("application/pdf") and max_bytes == pdf_photos.MAX_PDF_BYTES and timeout > 15
    assert check is check_pdf_prefix
    check_pdf_prefix(b"%PDF-1.7\n%\xe2\xe3")
    check_pdf_prefix(b"\xef\xbb\xbf%PDF-1.4")
    with pytest.raises(MirrorFailure) as caught:
        check_pdf_prefix(b"<!doctype html><html>")
    assert (caught.value.reason, caught.value.permanent) == ("not_pdf", True)


def test_paths_and_public_url_follow_the_site_form() -> None:
    assert photo_paths(SALE_ID, _sha("e"), single=True) == (f"documents/{SALE_ID}/{'e' * 16}-640.webp",) * 2
    with pytest.raises(ValueError):
        photo_paths("not-a-uuid", _sha("e"), single=False)
    # Empreinte exacte : un saut de ligne final n'est plus accepté.
    with pytest.raises(ValueError, match="invalid sha256"):
        photo_paths(SALE_ID, _sha("e") + "\n", single=False)
    assert public_url(SUPABASE_URL + "/", "documents/x.webp") == (
        f"{SUPABASE_URL}/storage/v1/object/public/sale-photos/documents/x.webp"
    )
    with pytest.raises(ValueError):
        public_url("project.supabase.co", "documents/x.webp")


def _output(header: dict[str, Any], body: bytes = b"") -> bytes:
    return json.dumps(header).encode() + b"\n" + body


def test_a_valid_extractor_answer_is_read() -> None:
    entry = {"sha256": _sha("a"), "page": 6, "position": 6, "width": 1046, "height": 657, "single": False,
             "len640": len(WEBP), "len1600": len(WEBP)}
    extraction = parse_extraction(
        _output({"ok": True, "pages": 29, "images": 14, "rejected": {"low_contrast": 2}, "photos": [entry]}, WEBP * 2)
    )

    assert extraction.pages == 29 and extraction.rejected == {"low_contrast": 2}
    assert extraction.photos[0].sha256 == _sha("a") and extraction.photos[0].data_1600 == WEBP


@pytest.mark.parametrize(
    "output",
    [
        b"not json",
        _output({"ok": True, "photos": [{"sha256": "abc"}]}),
        _output({"ok": True, "photos": [{"sha256": "a" * 64, "page": 1, "position": 1, "width": 9, "height": 9,
                                          "single": True, "len640": 4, "len1600": 0}]}, b"abcd"),
        _output({"ok": True, "photos": []}, b"trailing"),
        _output({"ok": True, "photos": [{"sha256": "a" * 64, "page": 0, "position": 1, "width": 9, "height": 9,
                                          "single": True, "len640": len(WEBP), "len1600": 0}]}, WEBP),
    ],
)
def test_an_unreadable_or_inconsistent_extractor_answer_is_an_extract_error(output: bytes) -> None:
    with pytest.raises(ImageRejected) as caught:
        parse_extraction(output)
    assert caught.value.reason == "extract_error"


def test_a_refusal_of_the_extractor_keeps_its_reason() -> None:
    with pytest.raises(ImageRejected) as caught:
        parse_extraction(_output({"ok": False, "reason": "encrypted"}))
    assert caught.value.reason == "encrypted"
