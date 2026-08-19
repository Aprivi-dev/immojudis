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
from pathlib import Path
from typing import Any

from .base import canonical_sha256

JUSTICE_COMPETENCES_DATASET_URL = (
    "https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france"
)
JUSTICE_STRUCTURES_DATASET_URL = (
    "https://www.data.gouv.fr/datasets/donnees-geocodees-des-structures-de-la-justice-30378257"
)

COMPETENCE_SCHEMA = (
    "Commune",
    "Libellé Commune",
    "Orig. CA",
    "N° CA",
    "Cour d'Appel compétente",
    "Orig. TJ",
    "N° TJ",
    "Tribunal judiciaire compétent",
    "Orig. TPRX",
    "N° TPRX",
    "Tribunal de proximité compétent",
    "Orig. CPH",
    "N° CPH",
    "Conseil de Prud'hommes compétent",
)

# The July 2026 publication clarified the proximity-court column label without
# changing its meaning. Canonicalize it so historical and current Ministry
# exports share one parser contract.
_COMPETENCE_HEADER_ALIASES = {
    "Tribunal de proximité compétent (hors communes exclusives aux TJ)": (
        "Tribunal de proximité compétent"
    ),
}

# These stable commune/court pairs are deliberately geographically dispersed.
# They catch a real failure mode observed in a structurally valid Ministry CSV
# where the jurisdiction columns were shifted between communes. Schema checks
# and per-row SRJ validation alone cannot detect that semantic corruption.
_COMPETENCE_SEMANTIC_CANARIES = {
    "01187": "Tribunal judiciaire de Bourg-en-Bresse",
    "13201": "Tribunal judiciaire de Marseille",
    "33063": "Tribunal judiciaire de Bordeaux",
    "69381": "Tribunal judiciaire de Lyon",
    "75056": "Tribunal judiciaire de Paris",
}

STRUCTURE_SCHEMA = (
    "TYPE",
    "CODE_INSEE",
    "CODE_ORIG",
    "NUM",
    "NOM_ETABLISSEMENT",
    "NUMÉRO_ET_LIBELLÉ_VOIE",
    "LIEU_DIT",
    "CODE_POSTAL",
    "LIGNE_D_ACHEMINEMENT",
    "PAYS_OU_DÉNOMINATION_TOM_COM",
    "COORDONNÉES_X",
    "COORDONNÉES_Y",
    "NU_TEL",
    "ADRESSE_MAIL",
)

_SCHEMAS = {
    "justice_court_competence": COMPETENCE_SCHEMA,
    "justice_court_structure": STRUCTURE_SCHEMA,
}
_DELIMITERS = (";", ",", "|", "\t")
_INSEE_CODE_RE = re.compile(r"^(?:\d{5}|2[AB]\d{3})$")
_DIGITS_RE = re.compile(r"^\d+$")


class JusticeOpenDataSchemaError(ValueError):
    """Raised when a download is not one of the supported Justice CSV schemas."""


@dataclass(frozen=True)
class DetectedCsvFormat:
    encoding: str
    delimiter: str
    headers: tuple[str, ...]


@dataclass
class ParseQualityStats:
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
class JusticeOpenDataParseResult:
    records: list[dict[str, Any]]
    quality: ParseQualityStats

    @property
    def stats(self) -> ParseQualityStats:
        return self.quality


def parse_justice_open_data_csv(path: str | Path) -> JusticeOpenDataParseResult:
    """Detect and parse either supported Ministry of Justice open-data CSV."""
    csv_path = Path(path)
    text, encoding = _decode_text_file(csv_path)
    dataset_kind, delimiter, headers = _detect_supported_schema(text)
    return _parse_decoded_csv(
        text,
        encoding=encoding,
        delimiter=delimiter,
        headers=headers,
        dataset_kind=dataset_kind,
    )


def parse_justice_competences_csv(path: str | Path) -> JusticeOpenDataParseResult:
    return _parse_expected_csv(Path(path), expected_kind="justice_court_competence")


