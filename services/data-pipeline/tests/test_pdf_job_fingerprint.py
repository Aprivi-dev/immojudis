"""Unit coverage for the PDF-only enrichment job generation."""

from datetime import UTC, datetime, timedelta

from src.normalize import normalize_sale
from src.storage import supabase_client as storage

SETTINGS = {
    "llm_prompt_version": "display-v1",
    "llm_fact_prompt_version": "fact-v1",
    "llm_display_prompt_version": "display-v1",
    "replicate_model": "model-v1",
}
SOURCE_URL = "https://example.test/pdf-fingerprint"
DOCUMENT_URL = f"{SOURCE_URL}/pv.pdf"
FILE_SHA = "a" * 64


def _sale():
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": SOURCE_URL,
            "status": "upcoming",
            "sale_date": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            "documents": [{"label": "PV descriptif", "url": DOCUMENT_URL}],
        }
    )
    sale.status = "upcoming"
    sale.raw_payload["source_checks"] = {
        SOURCE_URL: {"fingerprint": "source-v1", "checked_at": "2026-09-30T08:00:00+00:00"}
    }
    sale.raw_payload["document_analysis"] = {
        "checked_at": "2026-09-30T09:00:00+00:00",
        "last_successful_check_at": "2026-09-30T08:30:00+00:00",
        "failed_documents": 1,
        "failed_pages": [2],
        "profiles": [{
            "url": DOCUMENT_URL,
            "sha256": FILE_SHA,
            "extraction_status": "incomplete",
            "complete": False,
        }],
    }
    return sale


def test_pdf_hash_ignores_source_checks_and_llm_settings() -> None:
    sale = _sale()
    baseline = storage.pdf_enrichment_input_hash_for_sale(sale, SETTINGS)

    sale.raw_payload["source_checks"][SOURCE_URL]["fingerprint"] = "source-v2"
    changed_settings = {
        **SETTINGS,
        "llm_prompt_version": "display-v2",
        "llm_fact_prompt_version": "fact-v2",
        "llm_display_prompt_version": "display-v2",
        "replicate_model": "model-v2",
    }

    assert storage.pdf_enrichment_input_hash_for_sale(sale, changed_settings) == baseline


def test_pdf_hash_tracks_documents_profiles_and_last_success(monkeypatch) -> None:
    sale = _sale()
    baseline = storage.pdf_enrichment_input_hash_for_sale(sale)

    sale.documents[0]["label"] = "PV actualisé"
    assert storage.pdf_enrichment_input_hash_for_sale(sale) != baseline

    sale.documents[0]["label"] = "PV descriptif"
    sale.documents[0]["sha256"] = "b" * 64
    assert storage.pdf_enrichment_input_hash_for_sale(sale) != baseline

    sale.documents[0].pop("sha256")
    sale.raw_payload["document_analysis"]["profiles"][0]["sha256"] = "c" * 64
    assert storage.pdf_enrichment_input_hash_for_sale(sale) != baseline

    sale.raw_payload["document_analysis"]["profiles"][0]["sha256"] = FILE_SHA
    sale.raw_payload["document_analysis"]["last_successful_check_at"] = "2026-09-30T09:30:00+00:00"
    current = storage.pdf_enrichment_input_hash_for_sale(sale)
    assert current != baseline

    monkeypatch.setattr(storage, "PDF_TEXT_CACHE_VERSION", "pdf_text_next")
    assert storage.pdf_enrichment_input_hash_for_sale(sale) != current


def test_stable_pdf_failure_does_not_renew_retry_generation() -> None:
    sale = _sale()
    baseline = storage.pdf_enrichment_input_hash_for_sale(sale)

    sale.raw_payload["document_analysis"]["checked_at"] = "2026-09-30T10:00:00+00:00"
    assert storage.pdf_enrichment_input_hash_for_sale(sale) == baseline


def test_enqueue_uses_pdf_hash_constructor(monkeypatch) -> None:
    sale = _sale()
    rows = []
    monkeypatch.setattr(storage, "load_settings", lambda: SETTINGS)
    monkeypatch.setattr(storage, "documents_are_current", lambda _sale: False)
    monkeypatch.setattr(storage, "_has_current_llm_description", lambda *_args: True)
    monkeypatch.setattr(
        "src.enrichment.extract_structured.needs_fact_extraction",
        lambda _sale: False,
    )
    monkeypatch.setattr(
        storage,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, _conflict: rows.extend(payload),
    )

    storage._enqueue_due_enrichment([sale], "unused", "unused")
    first_hash = rows[-1]["input_hash"]
    assert rows[-1]["job_type"] == "pdf"
    assert first_hash == storage.pdf_enrichment_input_hash_for_sale(sale, SETTINGS)

    sale.raw_payload["document_analysis"]["checked_at"] = "2026-09-30T10:30:00+00:00"
    sale.raw_payload["source_checks"][SOURCE_URL]["fingerprint"] = "source-v2"
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    assert rows[-1]["input_hash"] == first_hash

    sale.raw_payload["document_analysis"]["profiles"][0]["sha256"] = "d" * 64
    storage._enqueue_due_enrichment([sale], "unused", "unused")
    assert rows[-1]["input_hash"] != first_hash


class _CheckpointResult:
    def __init__(self, row=None) -> None:
        self.row = row

    def fetchone(self):
        return self.row


class _CheckpointConnection:
    def __init__(self, *, sale, job) -> None:
        self.sale = sale
        self.job = job
        self.calls = []

    def execute(self, statement, params=()):
        text = str(statement)
        self.calls.append((text, params))
        if text.startswith("select updated_at"):
            return _CheckpointResult((self.sale.updated_at,))
        if "update public.auction_sales" in text:
            return _CheckpointResult((self.sale.updated_at,))
        return _CheckpointResult()


def test_durable_checkpoint_rekeys_the_claimed_pdf_generation() -> None:
    sale = _sale()
    sale.updated_at = datetime.now(UTC)
    old_hash = storage.pdf_enrichment_input_hash_for_sale(sale)
    sale.documents[0]["sha256"] = "e" * 64
    new_hash = storage.pdf_enrichment_input_hash_for_sale(sale)
    job = {
        "id": "pdf-job",
        "job_type": "pdf",
        "input_hash": old_hash,
        "attempt_count": 1,
        "locked_at": "2026-09-30T10:00:00+00:00",
    }
    connection = _CheckpointConnection(sale=sale, job=job)

    assert storage._persist_pdf_document_checkpoint_with_connection(
        connection,
        sale,
        sale.raw_payload["document_analysis"],
        [{"url": DOCUMENT_URL, "sha256": "e" * 64, "complete": False}],
        pdf_job=job,
    ) is True
    queue_update = next(
        (
            params
            for statement, params in connection.calls
            if "update public.auction_enrichment_jobs" in statement
            and "set input_hash=%s" in statement
        ),
        None,
    )
    assert queue_update is not None
    assert queue_update[0] == new_hash
