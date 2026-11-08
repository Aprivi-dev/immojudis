"""Revalidate stored extractions and document readings with current checks, without calling an AI provider."""
from __future__ import annotations

import argparse
import json
import logging

from src.config import EncheresPubliquesAccessNotAuthorized, load_settings
from src.encheres_publiques_guard import require_encheres_publiques_sale_access
from src.enrichment.display_quality import has_current_display
from src.enrichment.extract_structured import apply_cached_llm_extraction_to_sale
from src.storage.supabase_client import fetch_sales_needing_llm_descriptions, upsert_sales_to_supabase

LOGGER = logging.getLogger(__name__)


def revalidate_cached_displays(limit: int = 1000) -> dict[str, int]:
    if not 1 <= limit <= 5000:
        raise ValueError('Revalidation limit must be between 1 and 5000')
    settings = load_settings()
    version = str(settings['llm_prompt_version'])
    display_version = str(settings['llm_display_prompt_version'])
    model_version = str(settings.get('replicate_model') or '') or None
    sales = fetch_sales_needing_llm_descriptions(limit=limit, prompt_version=version)
    report = {
        'selected': len(sales),
        'revalidated': 0,
        'rejected': 0,
        'without_cache': 0,
        'persisted': 0,
        'skipped_unauthorized': 0,
    }
    for sale in sales:
        try:
            require_encheres_publiques_sale_access(
                source_name=sale.source_name,
                source_url=sale.source_url,
                source_urls=sale.source_urls,
                documents=sale.documents,
                settings=settings,
            )
        except EncheresPubliquesAccessNotAuthorized as exc:
            report['skipped_unauthorized'] += 1
            LOGGER.info(
                'Skipping unauthorized Encheres Publiques cached display %s: %s',
                sale.source_url,
                exc,
            )
            continue
        if not isinstance(sale.raw_payload.get('llm_extraction'), dict):
            report['without_cache'] += 1
            continue
        before = json.dumps(sale.to_storage_dict(), sort_keys=True, default=str)
        apply_cached_llm_extraction_to_sale(sale, prompt_version=version)
        valid = has_current_display(sale.raw_payload, version, display_version, model_version)
        report['revalidated' if valid else 'rejected'] += 1
        if before != json.dumps(sale.to_storage_dict(), sort_keys=True, default=str):
            count = upsert_sales_to_supabase([sale], refresh_last_seen=False)
            if count != 1:
                raise RuntimeError('Cached revalidation was not persisted')
            report['persisted'] += count
    return report


def revalidate_document_readings(limit: int = 1000) -> dict[str, int] | str:
    """Stored « lecture des pièces » points replayed through the current checks (no model call)."""
    from src.document_reading import revalidate_stored_readings

    if not 1 <= limit <= 5000:
        raise ValueError('Revalidation limit must be between 1 and 5000')
    db_url = str(load_settings().get('supabase_db_url') or '')
    if not db_url:
        return 'skipped: SUPABASE_DB_URL is not set'
    try:
        return revalidate_stored_readings(db_url, limit=limit)
    except Exception as exc:  # noqa: BLE001 - reported, never blocks the display revalidation that follows
        LOGGER.warning('Document reading revalidation stopped: %s', type(exc).__name__)
        return f'error: {type(exc).__name__}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int, default=1000)
    args = parser.parse_args()
    report: dict[str, object] = dict(revalidate_cached_displays(args.limit))
    report['document_readings'] = revalidate_document_readings(args.limit)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
