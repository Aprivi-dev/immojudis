"""A date read in the attachments survives a re-read of a source page that gives none (02/11/2026)."""

from src.known_document_backfill import backfill_document_sale_date_from_known

DEADLINE = "2026-12-10T14:00:00+00:00"


def _known(sale_date: str | None) -> dict[str, object]:
    return {
        "sale_date": sale_date,
        "raw_payload": {
            "pdf_sale_date_extraction": {"sale_date": DEADLINE, "sale_date_kind": "offer_deadline"},
            "pdf_fact_provenance": {"sale_date": {"source": "pdf", "value": DEADLINE}},
        },
    }


def test_the_document_deadline_is_kept_when_the_page_has_no_date() -> None:
    sale: dict[str, object] = {"sale_date": None}
    assert backfill_document_sale_date_from_known(sale, _known(DEADLINE)) == 1
    assert sale["sale_date"] == DEADLINE


def test_a_deadline_already_lost_is_restored_from_its_trace() -> None:
    sale: dict[str, object] = {"sale_date": None}
    assert backfill_document_sale_date_from_known(sale, _known(None)) == 1
    assert sale["sale_date"] == DEADLINE


def test_a_date_of_the_page_or_without_document_trace_is_left_alone() -> None:
    dated = {"sale_date": "2027-01-05T10:00:00+00:00"}
    assert backfill_document_sale_date_from_known(dated, _known(DEADLINE)) == 0
    assert dated["sale_date"] == "2027-01-05T10:00:00+00:00"

    untraced: dict[str, object] = {"sale_date": None}
    assert backfill_document_sale_date_from_known(untraced, {"sale_date": DEADLINE, "raw_payload": {}}) == 0
    assert untraced["sale_date"] is None
