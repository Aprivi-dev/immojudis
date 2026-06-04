from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


class RawAuctionSale(BaseModel):
    model_config = ConfigDict(extra="allow")

    source_name: str
    source_url: str
    external_id: str | None = None
    department: str | None = None
    city: str | None = None
    title: str | None = None
    description: str | None = None
    raw_text: str | None = None
    documents: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("source_name", "source_url", mode="before")
    @classmethod
    def require_non_empty_text(cls, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("required non-empty text")
        return text

    @field_validator("documents", mode="before")
    @classmethod
    def normalize_documents(cls, value: Any) -> list[dict[str, Any]]:
        return value if isinstance(value, list) else []

    @model_validator(mode="after")
    def require_content_signal(self) -> "RawAuctionSale":
        if not any(_has_text(value) for value in (self.title, self.description, self.raw_text)):
            raise ValueError("missing title, description or raw_text")
        return self


class RawAvoventesSale(RawAuctionSale):
    source_name: Literal["avoventes"]


class RawLicitorSale(RawAuctionSale):
    source_name: Literal["licitor"]


class RawVenchSale(RawAuctionSale):
    source_name: Literal["vench"]


class RawInfoEncheresSale(RawAuctionSale):
    source_name: Literal["info_encheres"]


class RawEncheresPubliquesSale(RawAuctionSale):
    source_name: Literal["encheres_publiques"]


SOURCE_MODELS: dict[str, type[RawAuctionSale]] = {
    "avoventes": RawAvoventesSale,
    "licitor": RawLicitorSale,
    "vench": RawVenchSale,
    "info_encheres": RawInfoEncheresSale,
    "encheres_publiques": RawEncheresPubliquesSale,
}


def validate_raw_sales(
    source_name: str,
    raw_sales: list[dict[str, Any]],
    errors: list[str],
) -> list[dict[str, Any]]:
    model = SOURCE_MODELS[source_name]
    valid: list[dict[str, Any]] = []
    for sale in raw_sales:
        try:
            model.model_validate(sale)
        except ValidationError as exc:
            marker = sale.get("source_url") or sale.get("external_id") or "unknown"
            errors.append(f"validation {marker}: {_compact_validation_error(exc)}")
            continue
        valid.append(sale)
    return valid


def _compact_validation_error(exc: ValidationError) -> str:
    parts: list[str] = []
    for item in exc.errors():
        loc = ".".join(str(part) for part in item.get("loc", ())) or "root"
        parts.append(f"{loc}: {item.get('msg')}")
    return "; ".join(parts)


def _has_text(value: str | None) -> bool:
    return bool(value and value.strip())
