from __future__ import annotations

import argparse
import codecs
import csv
import io
import json
import re
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .base import canonical_sha256

ENCHERES_PUBLIQUES_DATASET_URL = (
    "https://www.data.gouv.fr/datasets/"
    "distribution-des-prix-de-vente-des-biens-immobiliers-des-tribunaux-judiciaires-francais"
)
ENCHERES_PUBLIQUES_EXPECTED_HOST = "www.encheres-publiques.com"
ENCHERES_PUBLIQUES_SCHEMA = (
    "Date de vente",
    "Organisateur_id",
    "Organisateur_nom",
    "Categorie",
    "Adresse",
    "Url",
)
ENCHERES_PUBLIQUES_COURT_SCHEMA = (
    "ID",
    "Nom",
    "Adresse",
    "Lien vers le Profil",
)
DECLARED_COVERAGE_START_YEAR = 2006
DECLARED_COVERAGE_END_YEAR = 2024

_DELIMITERS = (",", ";", "|", "\t")
_FORBIDDEN_SEMANTIC_HEADERS = {
    "adjudication",
    "adjudication price",
    "montant",
    "outcome",
    "price",
    "prix",
    "prix de vente",
    "resultat",
    "résultat",
}


class EncheresPubliquesSchemaError(ValueError):
    """Raised when the file is not the known candidate-only open-data CSV."""


@dataclass
class EncheresPubliquesQualityStats:
    dataset_kind: str
    source_url: str
    detected_encoding: str
    detected_delimiter: str
    total_rows: int = 0
    valid_rows: int = 0
    rejected_rows: int = 0
    duplicate_rows: int = 0
    null_counts: dict[str, int] = field(default_factory=dict)
    anomaly_counts: dict[str, int] = field(default_factory=dict)
    error_samples: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EncheresPubliquesParseResult:
    records: list[dict[str, Any]]
    quality: EncheresPubliquesQualityStats

    @property
    def stats(self) -> EncheresPubliquesQualityStats:
        return self.quality


@dataclass(frozen=True)
class CourtReferenceJoinResult:
    records: list[dict[str, Any]]
    matched_rows: int
    unmatched_rows: int


def parse_encheres_publiques_csv(path: str | Path) -> EncheresPubliquesParseResult:
    """Parse the published file strictly as hearing candidates, never as outcomes.

    Despite its data.gouv title, the observed six-column file contains no sale
    result and no price. Records from this parser are therefore permanently
    excluded from training and carry only grade-C candidate evidence.
    """
    text, encoding = _decode_text_file(Path(path))
    delimiter, headers = _detect_expected_schema(text)
    return _parse_decoded_csv(text, encoding=encoding, delimiter=delimiter, headers=headers)


def parse_encheres_publiques_hearings_csv(path: str | Path) -> EncheresPubliquesParseResult:
    """Explicit alias for the candidate-only audience parser."""
    return parse_encheres_publiques_csv(path)


def parse_encheres_publiques_courts_csv(path: str | Path) -> EncheresPubliquesParseResult:
    """Parse private organizer profiles as non-canonical court references.

    These rows may support a reviewed name/address match to the Ministry of
    Justice reference, but they must never create or replace an ``outcome_courts``
    row by themselves.
    """
    text, encoding = _decode_text_file(Path(path))
    delimiter, headers = _detect_schema(
        text,
        expected_headers=ENCHERES_PUBLIQUES_COURT_SCHEMA,
        schema_label="Encheres Publiques court-reference",
    )
    quality = EncheresPubliquesQualityStats(
        dataset_kind="court_reference_candidate",
        source_url=ENCHERES_PUBLIQUES_DATASET_URL,
        detected_encoding=encoding,
        detected_delimiter=delimiter,
        null_counts={header: 0 for header in headers},
    )
    anomalies: Counter[str] = Counter()
    records: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()

    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)
    for row_number, raw_row in enumerate(reader, start=2):
        if None in raw_row or any(value is None for value in raw_row.values()):
            quality.total_rows += 1
            quality.rejected_rows += 1
            _record_anomaly(anomalies, quality, row_number, "malformed_column_count")
            continue
        row = {_clean_header(key): _clean_text(value) for key, value in raw_row.items()}
        if not any(row.values()):
            continue

        quality.total_rows += 1
        for header in headers:
            if not row.get(header):
                quality.null_counts[header] += 1
        try:
            record = _parse_court_reference_row(row)
        except ValueError as exc:
            quality.rejected_rows += 1
            _record_anomaly(anomalies, quality, row_number, str(exc))
            continue

        organizer_id = str(record["organizer_source_id"])
        profile_url = str(record["source_url"])
        if organizer_id in seen_ids:
            raise EncheresPubliquesSchemaError(
                f"duplicate organizer ID {organizer_id} at row {row_number}; court join is ambiguous"
            )
        if profile_url in seen_urls:
            raise EncheresPubliquesSchemaError(
                f"duplicate court profile URL at row {row_number}; court join is ambiguous"
            )
        seen_ids.add(organizer_id)
        seen_urls.add(profile_url)
        records.append(record)

    quality.valid_rows = len(records)
    quality.anomaly_counts = dict(sorted(anomalies.items()))
    return EncheresPubliquesParseResult(records=records, quality=quality)


