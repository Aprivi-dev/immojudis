begin;

-- The preceding fairness migration allowed three overdue collection claims
-- before giving a due queue a turn.  That bound is still too wide for a
-- growing queue because each collection run can occupy the single pipeline
-- for many minutes.  Keep one collection turn for an overdue source, then
-- give the due queue the next scheduler turn.  Recent sources retain the
-- existing one-hour freshness rule and an empty/not-yet-due queue never
-- preempts collection.
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

  -- A source inside the one-hour freshness budget may still be preempted
  -- immediately.  A null source means there is no collection turn to protect.
  if p_source_due_at is null
     or (p_now is not null and p_source_due_at > p_now - interval '1 hour') then
    return true;
  end if;

  -- For an older source, bound source-first scheduling to one committed
  -- collection claim since the last queue claim.  The existing insert trigger
  -- resets this counter on a queue run and increments it on a source run.
  select source_dispatch_streak
    into v_source_dispatch_streak
    from public.auction_pipeline_control
   where id;

  return coalesce(v_source_dispatch_streak, 0) >= 1;
end;
$$;

comment on column public.auction_pipeline_control.source_dispatch_streak is
  'Consecutive scheduler-owned collection claims since the last enrichment-queue claim; an eligible queue receives a turn after at most one overdue source claim.';

revoke all on function app_private.pipeline_queue_should_preempt_source(
  boolean, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function app_private.pipeline_queue_should_preempt_source(
  boolean, timestamptz, timestamptz
) to service_role;

notify pgrst, 'reload schema';

commit;
