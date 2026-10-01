"""Child-process entrypoint for one isolated source collector."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from src.source_checkpoint import configure_publisher, flush_publications
from src.source_process import WORKER_EVENT_PREFIX
from src.sources.agrasc import scrape_agrasc_aquitaine_result
from src.sources.avoventes import scrape_avoventes_aquitaine_result
from src.sources.cessions_etat import scrape_cessions_etat_aquitaine_result
from src.sources.encheres_immobilieres import scrape_encheres_immobilieres_aquitaine_result
from src.sources.encheres_publiques import scrape_encheres_publiques_aquitaine_result
from src.sources.info_encheres import scrape_info_encheres_aquitaine_result
from src.sources.licitor import scrape_licitor_aquitaine_result
from src.sources.notaires import scrape_notaires_aquitaine_result
from src.sources.petites_affiches import scrape_petites_affiches_aquitaine_result
from src.sources.vench import scrape_vench_aquitaine_result


def collect_source(source: str, payload: dict[str, Any]):
    """Dispatch a serializable source request without importing ``src.main``."""

    known = payload.get("known") if isinstance(payload.get("known"), dict) else {}
    known_details = payload.get("known_details")
    if not isinstance(known_details, dict):
        known_details = {}
    max_pages = payload.get("max_pages")
    if max_pages is not None:
        max_pages = int(max_pages)
    fetch_detail_heavy = bool(payload.get("fetch_detail_heavy", True))

    if source == "avoventes":
        return scrape_avoventes_aquitaine_result(known=known)
    if source == "licitor":
        return scrape_licitor_aquitaine_result(
            max_pages=max_pages,
            fetch_details=fetch_detail_heavy,
            known=known,
        )
    if source == "vench":
        return scrape_vench_aquitaine_result(
            max_pages=max_pages,
            known=known,
            known_details=known_details,
        )
    if source == "info_encheres":
        return scrape_info_encheres_aquitaine_result(max_pages=max_pages, known=known)
    if source == "encheres_publiques":
        return scrape_encheres_publiques_aquitaine_result(max_pages=max_pages, known=known)
    if source == "petites_affiches":
        return scrape_petites_affiches_aquitaine_result(max_pages=max_pages, known=known)
    if source == "cessions_etat":
        return scrape_cessions_etat_aquitaine_result(max_pages=max_pages, known=known)
    if source == "agrasc":
        return scrape_agrasc_aquitaine_result()
    if source == "encheres_immobilieres":
        return scrape_encheres_immobilieres_aquitaine_result(max_pages=max_pages, known=known)
    if source == "notaires":
        return scrape_notaires_aquitaine_result(max_pages=max_pages)
    raise ValueError(f"unsupported isolated source: {source}")


def _configure_batch_publisher(enabled: bool) -> None:
    if not enabled:
        configure_publisher()
        return

    def emit(batch: list[dict[str, Any]]) -> None:
        print(
            WORKER_EVENT_PREFIX
            + json.dumps({"type": "factual_batch", "sales": batch}, default=str, ensure_ascii=False),
            flush=True,
        )

    configure_publisher(emit)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one isolated Immojudis source collector")
    parser.add_argument("source")
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("worker payload must be an object")
        _configure_batch_publisher(bool(payload.get("publish_batches")))
        try:
            result = collect_source(args.source, payload)
        finally:
            # ``CheckpointSales`` flushes every 25 rows while collecting.  Flush
            # a smaller final batch too, matching the parent collector's
            # end-of-run flush even when parsing fails after partial collection.
            flush_publications()
        message = {
            "ok": True,
            "result": {
                "sales": result.sales,
                "errors": result.errors,
                "coverage": result.coverage,
            },
        }
        print(json.dumps(message, default=str, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
