from __future__ import annotations

from typing import Any


def scrape_cabinet_page(url: str) -> list[dict[str, Any]]:
    """Placeholder extension point for local law-firm pages.

    Each cabinet can later provide a small adapter that returns the same raw sale
    dictionary shape as the Avoventes scraper.
    """
    raise NotImplementedError(f"No generic cabinet parser is configured yet for {url}")