def enrich_hearing_candidates_with_court_references(
    hearings: list[dict[str, Any]],
    court_references: list[dict[str, Any]],
) -> CourtReferenceJoinResult:
    """Attach private court candidates by organizer ID without canonical promotion."""
    by_organizer_id: dict[str, dict[str, Any]] = {}
    for reference in court_references:
        if reference.get("record_type") != "court_reference_candidate":
            raise ValueError("court reference has an unexpected record_type")
        if reference.get("training_eligible") is not False or reference.get("candidate_grade") != "C":
            raise ValueError("court reference is not a grade-C non-training candidate")
        organizer_id = str(reference.get("organizer_source_id") or "")
        if not organizer_id:
            raise ValueError("court reference is missing organizer_source_id")
        if organizer_id in by_organizer_id:
            raise ValueError(f"duplicate court organizer ID in join input: {organizer_id}")
        by_organizer_id[organizer_id] = reference

    enriched_records: list[dict[str, Any]] = []
    matched_rows = 0
    for hearing in hearings:
        if hearing.get("record_type") != "auction_hearing_candidate":
            raise ValueError("hearing has an unexpected record_type")
        enriched = dict(hearing)
        reference = by_organizer_id.get(str(hearing.get("organizer_source_id") or ""))
        if reference is not None:
            matched_rows += 1
            enriched["court_reference_candidate"] = {
                "stable_id": reference["stable_id"],
                "canonical_hash": reference["canonical_hash"],
                "name": reference["name"],
                "address": reference["address"],
                "source_url": reference["source_url"],
                "candidate_grade": "C",
                "official_match_status": "review_required",
            }
            enriched.pop("canonical_hash", None)
            enriched["canonical_hash"] = canonical_sha256(enriched)
        enriched_records.append(enriched)

    return CourtReferenceJoinResult(
        records=enriched_records,
        matched_rows=matched_rows,
        unmatched_rows=len(enriched_records) - matched_rows,
    )


def _parse_decoded_csv(
    text: str,
    *,
    encoding: str,
    delimiter: str,
    headers: tuple[str, ...],
) -> EncheresPubliquesParseResult:
    quality = EncheresPubliquesQualityStats(
        dataset_kind="auction_hearing_candidate",
        source_url=ENCHERES_PUBLIQUES_DATASET_URL,
        detected_encoding=encoding,
        detected_delimiter=delimiter,
        null_counts={header: 0 for header in headers},
    )
    anomalies: Counter[str] = Counter()
    records: list[dict[str, Any]] = []
    seen_hashes_by_id: dict[str, str] = {}

    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)
    observed_headers = tuple(_clean_header(value) for value in (reader.fieldnames or ()))
    if observed_headers != headers:
        if len(observed_headers) != len(headers) or set(observed_headers) != set(headers):
            raise EncheresPubliquesSchemaError("CSV headers changed after schema detection")

    for row_number, raw_row in enumerate(reader, start=2):
        if None in raw_row or any(value is None for value in raw_row.values()):
            quality.total_rows += 1
            quality.rejected_rows += 1
            _record_anomaly(anomalies, quality, row_number, "malformed_column_count")
            continue
        row = {_clean_header(key): _clean_text(value) for key, value in raw_row.items()}
        if not any(row.values()):
            continue

        quality.total_rows += 1
        for header in headers:
            if not row.get(header):
                quality.null_counts[header] += 1

        try:
            record, row_anomalies = _parse_candidate_row(row)
        except ValueError as exc:
            quality.rejected_rows += 1
            _record_anomaly(anomalies, quality, row_number, str(exc))
            continue

        anomalies.update(row_anomalies)
        stable_id = str(record["stable_id"])
        canonical_hash = str(record["canonical_hash"])
        previous_hash = seen_hashes_by_id.get(stable_id)
        if previous_hash is not None:
            quality.duplicate_rows += 1
            if previous_hash != canonical_hash:
                anomalies["conflicting_stable_id"] += 1
            continue

        seen_hashes_by_id[stable_id] = canonical_hash
        records.append(record)

    quality.valid_rows = len(records)
    quality.anomaly_counts = dict(sorted(anomalies.items()))
    return EncheresPubliquesParseResult(records=records, quality=quality)


