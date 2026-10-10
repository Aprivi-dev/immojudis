begin;

set local lock_timeout = '5s';

-- Incidents that open and resolve every few minutes (sources that miss one run,
-- then recover) were producing two notifications each time: one GitHub Actions
-- failure and one recovery.  Three changes:
--   * an incident only resolves after the condition has been clear for two
--     hours (hysteresis), so a flapping source stays one open incident;
--   * a still-open incident reminds at most once every 24 hours;
--   * reopened_at keeps the latest reopening apart from first_seen_at.
alter table public.operational_alerts
  add column if not exists reopened_at timestamptz,
  add column if not exists inactive_since timestamptz;

comment on column public.operational_alerts.reopened_at is
  'When the incident last reopened after having been resolved; first_seen_at stays the first occurrence.';
comment on column public.operational_alerts.inactive_since is
  'Since when the failing condition is clear; the incident resolves once this is older than two hours.';

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
as $function$
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

    -- Notify on (re)opening, on a severity change, and as a 24-hour reminder
    -- while the incident stays open and the previous notice was delivered.
    should_notify := current_alert.status = 'resolved'
      or current_alert.severity is distinct from p_severity
      or (
        current_alert.notification_status = 'delivered'
        and coalesce(current_alert.notified_at, '-infinity'::timestamptz) <= p_now - interval '24 hours'
      );
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
      inactive_since = null,
      reopened_at = case when current_alert.status = 'resolved' then p_now else reopened_at end,
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
    if current_alert.inactive_since is null then
      update public.operational_alerts
      set inactive_since = p_now
      where alert_key = p_alert_key;
    elsif current_alert.inactive_since <= p_now - interval '2 hours' then
      update public.operational_alerts
      set
        status = 'resolved',
        last_seen_at = p_now,
        resolved_at = p_now,
        inactive_since = null,
        notification_event = 'resolved',
        notification_status = 'pending',
        notification_version = notification_version + 1,
        notification_attempt_count = 0,
        notification_next_attempt_at = p_now,
        notification_claimed_at = null,
        notification_error = null
      where alert_key = p_alert_key;
    end if;
  end if;
end;
$function$;

revoke all on function app_private.sync_operational_alert(
  text, text, text, jsonb, boolean, timestamptz
) from public, anon, authenticated, service_role;

comment on function app_private.sync_operational_alert(
  text, text, text, jsonb, boolean, timestamptz
) is 'Synchronizes operational incidents: notifies on opening, severity change, a 24-hour reminder and resolution, which only happens after two clear hours.';

commit;