def parse_justice_structures_csv(path: str | Path) -> JusticeOpenDataParseResult:
    return _parse_expected_csv(Path(path), expected_kind="justice_court_structure")


def validate_justice_competence_semantics(
    result: JusticeOpenDataParseResult,
) -> None:
    """Reject a full territorial reference whose commune mappings are corrupt.

    This validator is intentionally separate from the row parser: unit tests,
    bounded samples and fixtures may contain only a few communes. Production
    ingestion and the competent-court resolver call it on the complete file.
    """

    if result.quality.dataset_kind != "justice_court_competence":
        raise JusticeOpenDataSchemaError(
            "territorial competence semantic validation requires the competence dataset"
        )
    if result.quality.rejected_rows or result.quality.valid_rows < 34_000:
        raise JusticeOpenDataSchemaError(
            "territorial competence reference is incomplete or contains rejected rows"
        )

    court_by_insee = {
        str(record.get("insee_code") or "").upper(): _court_fingerprint(
            record.get("tj_name")
        )
        for record in result.records
    }
    mismatches = [
        insee_code
        for insee_code, expected_court in _COMPETENCE_SEMANTIC_CANARIES.items()
        if court_by_insee.get(insee_code) != _court_fingerprint(expected_court)
    ]
    if mismatches:
        raise JusticeOpenDataSchemaError(
            "territorial competence reference failed semantic canaries: " + ", ".join(mismatches)
        )


def _parse_expected_csv(path: Path, *, expected_kind: str) -> JusticeOpenDataParseResult:
    text, encoding = _decode_text_file(path)
    dataset_kind, delimiter, headers = _detect_supported_schema(text)
    if dataset_kind != expected_kind:
        raise JusticeOpenDataSchemaError(
            f"expected {expected_kind} schema, observed {dataset_kind} schema"
        )
    return _parse_decoded_csv(
        text,
        encoding=encoding,
        delimiter=delimiter,
        headers=headers,
        dataset_kind=dataset_kind,
    )


