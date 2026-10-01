begin;

-- A source which is already more than one hour late keeps its collection turn
-- ahead of the enrichment queue.  With several overdue sources, however, that
-- rule can starve the queue for the entire source catch-up pass.  Count
-- scheduler-owned collection claims and give a due queue one bounded turn
-- after three such claims.  The counter is reset by the queue claim itself.
alter table public.auction_pipeline_control
  add column if not exists source_dispatch_streak integer not null default 0;

alter table public.auction_pipeline_control
  drop constraint if exists auction_pipeline_control_source_dispatch_streak_check;

alter table public.auction_pipeline_control
  add constraint auction_pipeline_control_source_dispatch_streak_check
  check (source_dispatch_streak >= 0 and source_dispatch_streak <= 100);

comment on column public.auction_pipeline_control.source_dispatch_streak is
  'Consecutive scheduler-owned collection claims since the last enrichment-queue claim; bounds queue starvation when several sources are overdue.';

create or replace function app_private.pipeline_queue_should_preempt_source(
  p_queue_due boolean,
  p_source_due_at timestamptz,
  p_now timestamptz
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_source_dispatch_streak integer;
begin
  if not coalesce(p_queue_due, false) then
    return false;
  end if;

  -- Keep the one-hour source freshness budget from the original fairness
  -- migration.  A recent source due turn may still be preempted immediately.
  if p_source_due_at is null
     or (p_now is not null and p_source_due_at > p_now - interval '1 hour') then
    return true;
  end if;

  -- Once three overdue collection claims have committed, let the queue make
  -- one bounded turn.  The insert trigger below resets this counter to zero.
  select source_dispatch_streak
    into v_source_dispatch_streak
    from public.auction_pipeline_control
   where id;
  return coalesce(v_source_dispatch_streak, 0) >= 3;
end;
$$;

revoke all on function app_private.pipeline_queue_should_preempt_source(
  boolean, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function app_private.pipeline_queue_should_preempt_source(
  boolean, timestamptz, timestamptz
) to service_role;

create or replace function app_private.track_pipeline_dispatch_lane()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.scheduler_owned and new.status = 'queued' then
    update public.auction_pipeline_control
       set source_dispatch_streak = case
         when new.source = 'enrichment-queue' then 0
         else least(coalesce(source_dispatch_streak, 0) + 1, 100)
       end,
           updated_at = statement_timestamp()
     where id;
  end if;
  return new;
end;
$$;

revoke all on function app_private.track_pipeline_dispatch_lane() from public, anon, authenticated;
grant execute on function app_private.track_pipeline_dispatch_lane() to service_role;

drop trigger if exists auction_runs_track_pipeline_dispatch_lane on public.auction_runs;
create trigger auction_runs_track_pipeline_dispatch_lane
after insert on public.auction_runs
for each row
execute function app_private.track_pipeline_dispatch_lane();

notify pgrst, 'reload schema';

commit;
