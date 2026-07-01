from __future__ import annotations

import sys
from pathlib import Path

import psycopg

from src.config import ROOT_DIR, load_settings


def apply_schema(schema_path: Path | None = None) -> None:
    settings = load_settings()
    db_url = settings["supabase_db_url"]
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL is missing from .env")

    schema_sql = (schema_path or ROOT_DIR / "sql" / "schema.sql").read_text(encoding="utf-8")
    with psycopg.connect(str(db_url)) as connection:
        with connection.cursor() as cursor:
            cursor.execute(schema_sql)
        connection.commit()


def main() -> int:
    try:
        apply_schema()
    except Exception as exc:
        print(f"Supabase schema setup failed: {exc}", file=sys.stderr)
        return 1
    print("Supabase schema setup completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
