"""Select lists and raw_payload projections used to read known sales back from the database."""

from __future__ import annotations

from src.storage.column_sets import UPSERT_COLUMNS

KNOWN_SALE_DETAIL_SELECT = ",".join(
    (
        "id",
        "source_url",
        "source_urls",
        "sale_date",
        "starting_price_eur",
        "visit_dates",
        "lawyer_name",
        "lawyer_contact",
        "status",
        "adjudication_price_eur",
        "score_version",
        "score_confidence",
        "score_factors",
        "quality_flags",
        "latitude",
        "longitude",
        "risk_notes",
        "investment_score",
        "investment_summary",
        "tribunal",
        "tribunal_code",
        "department",
        "city",
        "address",
        "postal_code",
        "property_type",
        "title",
        "description",
        "surface_m2",
        "habitable_surface_m2",
        "land_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "app_surface_kind",
        "surface_scope",
        "surface_source",
        "surface_confidence",
        "surface_evidence",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "parking_count",
        "has_garden",
        "has_terrace",
        "has_garage",
        "has_pool",
        "has_air_conditioning",
        "has_double_glazing",
        "occupancy_status",
        "documents",
        "raw_text",
        "raw_payload",
    )
)


# The REST fallback keeps the historical projection above because PostgREST
# cannot express the JSONB allow-list below.  The direct PostgreSQL preflight
# only needs fields used by the source fallback and enrichment preservation;
# forwarding arbitrary scraper payload keys here was the main source of the
# full-snapshot egress.  Keep the list explicit so a new preservation contract
# has to opt in rather than silently re-expanding every row.
KNOWN_SALE_RAW_PAYLOAD_KEYS = (
    "source_checks",
    "source_checks_by_source",
    "source_presence",
    # Vench's source-contract projection is consumed again when a cold worker
    # restores a known listing.  Keep the complete contract together so a
    # bounded snapshot cannot silently downgrade a paywalled source row.
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
    "source_conflicts",
    "source_images",
    "raw_image_url",
    "source_description",
    "source_factual_snapshot",
    "source_identity_mismatch",
    "source_detail_status",
    "source_content_changed",
    "source_content_change_reason",
    "source_operational_changed",
    "superseded_analysis",
    "superseded_document_analysis",
    "publication_identity_conflict",
    "publication_conflict_evidence",
    "document_analysis",
    "document_facts_version",
    "starting_price_extraction",
    "surface_extraction",
    "surface_analysis",
    "land_surface_extraction",
    "investment_analysis",
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
    "llm_display_quality_version",
    "llm_display_source_constraints",
    "llm_display_evidence_check",
    "llm_prompt_version",
    "llm_due_diligence",
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
    "rooms_bedrooms_conflict_evidence",
    "geocode",
    "tribunal_assignment",
)


# The collection index only needs the source freshness proof.  Enrichment
# payloads are hydrated later for URLs observed during the current run.
KNOWN_SALE_RAW_PAYLOAD_INDEX_KEYS = (
    "source_checks",
    "source_identity_mismatch",
    "source_presence",
)


# PostgreSQL caps a function call at 100 arguments.  A single
# ``jsonb_build_object`` needs two arguments per key, so keep each chunk below
# that limit and merge the chunks before stripping JSON nulls.  This preserves
# the complete allow-list while avoiding a runtime 54023 on the direct worker
# snapshot path.
KNOWN_SALE_RAW_PAYLOAD_PROJECTION_CHUNK_SIZE = 40


def _build_known_sale_raw_payload_projection(keys: tuple[str, ...]) -> str:
    chunks = tuple(
        "jsonb_build_object("
        + ",".join(
            f"'{key}',raw_payload->'{key}'"
            for key in keys[start : start + KNOWN_SALE_RAW_PAYLOAD_PROJECTION_CHUNK_SIZE]
        )
        + ")"
        for start in range(0, len(keys), KNOWN_SALE_RAW_PAYLOAD_PROJECTION_CHUNK_SIZE)
    )
    return "jsonb_strip_nulls(" + " || ".join(chunks) + ") as raw_payload"


KNOWN_SALE_RAW_PAYLOAD_PROJECTION = _build_known_sale_raw_payload_projection(
    KNOWN_SALE_RAW_PAYLOAD_KEYS
)


KNOWN_SALE_RAW_PAYLOAD_INDEX_PROJECTION = _build_known_sale_raw_payload_projection(
    KNOWN_SALE_RAW_PAYLOAD_INDEX_KEYS
)


KNOWN_SALE_POSTGRES_SELECT = ",".join(
    (
        KNOWN_SALE_DETAIL_SELECT.rsplit(",raw_payload", 1)[0],
        KNOWN_SALE_RAW_PAYLOAD_PROJECTION,
    )
)


def _known_sale_postgres_select(
    *,
    compact_presence: bool,
    include_enrichment_payload: bool = True,
) -> str:
    """Build the bounded snapshot projection for the active DB schema.

    The compact source-presence migration replaces the catalogue-view JSON
    expression with a SECURITY DEFINER helper.  Direct worker snapshots read
    ``auction_sales`` rather than those views, so hydrate the same projection
    here only after the helper's presence has been confirmed.
    """
    scalar_projection = KNOWN_SALE_DETAIL_SELECT.rsplit(",raw_payload", 1)[0]
    payload_projection = (
        KNOWN_SALE_RAW_PAYLOAD_PROJECTION
        if include_enrichment_payload
        else KNOWN_SALE_RAW_PAYLOAD_INDEX_PROJECTION
    )
    if not compact_presence:
        return ",".join((scalar_projection, payload_projection))
    compact_payload = (
        "jsonb_set("
        f"{payload_projection.removesuffix(' as raw_payload')},"
        "'{source_presence}',"
        "coalesce(app_private.auction_sale_source_presence_json(id),'{}'::jsonb),"
        "true) as raw_payload"
    )
    return ",".join((scalar_projection, compact_payload))


# Enrichment writes the full record back: a partial SELECT would erase price,
# procedure, dates and other facts that the worker did not actually re-extract.
DATA_REFRESH_SALE_SELECT = ",".join(dict.fromkeys((
    "id", "created_at", "updated_at", "first_seen_at", "last_seen_at", *UPSERT_COLUMNS,
)))
