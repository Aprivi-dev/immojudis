begin;

set local lock_timeout = '5s';

-- Owner decision (11/10/2026): the free Découverte alert is delivered by email
-- once a week; the daily digest stays with Analyse. In-place body patch of the
-- quota trigger: only the frequency rule and its message change.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.enforce_geographic_alert_quota()'::regprocedure
  );
  old_rule constant text := $old$new.alert_frequency <> 'daily'$old$;
  new_rule constant text := $new$new.alert_frequency <> 'weekly'$new$;
  old_message constant text := $old$public criteria and daily notifications only$old$;
  new_message constant text := $new$public criteria and weekly notifications only$new$;
begin
  if position(old_rule in definition) = 0 or position(old_message in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected Discovery alert rule; refusing weekly alert patch.';
  end if;
  definition := replace(replace(definition, old_rule, new_rule), old_message, new_message);
  execute definition;
end;
$patch$;

revoke all on function app_private.enforce_geographic_alert_quota() from public, anon, authenticated;

-- Free alerts created under the daily rule move to the weekly digest.
update public.user_alerts a
   set alert_frequency = 'weekly'
 where a.alert_frequency = 'daily'
   and not app_private.has_active_analysis_access(a.user_id)
   and not exists (
     select 1 from public.user_profiles p
      where p.user_id = a.user_id and (p.account_tier = 'premium' or p.user_role = 'admin')
   );

commit;
