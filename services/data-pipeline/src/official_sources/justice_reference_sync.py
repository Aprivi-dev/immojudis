from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import tempfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from src.config import RAW_DIR
from src.court_competence import CourtCompetenceReference
from src.official_sources.justice_open_data import (
    JusticeOpenDataSchemaError,
    parse_justice_competences_csv,
    parse_justice_structures_csv,
    validate_justice_competence_semantics,
)

LOGGER = logging.getLogger(__name__)

DATA_GOUV_ORGANIZATION_ID = "534fff93a3a7292c64a77fa2"
REFERENCE_DIR = RAW_DIR / "outcome_sources" / "justice_courts"
COMPETENCES_FILENAME = "resource-e2a1941b-observed-competences.csv"
STRUCTURES_FILENAME = "2026-domaine-juridique-adresse.csv"
MANIFEST_FILENAME = "justice-reference-manifest.json"
_ALLOWED_DOWNLOAD_HOSTS = {"static.data.gouv.fr", "www.data.gouv.fr"}
_SHA1_RE = re.compile(r"^[0-9a-f]{40}$")


class JusticeReferenceSyncError(RuntimeError):
    """Raised when an official Justice reference cannot be safely refreshed."""


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    api_url: str
    expected_kind: str
    target_filename: str
    minimum_bytes: int
    maximum_bytes: int


@dataclass(frozen=True)
class ResourceCandidate:
    dataset_id: str
    resource_id: str
    title: str
    url: str
    last_modified: str
    expected_bytes: int
    expected_sha1: str | None


@dataclass(frozen=True)
class SyncedResource:
    dataset_id: str
    resource_id: str
    title: str
    url: str
    last_modified: str
    byte_size: int
    sha1: str
    sha256: str
    target_filename: str


COMPETENCES_SPEC = DatasetSpec(
    dataset_id="6392017edf7251532fda4bab",
    api_url=(
        "https://www.data.gouv.fr/api/1/datasets/"
        "liste-des-juridictions-competentes-pour-les-communes-de-france/"
    ),
    expected_kind="justice_court_competence",
    target_filename=COMPETENCES_FILENAME,
    minimum_bytes=2_000_000,
    maximum_bytes=8_000_000,
)
STRUCTURES_SPEC = DatasetSpec(
    dataset_id="5369932fa3a729239d20410c",
    api_url=(
        "https://www.data.gouv.fr/api/1/datasets/"
        "donnees-geocodees-des-structures-de-la-justice-30378257/"
    ),
    expected_kind="justice_court_structure",
    target_filename=STRUCTURES_FILENAME,
    minimum_bytes=100_000,
    maximum_bytes=2_000_000,
)
DATASET_SPECS = (COMPETENCES_SPEC, STRUCTURES_SPEC)


def sync_justice_references(
    output_dir: str | Path = REFERENCE_DIR,
    *,
    client: httpx.Client | None = None,
    allow_verified_cache: bool = True,
) -> dict[str, Any]:
    """Refresh both Ministry references and install them only after validation.

    data.gouv.fr occasionally retains several main resources, and one resource
    has previously been published on the wrong dataset page. Selection is thus
    based on the expected byte range *and* the detected Justice CSV schema.
    """

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    owned_client = client is None
    http_client = client or httpx.Client(
        follow_redirects=True,
        timeout=httpx.Timeout(45.0, connect=15.0),
        headers={"User-Agent": "immojudis-justice-reference-sync/1.0"},
        transport=httpx.HTTPTransport(retries=3),
    )

    try:
        with tempfile.TemporaryDirectory(prefix="justice-reference-", dir=destination.parent) as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            synced: dict[str, SyncedResource] = {}
            try:
                for spec in DATASET_SPECS:
                    metadata = _fetch_dataset_metadata(http_client, spec)
                    artifact = _download_expected_resource(http_client, spec, metadata, temp_dir)
                    synced[spec.expected_kind] = artifact
                _validate_reference_pair(
                    temp_dir / COMPETENCES_FILENAME,
                    temp_dir / STRUCTURES_FILENAME,
                )
            except (
                httpx.HTTPError,
                OSError,
                ValueError,
                JusticeOpenDataSchemaError,
                JusticeReferenceSyncError,
            ) as exc:
                if allow_verified_cache and _validate_cached_pair(destination):
                    LOGGER.warning(
                        "Official Justice refresh failed; keeping the previously verified cache: %s",
                        exc,
                    )
                    return _cached_manifest(destination, refresh_error=str(exc))
                raise JusticeReferenceSyncError(
                    f"official Justice references could not be refreshed safely: {exc}"
                ) from exc

            for spec in DATASET_SPECS:
                os.replace(temp_dir / spec.target_filename, destination / spec.target_filename)

            manifest = {
                "schema_version": "justice_reference_sync_v1",
                "status": "verified",
                "source_organization_id": DATA_GOUV_ORGANIZATION_ID,
                "synced_at": datetime.now(UTC).isoformat(),
                "cache_fallback": False,
                "resources": {
                    kind: asdict(resource)
                    for kind, resource in sorted(synced.items())
                },
            }
            _atomic_write_json(destination / MANIFEST_FILENAME, manifest)
            return manifest
    finally:
        if owned_client:
            http_client.close()