def _parse_candidate_row(row: dict[str, str]) -> tuple[dict[str, Any], Counter[str]]:
    hearing_at = _parse_utc_datetime(_required(row, "Date de vente"))
    organizer_id = _required(row, "Organisateur_id")
    if not organizer_id.isdigit():
        raise ValueError("invalid_organizer_id")
    organizer_name = _required(row, "Organisateur_nom")
    source_url = _validate_exact_source_url(_required(row, "Url"))

    category = row["Categorie"] or None
    address = row["Adresse"] or None
    anomalies: Counter[str] = Counter()
    quality_flags: list[str] = []
    if hearing_at.year < DECLARED_COVERAGE_START_YEAR:
        anomalies["event_before_declared_coverage"] += 1
        quality_flags.append("event_before_declared_coverage")
    elif hearing_at.year > DECLARED_COVERAGE_END_YEAR:
        anomalies["event_after_declared_coverage"] += 1
        quality_flags.append("event_after_declared_coverage")
    if address is None:
        anomalies["missing_address"] += 1
        quality_flags.append("missing_address")
    if category is None:
        anomalies["missing_category"] += 1
        quality_flags.append("missing_category")

    stable_id = f"encheres_publiques:hearing:{canonical_sha256({'url': source_url})}"
    payload: dict[str, Any] = {
        "record_type": "auction_hearing_candidate",
        "event_type": "auction_hearing_candidate",
        "stable_id": stable_id,
        "source_name": "encheres_publiques_open_data",
        "source_url": source_url,
        "source_dataset_url": ENCHERES_PUBLIQUES_DATASET_URL,
        "source_is_official": False,
        "candidate_only": True,
        "candidate_grade": "C",
        "evidence_grade": "C",
        "training_eligible": False,
        "hearing_at": hearing_at,
        "organizer_source_id": organizer_id,
        "organizer_name": organizer_name,
        "category": category,
        "address": address,
        "quality_flags": quality_flags,
    }
    payload["canonical_hash"] = canonical_sha256(payload)
    return payload, anomalies


def _parse_court_reference_row(row: dict[str, str]) -> dict[str, Any]:
    organizer_id = _required(row, "ID")
    if not organizer_id.isdigit():
        raise ValueError("invalid_organizer_id")
    name = _required(row, "Nom")
    address = _required(row, "Adresse")
    profile_url = _validate_profile_url(_required(row, "Lien vers le Profil"))

    payload: dict[str, Any] = {
        "record_type": "court_reference_candidate",
        "stable_id": f"encheres_publiques:court:{organizer_id}",
        "source_name": "encheres_publiques_open_data",
        "source_url": profile_url,
        "source_dataset_url": ENCHERES_PUBLIQUES_DATASET_URL,
        "source_is_official": False,
        "reference_role": "match_candidate_only",
        "requires_official_match_review": True,
        "candidate_grade": "C",
        "evidence_grade": "C",
        "training_eligible": False,
        "organizer_source_id": organizer_id,
        "name": name,
        "address": address,
    }
    payload["canonical_hash"] = canonical_sha256(payload)
    return payload


def _parse_utc_datetime(value: str) -> datetime:
    candidate = value.strip()
    if candidate.endswith(("Z", "z")):
        candidate = f"{candidate[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError("invalid_hearing_date") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("hearing_date_missing_timezone")
    return parsed.astimezone(UTC)


def _validate_exact_source_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid_source_url") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != ENCHERES_PUBLIQUES_EXPECTED_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or not parsed.path.startswith("/encheres/immobilier/")
        or parsed.fragment
    ):
        raise ValueError("invalid_source_url")
    # Preserve the source evidence URL byte-for-byte after surrounding whitespace
    # has been removed; do not rewrite paths, query strings or casing.
    return value


def _validate_profile_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid_court_profile_url") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != ENCHERES_PUBLIQUES_EXPECTED_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or not parsed.path.startswith("/profils/tribunal/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid_court_profile_url")
    return value


def _decode_text_file(path: Path) -> tuple[str, str]:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise EncheresPubliquesSchemaError(f"cannot read CSV file: {path.name}") from exc
    if not payload:
        raise EncheresPubliquesSchemaError("CSV file is empty")
    if b"\x00" in payload and not (
        payload.startswith(codecs.BOM_UTF16_LE) or payload.startswith(codecs.BOM_UTF16_BE)
    ):
        raise EncheresPubliquesSchemaError("CSV file contains binary NUL bytes")

    if payload.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        candidates = ("utf-16",)
    elif payload.startswith(codecs.BOM_UTF8):
        candidates = ("utf-8-sig",)
    else:
        candidates = ("utf-8", "cp1252")

    for encoding in candidates:
        try:
            text = payload.decode(encoding, errors="strict")
        except UnicodeDecodeError:
            continue
        if _looks_like_html(text):
            raise EncheresPubliquesSchemaError("download is HTML, not the expected CSV resource")
        if _has_excessive_controls(text):
            raise EncheresPubliquesSchemaError("CSV file contains unexpected control characters")
        return text, encoding
    raise EncheresPubliquesSchemaError("CSV encoding is neither UTF-8 nor Windows-1252")


