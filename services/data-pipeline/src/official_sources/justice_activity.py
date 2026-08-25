from __future__ import annotations

import hashlib
import re
import time
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Literal

import httpx

from src.official_sources.base import canonical_sha256, has_exact_origin, safe_endpoint_name

STATJUR_INDEX_URL = "https://www.stats.justice.gouv.fr/statjur/html/index.php"
STATJUR_ENDPOINT_URL = "https://www.stats.justice.gouv.fr/statjur/html/ajaxService.php"
STATJUR_TABLE_ID = "5"
STATJUR_TABLE_TYPE = "T1"
PARSER_VERSION = "justice_statjur_tgi_activity_v1"
_EXPECTED_CELL_COUNT = 72
_NEW_SALES_SEIZURES_INDEX = 12
_TERMINATED_SALES_SEIZURES_INDEX = 34
_MAX_RESPONSE_BYTES = 2_000_000
_SOURCE_CODE_RE = re.compile(r"^\d{8}$")
_SOURCE_VERSION_RE = re.compile(r"\bv\d{2}\.\d{2}\.\d+\b", re.IGNORECASE)
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")


class JusticeActivitySourceError(RuntimeError):
    """Raised when StatJur cannot be read without weakening source validation."""


class JusticeActivitySchemaError(ValueError):
    """Raised when the official table no longer matches the reviewed schema."""


MetricStatus = Literal["observed", "suppressed", "missing"]


@dataclass(frozen=True)
class JusticeActivityMetric:
    status: MetricStatus
    value: int | None


@dataclass(frozen=True)
class JusticeJurisdictionActivityRecord:
    source_court_code: str
    source_court_name: str
    activity_year: int
    new_sales_seizures: JusticeActivityMetric
    terminated_sales_seizures: JusticeActivityMetric
    canonical_hash: str


@dataclass(frozen=True)
class JusticeActivityParseResult:
    activity_year: int
    source_version: str
    national: JusticeJurisdictionActivityRecord
    records: tuple[JusticeJurisdictionActivityRecord, ...]
    content_hash: str


@dataclass(frozen=True)
class _ParsedRow:
    cells: tuple[str, ...]
    source_code: str | None


class _StatJurTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.header_cells: list[str] = []
        self.rows: list[_ParsedRow] = []
        self._section: str | None = None
        self._row_cells: list[str] | None = None
        self._cell_parts: list[str] | None = None
        self._row_code: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        if lowered in {"thead", "tbody"}:
            self._section = lowered
        elif lowered == "tr" and self._section == "tbody":
            self._row_cells = []
            self._row_code = None
        elif lowered in {"td", "th"} and self._section in {"thead", "tbody"}:
            self._cell_parts = []
        elif lowered == "a" and self._row_cells is not None:
            attr_map = {name.lower(): value for name, value in attrs}
            candidate = attr_map.get("i_elst")
            if candidate:
                self._row_code = candidate.strip()

    def handle_data(self, data: str) -> None:
        if self._cell_parts is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered in {"td", "th"} and self._cell_parts is not None:
            value = _clean_text(" ".join(self._cell_parts))
            if self._section == "thead":
                self.header_cells.append(value)
            elif self._row_cells is not None:
                self._row_cells.append(value)
            self._cell_parts = None
        elif lowered == "tr" and self._section == "tbody" and self._row_cells is not None:
            if self._row_cells:
                self.rows.append(_ParsedRow(cells=tuple(self._row_cells), source_code=self._row_code))
            self._row_cells = None
            self._row_code = None
        elif lowered in {"thead", "tbody"}:
            self._section = None


def parse_activity_metric(value: str) -> JusticeActivityMetric:
    cleaned = _clean_text(value)
    if not cleaned:
        return JusticeActivityMetric(status="missing", value=None)
    if cleaned.upper() == "NC":
        return JusticeActivityMetric(status="suppressed", value=None)
    compact = cleaned.replace(" ", "")
    if not compact.isdigit():
        raise JusticeActivitySchemaError(f"unexpected StatJur metric value: {cleaned!r}")
    return JusticeActivityMetric(status="observed", value=int(compact))