def _fetch_dataset_metadata(client: httpx.Client, spec: DatasetSpec) -> dict[str, Any]:
    response = client.get(spec.api_url, headers={"Accept": "application/json"})
    response.raise_for_status()
    if len(response.content) > 2_000_000:
        raise JusticeReferenceSyncError("data.gouv.fr dataset metadata is unexpectedly large")
    try:
        metadata = response.json()
    except ValueError as exc:
        raise JusticeReferenceSyncError("data.gouv.fr dataset metadata is not JSON") from exc
    if not isinstance(metadata, dict):
        raise JusticeReferenceSyncError("data.gouv.fr dataset metadata is not an object")
    organization = metadata.get("organization")
    if (
        metadata.get("id") != spec.dataset_id
        or metadata.get("private") is not False
        or not isinstance(organization, dict)
        or organization.get("id") != DATA_GOUV_ORGANIZATION_ID
    ):
        raise JusticeReferenceSyncError("unexpected dataset identity or producer")
    if metadata.get("license") not in {"lov2", "fr-lo"}:
        raise JusticeReferenceSyncError("official Justice dataset is not under an accepted open licence")
    return metadata


def _download_expected_resource(
    client: httpx.Client,
    spec: DatasetSpec,
    metadata: dict[str, Any],
    temp_dir: Path,
) -> SyncedResource:
    candidates = list(_resource_candidates(spec, metadata.get("resources")))
    if not candidates:
        raise JusticeReferenceSyncError(
            f"no plausible CSV resource found for {spec.expected_kind}"
        )

    failures: list[str] = []
    for index, candidate in enumerate(candidates):
        attempt_path = temp_dir / f".{spec.target_filename}.{index}.part"
        try:
            downloaded = _download_candidate(client, candidate, spec, attempt_path)
            _validate_expected_file(attempt_path, spec.expected_kind)
            os.replace(attempt_path, temp_dir / spec.target_filename)
            return SyncedResource(
                dataset_id=candidate.dataset_id,
                resource_id=candidate.resource_id,
                title=candidate.title,
                url=candidate.url,
                last_modified=candidate.last_modified,
                byte_size=downloaded["byte_size"],
                sha1=downloaded["sha1"],
                sha256=downloaded["sha256"],
                target_filename=spec.target_filename,
            )
        except (
            httpx.HTTPError,
            OSError,
            ValueError,
            JusticeOpenDataSchemaError,
            JusticeReferenceSyncError,
        ) as exc:
            failures.append(f"{candidate.resource_id}: {exc}")
            attempt_path.unlink(missing_ok=True)

    raise JusticeReferenceSyncError(
        f"no {spec.expected_kind} resource passed validation ({'; '.join(failures)})"
    )


def _resource_candidates(
    spec: DatasetSpec,
    resources: object,
) -> Iterable[ResourceCandidate]:
    if not isinstance(resources, list):
        return ()
    candidates: list[ResourceCandidate] = []
    for raw in resources:
        if not isinstance(raw, dict):
            continue
        url = str(raw.get("url") or "").strip()
        parsed_url = urlparse(url)
        try:
            expected_bytes = int(raw.get("filesize") or 0)
        except (TypeError, ValueError):
            continue
        if (
            str(raw.get("format") or "").lower() != "csv"
            or raw.get("type") != "main"
            or parsed_url.scheme != "https"
            or parsed_url.hostname not in _ALLOWED_DOWNLOAD_HOSTS
            or not spec.minimum_bytes <= expected_bytes <= spec.maximum_bytes
        ):
            continue
        resource_id = str(raw.get("id") or "").strip()
        if not resource_id:
            continue
        candidates.append(
            ResourceCandidate(
                dataset_id=spec.dataset_id,
                resource_id=resource_id,
                title=str(raw.get("title") or resource_id).strip(),
                url=url,
                last_modified=str(raw.get("last_modified") or raw.get("created_at") or ""),
                expected_bytes=expected_bytes,
                expected_sha1=_metadata_sha1(raw),
            )
        )
    return tuple(sorted(candidates, key=lambda value: value.last_modified, reverse=True))


