from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

from src.null_text import is_null_text, null_if_placeholder

# Free-text columns: a literal « nan » or « None » means "missing", never a value.
NULLABLE_TEXT_FIELDS = (
    "external_id",
    "tribunal",
    "tribunal_code",
    "department",
    "city",
    "address",
    "postal_code",
    "property_type",
    "title",
    "description",
    "app_surface_kind",
    "surface_scope",
    "surface_source",
    "surface_evidence",
    "lawyer_name",
    "lawyer_contact",
    "occupancy_status",
    "risk_notes",
    "investment_summary",
    "score_version",
    "raw_text",
)


class AuctionSale(BaseModel):
    model_config = ConfigDict(populate_by_name=True, arbitrary_types_allowed=True)

    id: str | None = None
    source_name: str
    source_url: str
    primary_source: str | None = None
    source_urls: list[str] = Field(default_factory=list)
    dedupe_confidence: str | None = None
    external_id: str | None = None
    tribunal: str | None = None
    tribunal_code: str | None = None
    sale_venue_type: str = "unknown"
    sale_legal_framework: str = "unknown"
    sale_verification_status: str = "pending"
    sale_procedure: dict[str, Any] = Field(default_factory=dict)
    department: str | None = None
    city: str | None = None
    address: str | None = None
    postal_code: str | None = None
    property_type: str | None = None
    title: str | None = None
    description: str | None = None
    surface_m2: Decimal | None = None
    habitable_surface_m2: Decimal | None = None
    land_surface_m2: Decimal | None = None
    carrez_surface_m2: Decimal | None = None
    app_surface_m2: Decimal | None = None
    app_surface_kind: str | None = None
    surface_scope: str | None = None
    surface_source: str | None = None
    surface_confidence: Decimal | None = None
    surface_evidence: str | None = None
    rooms_count: int | None = None
    bedrooms_count: int | None = None
    bathrooms_count: int | None = None
    parking_count: int | None = None
    has_garden: bool | None = None
    has_terrace: bool | None = None
    has_garage: bool | None = None
    has_pool: bool | None = None
    has_air_conditioning: bool | None = None
    has_double_glazing: bool | None = None
    starting_price_eur: Decimal | None = None
    sale_date: datetime | None = None
    visit_dates: list[str] = Field(default_factory=list)
    lawyer_name: str | None = None
    lawyer_contact: str | None = None
    status: str = "upcoming"
    adjudication_price_eur: Decimal | None = None
    documents: list[dict[str, str]] = Field(default_factory=list)
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    occupancy_status: str | None = None
    risk_notes: str | None = None
    investment_score: Decimal | None = None
    investment_summary: str | None = None
    score_version: str | None = None
    score_confidence: Decimal | None = None
    score_factors: list[dict[str, Any]] = Field(default_factory=list)
    premium_readiness_score: int | None = None
    premium_readiness_status: str | None = None
    premium_readiness_policy_version: str | None = None
    premium_readiness_factors: dict[str, Any] = Field(default_factory=dict)
    premium_readiness_blockers: list[str] = Field(default_factory=list)
    premium_readiness_missing_fields: list[str] = Field(default_factory=list)
    premium_readiness_evaluated_at: datetime | None = None
    quality_flags: list[str] = Field(default_factory=list)
    raw_text: str | None = None
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    observations: list[dict[str, Any]] = Field(default_factory=list)
    content_hash: str | None = None
    last_run_id: str | None = None
    first_seen_at: datetime | None = None
    last_seen_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @field_validator("source_url", mode="before")
    @classmethod
    def source_url_to_string(cls, value: str | HttpUrl) -> str:
        return str(value) if value is not None else value

    @field_validator(*NULLABLE_TEXT_FIELDS, mode="before")
    @classmethod
    def placeholder_text_to_none(cls, value: Any) -> Any:
        return null_if_placeholder(value)

    @field_validator("visit_dates", mode="before")
    @classmethod
    def drop_placeholder_visit_dates(cls, value: Any) -> Any:
        if isinstance(value, list):
            return [item for item in value if not is_null_text(item)]
        return value

    def to_storage_dict(self, exclude_none: bool = True) -> dict[str, Any]:
        data = self.model_dump(exclude_none=exclude_none)
        for key in NULLABLE_TEXT_FIELDS:
            # Fields assigned after construction bypass the validators above.
            if is_null_text(data.get(key)):
                if exclude_none:
                    del data[key]
                else:
                    data[key] = None
        for key, value in list(data.items()):
            if isinstance(value, Decimal):
                data[key] = float(value)
            elif isinstance(value, datetime):
                data[key] = value.isoformat()
        return data
