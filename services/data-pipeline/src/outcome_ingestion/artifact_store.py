from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

try:
    from storage3.utils import StorageException
    from supabase import create_client
except ModuleNotFoundError:  # pragma: no cover - dry-run/parser installs may omit storage.
    StorageException = None
    create_client = None

OUTCOME_RAW_ARTIFACT_BUCKET = "outcome-raw-artifacts"


class RawArtifactStorageError(RuntimeError):
    """Log-safe storage failure that never contains a service-role credential."""


@dataclass(frozen=True)
class StoredRawArtifact:
    bucket: str
    object_path: str
    content_hash: str
    byte_size: int
    mime_type: str


def raw_artifact_object_path(
    *,
    source_name: str,
    external_record_id: str,
    content_hash: str,
    mime_type: str,
) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", content_hash):
        raise ValueError("content_hash must be a lowercase SHA-256 hex digest")
    source_slug = re.sub(r"[^a-z0-9]+", "-", source_name.casefold()).strip("-")
    if not source_slug:
        raise ValueError("source_name must contain a safe path segment")
    identity_hash = hashlib.sha256(external_record_id.encode("utf-8")).hexdigest()[:32]
    extension = {
        "application/json": "json",
        "text/csv": "csv",
        "text/plain": "txt",
        "application/pdf": "pdf",
    }.get(mime_type.casefold(), "bin")
    return f"{source_slug}/{identity_hash}/{content_hash}.{extension}"


class SupabaseRawArtifactStore:
    def __init__(
        self,
        client: Any,
        *,
        bucket: str = OUTCOME_RAW_ARTIFACT_BUCKET,
    ) -> None:
        self._client = client
        self.bucket = bucket

    @classmethod
    def from_settings(
        cls,
        settings: Mapping[str, Any],
        *,
        client_factory: Callable[[str, str], Any] | None = None,
        bucket: str = OUTCOME_RAW_ARTIFACT_BUCKET,
    ) -> SupabaseRawArtifactStore:
        url = str(settings.get("supabase_url") or "").strip()
        service_role_key = str(settings.get("supabase_service_role_key") or "").strip()
        if not url or not service_role_key:
            raise RawArtifactStorageError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for private artifact storage"
            )
        factory = client_factory or create_client
        if factory is None:
            raise RawArtifactStorageError("the Supabase Python client is required for artifact storage")
        return cls(factory(url, service_role_key), bucket=bucket)

    def put_bytes(
        self,
        *,
        source_name: str,
        external_record_id: str,
        payload: bytes,
        mime_type: str,
    ) -> StoredRawArtifact:
        content_hash = hashlib.sha256(payload).hexdigest()
        object_path = raw_artifact_object_path(
            source_name=source_name,
            external_record_id=external_record_id,
            content_hash=content_hash,
            mime_type=mime_type,
        )
        try:
            self._client.storage.from_(self.bucket).upload(
                path=object_path,
                file=payload,
                file_options={
                    "cache-control": "31536000",
                    "content-type": mime_type,
                    "upsert": "false",
                },
            )
        except Exception as exc:
            if not _is_duplicate_storage_error(exc):
                raise RawArtifactStorageError("private raw artifact upload failed") from None
        return StoredRawArtifact(
            bucket=self.bucket,
            object_path=object_path,
            content_hash=content_hash,
            byte_size=len(payload),
            mime_type=mime_type,
        )


def _is_duplicate_storage_error(error: Exception) -> bool:
    if StorageException is not None and not isinstance(error, StorageException):
        return False
    if not error.args or not isinstance(error.args[0], dict):
        return False
    details = error.args[0]
    status = details.get("statusCode")
    label = " ".join(str(details.get(key) or "") for key in ("error", "message", "code"))
    return status in {400, 409} and "duplicate" in label.casefold()
