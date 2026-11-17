"""One general claim in four is oldest-first, with a fallback for a database without the family (16/11/2026)."""

from __future__ import annotations

import httpx
import pytest

from src import general_lane_claims as lane


def _claim(*, refuse_oldest: str | None = None):
    families: list[str] = []

    def claim(*, family: str, limit: int) -> list[dict[str, object]]:
        families.append(family)
        if family == lane.ENRICHMENT_OLDEST_CLAIM_FAMILY and refuse_oldest is not None:
            request = httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim_auction_enrichment_jobs_request")
            response = httpx.Response(400, json={"code": refuse_oldest, "message": "refused"}, request=request)
            raise httpx.HTTPStatusError("refused", request=request, response=response)
        return [{"id": f"{family}-{len(families)}"}]

    return claim, families


def test_one_general_claim_in_four_is_oldest_first_during_a_worker_run() -> None:
    # The urgency bonus kept jobs of distant sales out of the head of the general lane for days.
    claim, families = _claim()
    token = lane.start_worker_general_claims()
    try:
        for _ in range(8):
            lane.claim_general_jobs(claim, limit=1)
    finally:
        lane.end_worker_general_claims(token)

    assert families == (["enrichment"] * 3 + ["enrichment_oldest"]) * 2


def test_general_claims_outside_a_worker_run_keep_the_score_order() -> None:
    claim, families = _claim()
    for _ in range(4):
        lane.claim_general_jobs(claim, limit=1)
    assert families == ["enrichment"] * 4


def test_a_database_without_the_oldest_family_falls_back_for_the_rest_of_the_run() -> None:
    claim, families = _claim(refuse_oldest="22023")
    token = lane.start_worker_general_claims()
    try:
        claimed = [lane.claim_general_jobs(claim, limit=1) for _ in range(8)]
    finally:
        lane.end_worker_general_claims(token)

    assert families == ["enrichment"] * 3 + ["enrichment_oldest", "enrichment"] + ["enrichment"] * 4
    assert all(len(jobs) == 1 for jobs in claimed)


def test_another_claim_error_is_not_mistaken_for_a_missing_family() -> None:
    claim, _families = _claim(refuse_oldest="42501")
    token = lane.start_worker_general_claims()
    try:
        for _ in range(3):
            lane.claim_general_jobs(claim, limit=1)
        with pytest.raises(httpx.HTTPStatusError):
            lane.claim_general_jobs(claim, limit=1)
    finally:
        lane.end_worker_general_claims(token)


def test_the_worker_routes_its_general_claims_through_the_lane(monkeypatch) -> None:
    from src import queued_runner

    families: list[str] = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: families.append(family) or [],
    )
    token = lane.start_worker_general_claims()
    try:
        for _ in range(4):
            queued_runner._claim_enrichment_queue_jobs(limit=1, family="enrichment")
        queued_runner._claim_enrichment_queue_jobs(limit=2, family="source_detail")
    finally:
        lane.end_worker_general_claims(token)

    assert families == ["enrichment"] * 3 + ["enrichment_oldest", "source_detail"]


def _pdf_claim(*, refuse: str | None = None):
    families: list[str] = []

    def claim(*, family: str, limit: int) -> list[dict[str, object]]:
        families.append(family)
        if refuse is not None:
            request = httpx.Request("POST", "https://supabase.test/rest/v1/rpc/claim_auction_enrichment_jobs_request")
            response = httpx.Response(400, json={"code": refuse, "message": "refused"}, request=request)
            raise httpx.HTTPStatusError("refused", request=request, response=response)
        return [{"id": "pdf-1", "job_type": "pdf"}]

    return claim, families


def test_document_readings_only_claim_the_enrichment_pdf_family() -> None:
    # 17/11/2026: the AI budget refuses the fact passes, the document readings (no AI) go on.
    claim, families = _pdf_claim()
    token = lane.start_worker_general_claims()
    try:
        assert lane.claim_pdf_jobs(claim, limit=1) == [{"id": "pdf-1", "job_type": "pdf"}]
        assert lane.pdf_family_available()
        # The document readings never count towards the oldest-first share of the general claims.
        assert [lane.claim_general_jobs(claim, limit=1) for _ in range(3)]
    finally:
        lane.end_worker_general_claims(token)
    assert families == ["enrichment_pdf"] + ["enrichment"] * 3


def test_a_database_without_the_pdf_family_is_asked_once_per_run() -> None:
    claim, families = _pdf_claim(refuse="22023")
    token = lane.start_worker_general_claims()
    try:
        assert lane.claim_pdf_jobs(claim, limit=1) == []
        assert not lane.pdf_family_available()
        assert lane.claim_pdf_jobs(claim, limit=1) == []
    finally:
        lane.end_worker_general_claims(token)
    assert families == ["enrichment_pdf"]
    assert lane.pdf_family_available()  # outside a worker run


def test_another_pdf_claim_error_is_not_mistaken_for_a_missing_family() -> None:
    claim, _families = _pdf_claim(refuse="42501")
    token = lane.start_worker_general_claims()
    try:
        with pytest.raises(httpx.HTTPStatusError):
            lane.claim_pdf_jobs(claim, limit=1)
        assert lane.pdf_family_available()
    finally:
        lane.end_worker_general_claims(token)


def test_the_worker_routes_its_document_reading_claims_through_the_lane(monkeypatch) -> None:
    from src import queued_runner
    from src.storage import supabase_client

    families: list[str] = []
    monkeypatch.setattr(
        queued_runner,
        "claim_auction_enrichment_jobs_family_from_supabase",
        lambda *, family, limit: families.append(family) or [],
    )
    token = lane.start_worker_general_claims()
    try:
        queued_runner._claim_enrichment_queue_jobs(limit=1, family="enrichment", pdf_only=True)
        with pytest.raises(ValueError):
            queued_runner._claim_enrichment_queue_jobs(limit=1, family="source_detail", pdf_only=True)
    finally:
        lane.end_worker_general_claims(token)
    assert families == ["enrichment_pdf"]
    assert "enrichment_pdf" in supabase_client.ENRICHMENT_QUEUE_FAMILIES
