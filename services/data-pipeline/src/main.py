from __future__ import annotations

import argparse
from dataclasses import dataclass
import logging
import sys
import time

from src.asset_normalization import normalize_asset_features
from src.dedupe import merge_duplicate_sales
from src.enrichment.extract_structured import LLMEnrichmentStats, enrich_sale_with_llm
from src.enrichment.llm_client import LLMClientUnavailable, create_llm_client
from src.export import export_sales
from src.geocode import geocode_sale
from src.lifecycle import mark_past_sales
from src.normalize import normalize_sale
from src.pdf_enrichment import PdfEnrichmentStats, enrich_sale_from_pdfs
from src.config import load_settings
from src.quality import build_quality_report, format_quality_report
from src.sources.encheres_publiques import scrape_encheres_publiques_aquitaine_result
from src.sources.avoventes import scrape_avoventes_aquitaine_result
from src.sources.info_encheres import scrape_info_encheres_aquitaine_result
from src.sources.licitor import scrape_licitor_aquitaine_result
from src.sources.vench import scrape_vench_aquitaine_result
from src.storage.supabase_client import upsert_sales_to_supabase
from src.storage.supabase_client import upsert_observations_to_supabase
from src.storage.supabase_client import mark_past_sales_in_supabase
from src.storage.supabase_client import create_run_in_supabase, finish_run_in_supabase
from src.tribunal import fill_tribunal


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
LOGGER = logging.getLogger(__name__)
SOURCE_NAMES = ("avoventes", "licitor", "vench", "info_encheres", "encheres_publiques")


@dataclass
class PipelineOptions:
    source: str = "all"
    use_llm: bool = True
    upsert: bool = True
    limit: int | None = None
    run_id: str | None = None