def _metadata_sha1(resource: dict[str, Any]) -> str | None:
    checksum = resource.get("checksum")
    if isinstance(checksum, dict) and checksum.get("type") == "sha1":
        value = str(checksum.get("value") or "").lower()
        if _SHA1_RE.fullmatch(value):
            return value
    extras = resource.get("extras")
    if isinstance(extras, dict):
        value = str(extras.get("analysis:checksum") or "").lower()
        if _SHA1_RE.fullmatch(value):
            return value
    return None


def _download_candidate(
    client: httpx.Client,
    candidate: ResourceCandidate,
    spec: DatasetSpec,
    target: Path,
) -> dict[str, Any]:
    sha1 = hashlib.sha1(usedforsecurity=False)
    sha256 = hashlib.sha256()
    byte_size = 0
    with client.stream("GET", candidate.url, headers={"Accept": "text/csv,*/*;q=0.1"}) as response:
        response.raise_for_status()
        final_url = urlparse(str(response.url))
        if final_url.scheme != "https" or final_url.hostname not in _ALLOWED_DOWNLOAD_HOSTS:
            raise JusticeReferenceSyncError("resource redirected outside data.gouv.fr")
        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > spec.maximum_bytes:
            raise JusticeReferenceSyncError("resource exceeds the configured byte limit")
        with target.open("wb") as handle:
            for chunk in response.iter_bytes():
                byte_size += len(chunk)
                if byte_size > spec.maximum_bytes:
                    raise JusticeReferenceSyncError("resource exceeds the configured byte limit")
                sha1.update(chunk)
                sha256.update(chunk)
                handle.write(chunk)

    if byte_size < spec.minimum_bytes:
        raise JusticeReferenceSyncError("resource is smaller than the expected official export")
    if candidate.expected_bytes and byte_size != candidate.expected_bytes:
        raise JusticeReferenceSyncError(
            f"resource byte size differs from metadata ({byte_size} != {candidate.expected_bytes})"
        )
    observed_sha1 = sha1.hexdigest()
    if candidate.expected_sha1 and observed_sha1 != candidate.expected_sha1:
        raise JusticeReferenceSyncError("resource SHA-1 differs from data.gouv.fr metadata")
    return {
        "byte_size": byte_size,
        "sha1": observed_sha1,
        "sha256": sha256.hexdigest(),
    }


def _validate_expected_file(path: Path, expected_kind: str) -> None:
    if expected_kind == "justice_court_competence":
        result = parse_justice_competences_csv(path)
        validate_justice_competence_semantics(result)
        return
    if expected_kind == "justice_court_structure":
        result = parse_justice_structures_csv(path)
        tj_count = sum(
            record.get("structure_type_code") == "TGI" for record in result.records
        )
        if (
            result.quality.valid_rows < 1_000
            or result.quality.rejected_rows
            or tj_count < 150
        ):
            raise JusticeOpenDataSchemaError(
                "Justice structure registry is incomplete or contains rejected rows"
            )
        return
    raise JusticeReferenceSyncError(f"unsupported expected dataset kind: {expected_kind}")


def _validate_reference_pair(competences_path: Path, structures_path: Path) -> None:
    _validate_expected_file(competences_path, "justice_court_competence")
    _validate_expected_file(structures_path, "justice_court_structure")
    CourtCompetenceReference(competences_path, structures_path)


def _validate_cached_pair(destination: Path) -> bool:
    try:
        _validate_reference_pair(
            destination / COMPETENCES_FILENAME,
            destination / STRUCTURES_FILENAME,
        )
    except (OSError, ValueError, JusticeOpenDataSchemaError):
        return False
    return True


def _cached_manifest(destination: Path, *, refresh_error: str) -> dict[str, Any]:
    manifest_path = destination / MANIFEST_FILENAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {
            "schema_version": "justice_reference_sync_v1",
            "status": "verified",
            "resources": {},
        }
    manifest["cache_fallback"] = True
    manifest["refresh_attempted_at"] = datetime.now(UTC).isoformat()
    manifest["refresh_error"] = refresh_error[:500]
    return manifest


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _main() -> int:
    parser = argparse.ArgumentParser(
        description="Download and verify the official Justice court references."
    )
    parser.add_argument("--output-dir", type=Path, default=REFERENCE_DIR)
    parser.add_argument(
        "--no-cache-fallback",
        action="store_true",
        help="Fail instead of using a previously verified local reference.",
    )
    args = parser.parse_args()
    manifest = sync_justice_references(
        args.output_dir,
        allow_verified_cache=not args.no_cache_fallback,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point.
    raise SystemExit(_main())
