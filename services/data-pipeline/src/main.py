from __future__ import annotations

import argparse
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
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
from src.sources.agrasc import scrape_agrasc_aquitaine_result
from src.sources.cessions_etat import scrape_cessions_etat_aquitaine_result
from src.sources.common import ScrapeResult
from src.sources.encheres_immobilieres import scrape_encheres_immobilieres_aquitaine_result
from src.sources.encheres_publiques import scrape_encheres_publiques_aquitaine_result
from src.sources.avoventes import scrape_avoventes_aquitaine_result
from src.sources.info_encheres import scrape_info_encheres_aquitaine_result
from src.sources.licitor import scrape_licitor_aquitaine_result
from src.sources.notaires import scrape_notaires_aquitaine_result
from src.sources.petites_affiches import scrape_petites_affiches_aquitaine_result
from src.sources.vench import scrape_vench_aquitaine_result
from src.storage.supabase_client import upsert_sales_to_supabase
from src.storage.supabase_client import upsert_observations_to_supabase
from src.storage.supabase_client import mark_past_sales_in_supabase
from src.storage.supabase_client import create_run_in_supabase, finish_run_in_supabase
from src.storage.supabase_client import (
    fetch_enriched_content_hashes,
    fetch_known_sale_signatures,
    touch_last_seen_for_content_hashes,
    touch_last_seen_for_source_urls,
)
from src.models import AuctionSale
from src.tribunal import fill_tribunal


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
LOGGER = logging.getLogger(__name__)
SOURCE_NAMES = (
    "avoventes",
    "licitor",
    "vench",
    "info_encheres",
    "encheres_publiques",
    "petites_affiches",
    "cessions_etat",
    "agrasc",
    "encheres_immobilieres",
    "notaires",
)


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

    # Signatures des annonces déjà enrichies (source_url → date|prix) : permet
    # aux scrapers de sauter la page détail des annonces déjà vues et inchangées.
    known_signatures: dict[str, str] = (
        fetch_known_sale_signatures() if (settings["incremental_enrichment"] and options.upsert) else {}
    )

    # ── Scraping des sources en parallèle ────────────────────────────────────
    # Chaque source est indépendante (domaine + client HTTP + délai propres), donc
    # on les lance en threads : le temps total ≈ la source la plus lente au lieu
    # de la somme. Indispensable avant de passer à toute la France.
    scrapers = _enabled_scrapers(options.source, settings, known_signatures)
    scrape_overall_started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, len(scrapers))) as executor:
        futures = {executor.submit(_timed_scrape, name, fn): name for name, fn in scrapers.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                result, seconds = future.result()
            except Exception as exc:
                LOGGER.exception("Scraper %s failed: %s", name, exc)
                errors.setdefault(name, []).append(str(exc))
                continue
            timings[f"scrape_{name}_seconds"] = seconds
            errors.setdefault(name, []).extend(result.errors)
            raw_by_source[name] = len(result.sales)
            raw_sales.extend(result.sales)
    timings["scrape_total_seconds"] = round(time.perf_counter() - scrape_overall_started, 2)

    # Annonces dont la page détail a été sautée (connues et inchangées) : on ne
    # les normalise/enrichit pas, on rafraîchit juste leur last_seen_at.
    skipped_detail_urls = [
        str(s.get("source_url"))
        for s in raw_sales
        if s.get("_known_unchanged") and s.get("source_url")
    ]
    skipped_detail = len(skipped_detail_urls)
    if skipped_detail_urls:
        touch_last_seen_for_source_urls(skipped_detail_urls)
    raw_sales = [s for s in raw_sales if not s.get("_known_unchanged")]

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

    # ── Incrémental : sauter les annonces déjà enrichies et inchangées ────────
    # content_hash = adresse|ville|date|prix : il change quand l'annonce change.
    # Une annonce déjà scorée avec le même hash n'a pas besoin d'être
    # re-téléchargée / ré-OCR / renvoyée au LLM.
    skipped_unchanged = 0
    to_enrich = canonical_sales
    if settings["incremental_enrichment"] and options.upsert:
        existing_hashes = fetch_enriched_content_hashes(
            [sale.content_hash for sale in canonical_sales if sale.content_hash]
        )
        if existing_hashes:
            to_enrich = [sale for sale in canonical_sales if sale.content_hash not in existing_hashes]
            skipped = [sale for sale in canonical_sales if sale.content_hash in existing_hashes]
            skipped_unchanged = len(skipped)
            touched = touch_last_seen_for_content_hashes([sale.content_hash for sale in skipped])
            LOGGER.info(
                "Incrémental : %s annonces déjà enrichies sautées (last_seen rafraîchi: %s), %s à enrichir",
                skipped_unchanged,
                touched,
                len(to_enrich),
            )

    enriched: list[AuctionSale] = []
    pdf_stats = PdfEnrichmentStats()
    llm_stats = LLMEnrichmentStats()
    llm_client = None
    if options.use_llm:
        try:
            llm_client = create_llm_client()
        except LLMClientUnavailable as exc:
            LOGGER.warning("LLM client unavailable: %s", exc)
            llm_stats.unavailable = True

    pdf_workers = max(1, int(settings["pipeline_pdf_workers"]))
    llm_workers = max(1, int(settings["pipeline_enrich_workers"]))
    enrich_started = time.perf_counter()
    failed_urls: set[str] = set()

    for sale in to_enrich:
        sale.last_run_id = run_id

    # ── Phase 1 : PDF / Docling / OCR (CPU+RAM) — concurrence modérée ─────────
    started = time.perf_counter()
    if to_enrich:
        with ThreadPoolExecutor(max_workers=pdf_workers) as executor:
            futures = {executor.submit(enrich_sale_from_pdfs, sale): sale for sale in to_enrich}
            for future in as_completed(futures):
                sale = futures[future]
                try:
                    _merge_pdf_stats(pdf_stats, future.result())
                except Exception as exc:
                    LOGGER.exception("PDF enrichment failed for %s: %s", sale.source_url, exc)
                    errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
                    failed_urls.add(sale.source_url)
    timings["pdf_seconds"] = round(time.perf_counter() - started, 2)

    # ── Phase 2 : LLM Replicate (réseau) — forte concurrence ─────────────────
    started = time.perf_counter()
    llm_targets = [sale for sale in to_enrich if sale.source_url not in failed_urls]
    if options.use_llm and llm_client is not None and llm_targets:
        with ThreadPoolExecutor(max_workers=llm_workers) as executor:
            futures = {
                executor.submit(enrich_sale_with_llm, sale, client=llm_client): sale
                for sale in llm_targets
            }
            for future in as_completed(futures):
                sale = futures[future]
                try:
                    sale_llm_stats = future.result()
                except Exception as exc:
                    LOGGER.exception("LLM enrichment failed for %s: %s", sale.source_url, exc)
                    errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
                    continue
                _add_llm_stats(llm_stats, sale_llm_stats)
                if sale_llm_stats.error_messages:
                    source_name = str(sale.source_name or sale.primary_source or "unknown")
                    errors.setdefault(source_name, []).extend(sale_llm_stats.error_messages)
    timings["llm_seconds"] = round(time.perf_counter() - started, 2)

    # ── Phase 3 : finition (géocode réseau léger, tribunal, scoring) ─────────
    started = time.perf_counter()
    for sale in to_enrich:
        if sale.source_url in failed_urls:
            continue
        try:
            geocode_sale(sale)
            fill_tribunal(sale)
            normalize_asset_features(sale)
            enriched.append(sale)
        except Exception as exc:
            LOGGER.exception("Finalisation failed for %s: %s", sale.source_url, exc)
            errors.setdefault(str(sale.source_name or "unknown"), []).append(str(exc))
    timings["geocode_seconds"] = round(time.perf_counter() - started, 2)
    timings["enrich_wall_seconds"] = round(time.perf_counter() - enrich_started, 2)
    timings["enrich_pdf_workers"] = pdf_workers
    timings["enrich_llm_workers"] = llm_workers

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
        "deduplicated": len(canonical_sales),
        "skipped_detail": skipped_detail,
        "skipped_unchanged": skipped_unchanged,
        "enriched": len(enriched),
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
    print(f"- deduplicated: {len(canonical_sales)}")
    print(f"- skipped_detail: {skipped_detail}")
    print(f"- skipped_unchanged: {skipped_unchanged}")
    print(f"- enriched: {len(enriched)}")
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


def _enabled_scrapers(
    source: str, settings: dict[str, object], known: dict[str, str]
) -> dict[str, "Callable[[], ScrapeResult]"]:
    """Map of enabled source name → zero-arg scraper callable, honouring the
    requested source and the per-source benchmark toggles. `known` (source_url →
    change-signature) lets list-based scrapers skip detail pages of unchanged
    listings; licitor exposes price/date only on detail pages, so it always
    fetches."""
    candidates: list[tuple[str, bool, "Callable[[], ScrapeResult]"]] = [
        ("avoventes", True, lambda: scrape_avoventes_aquitaine_result(known=known)),
        (
            "licitor",
            bool(settings["enable_licitor_benchmark"]),
            lambda: scrape_licitor_aquitaine_result(max_pages=int(settings["licitor_max_pages"])),
        ),
        (
            "vench",
            bool(settings["enable_vench_benchmark"]),
            lambda: scrape_vench_aquitaine_result(
                max_pages=int(settings["vench_max_pages"]), known=known
            ),
        ),
        (
            "info_encheres",
            bool(settings["enable_info_encheres_benchmark"]),
            lambda: scrape_info_encheres_aquitaine_result(
                max_pages=int(settings["info_encheres_max_pages"]), known=known
            ),
        ),
        (
            "encheres_publiques",
            bool(settings["enable_encheres_publiques_benchmark"]),
            lambda: scrape_encheres_publiques_aquitaine_result(
                max_pages=int(settings["encheres_publiques_max_pages"]), known=known
            ),
        ),
        (
            "petites_affiches",
            bool(settings["enable_petites_affiches_benchmark"]),
            lambda: scrape_petites_affiches_aquitaine_result(),
        ),
        (
            "cessions_etat",
            bool(settings["enable_cessions_etat_benchmark"]),
            lambda: scrape_cessions_etat_aquitaine_result(
                max_pages=int(settings["cessions_etat_max_pages"]), known=known
            ),
        ),
        (
            "agrasc",
            bool(settings["enable_agrasc_benchmark"]),
            lambda: scrape_agrasc_aquitaine_result(),
        ),
        (
            "encheres_immobilieres",
            bool(settings["enable_encheres_immobilieres_benchmark"]),
            lambda: scrape_encheres_immobilieres_aquitaine_result(
                max_pages=int(settings["encheres_immobilieres_max_pages"])
            ),
        ),
        (
            "notaires",
            bool(settings["enable_notaires_benchmark"]),
            lambda: scrape_notaires_aquitaine_result(max_pages=int(settings["notaires_max_pages"])),
        ),
    ]
    enabled: dict[str, "Callable[[], ScrapeResult]"] = {}
    for name, benchmark_on, fn in candidates:
        if source == name or (source == "all" and benchmark_on):
            enabled[name] = fn
    return enabled


def _timed_scrape(name: str, fn: "Callable[[], ScrapeResult]") -> tuple[ScrapeResult, float]:
    started = time.perf_counter()
    result = fn()
    return result, round(time.perf_counter() - started, 2)


def _merge_pdf_stats(total: PdfEnrichmentStats, item: PdfEnrichmentStats) -> None:
    total.downloaded += item.downloaded
    total.errors += item.errors
    total.raw_text_enriched += item.raw_text_enriched
    total.document_cache_hits += item.document_cache_hits
    total.document_cache_misses += item.document_cache_misses
    total.documents_processed += item.documents_processed


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
    total.error_messages.extend(item.error_messages)
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
