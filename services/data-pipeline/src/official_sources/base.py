from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from enum import Enum
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel


class OfficialSourceError(RuntimeError):
    """Base error whose message is safe to log (it never contains credentials)."""


class OfficialSourceConfigurationError(OfficialSourceError):
    pass


class OfficialSourceDisabledError(OfficialSourceError):
    pass


class OfficialSourceDryRun(OfficialSourceError):
    pass


class OfficialSourceHTTPError(OfficialSourceError):
    def __init__(self, *, method: str, endpoint: str, status_code: int | None = None) -> None:
        status = f" (HTTP {status_code})" if status_code is not None else ""
        super().__init__(f"official source request failed: {method.upper()} {endpoint}{status}")
        self.method = method.upper()
        self.endpoint = endpoint
        self.status_code = status_code


@dataclass(frozen=True)
class RetryPolicy:
    max_retries: int = 4
    backoff_seconds: float = 1.0
    max_sleep_seconds: float = 30.0

    def __post_init__(self) -> None:
        if self.max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        if self.backoff_seconds < 0:
            raise ValueError("backoff_seconds must be non-negative")
        if self.max_sleep_seconds < 0:
            raise ValueError("max_sleep_seconds must be non-negative")


def exact_origin(url: str) -> tuple[str, str, int]:
    parsed = urlparse(url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise OfficialSourceConfigurationError("official source URLs must use absolute HTTPS URLs")
    if parsed.username is not None or parsed.password is not None:
        raise OfficialSourceConfigurationError("official source URLs must not contain user information")
    try:
        port = parsed.port or 443
    except ValueError as exc:
        raise OfficialSourceConfigurationError("official source URL contains an invalid port") from exc
    return parsed.scheme.lower(), parsed.hostname.rstrip(".").lower(), port


def has_exact_origin(url: str, expected_url: str) -> bool:
    try:
        return exact_origin(url) == exact_origin(expected_url)
    except OfficialSourceConfigurationError:
        return False


def validate_base_url(url: str) -> str:
    exact_origin(url)
    parsed = urlparse(url)
    if parsed.query or parsed.fragment:
        raise OfficialSourceConfigurationError("official source base URLs must not contain query strings or fragments")
    return url.rstrip("/")


def safe_endpoint_name(value: str) -> str:
    """Reduce an endpoint to a non-sensitive path for errors and metrics."""
    parsed = urlparse(value)
    path = parsed.path if parsed.scheme else value.split("?", 1)[0]
    if not path.startswith("/"):
        path = f"/{path}"
    return path


def canonical_json(value: Any) -> bytes:
    """Return deterministic UTF-8 JSON suitable for evidence hashing."""
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json", by_alias=True, exclude_none=False)
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def retry_delay_seconds(
    *,
    retry_after: str | None,
    retry_number: int,
    policy: RetryPolicy,
    now: datetime | None = None,
) -> float:
    exponential = policy.backoff_seconds * (2 ** max(0, retry_number))
    instructed = 0.0
    if retry_after:
        try:
            instructed = max(0.0, float(retry_after.strip()))
        except ValueError:
            try:
                target = parsedate_to_datetime(retry_after)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=UTC)
                current = now or datetime.now(UTC)
                instructed = max(0.0, (target - current).total_seconds())
            except (TypeError, ValueError, OverflowError):
                instructed = 0.0
    return min(policy.max_sleep_seconds, max(exponential, instructed))


def _json_default(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_none=False)
    raise TypeError(f"value of type {type(value).__name__} is not JSON serializable")
