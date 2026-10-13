from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
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


def _write_copy(directory: Path, *, age: timedelta) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / sync.COMPETENCES_FILENAME).write_bytes(b"competences")
    (directory / sync.STRUCTURES_FILENAME).write_bytes(b"structures")
    manifest = {
        "schema_version": "justice_reference_sync_v1",
        "status": "verified",
        "synced_at": (datetime.now(UTC) - age).isoformat(),
        "resources": {},
    }
    (directory / sync.MANIFEST_FILENAME).write_text(json.dumps(manifest), encoding="utf-8")


def _offline_client() -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected network access: {request.url}")

    return httpx.Client(transport=httpx.MockTransport(handler))


def _unreachable_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("data.gouv.fr unreachable", request=request)

    return httpx.MockTransport(handler)


def test_recent_valid_copy_skips_the_refresh_without_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_copy(tmp_path, age=timedelta(days=3))
    monkeypatch.setattr(sync, "_validate_reference_pair", lambda *_args: None)

    with _offline_client() as client:
        manifest = sync.sync_justice_references(tmp_path, client=client, max_age_days=7)

    assert manifest["refresh_skipped"] is True
    assert manifest["cache_fallback"] is False
    assert 2.9 < manifest["age_days"] < 3.1


def test_copy_older_than_the_limit_is_refreshed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_copy(tmp_path, age=timedelta(days=8))
    monkeypatch.setattr(sync, "_validate_reference_pair", lambda *_args: None)
    monkeypatch.setattr(sync, "_fetch_dataset_metadata", lambda *_args: {"resources": []})

    with _offline_client() as client:
        manifest = sync.sync_justice_references(tmp_path, client=client, max_age_days=7)

    # The refresh was attempted (no resource found), and the valid old copy is kept.
    assert manifest["cache_fallback"] is True
    assert "refresh_skipped" not in manifest
    assert "no plausible CSV resource" in manifest["refresh_error"]


def test_invalid_recent_copy_is_not_trusted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_copy(tmp_path, age=timedelta(days=1))

    def broken(*_args):
        raise sync.JusticeOpenDataSchemaError("corrupted copy")

    monkeypatch.setattr(sync, "_validate_reference_pair", broken)

    with httpx.Client(transport=_unreachable_transport()) as client:
        with pytest.raises(sync.JusticeReferenceSyncError, match="no valid local copy exists"):
            sync.sync_justice_references(tmp_path, client=client, max_age_days=7)


def test_failed_refresh_with_a_valid_older_copy_is_not_an_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_copy(tmp_path, age=timedelta(days=30))
    monkeypatch.setattr(sync, "_validate_reference_pair", lambda *_args: None)

    with httpx.Client(transport=_unreachable_transport()) as client:
        manifest = sync.sync_justice_references(tmp_path, client=client, max_age_days=7)

    assert manifest["cache_fallback"] is True
    assert "unreachable" in manifest["refresh_error"]


def test_cold_start_with_unreachable_source_fails_with_a_clear_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    class _Client(httpx.Client):
        def __init__(self, **_kwargs: object) -> None:
            super().__init__(transport=_unreachable_transport())

    monkeypatch.setattr(sync.httpx, "Client", _Client)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setattr(
        "sys.argv",
        ["justice_reference_sync", "--output-dir", str(tmp_path), "--max-age-days", "7"],
    )

    assert sync._main() == 1

    error = capsys.readouterr().err
    assert error.startswith("::error title=Justice references unavailable::")
    assert "no valid local copy exists" in error
    assert "unreachable" in error


def test_failed_refresh_is_recorded_and_not_retried_within_six_hours(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_copy(tmp_path, age=timedelta(days=30))
    monkeypatch.setattr(sync, "_validate_reference_pair", lambda *_args: None)

    with httpx.Client(transport=_unreachable_transport()) as client:
        first = sync.sync_justice_references(tmp_path, client=client, max_age_days=7)
    assert first["cache_fallback"] is True and "refresh_skipped" not in first
    recorded = json.loads((tmp_path / sync.MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert recorded["refresh_attempted_at"] and "unreachable" in recorded["refresh_error"]
    assert recorded["synced_at"] == first["synced_at"]

    # The next units reuse the valid copy without any network access.
    with _offline_client() as client:
        second = sync.sync_justice_references(tmp_path, client=client, max_age_days=7)
    assert second["refresh_throttled"] is True and second["cache_fallback"] is True


def test_refresh_is_retried_once_the_throttle_has_elapsed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_copy(tmp_path, age=timedelta(days=30))
    monkeypatch.setattr(sync, "_validate_reference_pair", lambda *_args: None)
    manifest_path = tmp_path / sync.MANIFEST_FILENAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["refresh_attempted_at"] = (datetime.now(UTC) - timedelta(hours=7)).isoformat()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with httpx.Client(transport=_unreachable_transport()) as client:
        retried = sync.sync_justice_references(tmp_path, client=client, max_age_days=7)

    assert "refresh_throttled" not in retried
    assert "unreachable" in retried["refresh_error"]


def test_throttle_is_ignored_without_a_valid_copy_and_without_max_age(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_copy(tmp_path, age=timedelta(days=30))
    manifest_path = tmp_path / sync.MANIFEST_FILENAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["refresh_attempted_at"] = datetime.now(UTC).isoformat()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def broken(*_args):
        raise sync.JusticeOpenDataSchemaError("corrupted copy")

    monkeypatch.setattr(sync, "_validate_reference_pair", broken)
    with httpx.Client(transport=_unreachable_transport()) as client:
        with pytest.raises(sync.JusticeReferenceSyncError, match="no valid local copy exists"):
            sync.sync_justice_references(tmp_path, client=client, max_age_days=7)

    monkeypatch.setattr(sync, "_validate_reference_pair", lambda *_args: None)
    with httpx.Client(transport=_unreachable_transport()) as client:
        without_limit = sync.sync_justice_references(tmp_path, client=client)
    assert "refresh_throttled" not in without_limit


def test_manifest_without_a_usable_date_forces_the_refresh(tmp_path: Path) -> None:
    _write_copy(tmp_path, age=timedelta(days=1))
    max_age = timedelta(days=7)

    (tmp_path / sync.MANIFEST_FILENAME).write_text('{"synced_at": "not a date"}', encoding="utf-8")
    assert sync._fresh_cached_manifest(tmp_path, max_age) is None
    (tmp_path / sync.MANIFEST_FILENAME).write_text("[]", encoding="utf-8")
    assert sync._fresh_cached_manifest(tmp_path, max_age) is None
    (tmp_path / sync.MANIFEST_FILENAME).unlink()
    assert sync._fresh_cached_manifest(tmp_path, max_age) is None