def _parse_decoded_csv(
    text: str,
    *,
    encoding: str,
    delimiter: str,
    headers: tuple[str, ...],
    dataset_kind: str,
) -> JusticeOpenDataParseResult:
    source_url = (
        JUSTICE_COMPETENCES_DATASET_URL
        if dataset_kind == "justice_court_competence"
        else JUSTICE_STRUCTURES_DATASET_URL
    )
    quality = ParseQualityStats(
        dataset_kind=dataset_kind,
        source_url=source_url,
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
        # The detector permits reordered fields; remap DictReader's keys to their
        # cleaned names before parsing rows.
        if len(observed_headers) != len(headers) or set(observed_headers) != set(headers):
            raise JusticeOpenDataSchemaError("CSV headers changed after schema detection")

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
            if dataset_kind == "justice_court_competence":
                record = _parse_competence_row(row)
            else:
                record = _parse_structure_row(row)
        except ValueError as exc:
            quality.rejected_rows += 1
            _record_anomaly(anomalies, quality, row_number, str(exc))
            continue

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
    return JusticeOpenDataParseResult(records=records, quality=quality)


def _parse_competence_row(row: dict[str, str]) -> dict[str, Any]:
    insee_code = _required_code(row, "Commune", insee=True)
    commune_name = _required_text(row, "Libellé Commune")
    ca_origin = _required_code(row, "Orig. CA")
    ca_srj = _required_code(row, "N° CA")
    ca_name = _required_text(row, "Cour d'Appel compétente")
    tj_origin = _required_code(row, "Orig. TJ")
    tj_srj = _required_code(row, "N° TJ")
    tj_name = _required_text(row, "Tribunal judiciaire compétent")
    cph_origin = _required_code(row, "Orig. CPH")
    cph_srj = _required_code(row, "N° CPH")
    cph_name = _required_text(row, "Conseil de Prud'hommes compétent")

    tprx_values = (
        row["Orig. TPRX"],
        row["N° TPRX"],
        row["Tribunal de proximité compétent"],
    )
    if any(tprx_values) and not all(tprx_values):
        raise ValueError("partial_proximity_court_reference")
    if all(tprx_values):
        tprx_origin = _required_code(row, "Orig. TPRX")
        tprx_srj = _required_code(row, "N° TPRX")
        tprx_name: str | None = _required_text(row, "Tribunal de proximité compétent")
    else:
        tprx_origin = None
        tprx_srj = None
        tprx_name = None

    stable_id = f"justice_open_data:competence:{insee_code}"
    payload: dict[str, Any] = {
        "record_type": "court_competence",
        "stable_id": stable_id,
        "source_name": "justice_open_data",
        "source_url": JUSTICE_COMPETENCES_DATASET_URL,
        "source_grade": "A",
        "insee_code": insee_code,
        "commune_name": commune_name,
        "ca_origin_code": ca_origin,
        "ca_srj_code": ca_srj,
        "ca_name": ca_name,
        "tj_origin_code": tj_origin,
        "tj_srj_code": tj_srj,
        "tj_name": tj_name,
        "tprx_origin_code": tprx_origin,
        "tprx_srj_code": tprx_srj,
        "tprx_name": tprx_name,
        "cph_origin_code": cph_origin,
        "cph_srj_code": cph_srj,
        "cph_name": cph_name,
    }
    payload["canonical_hash"] = canonical_sha256(payload)
    return payload


def _parse_structure_row(row: dict[str, str]) -> dict[str, Any]:
    structure_type = _required_text(row, "TYPE")
    if not re.fullmatch(r"[A-Z]{2,5}", structure_type):
        raise ValueError("invalid_structure_type")
    insee_code = _required_code(row, "CODE_INSEE", insee=True)
    origin_code = _required_code(row, "CODE_ORIG")
    srj_code = _required_code(row, "NUM")
    name = _required_text(row, "NOM_ETABLISSEMENT")
    postal_code = _required_text(row, "CODE_POSTAL")
    if not re.fullmatch(r"\d{5}", postal_code):
        raise ValueError("invalid_postal_code")

    try:
        longitude = float(_required_text(row, "COORDONNÉES_X"))
        latitude = float(_required_text(row, "COORDONNÉES_Y"))
    except ValueError as exc:
        raise ValueError("invalid_coordinates") from exc
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise ValueError("coordinates_out_of_range")

    street = row["NUMÉRO_ET_LIBELLÉ_VOIE"] or None
    locality = row["LIEU_DIT"] or None
    routing_line = row["LIGNE_D_ACHEMINEMENT"] or None
    country_or_territory = row["PAYS_OU_DÉNOMINATION_TOM_COM"] or None
    address_parts = [street, locality, postal_code, routing_line, country_or_territory]
    full_address = ", ".join(value for value in address_parts if value)

    stable_id = f"justice_open_data:structure:{structure_type}:{origin_code}:{srj_code}"
    payload: dict[str, Any] = {
        "record_type": "justice_court_structure",
        "stable_id": stable_id,
        "source_name": "justice_open_data",
        "source_url": JUSTICE_STRUCTURES_DATASET_URL,
        "source_grade": "A",
        "dataset_year": 2026,
        "structure_type_code": structure_type,
        "insee_code": insee_code,
        "origin_code": origin_code,
        "srj_code": srj_code,
        "name": name,
        "street": street,
        "locality": locality,
        "postal_code": postal_code,
        "routing_line": routing_line,
        "country_or_territory": country_or_territory,
        "full_address": full_address,
        "longitude": longitude,
        "latitude": latitude,
        "phone": row["NU_TEL"] or None,
        "email": row["ADRESSE_MAIL"] or None,
    }
    payload["canonical_hash"] = canonical_sha256(payload)
    return payload


def _decode_text_file(path: Path) -> tuple[str, str]:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise JusticeOpenDataSchemaError(f"cannot read CSV file: {path.name}") from exc
    if not payload:
        raise JusticeOpenDataSchemaError("CSV file is empty")
    if b"\x00" in payload and not (
        payload.startswith(codecs.BOM_UTF16_LE) or payload.startswith(codecs.BOM_UTF16_BE)
    ):
        raise JusticeOpenDataSchemaError("CSV file contains binary NUL bytes")

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
            raise JusticeOpenDataSchemaError("download is HTML, not a Justice CSV resource")
        if _has_excessive_controls(text):
            raise JusticeOpenDataSchemaError("CSV file contains unexpected control characters")
        return text, encoding
    raise JusticeOpenDataSchemaError("CSV encoding is neither UTF-8 nor Windows-1252")


def _detect_supported_schema(text: str) -> tuple[str, str, tuple[str, ...]]:
    observed_by_delimiter: dict[str, tuple[str, ...]] = {}
    for delimiter in _DELIMITERS:
        try:
            first_row = next(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))
        except (StopIteration, csv.Error):
            continue
        headers = tuple(_clean_header(value) for value in first_row)
        observed_by_delimiter[delimiter] = headers
        if len(headers) != len(set(headers)):
            continue
        for dataset_kind, expected_headers in _SCHEMAS.items():
            if len(headers) == len(expected_headers) and set(headers) == set(expected_headers):
                return dataset_kind, delimiter, headers

    best_headers = max(observed_by_delimiter.values(), key=len, default=())
    preview = ", ".join(best_headers[:5]) or "<none>"
    raise JusticeOpenDataSchemaError(
        f"unsupported Justice CSV schema; observed headers: {preview}"
    )