def run_pipeline(options: PipelineOptions | None = None) -> int:
    options = options or PipelineOptions()
    settings = load_settings()
    run_id = create_run_in_supabase(options.source, options.use_llm, run_id=options.run_id) if options.upsert else None
    errors: dict[str, list[str]] = {source: [] for source in SOURCE_NAMES}
    raw_sales: list[dict[str, object]] = []
    raw_by_source = {source: 0 for source in SOURCE_NAMES}
    timings: dict[str, float] = {}

    if options.source in {"all", "avoventes"}:
        started = time.perf_counter()
        avoventes_result = scrape_avoventes_aquitaine_result()
        timings["scrape_avoventes_seconds"] = round(time.perf_counter() - started, 2)
        avoventes_sales = avoventes_result.sales
        errors["avoventes"].extend(avoventes_result.errors)
        raw_by_source["avoventes"] = len(avoventes_sales)
        raw_sales.extend(avoventes_sales)

    if options.source == "licitor" or (options.source == "all" and settings["enable_licitor_benchmark"]):
        started = time.perf_counter()
        licitor_result = scrape_licitor_aquitaine_result(max_pages=int(settings["licitor_max_pages"]))
        timings["scrape_licitor_seconds"] = round(time.perf_counter() - started, 2)
        licitor_sales = licitor_result.sales
        errors["licitor"].extend(licitor_result.errors)
        raw_by_source["licitor"] = len(licitor_sales)
        raw_sales.extend(licitor_sales)

    if options.source == "vench" or (options.source == "all" and settings["enable_vench_benchmark"]):
        started = time.perf_counter()
        vench_result = scrape_vench_aquitaine_result(max_pages=int(settings["vench_max_pages"]))
        timings["scrape_vench_seconds"] = round(time.perf_counter() - started, 2)
        vench_sales = vench_result.sales
        errors["vench"].extend(vench_result.errors)
        raw_by_source["vench"] = len(vench_sales)
        raw_sales.extend(vench_sales)

    if options.source == "info_encheres" or (
        options.source == "all" and settings["enable_info_encheres_benchmark"]
    ):
        started = time.perf_counter()
        info_encheres_result = scrape_info_encheres_aquitaine_result(
            max_pages=int(settings["info_encheres_max_pages"])
        )
        timings["scrape_info_encheres_seconds"] = round(time.perf_counter() - started, 2)
        info_encheres_sales = info_encheres_result.sales
        errors["info_encheres"].extend(info_encheres_result.errors)
        raw_by_source["info_encheres"] = len(info_encheres_sales)
        raw_sales.extend(info_encheres_sales)

    if options.source == "encheres_publiques" or (
        options.source == "all" and settings["enable_encheres_publiques_benchmark"]
    ):
        started = time.perf_counter()
        encheres_publiques_result = scrape_encheres_publiques_aquitaine_result(
            max_pages=int(settings["encheres_publiques_max_pages"])
        )
        timings["scrape_encheres_publiques_seconds"] = round(time.perf_counter() - started, 2)
        encheres_publiques_sales = encheres_publiques_result.sales
        errors["encheres_publiques"].extend(encheres_publiques_result.errors)
        raw_by_source["encheres_publiques"] = len(encheres_publiques_sales)
        raw_sales.extend(encheres_publiques_sales)

    if options.limit is not None:
        raw_sales = raw_sales[: options.limit]

    normalized_observations = []
    started = time.perf_counter()
    for raw_sale in raw_sales:
        try:
            sale = normalize_sale(raw_sale)
            normalized_observations.append(sale)
        except Exception as exc:
            LOGGER.exception("Initial normalization failed for %s: %s", raw_sale.get("source_url"), exc)
            source_name = str(raw_sale.get("source_name") or "unknown")
            errors.setdefault(source_name, []).append(str(exc))
    timings["normalize_seconds"] = round(time.perf_counter() - started, 2)

    canonical_sales = merge_duplicate_sales(normalized_observations)
    enriched = []
    pdf_stats = PdfEnrichmentStats()
    llm_stats = LLMEnrichmentStats()
    llm_client = None
    if options.use_llm:
        try:
            llm_client = create_llm_client()
        except LLMClientUnavailable as exc:
            LOGGER.warning("LLM client unavailable: %s", exc)
            llm_stats.unavailable = True
    for sale in canonical_sales:
        try:
            sale.last_run_id = run_id
            started = time.perf_counter()
            sale_pdf_stats = enrich_sale_from_pdfs(sale)
            timings["pdf_seconds"] = round(timings.get("pdf_seconds", 0.0) + time.perf_counter() - started, 2)
            pdf_stats.downloaded += sale_pdf_stats.downloaded
            pdf_stats.errors += sale_pdf_stats.errors
            pdf_stats.raw_text_enriched += sale_pdf_stats.raw_text_enriched
            pdf_stats.document_cache_hits += sale_pdf_stats.document_cache_hits
            pdf_stats.document_cache_misses += sale_pdf_stats.document_cache_misses
            pdf_stats.documents_processed += sale_pdf_stats.documents_processed
            if options.use_llm and llm_client is not None:
                started = time.perf_counter()
                sale_llm_stats = enrich_sale_with_llm(sale, client=llm_client)
                timings["llm_seconds"] = round(timings.get("llm_seconds", 0.0) + time.perf_counter() - started, 2)
                _add_llm_stats(llm_stats, sale_llm_stats)
            started = time.perf_counter()
            geocode_sale(sale)
            timings["geocode_seconds"] = round(timings.get("geocode_seconds", 0.0) + time.perf_counter() - started, 2)
            fill_tribunal(sale)
            normalize_asset_features(sale)
            enriched.append(sale)
        except Exception as exc:
            LOGGER.exception("Enrichment failed for %s: %s", sale.source_url, exc)
            source_name = str(sale.source_name or "unknown")
            errors.setdefault(source_name, []).append(str(exc))

    lifecycle_stats = mark_past_sales(enriched)
    quality_report = build_quality_report(enriched, pdf_stats=pdf_stats, llm_stats=llm_stats)
    json_path, csv_path = export_sales(enriched)

    upserted = 0
    observations_upserted = 0
    supabase_cleaned_past = 0
    summary = {
        "collected": len(raw_sales),
        "collected_by_source": raw_by_source,
        "normalized": len(normalized_observations),
        "deduplicated": len(enriched),
        "quality_report": quality_report,
        "timings": timings,
    }
    if options.upsert:
        try:
            started = time.perf_counter()
            upserted = upsert_sales_to_supabase(enriched)
            observations_upserted = upsert_observations_to_supabase(enriched)
            supabase_cleaned_past = mark_past_sales_in_supabase()
            timings["supabase_seconds"] = round(time.perf_counter() - started, 2)
            summary.update(
                {
                    "upserted": upserted,
                    "observations_upserted": observations_upserted,
                    "marked_past_in_run": lifecycle_stats.marked_past,
                    "marked_past_in_supabase": supabase_cleaned_past,
                }
            )
            finish_run_in_supabase(run_id, "succeeded", summary, errors)
        except Exception as exc:
            LOGGER.exception("Supabase upsert failed: %s", exc)
            errors.setdefault("supabase", []).append(str(exc))
            finish_run_in_supabase(run_id, "failed", summary, errors)

    print("Immojudis data pipeline summary")
    print(f"- collected: {len(raw_sales)}")
    print(f"- collected_by_source: {raw_by_source}")
    print(f"- normalized: {len(normalized_observations)}")
    print(f"- deduplicated: {len(enriched)}")
    print(f"- upserted: {upserted}")
    print(f"- observations_upserted: {observations_upserted}")
    print(f"- marked_past_in_run: {lifecycle_stats.marked_past}")
    print(f"- marked_past_in_supabase: {supabase_cleaned_past}")
    print(f"- json: {json_path}")
    print(f"- csv: {csv_path}")
    for line in format_quality_report(quality_report):
        print(line)
    for key, value in timings.items():
        print(f"- timing_{key}: {value}")
    print(f"- errors: { {source: len(items) for source, items in errors.items()} }")
    return 0


