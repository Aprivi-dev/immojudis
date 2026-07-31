from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx

BRIDGE_RPC_NAME = "bridge_auction_sales_to_outcome_graph"
BRIDGE_TIMEOUT = httpx.Timeout(120.0, connect=20.0)


class OutcomeCatalogueBridgeError(RuntimeError):
    """The mutable catalogue could not be durably linked before cleanup."""


@dataclass(frozen=True, slots=True)
class OutcomeCatalogueBridgeResult:
    scanned_count: int
    created_count: int
    reused_count: int
    linked_count: int
    complete: bool

    @property
    def remaining_unlinked(self) -> int:
        return max(0, self.scanned_count - self.linked_count)

    def require_complete(self) -> OutcomeCatalogueBridgeResult:
        if not self.complete or self.remaining_unlinked != 0:
            raise OutcomeCatalogueBridgeError(
                "Outcome catalogue bridge is incomplete; destructive cleanup is disabled "
                f"({self.remaining_unlinked} of {self.scanned_count} rows remain unlinked)."
            )
        return self


PostCallable = Callable[..., httpx.Response]


def bridge_auction_sales_before_cleanup(
    settings: Mapping[str, object],
    *,
    post: PostCallable = httpx.post,
) -> OutcomeCatalogueBridgeResult:
    """Bridge the complete database catalogue through one service-role RPC.

    The RPC copies PostgreSQL ``numeric`` values directly into Outcome Graph;
    Python never serializes monetary ``Decimal`` values through ``float``.
    Any missing credential, HTTP error, malformed response, or incomplete scan
    raises so callers cannot proceed to destructive catalogue cleanup.
    """

    supabase_url = _required_setting(settings, "supabase_url")
    service_role_key = _required_setting(settings, "supabase_service_role_key")
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/rpc/{BRIDGE_RPC_NAME}"

    try:
        response = post(
            endpoint,
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
            json={},
            timeout=BRIDGE_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge RPC could not be reached; destructive cleanup is disabled."
        ) from exc

    if response.is_error:
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge RPC failed; destructive cleanup is disabled "
            f"(HTTP {response.status_code})."
        )

    try:
        payload: Any = response.json()
    except ValueError as exc:
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge RPC returned invalid JSON; destructive cleanup is disabled."
        ) from exc

    row = _single_result_row(payload)
    result = OutcomeCatalogueBridgeResult(
        scanned_count=_non_negative_int(row, "scanned_count"),
        created_count=_non_negative_int(row, "created_count"),
        reused_count=_non_negative_int(row, "reused_count"),
        linked_count=_non_negative_int(row, "linked_count"),
        complete=_strict_bool(row, "complete"),
    )
    if result.created_count + result.reused_count != result.scanned_count:
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge returned incoherent counters; destructive cleanup is disabled."
        )
    if result.linked_count > result.scanned_count:
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge linked count exceeds its scan; destructive cleanup is disabled."
        )
    return result.require_complete()


def _required_setting(settings: Mapping[str, object], key: str) -> str:
    value = settings.get(key)
    if not isinstance(value, str) or not value.strip():
        raise OutcomeCatalogueBridgeError(
            f"{key} is required to bridge the catalogue before destructive cleanup."
        )
    return value.strip()


def _single_result_row(payload: object) -> Mapping[str, object]:
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise OutcomeCatalogueBridgeError(
            "Outcome catalogue bridge RPC returned an unexpected result shape; "
            "destructive cleanup is disabled."
        )
    return payload[0]


def _non_negative_int(row: Mapping[str, object], key: str) -> int:
    value = row.get(key)
    if isinstance(value, bool):
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is invalid.")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and value.isdigit():
        parsed = int(value)
    else:
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is invalid.")
    if parsed < 0:
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is negative.")
    return parsed


def _strict_bool(row: Mapping[str, object], key: str) -> bool:
    value = row.get(key)
    if not isinstance(value, bool):
        raise OutcomeCatalogueBridgeError(f"Outcome catalogue bridge field {key} is invalid.")
    return value