def _detect_expected_schema(text: str) -> tuple[str, tuple[str, ...]]:
    try:
        return _detect_schema(
            text,
            expected_headers=ENCHERES_PUBLIQUES_SCHEMA,
            schema_label="Encheres Publiques hearing-candidate",
        )
    except EncheresPubliquesSchemaError:
        # Emit a sharper error if a future resource unexpectedly starts exposing
        # result or price fields. Such a schema must receive a separate reviewed
        # parser; this candidate parser must never infer those semantics.
        pass

    observed_by_delimiter: dict[str, tuple[str, ...]] = {}
    for delimiter in _DELIMITERS:
        try:
            first_row = next(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))
        except (StopIteration, csv.Error):
            continue
        headers = tuple(_clean_header(value) for value in first_row)
        observed_by_delimiter[delimiter] = headers
        if len(headers) == len(set(headers)) and set(headers) == set(ENCHERES_PUBLIQUES_SCHEMA):
            return delimiter, headers

    best_headers = max(observed_by_delimiter.values(), key=len, default=())
    semantic_headers = {_header_token(header) for header in best_headers}
    if semantic_headers & _FORBIDDEN_SEMANTIC_HEADERS:
        raise EncheresPubliquesSchemaError(
            "observed price/outcome columns do not match the candidate-only schema"
        )
    preview = ", ".join(best_headers[:6]) or "<none>"
    raise EncheresPubliquesSchemaError(
        f"unsupported Encheres Publiques CSV schema; observed headers: {preview}"
    )


def _detect_schema(
    text: str,
    *,
    expected_headers: tuple[str, ...],
    schema_label: str,
) -> tuple[str, tuple[str, ...]]:
    observed_by_delimiter: dict[str, tuple[str, ...]] = {}
    for delimiter in _DELIMITERS:
        try:
            first_row = next(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))
        except (StopIteration, csv.Error):
            continue
        headers = tuple(_clean_header(value) for value in first_row)
        observed_by_delimiter[delimiter] = headers
        if len(headers) == len(set(headers)) and set(headers) == set(expected_headers):
            return delimiter, headers

    best_headers = max(observed_by_delimiter.values(), key=len, default=())
    preview = ", ".join(best_headers[:6]) or "<none>"
    raise EncheresPubliquesSchemaError(
        f"unsupported {schema_label} CSV schema; observed headers: {preview}"
    )


def _required(row: dict[str, str], key: str) -> str:
    value = row.get(key, "")
    if not value:
        raise ValueError(f"missing_{_header_token(key).replace(' ', '_')}")
    return value


def _record_anomaly(
    anomalies: Counter[str],
    quality: EncheresPubliquesQualityStats,
    row_number: int,
    code: str,
) -> None:
    anomalies[code] += 1
    if len(quality.error_samples) < 20:
        quality.error_samples.append(f"row {row_number}: {code}")


def _header_token(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", normalized.strip().lower())


def _clean_header(value: str) -> str:
    return unicodedata.normalize("NFC", str(value)).strip().lstrip("\ufeff")


def _clean_text(value: object) -> str:
    return unicodedata.normalize("NFC", str(value or "")).strip()


def _looks_like_html(text: str) -> bool:
    prefix = text.lstrip()[:512].lower()
    return prefix.startswith(("<!doctype html", "<html", "<?xml")) or "<html" in prefix


def _has_excessive_controls(text: str) -> bool:
    if not text:
        return False
    controls = sum(ord(char) < 32 and char not in "\r\n\t" for char in text[:100_000])
    return controls > max(2, len(text[:100_000]) // 1_000)


def _main() -> int:
    parser = argparse.ArgumentParser(description="Validate Encheres Publiques candidate data (dry run).")
    parser.add_argument("path", type=Path)
    parser.add_argument("--kind", choices=("hearings", "courts"), default="hearings")
    args = parser.parse_args()
    result = (
        parse_encheres_publiques_courts_csv(args.path)
        if args.kind == "courts"
        else parse_encheres_publiques_csv(args.path)
    )
    print(json.dumps(result.quality.as_dict(), ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover - convenience dry-run CLI.
    raise SystemExit(_main())
