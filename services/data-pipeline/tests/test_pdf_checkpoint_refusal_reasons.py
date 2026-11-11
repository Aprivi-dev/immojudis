"""Un point d'étape refusé dit pourquoi (04/11/2026 : 9 ventes sur 34 refusées sans raison dans un vidage)."""

from __future__ import annotations

import logging

from src.normalize import normalize_sale
from src.storage.pdf_checkpoint_rules import (
    _validate_pdf_document_checkpoint_payload,
    last_checkpoint_refusal,
    reset_checkpoint_refusal,
)


def test_a_refused_checkpoint_logs_its_reason(caplog) -> None:
    sale = normalize_sale({"source_name": "vench", "source_url": "https://example.test/refused"})
    with caplog.at_level(logging.WARNING, logger="src.storage.pdf_checkpoint_rules"):
        assert _validate_pdf_document_checkpoint_payload(sale, None, []) is None
    assert "PDF checkpoint refused for https://example.test/refused: no_analysis_or_revision" in caplog.text


def test_the_reason_of_the_last_refusal_can_be_read_until_it_is_reset() -> None:
    # Lot R6 (11/11/2026) : la file écrit ce motif dans ``last_error`` ; seul le journal du worker le donnait.
    sale = normalize_sale({"source_name": "vench", "source_url": "https://example.test/refused"})
    reset_checkpoint_refusal()
    assert last_checkpoint_refusal() is None

    assert _validate_pdf_document_checkpoint_payload(sale, None, []) is None
    assert last_checkpoint_refusal() == "no_analysis_or_revision"

    reset_checkpoint_refusal()
    assert last_checkpoint_refusal() is None
