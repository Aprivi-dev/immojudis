"""Reprise, depuis le détail déjà connu d'une vente, des champs établis par les pièces (surfaces, mise à prix).

Une collecte qui relit la fiche source (liste ou détail) ne doit pas écraser une valeur que les documents PDF ont
établie : ``src.known_enrichment`` copie ces champs depuis la ligne publiée quand la fiche collectée ne les porte pas.
"""

from __future__ import annotations

from typing import Any

from src.document_facts_version import DOCUMENT_FACTS_VERSION
from src.normalize import parse_price

KNOWN_DOCUMENT_BUILT_SURFACE_FIELDS = (
    "surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
)
KNOWN_DOCUMENT_LAND_SURFACE_FIELDS = ("land_surface_m2",)
KNOWN_DOCUMENT_SURFACE_METADATA_FIELDS = (
    "app_surface_m2",
    "app_surface_kind",
    "surface_scope",
    "surface_source",
    "surface_confidence",
    "surface_evidence",
)


def is_missing_raw_value(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def backfill_document_surface_fields_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict):
        known_payload = {}
    built_extraction = known_payload.get("surface_extraction")
    land_extraction = known_payload.get("land_surface_extraction")
    has_built_document_surface = known.get("surface_source") == "pdf" or (
        isinstance(built_extraction, dict) and built_extraction.get("source") == "pdf"
    )
    has_land_document_surface = isinstance(land_extraction, dict) and land_extraction.get("source") == "pdf"
    if not has_built_document_surface and not has_land_document_surface:
        return 0

    fields: tuple[str, ...] = KNOWN_DOCUMENT_SURFACE_METADATA_FIELDS
    if has_built_document_surface:
        fields += KNOWN_DOCUMENT_BUILT_SURFACE_FIELDS
    if has_land_document_surface:
        fields += KNOWN_DOCUMENT_LAND_SURFACE_FIELDS

    copied = 0
    for key in fields:
        if is_missing_raw_value(sale.get(key)) and not is_missing_raw_value(known.get(key)):
            sale[key] = known[key]
            copied += 1
    return copied


def backfill_document_price_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict):
        return 0
    extraction = known_payload.get("starting_price_extraction")
    if not isinstance(extraction, dict) or extraction.get("version") not in {
        DOCUMENT_FACTS_VERSION,
        # A price read under the previous rules stays protected until its documents are read again.
        "document_facts_v4_occupancy_dates_prices",
        "document_facts_v1_starting_price",
    }:
        return 0

    known_price = parse_price(known.get("starting_price_eur"))
    if known_price is None:
        return 0
    incoming_price = parse_price(sale.get("starting_price_eur"))
    status = extraction.get("status")
    rejected_price = parse_price(extraction.get("rejected_source_price_eur"))
    source_matches_rejected = status == "resolved" and rejected_price is not None and incoming_price == rejected_price
    if incoming_price is not None and incoming_price != known_price and not source_matches_rejected:
        return 0

    copied = 0
    if incoming_price != known_price:
        sale["starting_price_eur"] = known_price
        copied += 1
    if sale.get("starting_price_extraction") != extraction:
        sale["starting_price_extraction"] = extraction
        copied += 1
    known_facts_version = known_payload.get("document_facts_version") or extraction.get("version")
    if sale.get("document_facts_version") != known_facts_version:
        # Preserve the last version that actually analyzed the document. Do not
        # mark it current here: the version check must still schedule the new
        # surface-reasoning pass while the verified price remains protected.
        sale["document_facts_version"] = known_facts_version
        copied += 1
    return copied


def backfill_document_facts_version_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    """Keep the version of the rules that read the attachments through a collection of the source page.

    ``document_facts_version`` was carried only by the price backfill above: every collection erased it for the
    sales whose price is not read in their documents, and the document drain read them again and again (04/11/2026:
    Licitor, 0 sale up to date out of 34 without a document price, 13 out of 14 with one). A real change of the page
    still removes it afterwards (``record_source_checks``). When the source price moved away from a price the
    documents settled, the documents must arbitrate again: the version is not kept.
    """
    if not is_missing_raw_value(sale.get("document_facts_version")):
        return 0
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict) or is_missing_raw_value(known_payload.get("document_facts_version")):
        return 0
    if isinstance(known_payload.get("starting_price_extraction"), dict):
        known_price = parse_price(known.get("starting_price_eur"))
        incoming_price = parse_price(sale.get("starting_price_eur"))
        if known_price is not None and incoming_price is not None and incoming_price != known_price:
            return 0
    sale["document_facts_version"] = known_payload["document_facts_version"]
    return 1


def backfill_document_sale_date_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    """Keep the date read in the attachments when the source page gives none.

    Cessions de l'État pages carry no date: the offer deadline is only in the conditions of sale. A complete
    re-read of the page set ``sale_date`` back to null while its PDF trace stayed, so the next PDF pass took the
    empty value for a manual correction and never wrote the date again (Saint-Alexandre, 02/11/2026).
    """
    if not is_missing_raw_value(sale.get("sale_date")):
        return 0
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict) or not isinstance(known_payload.get("pdf_sale_date_extraction"), dict):
        return 0
    provenance = known_payload.get("pdf_fact_provenance")
    trace = provenance.get("sale_date") if isinstance(provenance, dict) else None
    if not isinstance(trace, dict) or trace.get("source") != "pdf":
        return 0
    value = known.get("sale_date") or trace.get("value")
    if is_missing_raw_value(value):
        return 0
    sale["sale_date"] = value
    return 1


def backfill_document_occupancy_from_known(
    sale: dict[str, object],
    known: dict[str, object],
) -> int:
    """Keep the occupancy read in the attachments when the source page gives none.

    Cessions de l'État pages say nothing of occupancy: « 3 – SITUATION D'OCCUPATION Le bien est libre de toute
    occupation » is in the conditions of sale. A re-read of the page set the status back to null while its PDF
    trace stayed, so the next PDF pass took the empty value for a manual correction (audit 03/11/2026: the
    occupancy of most Cessions sales was read in their documents but not shown).
    """
    if not is_missing_raw_value(sale.get("occupancy_status")):
        return 0
    known_payload = known.get("raw_payload")
    provenance = known_payload.get("pdf_fact_provenance") if isinstance(known_payload, dict) else None
    trace = provenance.get("occupancy_status") if isinstance(provenance, dict) else None
    if not isinstance(trace, dict) or trace.get("source") != "pdf":
        return 0
    value = known.get("occupancy_status") or trace.get("value")
    if is_missing_raw_value(value):
        return 0
    sale["occupancy_status"] = value
    return 1