def _add_llm_stats(total: LLMEnrichmentStats, item: LLMEnrichmentStats) -> None:
    total.analyzed += item.analyzed
    total.valid_json += item.valid_json
    total.errors += item.errors
    total.surface_extracted += item.surface_extracted
    total.surface_detected += item.surface_detected
    total.rooms_extracted += item.rooms_extracted
    total.rooms_detected += item.rooms_detected
    total.bedrooms_extracted += item.bedrooms_extracted
    total.bedrooms_detected += item.bedrooms_detected
    total.occupancy_extracted += item.occupancy_extracted
    total.occupancy_detected += item.occupancy_detected
    total.risks_detected += item.risks_detected
    total.unavailable = total.unavailable or item.unavailable


def parse_args(argv: list[str] | None = None) -> PipelineOptions:
    parser = argparse.ArgumentParser(description="Collecte et enrichit les ventes aux enchères Aquitaine.")
    parser.add_argument("--source", choices=("all", *SOURCE_NAMES), default="all")
    parser.add_argument("--no-llm", action="store_true", help="Désactive les appels LLM Replicate pour ce run.")
    parser.add_argument("--no-upsert", action="store_true", help="N'écrit pas dans Supabase.")
    parser.add_argument("--limit", type=int, default=None, help="Limite le nombre d'annonces brutes traitées.")
    parser.add_argument(
        "--run-id",
        default=None,
        help="Reprend une ligne auction_runs existante, par exemple une demande créée depuis l'admin.",
    )
    args = parser.parse_args(argv)
    return PipelineOptions(
        source=args.source,
        use_llm=not args.no_llm,
        upsert=not args.no_upsert,
        limit=args.limit,
        run_id=args.run_id,
    )


if __name__ == "__main__":
    sys.exit(run_pipeline(parse_args()))
