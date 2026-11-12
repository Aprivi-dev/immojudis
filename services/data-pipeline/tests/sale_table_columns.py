"""Colonnes de ``auction_sales`` lues sous le verrou de publication, pour les tables minimales des tests PostgreSQL.

``resolve_publication_identities`` lit une liste de colonnes explicite (``LOCKED_SALE_SELECT``) : une table de test
réduite à quelques colonnes doit donc porter les autres. ``add_model_columns`` les ajoute sans valeur par défaut, pour
ne rien changer à ce que le test a défini lui-même. Types relevés sur la table réelle (migrations rejouées).
"""

from __future__ import annotations

from typing import Any

MODEL_COLUMN_TYPES: dict[str, str] = {
    "id": "uuid",
    "created_at": "timestamptz",
    "updated_at": "timestamptz",
    "first_seen_at": "timestamptz",
    "last_seen_at": "timestamptz",
    "source_name": "text",
    "source_url": "text",
    "primary_source": "text",
    "source_urls": "jsonb",
    "dedupe_confidence": "text",
    "external_id": "text",
    "tribunal": "text",
    "tribunal_code": "text",
    "sale_venue_type": "text",
    "sale_legal_framework": "text",
    "sale_verification_status": "text",
    "sale_procedure": "jsonb",
    "department": "text",
    "city": "text",
    "address": "text",
    "postal_code": "text",
    "property_type": "text",
    "title": "text",
    "description": "text",
    "surface_m2": "numeric",
    "habitable_surface_m2": "numeric",
    "land_surface_m2": "numeric",
    "carrez_surface_m2": "numeric",
    "app_surface_m2": "numeric",
    "app_surface_kind": "text",
    "surface_scope": "text",
    "surface_source": "text",
    "surface_confidence": "numeric",
    "surface_evidence": "text",
    "rooms_count": "integer",
    "bedrooms_count": "integer",
    "bathrooms_count": "integer",
    "parking_count": "integer",
    "has_garden": "boolean",
    "has_terrace": "boolean",
    "has_garage": "boolean",
    "has_pool": "boolean",
    "has_air_conditioning": "boolean",
    "has_double_glazing": "boolean",
    "starting_price_eur": "numeric",
    "sale_date": "timestamptz",
    "visit_dates": "jsonb",
    "lawyer_name": "text",
    "lawyer_contact": "text",
    "status": "text",
    "adjudication_price_eur": "numeric",
    "documents": "jsonb",
    "latitude": "numeric",
    "longitude": "numeric",
    "occupancy_status": "text",
    "risk_notes": "text",
    "investment_score": "numeric",
    "investment_summary": "text",
    "score_version": "text",
    "score_confidence": "numeric",
    "score_factors": "jsonb",
    "premium_readiness_score": "smallint",
    "premium_readiness_status": "text",
    "premium_readiness_policy_version": "text",
    "premium_readiness_factors": "jsonb",
    "premium_readiness_blockers": "jsonb",
    "premium_readiness_missing_fields": "jsonb",
    "premium_readiness_evaluated_at": "timestamptz",
    "quality_flags": "jsonb",
    "raw_text": "text",
    "raw_payload": "jsonb",
    "observations": "jsonb",
    "content_hash": "text",
    "last_run_id": "uuid",
}


def add_model_columns(db: Any, table: str = "auction_sales") -> None:
    """Ajoute à ``table`` les colonnes du modèle qu'elle n'a pas encore, sans valeur par défaut."""
    for column, column_type in MODEL_COLUMN_TYPES.items():
        db.execute(f"alter table {table} add column if not exists {column} {column_type}")
