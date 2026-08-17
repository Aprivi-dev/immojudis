from __future__ import annotations

import math
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal
from urllib.parse import parse_qs, urlparse

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .base import (
    OfficialSourceConfigurationError,
    OfficialSourceDisabledError,
    OfficialSourceDryRun,
    OfficialSourceHTTPError,
    RetryPolicy,
    canonical_json,
    canonical_sha256,
    has_exact_origin,
    retry_delay_seconds,
    safe_endpoint_name,
    validate_base_url,
)

JUDILIBRE_PRODUCTION_BASE_URL = "https://api.piste.gouv.fr/cassation/judilibre/v1.0"
JUDILIBRE_SANDBOX_BASE_URL = "https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0"
JUDILIBRE_PRODUCTION_TOKEN_URL = "https://oauth.piste.gouv.fr/api/oauth/token"
JUDILIBRE_SANDBOX_TOKEN_URL = "https://sandbox-oauth.piste.gouv.fr/api/oauth/token"

SEARCH_MAX_PAGE_SIZE = 50
SEARCH_MAX_RESULTS = 10_000
HISTORY_MIN_PAGE_SIZE = 10
HISTORY_MAX_PAGE_SIZE = 500
RETRYABLE_STATUS_CODES = {423, 429}
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}
_HISTORY_PATHS = {"/transactionalhistory", "/transactionalHistory"}

AuthMode = Literal["auto", "keyid", "oauth2", "keyid+oauth2"]
OAuthClientAuthMethod = Literal["basic", "form"]


class JudilibreResponseModel(BaseModel):
    """Typed known fields while retaining new fields introduced by Judilibre."""

    model_config = ConfigDict(
        extra="allow",
        populate_by_name=True,
        hide_input_in_errors=True,
    )

    def canonical_json(self) -> bytes:
        return canonical_json(self)

    def canonical_sha256(self) -> str:
        return canonical_sha256(self)


