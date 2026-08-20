from __future__ import annotations

import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from src.config import RAW_DIR
from src.models import AuctionSale
from src.official_sources.justice_open_data import (
    JUSTICE_COMPETENCES_DATASET_URL,
    JusticeOpenDataSchemaError,
    parse_justice_competences_csv,
    parse_justice_structures_csv,
    validate_justice_competence_semantics,
)

LOGGER = logging.getLogger(__name__)
COURT_ASSIGNMENT_SCHEMA_VERSION = "justice_competent_court_assignment_v1"
COURT_ASSIGNMENT_METHOD = "justice_competence_insee_exact"
_INSEE_CODE_RE = re.compile(r"^(?:\d{5}|2[AB]\d{3})$")

_DEFAULT_COMPETENCES_PATH = (
    RAW_DIR / "outcome_sources" / "justice_courts" / "resource-e2a1941b-observed-competences.csv"
)
_DEFAULT_STRUCTURES_PATH = RAW_DIR / "outcome_sources" / "justice_courts" / "2026-domaine-juridique-adresse.csv"

# Preserve the application codes already referenced by filters, lawyers and
# historical rows. Every other court receives a stable Ministry-SRJ code.
_LEGACY_CODE_BY_COURT = {
    "tribunal judiciaire de agen": "agen",
    "tribunal judiciaire d agen": "agen",
    "tribunal judiciaire de bayonne": "bayonne",
    "tribunal judiciaire de bergerac": "bergerac",
    "tribunal judiciaire de bordeaux": "bordeaux",
    "tribunal judiciaire de dax": "dax",
    "tribunal judiciaire de libourne": "libourne",
    "tribunal judiciaire de marmande": "marmande",
    "tribunal judiciaire de mont de marsan": "mont_de_marsan",
    "tribunal judiciaire de pau": "pau",
    "tribunal judiciaire de perigueux": "perigueux",
}


@dataclass(frozen=True)
class CompetentCourtAssignment:
    insee_code: str
    commune_name: str
    court_code: str
    court_name: str
    official_court_name: str
    court_origin_code: str
    court_srj_code: str
    court_department: str
    court_city: str
    reference_sha256: str
    court_address: str = ""
    court_postal_code: str = ""
    court_phone: str | None = None
    court_email: str | None = None

    def evidence(self) -> dict[str, object]:
        return {
            "schema_version": COURT_ASSIGNMENT_SCHEMA_VERSION,
            "status": "verified",
            "mapping_method": COURT_ASSIGNMENT_METHOD,
            "insee_code": self.insee_code,
            "commune_name": self.commune_name,
            "court_code": self.court_code,
            "court_name": self.court_name,
            "official_court_name": self.official_court_name,
            "court_origin_code": self.court_origin_code,
            "court_srj_code": self.court_srj_code,
            "court_department": self.court_department,
            "court_city": self.court_city,
            "court_address": self.court_address,
            "court_postal_code": self.court_postal_code,
            "court_phone": self.court_phone,
            "court_email": self.court_email,
            "reference_sha256": self.reference_sha256,
            "source_name": "justice_open_data",
            "source_url": JUSTICE_COMPETENCES_DATASET_URL,
        }

    def tribunal_reference_row(self) -> dict[str, object]:
        return {
            "code": self.court_code,
            "canonical_name": self.court_name,
            "department": self.court_department,
            "city": self.court_city,
            "aliases": [self.official_court_name, self.court_name],
        }


class CourtCompetenceReference:
    def __init__(
        self,
        competences_path: str | Path,
        structures_path: str | Path,
    ) -> None:
        competences = parse_justice_competences_csv(competences_path)
        validate_justice_competence_semantics(competences)
        structures = parse_justice_structures_csv(structures_path)

        structure_by_reference = {
            (str(row["origin_code"]), str(row["srj_code"])): row
            for row in structures.records
            if row.get("structure_type_code") == "TGI"
        }
        assignments: dict[str, CompetentCourtAssignment] = {}
        for row in competences.records:
            reference = (str(row["tj_origin_code"]), str(row["tj_srj_code"]))
            structure = structure_by_reference.get(reference)
            if structure is None or not _court_names_compatible(structure.get("name"), row.get("tj_name")):
                raise JusticeOpenDataSchemaError(
                    "territorial competence court does not match the Justice structure registry"
                )

            insee_code = str(row["insee_code"]).upper()
            official_name = str(row["tj_name"])
            court_name = _short_court_name(official_name)
            court_code = _LEGACY_CODE_BY_COURT.get(
                _fingerprint(official_name),
                f"justice_tj_{reference[0]}_{reference[1]}",
            )
            assignments[insee_code] = CompetentCourtAssignment(
                insee_code=insee_code,
                commune_name=str(row["commune_name"]),
                court_code=court_code,
                court_name=court_name,
                official_court_name=official_name,
                court_origin_code=reference[0],
                court_srj_code=reference[1],
                court_department=_department_from_insee(str(structure["insee_code"])),
                court_city=_court_city(official_name, str(structure.get("routing_line") or "")),
                reference_sha256=str(row["canonical_hash"]),
                court_address=str(structure.get("full_address") or ""),
                court_postal_code=str(structure.get("postal_code") or ""),
                court_phone=str(structure["phone"]) if structure.get("phone") else None,
                court_email=str(structure["email"]) if structure.get("email") else None,
            )
        self._assignments = assignments

    def resolve(self, insee_code: str) -> CompetentCourtAssignment | None:
        cleaned = insee_code.strip().upper()
        if not _INSEE_CODE_RE.fullmatch(cleaned):
            return None
        return self._assignments.get(cleaned)


