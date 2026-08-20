from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import pytest

from src.official_sources import justice_reference_sync as sync


def _dataset_metadata(
    spec: sync.DatasetSpec,
    *,
    resource_url: str,
    payload: bytes,
    last_modified: str = "2026-08-20T10:00:00+00:00",
) -> dict[str, object]:
    return {
        "id": spec.dataset_id,
        "private": False,
        "license": "lov2" if spec is sync.COMPETENCES_SPEC else "fr-lo",
        "organization": {"id": sync.DATA_GOUV_ORGANIZATION_ID},
        "resources": [
            {
                "id": f"resource-{spec.expected_kind}",
                "title": f"{spec.expected_kind}.csv",
                "format": "csv",
                "type": "main",
                "url": resource_url,
                "filesize": len(payload),
                "last_modified": last_modified,
                "checksum": {
                    "type": "sha1",
                    "value": hashlib.sha1(payload, usedforsecurity=False).hexdigest(),
                },
            }
        ],
    }


def test_structure_candidates_ignore_misplaced_large_competence_export() -> None:
    metadata = {
        "resources": [
            {
                "id": "misplaced-competences",
                "title": "competences.csv",
                "format": "csv",
                "type": "main",
                "url": "https://static.data.gouv.fr/competences.csv",
                "filesize": 4_910_649,
                "last_modified": "2026-05-19T17:18:27+00:00",
            },
            {
                "id": "structures",
                "title": "structures.csv",
                "format": "csv",
                "type": "main",
                "url": "https://static.data.gouv.fr/structures.csv",
                "filesize": 206_384,
                "last_modified": "2026-04-16T13:02:47+00:00",
            },
        ]
    }

    candidates = list(sync._resource_candidates(sync.STRUCTURES_SPEC, metadata["resources"]))

    assert [candidate.resource_id for candidate in candidates] == ["structures"]


def test_metadata_requires_the_official_ministry_dataset_identity() -> None:
    spec = sync.COMPETENCES_SPEC

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={
                "id": spec.dataset_id,
                "private": False,
                "license": "lov2",
                "organization": {"id": "untrusted-producer"},
                "resources": [],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(sync.JusticeReferenceSyncError, match="identity or producer"):
            sync._fetch_dataset_metadata(client, spec)


def test_sync_installs_both_files_only_after_pair_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    competence_payload = b"official competences"
    structure_payload = b"official structures"
    competence_url = "https://static.data.gouv.fr/competences.csv"
    structure_url = "https://static.data.gouv.fr/structures.csv"
    competence_spec = sync.DatasetSpec(
        dataset_id=sync.COMPETENCES_SPEC.dataset_id,
        api_url=sync.COMPETENCES_SPEC.api_url,
        expected_kind="justice_court_competence",
        target_filename=sync.COMPETENCES_FILENAME,
        minimum_bytes=1,
        maximum_bytes=1_000,
    )
    structure_spec = sync.DatasetSpec(
        dataset_id=sync.STRUCTURES_SPEC.dataset_id,
        api_url=sync.STRUCTURES_SPEC.api_url,
        expected_kind="justice_court_structure",
        target_filename=sync.STRUCTURES_FILENAME,
        minimum_bytes=1,
        maximum_bytes=1_000,
    )
    metadata = {
        competence_spec.api_url: _dataset_metadata(
            sync.COMPETENCES_SPEC,
            resource_url=competence_url,
            payload=competence_payload,
        ),
        structure_spec.api_url: _dataset_metadata(
            sync.STRUCTURES_SPEC,
            resource_url=structure_url,
            payload=structure_payload,
        ),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url in metadata:
            return httpx.Response(200, request=request, json=metadata[url])
        if url == competence_url:
            return httpx.Response(200, request=request, content=competence_payload)
        if url == structure_url:
            return httpx.Response(200, request=request, content=structure_payload)
        return httpx.Response(404, request=request)

    monkeypatch.setattr(sync, "DATASET_SPECS", (competence_spec, structure_spec))
    monkeypatch.setattr(sync, "_validate_expected_file", lambda *_args: None)

    validated: list[tuple[bytes, bytes]] = []

    def validate_pair(competences: Path, structures: Path) -> None:
        validated.append((competences.read_bytes(), structures.read_bytes()))

    monkeypatch.setattr(sync, "_validate_reference_pair", validate_pair)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        manifest = sync.sync_justice_references(
            tmp_path,
            client=client,
            allow_verified_cache=False,
        )

    assert validated == [(competence_payload, structure_payload)]
    assert (tmp_path / sync.COMPETENCES_FILENAME).read_bytes() == competence_payload
    assert (tmp_path / sync.STRUCTURES_FILENAME).read_bytes() == structure_payload
    assert manifest["status"] == "verified"
    assert manifest["cache_fallback"] is False
    assert (tmp_path / sync.MANIFEST_FILENAME).is_file()


def test_download_rejects_bytes_that_do_not_match_official_checksum(tmp_path: Path) -> None:
    payload = b"tampered"
    candidate = sync.ResourceCandidate(
        dataset_id="dataset",
        resource_id="resource",
        title="resource.csv",
        url="https://static.data.gouv.fr/resource.csv",
        last_modified="2026-08-20T10:00:00+00:00",
        expected_bytes=len(payload),
        expected_sha1="0" * 40,
    )
    spec = sync.DatasetSpec(
        dataset_id="dataset",
        api_url="https://www.data.gouv.fr/api/1/datasets/example/",
        expected_kind="justice_court_structure",
        target_filename="resource.csv",
        minimum_bytes=1,
        maximum_bytes=100,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, content=payload)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(sync.JusticeReferenceSyncError, match="SHA-1"):
            sync._download_candidate(client, candidate, spec, tmp_path / "resource.part")
