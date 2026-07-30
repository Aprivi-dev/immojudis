begin;

-- Notify once when an incident opens, again only if its severity changes, and
-- once when it resolves. Periodic six-hour reminders were generating repeated
-- GitHub Actions failures and email without adding a new operational signal.
create or replace function app_private.sync_operational_alert(
  p_alert_key text,
  p_category text,
  p_severity text,
  p_details jsonb,
  p_active boolean,
  p_now timestamptz default statement_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_alert public.operational_alerts%rowtype;
  should_notify boolean;
  next_event text;
begin
  select * into current_alert
  from public.operational_alerts
  where alert_key = p_alert_key
  for update;

  if p_active then
    if not found then
      insert into public.operational_alerts (
        alert_key,
        category,
        severity,
        status,
        details,
        first_seen_at,
        last_seen_at,
        notification_event,
        notification_status,
        notification_next_attempt_at
      ) values (
        p_alert_key,
        p_category,
        p_severity,
        'open',
        coalesce(p_details, '{}'::jsonb),
        p_now,
        p_now,
        'opened',
        'pending',
        p_now
      );
      return;
    end if;

    should_notify := current_alert.status = 'resolved'
      or current_alert.severity is distinct from p_severity
      or current_alert.notified_at is null;
    next_event := case when current_alert.status = 'resolved' then 'opened' else 'updated' end;

    update public.operational_alerts
    set
      category = p_category,
      severity = p_severity,
      status = 'open',
      details = coalesce(p_details, '{}'::jsonb),
      occurrence_count = occurrence_count + 1,
      last_seen_at = p_now,
      resolved_at = null,
      notification_event = case when should_notify then next_event else notification_event end,
      notification_status = case when should_notify then 'pending' else notification_status end,
      notification_version = case
        when should_notify then notification_version + 1
        else notification_version
      end,
      notification_attempt_count = case when should_notify then 0 else notification_attempt_count end,
      notification_next_attempt_at = case
        when should_notify then p_now
        else notification_next_attempt_at
      end,
      notification_claimed_at = case when should_notify then null else notification_claimed_at end,
      notification_error = case when should_notify then null else notification_error end
    where alert_key = p_alert_key;
    return;
  end if;

  if found and current_alert.status = 'open' then
    update public.operational_alerts
    set
      status = 'resolved',
      last_seen_at = p_now,
      resolved_at = p_now,
      notification_event = 'resolved',
      notification_status = 'pending',
      notification_version = notification_version + 1,
      notification_attempt_count = 0,
      notification_next_attempt_at = p_now,
      notification_claimed_at = null,
      notification_error = null
    where alert_key = p_alert_key;
  end if;
end;
$$;

revoke all on function app_private.sync_operational_alert(
  text, text, text, jsonb, boolean, timestamptz
) from public, anon, authenticated, service_role;

comment on function app_private.sync_operational_alert(
  text, text, text, jsonb, boolean, timestamptz
) is 'Synchronizes operational incidents and queues notifications only for opening, severity changes, and resolution.';

commit;
