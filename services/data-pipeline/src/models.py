from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


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

    def to_storage_dict(self, exclude_none: bool = True) -> dict[str, Any]:
        data = self.model_dump(exclude_none=exclude_none)
        for key, value in list(data.items()):
            if isinstance(value, Decimal):
                data[key] = float(value)
            elif isinstance(value, datetime):
                data[key] = value.isoformat()
        return data
