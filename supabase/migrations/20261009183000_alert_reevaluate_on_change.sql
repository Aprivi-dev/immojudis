begin;

set local lock_timeout = '5s';

-- An alert whose criteria change (or that is switched back on) must look at the
-- whole current inventory again, not only at sales modified since its last
-- evaluation.  Clearing last_evaluated_at is how the evaluator knows.
create or replace function app_private.reset_alert_evaluation_on_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (new.is_active and not old.is_active)
    or (to_jsonb(new) - array['updated_at', 'last_evaluated_at', 'last_match_count', 'name', 'alert_frequency', 'is_active'])
      is distinct from
      (to_jsonb(old) - array['updated_at', 'last_evaluated_at', 'last_match_count', 'name', 'alert_frequency', 'is_active'])
  then
    new.last_evaluated_at := null;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.reset_alert_evaluation_on_change()
  from public, anon, authenticated;

drop trigger if exists user_alerts_reset_evaluation on public.user_alerts;
create trigger user_alerts_reset_evaluation
  before update on public.user_alerts
  for each row
  execute function app_private.reset_alert_evaluation_on_change();

-- The "instant" frequency never existed: alerts are evaluated by the daily cron
-- and sent as a digest.  Fold the stray values into the daily frequency.
update public.user_alerts
set alert_frequency = 'daily'
where alert_frequency = 'instant';

commit;