class JudilibreDecisionSummary(JudilibreResponseModel):
    id: str = Field(min_length=1)
    jurisdiction: str | None = None
    location: str | None = None
    chamber: str | None = None
    number: str | None = None
    numbers: list[str] = Field(default_factory=list)
    ecli: str | None = None
    formation: str | None = None
    publication: list[str] = Field(default_factory=list)
    decision_date: date | None = None
    type: str | None = None
    solution: str | None = None
    solution_alt: str | None = None
    summary: str | None = None
    bulletin: str | None = None
    themes: list[str] = Field(default_factory=list)
    files: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def normalize_decision_id(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate:
            raise ValueError("decision id must not be empty")
        return candidate


class JudilibreSearchResult(JudilibreDecisionSummary):
    score: float | None = None
    highlights: dict[str, list[str]] = Field(default_factory=dict)


class JudilibreSearchPage(JudilibreResponseModel):
    page: int = Field(ge=0)
    page_size: int = Field(ge=1, le=SEARCH_MAX_PAGE_SIZE)
    query: dict[str, Any] = Field(default_factory=dict)
    total: int = Field(default=0, ge=0)
    next_page: str | None = None
    previous_page: str | None = None
    took: int | None = Field(default=None, ge=0)
    max_score: float | None = None
    relaxed: bool = False
    results: list[JudilibreSearchResult] = Field(default_factory=list)


class JudilibreDecision(JudilibreDecisionSummary):
    text: str | None = None
    text_highlight: str | None = None
    zones: dict[str, Any] = Field(default_factory=dict)
    nac: str | None = None
    decision_datetime: datetime | None = None
    update_date: date | None = None
    update_datetime: datetime | None = None
    visa: list[dict[str, Any]] = Field(default_factory=list)
    contested: dict[str, Any] | None = None
    forward: dict[str, Any] | None = None
    rapprochements: list[dict[str, Any]] = Field(default_factory=list)
    timeline: list[dict[str, Any]] | None = Field(default_factory=list)
    to_be_deleted: bool = False
    partial: bool = False
    legacy: dict[str, Any] = Field(default_factory=dict)
    particular_interest: bool = Field(default=False, alias="particularInterest")
    titles_and_summaries: dict[str, Any] | list[Any] = Field(
        default_factory=dict,
        alias="titlesAndSummaries",
    )

    @field_validator("decision_datetime", "update_datetime")
    @classmethod
    def validate_decision_timestamps(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Judilibre decision timestamps must include a timezone")
        return value

    @property
    def is_deletion(self) -> bool:
        return self.to_be_deleted


@dataclass(frozen=True)
class JudilibreDecisionFetch:
    """HTTP-aware decision result used for safe conditional refreshes."""

    status_code: int
    decision: JudilibreDecision | None
    etag: str | None = None
    last_modified: str | None = None

    @property
    def not_modified(self) -> bool:
        return self.status_code == 304


@dataclass(frozen=True)
class _JudilibreJSONResponse:
    status_code: int
    payload: Any | None
    etag: str | None = None
    last_modified: str | None = None


class JudilibreTaxonomy(JudilibreResponseModel):
    id: str | None = None
    key: str | None = None
    value: str | None = None
    result: Any = None


class JudilibreStats(JudilibreResponseModel):
    query: dict[str, Any] = Field(default_factory=dict)
    results: dict[str, Any] = Field(default_factory=dict)


class JudilibreTransaction(JudilibreResponseModel):
    id: str = Field(min_length=1)
    action: Literal["created", "updated", "deleted"]
    date: str

    @field_validator("id")
    @classmethod
    def normalize_transaction_id(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate:
            raise ValueError("transaction id must not be empty")
        return candidate

    @field_validator("date")
    @classmethod
    def validate_transaction_date(cls, value: str) -> str:
        return _aware_iso_datetime(value, field_name="transaction date")

    @property
    def is_deletion(self) -> bool:
        return self.action == "deleted"


class JudilibreHistoryCursor(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    date: str = Field(min_length=1)
    page_size: int = Field(default=100, ge=HISTORY_MIN_PAGE_SIZE, le=HISTORY_MAX_PAGE_SIZE)
    from_id: str | None = Field(default=None, min_length=1)

    @field_validator("date")
    @classmethod
    def validate_iso_date(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate:
            raise ValueError("date must be ISO-8601")
        # Judilibre accepts a calendar date for the first synchronization. All
        # long-form timestamps must be timezone-aware to avoid ambiguous
        # checkpoints.
        try:
            parsed_date = date.fromisoformat(candidate)
        except ValueError:
            return _aware_iso_datetime(candidate, field_name="date")
        if candidate == parsed_date.isoformat():
            return candidate
        return _aware_iso_datetime(candidate, field_name="date")

    @field_validator("from_id")
    @classmethod
    def normalize_from_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            raise ValueError("from_id must not be empty")
        return candidate

    def to_http_params(self) -> dict[str, str | int]:
        params: dict[str, str | int] = {"date": self.date, "page_size": self.page_size}
        if self.from_id:
            params["from_id"] = self.from_id
        return params

    @classmethod
    def from_next_page(
        cls,
        next_page: str,
        *,
        base_url: str,
        history_path: str = "/transactionalhistory",
        default_page_size: int = HISTORY_MAX_PAGE_SIZE,
    ) -> JudilibreHistoryCursor:
        raw = next_page.strip()
        if not raw:
            raise OfficialSourceConfigurationError("Judilibre returned an empty history cursor")

        parsed = urlparse(raw)
        if parsed.scheme or parsed.netloc:
            if not has_exact_origin(raw, base_url):
                raise OfficialSourceConfigurationError("Judilibre history cursor has an unexpected origin")
            if parsed.fragment:
                raise OfficialSourceConfigurationError("Judilibre history cursor contains a fragment")
            expected_path = f"{urlparse(base_url).path.rstrip('/')}{history_path}"
            if parsed.path.rstrip("/") != expected_path.rstrip("/"):
                raise OfficialSourceConfigurationError("Judilibre history cursor has an unexpected endpoint")
            query_string = parsed.query
        else:
            if raw.startswith("/"):
                raise OfficialSourceConfigurationError("Judilibre history cursor has an unexpected endpoint")
            query_string = raw[1:] if raw.startswith("?") else raw

        try:
            values = parse_qs(query_string, keep_blank_values=True, strict_parsing=True)
        except ValueError as exc:
            raise OfficialSourceConfigurationError("Judilibre history cursor is malformed") from exc
        allowed = {"date", "page_size", "from_id"}
        if set(values) - allowed or any(len(items) != 1 for items in values.values()):
            raise OfficialSourceConfigurationError("Judilibre history cursor contains unexpected parameters")
        try:
            cursor_date = values["date"][0]
            page_size = int(values.get("page_size", [str(default_page_size)])[0])
        except (KeyError, ValueError) as exc:
            raise OfficialSourceConfigurationError("Judilibre history cursor is incomplete") from exc
        try:
            return cls(
                date=cursor_date,
                page_size=page_size,
                from_id=values.get("from_id", [None])[0],
            )
        except ValueError as exc:
            raise OfficialSourceConfigurationError("Judilibre history cursor is invalid") from exc


class JudilibreHistoryPage(JudilibreResponseModel):
    transactions: list[JudilibreTransaction]
    # The current Judilibre implementation reports the number of hits actually
    # returned here, so the terminal page can legitimately contain 0..9 items.
    page_size: int = Field(ge=0, le=HISTORY_MAX_PAGE_SIZE)
    total: int = Field(ge=0)
    query_date: str
    next_page: str | None = None

    @field_validator("query_date")
    @classmethod
    def validate_query_date(cls, value: str) -> str:
        return _aware_iso_datetime(value, field_name="history query date")

    @model_validator(mode="after")
    def validate_page_counts(self) -> JudilibreHistoryPage:
        if len(self.transactions) > self.page_size:
            raise ValueError("history page contains more transactions than its page_size")
        if len(self.transactions) > self.total:
            raise ValueError("history page contains more transactions than its total")
        if self.next_page and not self.transactions:
            raise ValueError("history page cannot continue after an empty result")
        return self

    @property
    def has_deletions(self) -> bool:
        return any(transaction.is_deletion for transaction in self.transactions)

    def next_cursor(
        self,
        *,
        base_url: str,
        history_path: str = "/transactionalhistory",
        default_page_size: int = HISTORY_MAX_PAGE_SIZE,
    ) -> JudilibreHistoryCursor | None:
        if not self.next_page:
            return None
        return JudilibreHistoryCursor.from_next_page(
            self.next_page,
            base_url=base_url,
            history_path=history_path,
            default_page_size=default_page_size,
        )


class JudilibreSearchQuery(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        hide_input_in_errors=True,
    )

    query: str | None = None
    field: list[str] = Field(default_factory=list)
    operator: Literal["or", "and", "exact"] | None = None
    decision_types: list[str] = Field(default_factory=list, alias="type")
    theme: list[str] = Field(default_factory=list)
    chamber: list[str] = Field(default_factory=list)
    formation: list[str] = Field(default_factory=list)
    jurisdiction: list[str] = Field(default_factory=list)
    location: list[str] = Field(default_factory=list)
    publication: list[str] = Field(default_factory=list)
    solution: list[str] = Field(default_factory=list)
    date_start: date | None = None
    date_end: date | None = None
    sort: Literal["score", "scorepub", "date"] | None = None
    order: Literal["asc", "desc"] | None = None
    page_size: int | None = Field(default=None, ge=1, le=SEARCH_MAX_PAGE_SIZE)
    page: int = Field(default=0, ge=0)
    resolve_references: bool = False
    with_file_of_type: list[str] = Field(default_factory=list, alias="withFileOfType")
    particular_interest: bool | None = Field(default=None, alias="particularInterest")

    @model_validator(mode="after")
    def validate_dates_and_window(self) -> JudilibreSearchQuery:
        if self.date_start and self.date_end and self.date_start > self.date_end:
            raise ValueError("date_start must be before or equal to date_end")
        if self.page_size is not None and self.page * self.page_size >= SEARCH_MAX_RESULTS:
            raise ValueError("Judilibre search pages cannot start beyond the 10,000-result window")
        return self

    def with_defaults(self, *, page_size: int) -> JudilibreSearchQuery:
        return self.model_copy(update={"page_size": self.page_size or page_size})

    def to_http_params(self) -> list[tuple[str, str | int]]:
        values = self.model_dump(mode="json", by_alias=True, exclude_none=True)
        params: list[tuple[str, str | int]] = []
        for key, value in values.items():
            if isinstance(value, list):
                params.extend((key, str(item)) for item in value)
            elif isinstance(value, bool):
                params.append((key, "true" if value else "false"))
            else:
                params.append((key, value))
        return params


@dataclass(frozen=True)
class JudilibreCredentials:
    key_id: str | None = field(default=None, repr=False)
    oauth_client_id: str | None = field(default=None, repr=False)
    oauth_client_secret: str | None = field(default=None, repr=False)
    oauth_scope: str | None = field(default=None, repr=False)
    auth_mode: AuthMode = "auto"
    oauth_client_auth_method: OAuthClientAuthMethod = "basic"

    @property
    def has_key_id(self) -> bool:
        return bool(self.key_id and self.key_id.strip())

    @property
    def has_oauth(self) -> bool:
        return bool(
            self.oauth_client_id
            and self.oauth_client_id.strip()
            and self.oauth_client_secret
            and self.oauth_client_secret.strip()
        )

    def resolved_mode(self) -> Literal["keyid", "oauth2", "keyid+oauth2"]:
        if self.auth_mode not in {"auto", "keyid", "oauth2", "keyid+oauth2"}:
            raise OfficialSourceConfigurationError("unsupported Judilibre authentication mode")
        if self.oauth_client_auth_method not in {"basic", "form"}:
            raise OfficialSourceConfigurationError(
                "unsupported Judilibre OAuth2 client authentication method"
            )
        if self.auth_mode != "auto":
            mode = self.auth_mode
        elif self.has_key_id and self.has_oauth:
            mode = "keyid+oauth2"
        elif self.has_key_id:
            mode = "keyid"
        elif self.has_oauth:
            mode = "oauth2"
        else:
            raise OfficialSourceConfigurationError(
                "Judilibre credentials are missing (configure KeyId or OAuth2 client credentials)"
            )

        if mode in {"keyid", "keyid+oauth2"} and not self.has_key_id:
            raise OfficialSourceConfigurationError("Judilibre KeyId authentication is selected but not configured")
        if mode in {"oauth2", "keyid+oauth2"} and not self.has_oauth:
            raise OfficialSourceConfigurationError(
                "Judilibre OAuth2 authentication is selected but client credentials are incomplete"
            )
        return mode


class JudilibreClient:
    """Synchronous Judilibre client gated by an explicit source-policy flag.

    The client intentionally refuses redirects and never includes response bodies,
    headers, credentials, or full URLs in raised errors.
    """

    def __init__(
        self,
        *,
        credentials: JudilibreCredentials,
        base_url: str = JUDILIBRE_PRODUCTION_BASE_URL,
        oauth_token_url: str | None = None,
        policy_allows_network: bool = False,
        dry_run: bool = False,
        timeout_seconds: float = 20.0,
        page_size: int = 25,
        history_page_size: int = 100,
        max_results: int = SEARCH_MAX_RESULTS,
        retry_policy: RetryPolicy | None = None,
        transactional_history_path: str = "/transactionalhistory",
        user_agent: str = "immojudis-data-pipeline/1.0",
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.base_url = validate_base_url(base_url)
        if self.base_url not in {JUDILIBRE_PRODUCTION_BASE_URL, JUDILIBRE_SANDBOX_BASE_URL}:
            raise OfficialSourceConfigurationError("Judilibre base URL is not an approved PISTE endpoint")
        if transactional_history_path not in _HISTORY_PATHS:
            raise OfficialSourceConfigurationError("unsupported Judilibre transactional-history endpoint casing")
        if timeout_seconds <= 0:
            raise OfficialSourceConfigurationError("Judilibre timeout must be positive")
        if not 1 <= page_size <= SEARCH_MAX_PAGE_SIZE:
            raise OfficialSourceConfigurationError("Judilibre page size must be between 1 and 50")
        if not HISTORY_MIN_PAGE_SIZE <= history_page_size <= HISTORY_MAX_PAGE_SIZE:
            raise OfficialSourceConfigurationError("Judilibre history page size must be between 10 and 500")
        if not 1 <= max_results <= SEARCH_MAX_RESULTS:
            raise OfficialSourceConfigurationError("Judilibre max results must be between 1 and 10,000")

        self.credentials = credentials
        self.policy_allows_network = policy_allows_network
        self.dry_run = dry_run
        self.page_size = page_size
        self.history_page_size = history_page_size
        self.max_results = max_results
        self.retry_policy = retry_policy or RetryPolicy()
        self.transactional_history_path = transactional_history_path
        self._sleep = sleep
        self._monotonic = monotonic
        self._access_token: str | None = None
        self._access_token_expires_at = 0.0

        default_token_url = (
            JUDILIBRE_SANDBOX_TOKEN_URL
            if self.base_url == JUDILIBRE_SANDBOX_BASE_URL
            else JUDILIBRE_PRODUCTION_TOKEN_URL
        )
        self.oauth_token_url = validate_base_url(oauth_token_url or default_token_url)
        if self.oauth_token_url != default_token_url:
            raise OfficialSourceConfigurationError(
                "Judilibre OAuth token URL does not match the approved PISTE environment"
            )
        self._client = httpx.Client(
            headers={"Accept": "application/json", "User-Agent": user_agent},
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            verify=True,
            transport=transport,
        )

    @classmethod
    def from_settings(
        cls,
        settings: Mapping[str, Any] | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> JudilibreClient:
        if settings is None:
            from src.config import load_settings

            settings = load_settings()
        credentials = JudilibreCredentials(
            key_id=_optional_string(settings.get("judilibre_key_id")),
            oauth_client_id=_optional_string(settings.get("judilibre_oauth_client_id")),
            oauth_client_secret=_optional_string(settings.get("judilibre_oauth_client_secret")),
            # PISTE documents ``openid`` for the client-credentials grant. An
            # explicitly configured scope still takes precedence.
            oauth_scope=_optional_string(settings.get("judilibre_oauth_scope")) or "openid",
            auth_mode=_auth_mode(settings.get("judilibre_auth_mode", "auto")),
            oauth_client_auth_method=_oauth_method(
                settings.get("judilibre_oauth_client_auth_method", "basic")
            ),
        )
        return cls(
            credentials=credentials,
            base_url=str(settings.get("judilibre_base_url") or JUDILIBRE_PRODUCTION_BASE_URL),
            oauth_token_url=_optional_string(settings.get("judilibre_oauth_token_url")),
            policy_allows_network=_as_bool(settings.get("judilibre_enabled", False)),
            dry_run=_as_bool(settings.get("judilibre_dry_run", False)),
            timeout_seconds=float(settings.get("judilibre_timeout_seconds", 20.0)),
            page_size=int(settings.get("judilibre_page_size", 25)),
            history_page_size=int(settings.get("judilibre_history_page_size", 100)),
            max_results=int(settings.get("judilibre_max_results", SEARCH_MAX_RESULTS)),
            retry_policy=RetryPolicy(
                max_retries=int(settings.get("judilibre_max_retries", 4)),
                backoff_seconds=float(settings.get("judilibre_retry_backoff_seconds", 1.0)),
                max_sleep_seconds=float(settings.get("judilibre_retry_max_sleep_seconds", 30.0)),
            ),
            transactional_history_path=str(
                settings.get("judilibre_transactional_history_path") or "/transactionalhistory"
            ),
            user_agent=str(settings.get("user_agent") or "immojudis-data-pipeline/1.0"),
            transport=transport,
            sleep=sleep,
            monotonic=monotonic,
        )

    def __enter__(self) -> JudilibreClient:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def search(self, query: JudilibreSearchQuery | None = None) -> JudilibreSearchPage:
        request = (query or JudilibreSearchQuery()).with_defaults(page_size=self.page_size)
        if request.page * (request.page_size or self.page_size) >= SEARCH_MAX_RESULTS:
            raise ValueError("Judilibre search pages cannot start beyond the 10,000-result window")
        data = self._request_json("GET", "/search", params=request.to_http_params())
        return JudilibreSearchPage.model_validate(data)

    def iter_search(
        self,
        query: JudilibreSearchQuery | None = None,
        *,
        max_results: int | None = None,
    ) -> Iterator[JudilibreSearchResult]:
        template = (query or JudilibreSearchQuery()).with_defaults(page_size=self.page_size)
        limit = min(max_results if max_results is not None else self.max_results, self.max_results, SEARCH_MAX_RESULTS)
        if limit < 1:
            return

        page_index = template.page
        page_size = template.page_size or self.page_size
        emitted = 0
        while emitted < limit and page_index * page_size < SEARCH_MAX_RESULTS:
            page_query = template.model_copy(update={"page": page_index, "page_size": page_size})
            page = self.search(page_query)
            if not page.results:
                break
            for result in page.results:
                if emitted >= limit:
                    return
                yield result
                emitted += 1
            if not page.next_page or emitted >= min(page.total, limit):
                break
            page_index += 1

    def decision(
        self,
        decision_id: str,
        *,
        resolve_references: bool = False,
        query: str | None = None,
        operator: Literal["or", "and", "exact"] | None = None,
    ) -> JudilibreDecision:
        result = self.fetch_decision(
            decision_id,
            resolve_references=resolve_references,
            query=query,
            operator=operator,
        )
        if result.decision is None:
            # A caller that did not supply a validator cannot make safe use of
            # a 304 because it has no prior representation to return.
            raise OfficialSourceHTTPError(
                method="GET",
                endpoint="/decision",
                status_code=result.status_code,
            )
        return result.decision

    def fetch_decision(
        self,
        decision_id: str,
        *,
        resolve_references: bool = False,
        query: str | None = None,
        operator: Literal["or", "and", "exact"] | None = None,
        if_none_match: str | None = None,
        if_modified_since: str | None = None,
    ) -> JudilibreDecisionFetch:
        """Fetch a decision and represent HTTP 304 without parsing a body.

        The ingestion sync currently relies on Judilibre's transactional log,
        so it performs an unconditional fetch after every create/update event.
        This lower-level method is available for callers that persist HTTP
        validators alongside their cached representation.
        """
        if not decision_id.strip():
            raise ValueError("decision_id must not be empty")
        params: dict[str, str] = {
            "id": decision_id.strip(),
            "resolve_references": "true" if resolve_references else "false",
        }
        if query is not None:
            params["query"] = query
        if operator is not None:
            params["operator"] = operator
        conditional_headers: dict[str, str] = {}
        if if_none_match is not None:
            conditional_headers["If-None-Match"] = _conditional_header_value(
                if_none_match,
                field_name="If-None-Match",
            )
        if if_modified_since is not None:
            conditional_headers["If-Modified-Since"] = _conditional_header_value(
                if_modified_since,
                field_name="If-Modified-Since",
            )
        response = self._request_json_response(
            "GET",
            "/decision",
            params=params,
            request_headers=conditional_headers,
            allow_not_modified=True,
        )
        decision = (
            JudilibreDecision.model_validate(response.payload)
            if response.payload is not None
            else None
        )
        return JudilibreDecisionFetch(
            status_code=response.status_code,
            decision=decision,
            etag=response.etag,
            last_modified=response.last_modified,
        )

    def taxonomy(
        self,
        *,
        taxon_id: str | None = None,
        key: str | None = None,
        value: str | None = None,
        context_value: str | None = None,
    ) -> JudilibreTaxonomy:
        params = {
            name: item
            for name, item in {
                "id": taxon_id,
                "key": key,
                "value": value,
                "context_value": context_value,
            }.items()
            if item is not None
        }
        data = self._request_json("GET", "/taxonomy", params=params)
        return JudilibreTaxonomy.model_validate(data)

    def stats(
        self,
        *,
        jurisdiction: str | None = None,
        location: str | None = None,
        date_start: date | None = None,
        date_end: date | None = None,
        particular_interest: bool | None = None,
        keys: str | None = None,
    ) -> JudilibreStats:
        params: dict[str, str] = {}
        for name, item in {
            "jurisdiction": jurisdiction,
            "location": location,
            "date_start": date_start.isoformat() if date_start else None,
            "date_end": date_end.isoformat() if date_end else None,
            "particularInterest": (
                "true" if particular_interest else None if particular_interest is None else "false"
            ),
            "keys": keys,
        }.items():
            if item is not None:
                params[name] = item
        data = self._request_json("GET", "/stats", params=params)
        return JudilibreStats.model_validate(data)

    def transactional_history(
        self,
        cursor: JudilibreHistoryCursor | None = None,
        *,
        since: str | date | datetime | None = None,
        from_id: str | None = None,
        page_size: int | None = None,
    ) -> JudilibreHistoryPage:
        if cursor is not None and any(value is not None for value in (since, from_id, page_size)):
            raise ValueError("pass either a history cursor or explicit history parameters")
        if cursor is None:
            if since is None:
                raise ValueError("since is required when no history cursor is supplied")
            cursor = JudilibreHistoryCursor(
                date=_iso_value(since),
                from_id=from_id,
                page_size=page_size or self.history_page_size,
            )
        data = self._request_json(
            "GET",
            self.transactional_history_path,
            params=cursor.to_http_params(),
        )
        return JudilibreHistoryPage.model_validate(data)

    def iter_transactional_history(
        self,
        cursor: JudilibreHistoryCursor,
        *,
        max_pages: int = 100,
    ) -> Iterator[JudilibreHistoryPage]:
        if max_pages < 1:
            raise ValueError("max_pages must be positive")
        current = cursor
        seen: set[tuple[str, int, str | None]] = set()
        for _ in range(max_pages):
            marker = (current.date, current.page_size, current.from_id)
            if marker in seen:
                raise OfficialSourceConfigurationError("Judilibre returned a repeated history cursor")
            seen.add(marker)
            page = self.transactional_history(current)
            yield page
            following = page.next_cursor(
                base_url=self.base_url,
                history_path=self.transactional_history_path,
                default_page_size=current.page_size,
            )
            if following is None:
                return
            if not _same_history_boundary(following.date, current.date):
                raise OfficialSourceConfigurationError(
                    "Judilibre history cursor changed the synchronization boundary"
                )
            if following.page_size != current.page_size:
                raise OfficialSourceConfigurationError(
                    "Judilibre history cursor changed the requested page size"
                )
            current = following

    def _ensure_ready(self, *, endpoint: str) -> None:
        if not self.policy_allows_network:
            raise OfficialSourceDisabledError(
                "Judilibre network access is disabled until the source policy is approved"
            )
        self.credentials.resolved_mode()
        if self.dry_run:
            raise OfficialSourceDryRun(f"dry-run mode: request not sent (GET {safe_endpoint_name(endpoint)})")

    def _request_json(
        self,
        method: str,
        endpoint: str,
        *,
        params: Mapping[str, Any] | list[tuple[str, Any]] | None = None,
    ) -> Any:
        response = self._request_json_response(method, endpoint, params=params)
        return response.payload

    def _request_json_response(
        self,
        method: str,
        endpoint: str,
        *,
        params: Mapping[str, Any] | list[tuple[str, Any]] | None = None,
        request_headers: Mapping[str, str] | None = None,
        allow_not_modified: bool = False,
    ) -> _JudilibreJSONResponse:
        endpoint = self._validated_endpoint(endpoint)
        self._ensure_ready(endpoint=endpoint)
        url = f"{self.base_url}{endpoint}"
        if not has_exact_origin(url, self.base_url):
            raise OfficialSourceConfigurationError("Judilibre endpoint has an unexpected origin")

        refreshed_after_unauthorized = False
        attempt = 0
        while True:
            headers = self._auth_headers()
            headers.update(request_headers or {})
            try:
                response = self._client.request(method, url, params=params, headers=headers)
            except httpx.TransportError:
                if attempt >= self.retry_policy.max_retries:
                    raise OfficialSourceHTTPError(method=method, endpoint=endpoint) from None
                self._sleep(self._retry_delay(None, attempt))
                attempt += 1
                continue

            if response.status_code in REDIRECT_STATUS_CODES:
                raise OfficialSourceHTTPError(method=method, endpoint=endpoint, status_code=response.status_code)
            if response.status_code == 304:
                if not allow_not_modified:
                    raise OfficialSourceHTTPError(
                        method=method,
                        endpoint=endpoint,
                        status_code=response.status_code,
                    )
                return _JudilibreJSONResponse(
                    status_code=response.status_code,
                    payload=None,
                    etag=response.headers.get("ETag"),
                    last_modified=response.headers.get("Last-Modified"),
                )
            if response.status_code == 401 and self._uses_oauth() and not refreshed_after_unauthorized:
                self._invalidate_access_token()
                refreshed_after_unauthorized = True
                continue
            if self._is_retryable(response.status_code) and attempt < self.retry_policy.max_retries:
                self._sleep(self._retry_delay(response.headers.get("Retry-After"), attempt))
                attempt += 1
                continue
            if response.status_code < 200 or response.status_code >= 300:
                raise OfficialSourceHTTPError(
                    method=method,
                    endpoint=endpoint,
                    status_code=response.status_code,
                )
            try:
                payload = response.json()
            except ValueError:
                raise OfficialSourceHTTPError(
                    method=method,
                    endpoint=endpoint,
                    status_code=response.status_code,
                ) from None
            return _JudilibreJSONResponse(
                status_code=response.status_code,
                payload=payload,
                etag=response.headers.get("ETag"),
                last_modified=response.headers.get("Last-Modified"),
            )

    def _validated_endpoint(self, endpoint: str) -> str:
        allowed = {"/search", "/decision", "/taxonomy", "/stats", self.transactional_history_path}
        if endpoint not in allowed:
            raise OfficialSourceConfigurationError("unsupported Judilibre endpoint")
        return endpoint

    def _auth_headers(self) -> dict[str, str]:
        mode = self.credentials.resolved_mode()
        headers: dict[str, str] = {}
        if mode in {"keyid", "keyid+oauth2"}:
            headers["KeyId"] = str(self.credentials.key_id).strip()
        if mode in {"oauth2", "keyid+oauth2"}:
            headers["Authorization"] = f"Bearer {self._oauth_access_token()}"
        return headers

    def _uses_oauth(self) -> bool:
        return self.credentials.resolved_mode() in {"oauth2", "keyid+oauth2"}

    def _oauth_access_token(self) -> str:
        if self._access_token and self._monotonic() < self._access_token_expires_at:
            return self._access_token

        data: dict[str, str] = {"grant_type": "client_credentials"}
        if self.credentials.oauth_scope:
            data["scope"] = self.credentials.oauth_scope
        auth: httpx.BasicAuth | None = None
        if self.credentials.oauth_client_auth_method == "basic":
            auth = httpx.BasicAuth(
                str(self.credentials.oauth_client_id),
                str(self.credentials.oauth_client_secret),
            )
        else:
            data["client_id"] = str(self.credentials.oauth_client_id)
            data["client_secret"] = str(self.credentials.oauth_client_secret)

        endpoint_name = safe_endpoint_name(self.oauth_token_url)
        attempt = 0
        while True:
            try:
                response = self._client.post(
                    self.oauth_token_url,
                    data=data,
                    auth=auth,
                    headers={"Accept": "application/json"},
                )
            except httpx.TransportError:
                if attempt >= self.retry_policy.max_retries:
                    raise OfficialSourceHTTPError(method="POST", endpoint=endpoint_name) from None
                self._sleep(self._retry_delay(None, attempt))
                attempt += 1
                continue
            if response.status_code in REDIRECT_STATUS_CODES:
                raise OfficialSourceHTTPError(
                    method="POST",
                    endpoint=endpoint_name,
                    status_code=response.status_code,
                )
            if self._is_retryable(response.status_code) and attempt < self.retry_policy.max_retries:
                self._sleep(self._retry_delay(response.headers.get("Retry-After"), attempt))
                attempt += 1
                continue
            if response.status_code < 200 or response.status_code >= 300:
                raise OfficialSourceHTTPError(
                    method="POST",
                    endpoint=endpoint_name,
                    status_code=response.status_code,
                )
            try:
                payload = response.json()
                token = payload["access_token"]
                expires_in = float(payload.get("expires_in", 300))
                token_type = payload.get("token_type", "Bearer")
            except (KeyError, TypeError, ValueError):
                raise OfficialSourceHTTPError(
                    method="POST",
                    endpoint=endpoint_name,
                    status_code=response.status_code,
                ) from None
            if not isinstance(token, str) or not token.strip():
                raise OfficialSourceHTTPError(
                    method="POST",
                    endpoint=endpoint_name,
                    status_code=response.status_code,
                )
            if not isinstance(token_type, str) or token_type.lower() != "bearer":
                raise OfficialSourceHTTPError(
                    method="POST",
                    endpoint=endpoint_name,
                    status_code=response.status_code,
                )
            if not math.isfinite(expires_in) or expires_in <= 0:
                raise OfficialSourceHTTPError(
                    method="POST",
                    endpoint=endpoint_name,
                    status_code=response.status_code,
                )
            self._access_token = token
            self._access_token_expires_at = self._monotonic() + max(0.0, expires_in - 30.0)
            return token

    def _invalidate_access_token(self) -> None:
        self._access_token = None
        self._access_token_expires_at = 0.0

    def _retry_delay(self, retry_after: str | None, retry_number: int) -> float:
        return retry_delay_seconds(
            retry_after=retry_after,
            retry_number=retry_number,
            policy=self.retry_policy,
        )

    @staticmethod
    def _is_retryable(status_code: int) -> bool:
        return status_code in RETRYABLE_STATUS_CODES or 500 <= status_code <= 599


def _iso_value(value: str | date | datetime) -> str:
    return value if isinstance(value, str) else value.isoformat()


def _aware_iso_datetime(value: str, *, field_name: str) -> str:
    candidate = value.strip()
    try:
        parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field_name} must include a timezone")
    return candidate


def _same_history_boundary(left: str, right: str) -> bool:
    if left == right:
        return True
    try:
        left_date = date.fromisoformat(left)
        right_date = date.fromisoformat(right)
    except ValueError:
        try:
            left_datetime = datetime.fromisoformat(left.replace("Z", "+00:00"))
            right_datetime = datetime.fromisoformat(right.replace("Z", "+00:00"))
        except ValueError:
            return False
        if (
            left_datetime.tzinfo is None
            or left_datetime.utcoffset() is None
            or right_datetime.tzinfo is None
            or right_datetime.utcoffset() is None
        ):
            return False
        return left_datetime == right_datetime
    return left == left_date.isoformat() and right == right_date.isoformat() and left_date == right_date


def _conditional_header_value(value: str, *, field_name: str) -> str:
    candidate = value.strip()
    if not candidate or len(candidate) > 1024 or "\r" in candidate or "\n" in candidate:
        raise OfficialSourceConfigurationError(f"invalid Judilibre {field_name} validator")
    return candidate


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _auth_mode(value: Any) -> AuthMode:
    mode = str(value).strip().lower()
    if mode not in {"auto", "keyid", "oauth2", "keyid+oauth2"}:
        raise OfficialSourceConfigurationError("unsupported Judilibre authentication mode")
    return mode  # type: ignore[return-value]


def _oauth_method(value: Any) -> OAuthClientAuthMethod:
    method = str(value).strip().lower()
    if method not in {"basic", "form"}:
        raise OfficialSourceConfigurationError("unsupported Judilibre OAuth2 client authentication method")
    return method  # type: ignore[return-value]
