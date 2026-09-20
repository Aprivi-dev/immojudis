from types import SimpleNamespace

from src import queued_runner
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.llm_requests import LLMRequestDeterministicCooldown
from src.models import AuctionSale


def _queue(monkeypatch):
    settings = queued_runner.load_settings()
    sale = AuctionSale(
        source_name="avoventes", source_url="https://example.test/covered",
        description="Appartement sans indication fiable de surface ou d'occupation.",
        raw_payload={
            "llm_display_description": "Appartement décrit dans les documents de vente. Les informations absentes restent à vérifier auprès de la source.",
            "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
            "llm_display_status": "accepted",
            "llm_prompt_version": settings["llm_prompt_version"],
            "llm_display_prompt_version": settings["llm_display_prompt_version"],
            "llm_fact_coverage": {"complete": True},
        },
    )
    jobs = [{"id": "00000000-0000-0000-0000-000000000001", "source_url": sale.source_url,
             "job_type": "fact_extraction", "attempt_count": 1}]
    finished = []
    monkeypatch.setattr(queued_runner, "claim_auction_enrichment_jobs_from_supabase", lambda **kw: jobs)
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _: sale)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda *a, **kw: 1)
    monkeypatch.setattr(queued_runner, "geocode_sale", lambda *a: None)
    monkeypatch.setattr(queued_runner, "fill_tribunal", lambda *a: None)
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda *a: None)
    monkeypatch.setattr(queued_runner, "finish_auction_enrichment_job_in_supabase", lambda *a, **kw: finished.append(kw))
    return sale, jobs, finished


def test_covered_missing_fields_do_not_trigger_another_fact_call(monkeypatch):
    sale, jobs, finished = _queue(monkeypatch)
    jobs.append({**jobs[0], "id": "00000000-0000-0000-0000-000000000002", "job_type": "display_description"})
    monkeypatch.setattr(queued_runner, "has_current_fact_analysis", lambda _: True)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: (_ for _ in ()).throw(AssertionError("No paid client needed")))
    assert sale.app_surface_m2 is None
    assert queued_runner.run_enrichment_queue_batch(limit=2) == 2
    assert len(finished) == 2 and all(row["succeeded"] for row in finished)


def test_stale_display_with_current_facts_only_generates_display(monkeypatch):
    sale, _, finished = _queue(monkeypatch)
    sale.raw_payload.pop("llm_display_description")
    monkeypatch.setattr(queued_runner, "has_current_fact_analysis", lambda _: True)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    modes = []
    def enrich(current, **kwargs):
        modes.append(kwargs["extraction_mode"])
        current.raw_payload["llm_display_description"] = "Appartement décrit dans les documents de vente. Les informations absentes restent à vérifier auprès de la source."
        return SimpleNamespace(valid_json=1, errors=0, unavailable=False)
    monkeypatch.setattr(queued_runner, "enrich_sale_with_llm", enrich)
    queued_runner.run_enrichment_queue_batch(limit=1)
    assert modes == ["display_description"]
    assert finished[0]["succeeded"] is True


def test_display_job_with_planned_facts_generates_only_final_description(monkeypatch):
    sale, jobs, finished = _queue(monkeypatch)
    jobs.clear()
    jobs.append({
        "id": "00000000-0000-0000-0000-000000000003",
        "source_url": sale.source_url,
        "job_type": "display_description",
        "attempt_count": 1,
    })
    sale.raw_payload["document_analysis"] = {"documents_extracted": 1}
    monkeypatch.setattr(queued_runner, "has_current_fact_analysis", lambda _: False)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    modes = []

    def enrich(current, **kwargs):
        modes.append(kwargs["extraction_mode"])
        current.raw_payload.update(
            {
                "llm_display_description": "Description finale fondée sur les faits. " * 3,
                "llm_fact_coverage": {"complete": True},
            }
        )
        return SimpleNamespace(valid_json=1, errors=0, unavailable=False)

    monkeypatch.setattr(queued_runner, "enrich_sale_with_llm", enrich)
    assert queued_runner.run_enrichment_queue_batch(limit=1) == 1
    assert modes == ["structured_then_display"]
    assert finished[0]["succeeded"] is True


def test_deterministic_cooldown_defers_only_its_sale_and_keeps_batch_progress(monkeypatch):
    settings = queued_runner.load_settings()
    sales = {
        f"https://example.test/{suffix}": AuctionSale(
            source_name="avoventes",
            source_url=f"https://example.test/{suffix}",
            starting_price_eur=100_000,
            raw_payload={
                "llm_prompt_version": settings["llm_prompt_version"],
                "llm_display_prompt_version": settings["llm_display_prompt_version"],
                "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
            },
        )
        for suffix in ("blocked", "healthy")
    }
    jobs = [
        {
            "id": f"00000000-0000-0000-0000-00000000000{index}",
            "source_url": sale.source_url,
            "job_type": "display_description",
            "attempt_count": 1,
        }
        for index, sale in enumerate(sales.values(), start=4)
    ]
    deferred: list[str] = []
    finished: list[str] = []

    monkeypatch.setattr(queued_runner, "claim_auction_enrichment_jobs_from_supabase", lambda **_: jobs)
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", sales.get)
    monkeypatch.setattr(queued_runner, "create_llm_client", lambda: object())
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", lambda *_a, **_kw: 1)
    monkeypatch.setattr(queued_runner, "geocode_sale", lambda *_a: None)
    monkeypatch.setattr(queued_runner, "fill_tribunal", lambda *_a: None)
    monkeypatch.setattr(queued_runner, "normalize_asset_features", lambda *_a: None)
    monkeypatch.setattr(
        queued_runner,
        "defer_budget_jobs",
        lambda sale_jobs, _error: deferred.extend(str(job["id"]) for job in sale_jobs),
    )
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append(job_id) if kwargs.get("succeeded") else None,
    )

    def enrich(sale, **_kwargs):
        if sale.source_url.endswith("/blocked"):
            raise LLMRequestDeterministicCooldown("deterministic request key blocked")
        sale.raw_payload["llm_display_description"] = "Description finale vérifiée. " * 5
        return SimpleNamespace(valid_json=1, errors=0, unavailable=False)

    monkeypatch.setattr(queued_runner, "enrich_sale_with_llm", enrich)

    assert queued_runner.run_enrichment_queue_batch(limit=2) == 2
    assert deferred == [jobs[0]["id"]]
    assert finished == [jobs[1]["id"]]
