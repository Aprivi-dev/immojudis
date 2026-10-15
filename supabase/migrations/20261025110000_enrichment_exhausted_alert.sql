begin;

set local lock_timeout = '5s';

-- 20261022100000_enrichment_stalled_excludes_exhausted.sql took the failed jobs that
-- used all of their attempts (attempt_count >= max_attempts) out of
-- pipeline.enrichment.stalled, because such a dead letter is never claimed again and
-- could only keep that alert open for ever.  They were then only counted in
-- evidence.exhausted, with no alert: a source or a document type that starts to fail
-- for good would go unnoticed.
--
-- This migration adds a separate warning, pipeline.enrichment.exhausted.  It is
-- active when either
--   * at least 3 jobs became exhausted during the last 24 hours (a rise: for a failed
--     job, updated_at is the time of its last, final attempt), or
--   * at least 50 exhausted jobs are waiting for a manual decision (a backlog of dead
--     letters nobody handled).
-- The rise closes by itself 24 hours after the last new dead letter (plus the two-hour
-- hysteresis of app_private.sync_operational_alert); the backlog closes once the jobs
-- are requeued or cancelled.  Manual handling: docs/runbooks/pipeline-autonomy-progress.md,
-- section "Jobs d'enrichissement épuisés".
--
-- In-place body patch of the latest observe_autonomous_pipeline(timestamptz)
-- definition, like 20261022100000_enrichment_stalled_excludes_exhausted.sql:
-- idempotent (an observer that already raises the exhausted alert is a no-op) and it
-- refuses an unexpected body instead of guessing.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  old_declare constant text := $old_declare$  excluded_due integer;
  exhausted integer;
$old_declare$;
  new_declare constant text := $new_declare$  excluded_due integer;
  exhausted integer;
  exhausted_recent integer;
$new_declare$;
  old_select constant text := $old_select$         count(*) filter (where status = 'failed' and attempt_count >= max_attempts)
    into backlog, delayed, exhausted
$old_select$;
  new_select constant text := $new_select$         count(*) filter (where status = 'failed' and attempt_count >= max_attempts),
         count(*) filter (
           where status = 'failed'
             and attempt_count >= max_attempts
             and updated_at >= p_now - interval '24 hours'
         )
    into backlog, delayed, exhausted, exhausted_recent
$new_select$;
  old_evidence constant text := $old_evidence$    'exhausted', exhausted,
$old_evidence$;
  new_evidence constant text := $new_evidence$    'exhausted', exhausted,
    'exhausted_24h', exhausted_recent,
$new_evidence$;
  old_alert constant text := $old_alert$    delayed > 0,
    p_now
  );$old_alert$;
  new_alert constant text := $new_alert$    delayed > 0,
    p_now
  );
  -- Dead letters (failed, every attempt used) are never claimed again: they are
  -- reported apart from pipeline.enrichment.stalled, on a rise or a backlog.
  perform app_private.sync_operational_alert(
    'pipeline.enrichment.exhausted',
    'import',
    'warning',
    evidence || jsonb_build_object(
      'exhausted_24h_threshold', 3,
      'exhausted_threshold', 50
    ),
    exhausted_recent >= 3 or exhausted >= 50,
    p_now
  );$new_alert$;
  old_declare_count integer;
  old_select_count integer;
  old_evidence_count integer;
  old_alert_count integer;
begin
  -- Already patched (second application, or a database rebuilt with this observer):
  -- nothing to do, and this must not fail the whole migration run.
  if position('pipeline.enrichment.exhausted' in definition) > 0 then
    raise notice 'Enrichment exhausted alert already present; nothing to patch.';
    return;
  end if;

  old_declare_count := (length(definition) - length(replace(definition, old_declare, '')))
    / length(old_declare);
  old_select_count := (length(definition) - length(replace(definition, old_select, '')))
    / length(old_select);
  old_evidence_count := (length(definition) - length(replace(definition, old_evidence, '')))
    / length(old_evidence);
  old_alert_count := (length(definition) - length(replace(definition, old_alert, '')))
    / length(old_alert);

  -- Not the expected queue block (or an ambiguous body): refuse to guess.
  if old_declare_count <> 1 or old_select_count <> 1
     or old_evidence_count <> 1 or old_alert_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected enrichment queue block; refusing exhausted-alert patch.';
  end if;

  definition := replace(definition, old_declare, new_declare);
  definition := replace(definition, old_select, new_select);
  definition := replace(definition, old_evidence, new_evidence);
  definition := replace(definition, old_alert, new_alert);
  if position(new_declare in definition) = 0
     or position(new_select in definition) = 0
     or position(new_evidence in definition) = 0
     or position(new_alert in definition) = 0
     or position('claimable_due' in definition) = 0
     or position('''pipeline.enrichment.stalled''' in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Enrichment exhausted-alert patch did not produce the expected queue block.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

commit;
