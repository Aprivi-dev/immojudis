from __future__ import annotations

from src.enrichment.extract_structured import LLMEnrichmentStats
from src.models import AuctionSale
from src.pdf_enrichment import PdfEnrichmentStats


def build_quality_report(
    sales: list[AuctionSale],
    pdf_stats: PdfEnrichmentStats | None = None,
    llm_stats: LLMEnrichmentStats | None = None,
) -> dict[str, float | int]:
    total = len(sales)
    pdf_stats = pdf_stats or PdfEnrichmentStats()
    llm_stats = llm_stats or LLMEnrichmentStats()
    return {
        "total": total,
        "with_tribunal_pct": _pct(sum(bool(sale.tribunal) for sale in sales), total),
        "with_gps_pct": _pct(
            sum(sale.latitude is not None and sale.longitude is not None for sale in sales),
            total,
        ),
        "with_surface_pct": _pct(sum(sale.surface_m2 is not None for sale in sales), total),
        "with_app_surface_pct": _pct(sum(sale.app_surface_m2 is not None for sale in sales), total),
        "with_rooms_count_pct": _pct(sum(sale.rooms_count is not None for sale in sales), total),
        "with_bedrooms_count_pct": _pct(sum(sale.bedrooms_count is not None for sale in sales), total),
        "with_occupancy_status_pct": _pct(sum(bool(sale.occupancy_status) for sale in sales), total),
        "with_raw_text_enriched_pct": _pct(
            sum("PDF TEXT ENRICHMENT" in (sale.raw_text or "") for sale in sales),
            total,
        ),
        "with_documents_pct": _pct(sum(bool(sale.documents) for sale in sales), total),
        "with_visit_dates_pct": _pct(sum(bool(sale.visit_dates) for sale in sales), total),
        "pdfs_downloaded": pdf_stats.downloaded,
        "pdf_errors": pdf_stats.errors,
        "pdf_document_cache_hits": pdf_stats.document_cache_hits,
        "pdf_document_cache_misses": pdf_stats.document_cache_misses,
        "pdf_documents_processed": pdf_stats.documents_processed,
        "llm_analyzed": llm_stats.analyzed,
        "llm_valid_json": llm_stats.valid_json,
        "llm_surface_detected_pct": _pct(llm_stats.surface_detected, llm_stats.valid_json),
        "llm_surface_extracted_pct": _pct(llm_stats.surface_extracted, llm_stats.valid_json),
        "llm_rooms_detected_pct": _pct(llm_stats.rooms_detected, llm_stats.valid_json),
        "llm_rooms_extracted_pct": _pct(llm_stats.rooms_extracted, llm_stats.valid_json),
        "llm_bedrooms_detected_pct": _pct(llm_stats.bedrooms_detected, llm_stats.valid_json),
        "llm_bedrooms_extracted_pct": _pct(llm_stats.bedrooms_extracted, llm_stats.valid_json),
        "llm_occupancy_detected_pct": _pct(llm_stats.occupancy_detected, llm_stats.valid_json),
        "llm_occupancy_extracted_pct": _pct(llm_stats.occupancy_extracted, llm_stats.valid_json),
        "llm_risks_detected_pct": _pct(llm_stats.risks_detected, llm_stats.valid_json),
        "llm_errors": llm_stats.errors,
        "llm_unavailable": int(llm_stats.unavailable),
    }


def format_quality_report(report: dict[str, float | int]) -> list[str]:
    return [
        f"- quality_total: {report['total']}",
        f"- quality_with_tribunal: {report['with_tribunal_pct']}%",
        f"- quality_with_gps: {report['with_gps_pct']}%",
        f"- quality_with_surface: {report['with_surface_pct']}%",
        f"- quality_with_app_surface: {report['with_app_surface_pct']}%",
        f"- quality_with_rooms_count: {report['with_rooms_count_pct']}%",
        f"- quality_with_bedrooms_count: {report['with_bedrooms_count_pct']}%",
        f"- quality_with_occupancy_status: {report['with_occupancy_status_pct']}%",
        f"- quality_with_raw_text_enriched: {report['with_raw_text_enriched_pct']}%",
        f"- quality_with_documents: {report['with_documents_pct']}%",
        f"- quality_with_visit_dates: {report['with_visit_dates_pct']}%",
        f"- quality_pdfs_downloaded: {report['pdfs_downloaded']}",
        f"- quality_pdf_errors: {report['pdf_errors']}",
        f"- quality_pdf_document_cache_hits: {report['pdf_document_cache_hits']}",
        f"- quality_pdf_document_cache_misses: {report['pdf_document_cache_misses']}",
        f"- quality_pdf_documents_processed: {report['pdf_documents_processed']}",
        f"- quality_llm_analyzed: {report['llm_analyzed']}",
        f"- quality_llm_valid_json: {report['llm_valid_json']}",
        f"- quality_llm_surface_detected: {report['llm_surface_detected_pct']}%",
        f"- quality_llm_surface_extracted: {report['llm_surface_extracted_pct']}%",
        f"- quality_llm_rooms_detected: {report['llm_rooms_detected_pct']}%",
        f"- quality_llm_rooms_extracted: {report['llm_rooms_extracted_pct']}%",
        f"- quality_llm_bedrooms_detected: {report['llm_bedrooms_detected_pct']}%",
        f"- quality_llm_bedrooms_extracted: {report['llm_bedrooms_extracted_pct']}%",
        f"- quality_llm_occupancy_detected: {report['llm_occupancy_detected_pct']}%",
        f"- quality_llm_occupancy_extracted: {report['llm_occupancy_extracted_pct']}%",
        f"- quality_llm_risks_detected: {report['llm_risks_detected_pct']}%",
        f"- quality_llm_errors: {report['llm_errors']}",
        f"- quality_llm_unavailable: {report['llm_unavailable']}",
    ]


def _pct(count: int, total: int) -> float:
    if total == 0:
        return 0.0
    return round(count * 100 / total, 1)
