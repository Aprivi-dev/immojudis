from __future__ import annotations

import logging
import sys

from src.comparison import compare_source_sales, export_comparison
from src.normalize import normalize_sale
from src.sources.avoventes import scrape_avoventes_aquitaine_result
from src.sources.licitor import scrape_licitor_aquitaine_result


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
LOGGER = logging.getLogger(__name__)


def run_comparison() -> int:
    errors: dict[str, list[str]] = {"avoventes": [], "licitor": []}
    avoventes_result = scrape_avoventes_aquitaine_result()
    raw_avoventes = avoventes_result.sales
    errors["avoventes"].extend(avoventes_result.errors)

    licitor_result = scrape_licitor_aquitaine_result()
    raw_licitor = licitor_result.sales
    errors["licitor"].extend(licitor_result.errors)

    avoventes_sales = _normalize_source(raw_avoventes, "avoventes", errors)
    licitor_sales = _normalize_source(raw_licitor, "licitor", errors)

    report = compare_source_sales(avoventes_sales, licitor_sales, errors)
    json_path, csv_path = export_comparison(report)
    summary = report["summary"]

    print("Source comparison summary")
    print(f"- avoventes_count: {summary['avoventes_count']}")
    print(f"- licitor_count: {summary['licitor_count']}")
    print(f"- matched_count: {summary['matched_count']}")
    print(f"- avoventes_only_count: {summary['avoventes_only_count']}")
    print(f"- licitor_only_count: {summary['licitor_only_count']}")
    print(f"- json: {json_path}")
    print(f"- csv: {csv_path}")
    print(f"- errors: {summary['errors']}")
    return 0


def _normalize_source(
    raw_sales: list[dict[str, object]],
    source_name: str,
    errors: dict[str, list[str]],
):
    normalized = []
    for raw_sale in raw_sales:
        try:
            normalized.append(normalize_sale(raw_sale))
        except Exception as exc:
            LOGGER.exception("Normalization failed for %s: %s", raw_sale.get("source_url"), exc)
            errors.setdefault(source_name, []).append(str(exc))
    return normalized


if __name__ == "__main__":
    sys.exit(run_comparison())