def parse_justice_activity_html(
    content: str | bytes,
    *,
    activity_year: int,
    source_version: str,
    require_full_snapshot: bool = True,
) -> JusticeActivityParseResult:
    if activity_year < 1900 or activity_year > 2100:
        raise JusticeActivitySchemaError("activity year is outside the supported range")
    if _SOURCE_VERSION_RE.fullmatch(source_version) is None:
        raise JusticeActivitySchemaError("StatJur source version has an unexpected format")
    raw = content if isinstance(content, bytes) else content.encode("utf-8")
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise JusticeActivitySchemaError("StatJur table is unexpectedly large")
    decoded = raw.decode("utf-8-sig")
    parser = _StatJurTableParser()
    parser.feed(decoded)
    parser.close()

    normalized_headers = [_normalize_label(value) for value in parser.header_cells]
    metric_header = _normalize_label("Ventes, saisies immobilières")
    if normalized_headers.count(metric_header) != 2:
        raise JusticeActivitySchemaError("StatJur sales/seizures columns have changed")
    if not parser.rows:
        raise JusticeActivitySchemaError("StatJur table contains no jurisdiction row")

    records: list[JusticeJurisdictionActivityRecord] = []
    seen_codes: set[str] = set()
    for position, row in enumerate(parser.rows, start=1):
        if len(row.cells) != _EXPECTED_CELL_COUNT:
            raise JusticeActivitySchemaError(
                f"StatJur row {position} has {len(row.cells)} cells; expected {_EXPECTED_CELL_COUNT}"
            )
        source_code = row.source_code or ""
        if not _SOURCE_CODE_RE.fullmatch(source_code):
            raise JusticeActivitySchemaError(f"StatJur row {position} has an invalid jurisdiction code")
        if source_code in seen_codes:
            raise JusticeActivitySchemaError(f"duplicate StatJur jurisdiction code: {source_code}")
        seen_codes.add(source_code)
        court_name = _clean_text(row.cells[0])
        if not court_name:
            raise JusticeActivitySchemaError(f"StatJur row {position} has no jurisdiction name")
        new_metric = parse_activity_metric(row.cells[_NEW_SALES_SEIZURES_INDEX])
        terminated_metric = parse_activity_metric(row.cells[_TERMINATED_SALES_SEIZURES_INDEX])
        canonical_payload = {
            "activity_year": activity_year,
            "new_sales_seizures": {"status": new_metric.status, "value": new_metric.value},
            "source_court_code": source_code,
            "source_court_name": court_name,
            "terminated_sales_seizures": {
                "status": terminated_metric.status,
                "value": terminated_metric.value,
            },
        }
        records.append(
            JusticeJurisdictionActivityRecord(
                source_court_code=source_code,
                source_court_name=court_name,
                activity_year=activity_year,
                new_sales_seizures=new_metric,
                terminated_sales_seizures=terminated_metric,
                canonical_hash=canonical_sha256(canonical_payload),
            )
        )

    national_rows = [record for record in records if record.source_court_code == "00000000"]
    if len(national_rows) != 1:
        raise JusticeActivitySchemaError("StatJur table must contain exactly one France row")
    jurisdiction_rows = tuple(record for record in records if record.source_court_code != "00000000")
    if require_full_snapshot and len(jurisdiction_rows) < 150:
        raise JusticeActivitySchemaError("StatJur table contains too few tribunal rows for a national snapshot")

    return JusticeActivityParseResult(
        activity_year=activity_year,
        source_version=source_version,
        national=national_rows[0],
        records=jurisdiction_rows,
        content_hash=hashlib.sha256(raw).hexdigest(),
    )


def parse_source_version(content: str | bytes) -> str:
    decoded = content.decode("utf-8-sig") if isinstance(content, bytes) else content
    match = _SOURCE_VERSION_RE.search(decoded)
    if not match:
        raise JusticeActivitySchemaError("StatJur source version is missing")
    return match.group(0).lower()


def parse_available_years(content: str | bytes) -> tuple[int, ...]:
    decoded = content.decode("utf-8-sig") if isinstance(content, bytes) else content
    years = sorted({int(value) for value in _YEAR_RE.findall(decoded)})
    if not years or len(years) > 50:
        raise JusticeActivitySchemaError("StatJur period list is missing or unexpectedly large")
    return tuple(years)


class JusticeActivityClient:
    def __init__(
        self,
        *,
        client: httpx.Client | None = None,
        minimum_request_interval_seconds: float = 4.0,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        if minimum_request_interval_seconds < 0:
            raise ValueError("minimum request interval must be non-negative")
        self._owns_client = client is None
        self._client = client or httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={"User-Agent": "immojudis-justice-activity/1.0"},
            transport=httpx.HTTPTransport(retries=3),
        )
        self._minimum_request_interval_seconds = minimum_request_interval_seconds
        self._clock = clock
        self._sleeper = sleeper
        self._last_request_started_at: float | None = None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> JusticeActivityClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def source_version(self) -> str:
        return parse_source_version(self._request("GET", STATJUR_INDEX_URL).content)

    def available_years(self) -> tuple[int, ...]:
        response = self._request(
            "POST",
            STATJUR_ENDPOINT_URL,
            data={"demande": "lst_priod", "typtab": STATJUR_TABLE_TYPE, "id_tableau": STATJUR_TABLE_ID},
        )
        return parse_available_years(response.content)

    def fetch_year(
        self,
        activity_year: int,
        *,
        source_version: str | None = None,
        available_years: Sequence[int] | None = None,
    ) -> JusticeActivityParseResult:
        available = tuple(available_years) if available_years is not None else self.available_years()
        if activity_year not in available:
            raise JusticeActivitySourceError(f"StatJur does not publish activity year {activity_year}")
        version = source_version or self.source_version()
        response = self._request(
            "POST",
            STATJUR_ENDPOINT_URL,
            data={"demande": STATJUR_TABLE_TYPE, "id_tableau": STATJUR_TABLE_ID, "priod": str(activity_year)},
        )
        return parse_justice_activity_html(response.content, activity_year=activity_year, source_version=version)

    def _request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        if not has_exact_origin(url, STATJUR_INDEX_URL):
            raise JusticeActivitySourceError("StatJur request target has an unexpected origin")
        now = self._clock()
        if self._last_request_started_at is not None:
            remaining = self._minimum_request_interval_seconds - (now - self._last_request_started_at)
            if remaining > 0:
                self._sleeper(remaining)
                now = self._clock()
        self._last_request_started_at = now
        try:
            response = self._client.request(method, url, **kwargs)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            endpoint = safe_endpoint_name(url)
            raise JusticeActivitySourceError(f"StatJur request failed: {method.upper()} {endpoint}") from exc
        if not has_exact_origin(str(response.url), STATJUR_INDEX_URL):
            raise JusticeActivitySourceError("StatJur redirected to an unexpected origin")
        if len(response.content) > _MAX_RESPONSE_BYTES:
            raise JusticeActivitySourceError("StatJur response is unexpectedly large")
        return response


def _clean_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).replace("\xa0", " ").split())


def _normalize_label(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", _clean_text(value))
    ascii_value = "".join(character for character in decomposed if not unicodedata.combining(character))
    return re.sub(r"\s+", " ", ascii_value.casefold()).strip()