def resolve_competent_court(sale: AuctionSale) -> CompetentCourtAssignment | None:
    insee_code = verified_sale_insee_code(sale)
    if insee_code is None:
        return None
    try:
        reference = _load_reference(
            str(os.getenv("JUSTICE_COMPETENCES_PATH") or _DEFAULT_COMPETENCES_PATH),
            str(os.getenv("JUSTICE_STRUCTURES_PATH") or _DEFAULT_STRUCTURES_PATH),
        )
    except (OSError, JusticeOpenDataSchemaError) as exc:
        LOGGER.error("Official competent-court reference is unavailable: %s", exc)
        return None
    return reference.resolve(insee_code)


def verified_sale_insee_code(sale: AuctionSale) -> str | None:
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    geocode = raw_payload.get("geocode")
    if not isinstance(geocode, dict):
        return None
    if geocode.get("provider") != "ban_geoplateforme" or geocode.get("accepted") is not True:
        return None
    citycode = str(geocode.get("citycode") or "").strip().upper()
    return citycode if _INSEE_CODE_RE.fullmatch(citycode) else None


def tribunal_reference_rows(sales: list[AuctionSale]) -> list[dict[str, object]]:
    rows: dict[str, dict[str, object]] = {}
    for sale in sales:
        assignment = sale.raw_payload.get("tribunal_assignment") if isinstance(sale.raw_payload, dict) else None
        if not _valid_assignment_evidence(assignment):
            continue
        code = str(assignment["court_code"])
        rows[code] = {
            "code": code,
            "canonical_name": str(assignment["court_name"]),
            "department": str(assignment["court_department"]),
            "city": str(assignment["court_city"]),
            "aliases": [
                str(assignment["official_court_name"]),
                str(assignment["court_name"]),
            ],
        }
    return [rows[code] for code in sorted(rows)]


def _valid_assignment_evidence(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    required_text = (
        "insee_code",
        "commune_name",
        "court_code",
        "court_name",
        "official_court_name",
        "court_origin_code",
        "court_srj_code",
        "court_department",
        "court_city",
        "reference_sha256",
    )
    return (
        value.get("schema_version") == COURT_ASSIGNMENT_SCHEMA_VERSION
        and value.get("status") == "verified"
        and value.get("mapping_method") == COURT_ASSIGNMENT_METHOD
        and value.get("source_name") == "justice_open_data"
        and value.get("source_url") == JUSTICE_COMPETENCES_DATASET_URL
        and all(isinstance(value.get(key), str) and value[key].strip() for key in required_text)
        and bool(_INSEE_CODE_RE.fullmatch(str(value["insee_code"]).upper()))
        and bool(re.fullmatch(r"\d+", str(value["court_origin_code"])))
        and bool(re.fullmatch(r"\d+", str(value["court_srj_code"])))
        and bool(re.fullmatch(r"[0-9a-f]{64}", str(value["reference_sha256"])))
    )


@lru_cache(maxsize=4)
def _load_reference(competences_path: str, structures_path: str) -> CourtCompetenceReference:
    return CourtCompetenceReference(competences_path, structures_path)


def _short_court_name(official_name: str) -> str:
    suffix = re.sub(
        r"^tribunal\s+judiciaire\s+(?:de\s+|d['’])",
        "",
        official_name,
        flags=re.IGNORECASE,
    ).strip()
    return f"TJ {suffix}" if suffix else official_name


def _court_city(official_name: str, routing_line: str) -> str:
    short_name = _short_court_name(official_name)
    if short_name.startswith("TJ "):
        return short_name[3:]
    return routing_line.strip().title()


def _department_from_insee(insee_code: str) -> str:
    cleaned = insee_code.strip().upper()
    if cleaned.startswith(("97", "98")):
        return cleaned[:3]
    if cleaned.startswith("2A") or cleaned.startswith("2B"):
        return cleaned[:2]
    return cleaned[:2]


def _fingerprint(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.lower()).strip()


def _court_names_compatible(left: object, right: object) -> bool:
    left_fp = _fingerprint(left)
    right_fp = _fingerprint(right)
    if left_fp == right_fp:
        return True
    # The May 2026 structures file abbreviates the Saint-Denis court while the
    # July 2026 competence file adds the territorial suffix. The shared SRJ
    # identifiers remain exact and authoritative.
    reunion_aliases = {
        "tribunal judiciaire de saint denis",
        "tribunal judiciaire de saint denis de la reunion",
    }
    return {left_fp, right_fp} == reunion_aliases
