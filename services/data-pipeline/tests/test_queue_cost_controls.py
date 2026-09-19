from types import SimpleNamespace

from src import queued_runner
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
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
