#!/usr/bin/env python3
"""Dry-run or apply the private AI extraction review projection.

The default mode is read-only.  Use ``--apply`` only after the migration and
the printed mapping summary have been reviewed.  Every operation runs in one
PostgreSQL transaction; failed validation or a projection conflict rolls the
transaction back before a write can become visible.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from src.ai_review_import import (  # noqa: E402
    build_ai_review_export_payload,
    build_ai_review_import_plan,
    fetch_existing_case_status_rows,
    fetch_existing_projection_rows,
    fetch_sale_identity_snapshot,
    insert_new_case_status_rows,
    insert_new_projection_rows,
    load_manifest_file,
)
from src.config import load_settings  # noqa: E402
from src.real_extraction_review import write_private_json  # noqa: E402
from src.storage.supabase_client import _postgres_connect  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Private AI review manifest JSON.")
    action = parser.add_mutually_exclusive_group()
    action.add_argument(
        "--apply",
        action="store_true",
        help="Insert the validated pending projection in one transaction.",
    )
    action.add_argument(
        "--dry-run",
        action="store_true",
        help="Read current sale identities and print the plan without writing (default).",
    )
    parser.add_argument(
        "--sales-snapshot",
        type=Path,
        help="Offline JSON array of {id, source_name, source_url}; useful for a local dry-run.",
    )
    parser.add_argument(
        "--export-json",
        type=Path,
        help=(
            "Write sanitized, bounded JSON batches for app_private.import_ai_review_payload "
            "through Supabase MCP; does not require database credentials."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="Projection rows per exported MCP payload (1-500, default: 100).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        manifest, manifest_sha256 = load_manifest_file(args.manifest)
        if args.export_json:
            if args.apply or args.sales_snapshot:
                raise ValueError("--export-json cannot be combined with --apply or --sales-snapshot")
            payload = build_ai_review_export_payload(
                manifest,
                manifest_sha256=manifest_sha256,
                batch_size=args.batch_size,
            )
            write_private_json(args.export_json, payload)
            print(json.dumps({"mode": "export-json", **payload["summary"]}, ensure_ascii=False, sort_keys=True))
            return 0
        if args.sales_snapshot is not None:
            if args.apply:
                raise ValueError("--sales-snapshot is only allowed for a dry-run")
            sales = _load_sales_snapshot(args.sales_snapshot)
            plan = build_ai_review_import_plan(
                manifest,
                sales,
                manifest_sha256=manifest_sha256,
            )
            print(json.dumps({"mode": "dry-run", **plan.summary}, ensure_ascii=False, sort_keys=True))
            return 0

        settings = load_settings()
        db_url = settings.get("supabase_db_url")
        if not db_url:
            raise RuntimeError("SUPABASE_DB_URL is required when --sales-snapshot is not supplied")
        with _postgres_connect(str(db_url)) as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("set transaction read write" if args.apply else "set transaction read only")
                sales = fetch_sale_identity_snapshot(connection)
                existing = fetch_existing_projection_rows(connection, manifest["sample_sha256"])
                existing_cases = fetch_existing_case_status_rows(connection, manifest["sample_sha256"])
                plan = build_ai_review_import_plan(
                    manifest,
                    sales,
                    existing_rows=existing,
                    existing_case_rows=existing_cases,
                    manifest_sha256=manifest_sha256,
                )
                if args.apply:
                    inserted_cases = insert_new_case_status_rows(connection, plan)
                    inserted_rows = insert_new_projection_rows(connection, plan)
                    summary: dict[str, Any] = {
                        "mode": "apply",
                        **plan.summary,
                        "inserted_case_status_rows": inserted_cases,
                        "inserted_projection_rows": inserted_rows,
                    }
                else:
                    summary = {"mode": "dry-run", **plan.summary}
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(
            f"AI review projection import failed: {_safe_error_message(exc, args.manifest, args.export_json)}",
            file=sys.stderr,
        )
        return 2


def _load_sales_snapshot(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("sales snapshot must be valid UTF-8 JSON") from exc
    if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
        raise ValueError("sales snapshot must be an array of objects")
    return payload


def _safe_error_message(error: BaseException, *private_paths: Path | None) -> str:
    message = str(error)
    for path in private_paths:
        if path is not None:
            message = message.replace(str(path), "<private-artifact>")
    return re.sub(r"(?i)(?:postgres(?:ql)?://)\S+", "<database-connection-redacted>", message)


if __name__ == "__main__":
    raise SystemExit(main())
