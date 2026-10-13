begin;

set local lock_timeout = '5s';

-- The warning pipeline.enrichment.stalled opens as soon as one queued, running
-- or failed enrichment job is older than 24 hours.  A failed job that has used
-- all of its attempts (attempt_count >= max_attempts) is never claimed again,
-- so it can only age: the alert could never close.  Leave those exhausted jobs
-- out of older_than_24h (and so out of the alert condition) and report them
-- separately as evidence.exhausted, so that the dead letters stay visible
-- without keeping the warning open for ever.  backlog stays the raw count of
-- queued, running and failed jobs.  A job that can still be retried (failed with
-- attempts left, queued, running) keeps raising the alert as before.
--
-- In-place body patch of the latest observe_autonomous_pipeline(timestamptz)
-- definition, like 20261020120019_pipeline_missed_alert_threshold_18h.sql:
-- idempotent (an observer that already carries the exhausted counter is a
-- no-op) and it refuses an unexpected body instead of guessing.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  );
  old_declare constant text := $old_declare$  excluded_due integer;
$old_declare$;
  new_declare constant text := $new_declare$  excluded_due integer;
  exhausted integer;
$new_declare$;
  old_queue constant text := $old_queue$  select count(*),
         count(*) filter (where created_at < p_now - interval '24 hours')
    into backlog, delayed
    from public.auction_enrichment_jobs
   where status in ('queued', 'running', 'failed');
  evidence := jsonb_build_object(
    'backlog', backlog,
    'older_than_24h', delayed,
    'claimable_due', claimable_due,
    'excluded_due', excluded_due
  );$old_queue$;
  new_queue constant text := $new_queue$  select count(*),
         count(*) filter (
           where created_at < p_now - interval '24 hours'
             and not (status = 'failed' and attempt_count >= max_attempts)
         ),
         count(*) filter (where status = 'failed' and attempt_count >= max_attempts)
    into backlog, delayed, exhausted
    from public.auction_enrichment_jobs
   where status in ('queued', 'running', 'failed');
  evidence := jsonb_build_object(
    'backlog', backlog,
    'older_than_24h', delayed,
    'exhausted', exhausted,
    'claimable_due', claimable_due,
    'excluded_due', excluded_due
  );$new_queue$;
  old_count integer;
  new_count integer;
  declare_count integer;
begin
  old_count := (length(definition) - length(replace(definition, old_queue, '')))
    / length(old_queue);
  new_count := (length(definition) - length(replace(definition, new_queue, '')))
    / length(new_queue);
  declare_count := (length(definition) - length(replace(definition, old_declare, '')))
    / length(old_declare);

  -- Already patched (second application, or a database rebuilt with this observer):
  -- nothing to do, and this must not fail the whole migration run.
  if old_count = 0 and new_count = 1 then
    raise notice 'Enrichment stalled alert already excludes exhausted jobs; nothing to patch.';
    return;
  end if;

  -- Neither the previous nor the patched queue block, or an ambiguous body: refuse to guess.
  if old_count <> 1 or new_count <> 0 or declare_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected enrichment queue block; refusing exhausted-jobs patch.';
  end if;

  definition := replace(definition, old_queue, new_queue);
  definition := replace(definition, old_declare, new_declare);
  if position(old_queue in definition) > 0
     or position(new_queue in definition) = 0
     or position(new_declare in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Enrichment exhausted-jobs patch did not produce the expected queue block.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.observe_autonomous_pipeline(timestamptz)
  from public, anon, authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz)
  to service_role;

commit;
