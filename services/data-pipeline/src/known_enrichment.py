"""Ce que la collecte garde d'une vente déjà publiée quand elle relit sa fiche.

Une fiche relue (liste ou détail) ne porte pas l'enrichissement de la vente (lecture des pièces, IA, géocodage) ni
les champs établis par les pièces : ils sont recopiés de la ligne publiée quand la fiche ne les donne pas, sauf si la
liste des pièces a changé (l'analyse est alors à refaire). Partagé par la collecte (``src.main``) et la relecture
d'une fiche (``src.source_detail``).
"""

from __future__ import annotations

from datetime import UTC, datetime

from src import base_reads
from src.freshness import document_list_changed
from src.known_document_backfill import (
    KNOWN_DOCUMENT_BUILT_SURFACE_FIELDS,
    KNOWN_DOCUMENT_LAND_SURFACE_FIELDS,
    KNOWN_DOCUMENT_SURFACE_METADATA_FIELDS,
    backfill_document_facts_version_from_known,
    backfill_document_occupancy_from_known,
    backfill_document_price_from_known,
    backfill_document_sale_date_from_known,
    backfill_document_surface_fields_from_known,
    is_missing_raw_value,
)
from src.lot_scope import other_commune

KNOWN_ENRICHMENT_PAYLOAD_FIELDS = (
    "source_presence",
    # Preserve the structured source contract used by Vench and the source
    # proof/readiness checks when a cold pass restores a known sale.
    "source_property_features",
    "source_property_feature_evidence",
    "source_property_features_meta",
    "source_procedure_profile",
    "source_field_observations",
    "source_evidence",
    "source_evidence_provenance",
    "source_energy_diagnostics",
    "source_sale_schedule",
    "date_precision",
    "sale_date_precision",
    "operator_land_surface_conflict",
    "operator_land_surface_scope",
    "source_display_constraints",
    "source_blocks",
    "source_images",
    "raw_image_url",
    "source_description",
    "llm_extraction",
    "llm_fact_extraction",
    "llm_fact_prompt_version",
    "llm_display_prompt_version",
    "llm_fact_coverage",
    "llm_fact_input_key",
    "llm_fact_context_manifest",
    "llm_fact_context_coverage",
    "llm_display_description",
    "llm_display_description_word_count",
    "llm_display_status",
    "llm_display_model",
    "llm_display_origin",
    "source_operational_changed",
    "llm_display_quality_version",
    "llm_display_source_constraints",
    "llm_display_evidence_check",
    "llm_prompt_version",
    "source_content_changed",
    "source_content_change_reason",
    "source_content_changed_at",
    "superseded_analysis",
    "document_analysis",
    "surface_extraction",
    "surface_analysis",
    "land_surface_extraction",
    "investment_analysis",
    "llm_due_diligence",
    "geocode",
    "tribunal_assignment",
    "pdf_tribunal_extraction",
    # PDF projection traces and candidate evidence are enrichment metadata.
    # Preserve them through a cold source pass so the PDF worker can invalidate
    # only stale projections without treating the markers as fresh source text.
    "pdf_fact_provenance",
    "pdf_sale_date_extraction",
    "pdf_visit_dates_extraction",
    "pdf_energy_diagnostics",
    "pdf_energy_diagnostics_candidates",
    "pdf_surface_candidates",
    "pdf_land_surface_candidates",
    "pdf_rooms_candidates",
    "pdf_bedrooms_candidates",
    "pdf_occupancy_candidates",
    "pdf_multi_lot_guard",
)

KNOWN_SOURCE_FACT_SNAPSHOT_FIELDS = (
    "source_name",
    "source_url",
    "raw_text",
    "starting_price_eur",
    *KNOWN_DOCUMENT_BUILT_SURFACE_FIELDS,
    *KNOWN_DOCUMENT_LAND_SURFACE_FIELDS,
    *KNOWN_DOCUMENT_SURFACE_METADATA_FIELDS,
    "rooms_count",
    "bedrooms_count",
    "occupancy_status",
    "sale_date",
    "status",
    "visit_dates",
    "property_type",
    "description",
    "risk_notes",
)