def _required_text(row: dict[str, str], key: str) -> str:
    value = row.get(key, "")
    if not value:
        raise ValueError(f"missing_{_field_token(key)}")
    return value


def _required_code(row: dict[str, str], key: str, *, insee: bool = False) -> str:
    value = _required_text(row, key).upper()
    valid = bool(_INSEE_CODE_RE.fullmatch(value)) if insee else bool(_DIGITS_RE.fullmatch(value))
    if not valid:
        raise ValueError(f"invalid_{_field_token(key)}")
    return value


def _record_anomaly(
    anomalies: Counter[str],
    quality: ParseQualityStats,
    row_number: int,
    code: str,
) -> None:
    anomalies[code] += 1
    if len(quality.error_samples) < 20:
        quality.error_samples.append(f"row {row_number}: {code}")


def _field_token(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "_", normalized.lower()).strip("_")


def _clean_header(value: str) -> str:
    cleaned = unicodedata.normalize("NFC", str(value)).strip().lstrip("\ufeff")
    return _COMPETENCE_HEADER_ALIASES.get(cleaned, cleaned)


def _clean_text(value: object) -> str:
    return unicodedata.normalize("NFC", str(value or "")).strip()


def _court_fingerprint(value: object) -> str:
    normalized = unicodedata.normalize("NFKD", _clean_text(value))
    ascii_text = "".join(char for char in normalized if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.lower()).strip()


def _looks_like_html(text: str) -> bool:
    prefix = text.lstrip()[:512].lower()
    return prefix.startswith(("<!doctype html", "<html", "<?xml")) or "<html" in prefix


def _has_excessive_controls(text: str) -> bool:
    if not text:
        return False
    controls = sum(ord(char) < 32 and char not in "\r\n\t" for char in text[:100_000])
    return controls > max(2, len(text[:100_000]) // 1_000)


def _main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Ministry of Justice open-data CSV (dry run).")
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    result = parse_justice_open_data_csv(args.path)
    if result.quality.dataset_kind == "justice_court_competence":
        validate_justice_competence_semantics(result)
    print(json.dumps(result.quality.as_dict(), ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover - convenience dry-run CLI.
    raise SystemExit(_main())
