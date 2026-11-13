"""Close only this workflow's unfinished run; preserve existing progress."""
from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

from src.config import load_settings
from src.storage.supabase_client import close_open_run, connect

# Alias de compatibilité : des tests patchent ce nom de module.
_postgres_connect = connect


def register_run(run_id: str | None) -> None:
    if run_id and os.getenv('GITHUB_ENV'):
        value = str(UUID(run_id))
        with Path(os.environ['GITHUB_ENV']).open('a') as handle:
            handle.write(f'PIPELINE_CURRENT_RUN_ID={value}\n')


def main() -> int:
    run_id = os.getenv('PIPELINE_CURRENT_RUN_ID')
    # An automatic workflow may have been dispatched more than once after an
    # uncertain GitHub response.  Only the workflow which won the worker CAS
    # writes PIPELINE_CURRENT_RUN_ID; a loser must never finalize that same
    # requested id while another worker is running it.
    if not run_id and os.getenv('REQUESTED_AUTOMATIC', '').lower() == 'true':
        return 0
    run_id = run_id or os.getenv('REQUESTED_RUN_ID')
    if not run_id:
        return 0
    run_id = str(UUID(run_id))
    settings = load_settings()
    if not settings.get('supabase_db_url'):
        raise RuntimeError('Run finalization requires SUPABASE_DB_URL')
    with _postgres_connect(str(settings['supabase_db_url'])) as db:
        close_open_run(
            db,
            run_id,
            'failed',
            {'completion_status': 'interrupted'},
            {'runner': ['Workflow ended without a completed pipeline run; committed checkpoints are preserved']},
        )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