KNOWN_SOURCE_REFRESH_METADATA_FIELDS = (
    "source_sale_schedule",
    "date_precision",
    "sale_date_precision",
    "operator_land_surface_conflict",
    "operator_land_surface_scope",
    "source_display_constraints",
)


def preserve_known_enrichment_payloads(
    raw_sales: list[dict[str, object]],
    known_details: dict[str, dict[str, object]],
) -> int:
    preserved = 0
    for sale in raw_sales:
        if sale.get("source_identity_mismatch"):
            continue
        source_url = str(sale.get("source_url") or "")
        known = known_details.get(source_url)
        known = known or {}
        known_payload = known.get("raw_payload") or {}
        if base_reads.was_reread(sale):
            # Un champ que le collecteur a repris de la ligne stockée (Vench, page restreinte) n'est pas ce que la
            # source a publié. Sa clé est absente de l'instantané, qui en garde la liste : « inconnu de la source »
            # n'est pas « vide à la source », et une restauration ne doit pas le remettre à vide.
            relayed = base_reads.relayed_fields(sale) & set(KNOWN_SOURCE_FACT_SNAPSHOT_FIELDS)
            sale[base_reads.SOURCE_SNAPSHOT_KEY] = {
                key: sale.get(key) for key in KNOWN_SOURCE_FACT_SNAPSHOT_FIELDS if key not in relayed
            }
            if relayed:
                sale[base_reads.SOURCE_SNAPSHOT_KEY][base_reads.SNAPSHOT_RELAYED_FIELDS_KEY] = sorted(relayed)
        elif known_payload.get(base_reads.SOURCE_SNAPSHOT_KEY):
            sale[base_reads.SOURCE_SNAPSHOT_KEY] = known_payload[base_reads.SOURCE_SNAPSHOT_KEY]
        documents_changed = (
            base_reads.was_reread(sale)
            and "documents" in sale
            and document_list_changed(sale.get("documents") or [], known, source_url)
        )
        if documents_changed:
            sale["superseded_document_analysis"] = known_payload.get("document_analysis")
            sale["llm_display_status"] = "pending"
            sale["source_content_changed"] = True
            sale["source_content_changed_at"] = datetime.now(UTC).isoformat()
            continue
        payload_fields = KNOWN_ENRICHMENT_PAYLOAD_FIELDS
        if (
            sale.get("source_detail_status") == "complete"
            and base_reads.was_reread(sale)
        ):
            payload_fields = tuple(
                key
                for key in payload_fields
                if key not in KNOWN_SOURCE_REFRESH_METADATA_FIELDS
            )
        # Le géocodage d'une autre commune n'est pas une preuve pour celle-ci (lot Licitor autrefois lu comme le premier).
        foreign_geocode = other_commune(sale.get("city"), known.get("city"))
        preserved += backfill_payload_fields_from_known(
            sale,
            known,
            keys=tuple(
                key
                for key in payload_fields
                if (sale.get("source_detail_status") not in {"complete", "restricted"}
                    or key not in {"source_images", "raw_image_url"}) and not (foreign_geocode and key == "geocode")
            ),
        )
        preserved += backfill_document_surface_fields_from_known(sale, known)
        preserved += backfill_document_price_from_known(sale, known)
        preserved += backfill_document_facts_version_from_known(sale, known)
        preserved += backfill_document_sale_date_from_known(sale, known)
        preserved += backfill_document_occupancy_from_known(sale, known)
    return preserved


def backfill_payload_fields_from_known(
    sale: dict[str, object],
    known: dict[str, object],
    *,
    keys: tuple[str, ...],
) -> int:
    known_payload = known.get("raw_payload")
    if not isinstance(known_payload, dict):
        return 0
    copied = 0
    for key in keys:
        if is_missing_raw_value(sale.get(key)) and not is_missing_raw_value(known_payload.get(key)):
            sale[key] = known_payload[key]
            copied += 1
    return copied
