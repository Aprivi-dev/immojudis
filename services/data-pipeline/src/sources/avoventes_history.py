"""Inspect captured Avoventes archives without publishing or inferring outcomes.

The current catalogue and the historical results have different lifecycles. This
offline importer keeps archive evidence separate: every row still needs its court,
lot/round, cross-source identity and permission to reuse checked before publication.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from src.normalize import normalize_property_type, parse_french_datetime, parse_price, strip_accents
from src.sources.avoventes import (
    MAX_AVOVENTES_RAW_CATALOGUE_CHARS,
    compact_avoventes_catalogue_html,
    parse_avoventes_html,
)
from src.sources.common import parse_html

CONNECTOR_VERSION = "avoventes-history/1"
_PARIS = ZoneInfo("Europe/Paris")
_HOSTS = {"avoventes.fr", "www.avoventes.fr"}
_EVENTS = {"reportee", "retiree", "annulee", "non requise", "carence"}


def _archive_page_number(url: str) -> int:
    parts = urlsplit(url)
    if (
        parts.scheme != "https" or parts.hostname not in _HOSTS
        or parts.username or parts.password or parts.port not in (None, 443)
        or parts.path != "/ventes-passees" or parts.fragment
    ):
        raise ValueError("Expected an Avoventes public archive URL")
    query = parse_qs(parts.query, keep_blank_values=True)
    if set(query) - {"page", "display", "sort", "order"}:
        raise ValueError("Unexpected archive filters: coverage would be ambiguous")
    page = query.get("page", ["1"])
    if len(page) != 1 or not re.fullmatch(r"[1-9][0-9]*", page[0]):
        raise ValueError("Expected one positive archive page number")
    return int(page[0])


def _positive_money(value: Any) -> Decimal | None:
    if isinstance(value, bool) or (isinstance(value, str) and not re.fullmatch(
        r"\s*[0-9][0-9\s.,]*\s*(?:€|euros?)?\s*", value, re.I,
    )):
        return None
    parsed = parse_price(value)
    return parsed if parsed is not None and parsed.is_finite() and parsed > 0 else None


def _candidate(raw: dict[str, Any], *, period_start: date, as_of: date, page_hash: str, page_url: str) -> dict:
    source_parts = urlsplit(raw["source_url"])
    source_url = urlunsplit(("https", "avoventes.fr", source_parts.path.rstrip("/"), "", ""))
    raw_date = raw.get("sale_date") or ""
    # Do not let dateutil supply the current year for an incomplete archive date.
    scheduled_at = parse_french_datetime(raw_date) if re.search(r"\b\d{4}\b", raw_date) else None
    sale_day = scheduled_at.astimezone(_PARIS).date() if scheduled_at else None
    starting = _positive_money(raw.get("starting_price_eur"))
    hammer = _positive_money(raw.get("adjudication_price_eur"))
    lines = {strip_accents(line).lower().strip() for line in raw["raw_text"].splitlines()}
    events = sorted(lines & _EVENTS)
    exclusions = []
    if sale_day is None:
        exclusions.append("missing_or_invalid_sale_date")
    elif not period_start <= sale_day <= as_of:
        exclusions.append("sale_outside_requested_period")
    if starting is None:
        exclusions.append("missing_or_invalid_starting_price")
    if hammer is None:
        exclusions.append("missing_or_invalid_reported_price")
    if events:
        exclusions.append("non_adjudication_event_requires_review")
    if any("vente amiable" in line for line in lines):
        exclusions.append("amicable_sale_outside_scope")
    flags = ["third_party_result_candidate", "court_match_required", "lot_round_review_required",
             "cross_source_deduplication_required", "source_reuse_review_required"]
    if any("surenchere" in line for line in lines):
        flags.append("surenchere_mentioned")
    if starting and starting <= 1000:
        flags.append("below_current_licitor_starting_price_threshold")
    if starting and hammer and not Decimal("0.1") <= hammer / starting <= Decimal("10"):
        flags.append("ratio_outlier_requires_review")
    instant = scheduled_at.isoformat() if scheduled_at else None
    key = hashlib.sha256(f"{source_url}|{instant or raw_date}".encode()).hexdigest()
    return {
        "candidate_key": key,
        "source_name": "avoventes",
        "source_url": source_url,
        "source_page_url": page_url,
        "source_content_hash": page_hash,
        "connector_version": CONNECTOR_VERSION,
        "sale_date": instant,
        "sale_date_source_text": raw_date,
        "starting_price_eur": str(starting) if starting is not None else None,
        "adjudication_price_eur": str(hammer) if hammer is not None else None,
        "property_type": normalize_property_type(raw.get("property_type")),
        "address": raw.get("address"),
        "postal_code": raw.get("postal_code"),
        "city": raw.get("city"),
        # A property's location is not evidence of the competent tribunal.
        "tribunal": None,
        "sale_venue_type": "unknown",
        "source_events": events,
        "screening_status": "excluded" if exclusions else "price_pair_to_review",
        "exclusion_reasons": exclusions,
        "quality_flags": flags,
        "candidate_grade": "C",
        "evidence_grade": "C",
        "review_status": "pending",
        "finality_status": "unknown",
        "publication_eligible": False,
        "training_eligible": False,
    }


def inspect_avoventes_archive(html: str, *, page_url: str, period_start: date, as_of: date) -> dict:
    """One captured page; no HTTP, database writes, automatic match or price estimate."""
    page_number = _archive_page_number(page_url)
    if period_start > as_of:
        raise ValueError("The observation period is reversed")
    soup = parse_html(compact_avoventes_catalogue_html(html), "html.parser")
    heading = soup.find("h1")
    if not heading or strip_accents(heading.get_text(" ", strip=True)).lower() != "ventes passees":
        raise ValueError("Archive page identity could not be verified")
    page_hash = hashlib.sha256(html.encode()).hexdigest()
    raw_rows = parse_avoventes_html(html, page_url=page_url)
    if not raw_rows:
        raise ValueError("No archive cards found; empty coverage is not established")
    candidates: dict[str, dict] = {}
    duplicates = 0
    for raw in raw_rows:
        candidate = _candidate(raw, period_start=period_start, as_of=as_of, page_hash=page_hash, page_url=page_url)
        previous = candidates.get(candidate["candidate_key"])
        if previous is None:
            candidates[candidate["candidate_key"]] = candidate
            continue
        duplicates += 1
        # Same source/round appears twice: keep one count and quarantine any
        # contradictory amount or property fact rather than taking the last row.
        facts = ("starting_price_eur", "adjudication_price_eur", "property_type", "address", "source_events")
        if any(previous[field] != candidate[field] for field in facts):
            previous["screening_status"] = "excluded"
            previous["exclusion_reasons"] = sorted(set(previous["exclusion_reasons"] + ["conflicting_archive_cards"]))
        previous["exclusion_reasons"] = sorted(set(previous["exclusion_reasons"] + candidate["exclusion_reasons"]))
        previous["quality_flags"] = sorted(set(previous["quality_flags"] + candidate["quality_flags"]))
        if previous["exclusion_reasons"]:
            previous["screening_status"] = "excluded"
    next_urls: set[str] = set()
    for anchor in soup.select("a[href]"):
        url = urljoin(page_url, str(anchor.get("href") or ""))
        try:
            if _archive_page_number(url) == page_number + 1:
                next_urls.add(url)
        except ValueError:
            continue
    rows = list(candidates.values())
    return {
        "schema_version": "avoventes_archive_diagnostic_v1",
        "source_page_url": page_url,
        "source_content_hash": page_hash,
        "period_start": period_start.isoformat(),
        "as_of": as_of.isoformat(),
        "next_page_urls": sorted(next_urls),
        "summary": {
            "raw_cards": len(raw_rows),
            "distinct_source_rounds": len(rows),
            "duplicate_cards": duplicates,
            "price_pairs_to_review": sum(row["screening_status"] == "price_pair_to_review" for row in rows),
            "exclusion_reasons": dict(Counter(reason for row in rows for reason in row["exclusion_reasons"])),
            "quality_flags": dict(Counter(flag for row in rows for flag in row["quality_flags"])),
            "coverage_complete": False,
            "cross_source_unique_count": None,
            "published_results": 0,
        },
        "candidates": rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, required=True, help="Previously captured public archive HTML")
    parser.add_argument("--page-url", required=True)
    parser.add_argument("--period-start", type=date.fromisoformat, required=True)
    parser.add_argument("--as-of", type=date.fromisoformat, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New private diagnostic JSON file (never overwritten)")
    args = parser.parse_args(argv)
    if args.html.stat().st_size > MAX_AVOVENTES_RAW_CATALOGUE_CHARS * 4:
        parser.error("Archive input exceeds the bounded capture size")
    report = inspect_avoventes_archive(args.html.read_text(), page_url=args.page_url,
                                      period_start=args.period_start, as_of=args.as_of)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(json.dumps(report["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
