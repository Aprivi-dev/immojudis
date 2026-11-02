begin;

set local lock_timeout = '5s';

-- Plafond de validations par administrateur et par jour, appliqué DANS la fonction d'approbation (atomique).
-- Reprise EN ENTIER de la dernière définition de public.approve_information_agent_mission_admin (20260919124500),
-- avec un quatrième paramètre facultatif p_daily_cap : si renseigné, les approbations d'un même administrateur
-- sont sérialisées par un verrou consultatif et refusées (53400) au plafond, jour calendaire de Paris. Sans le
-- paramètre (nul), comportement inchangé. L'ancienne signature à trois paramètres est remplacée (un appel à trois
-- arguments nommés continue de fonctionner).
drop function if exists public.approve_information_agent_mission_admin(uuid, uuid, text);

create or replace function public.approve_information_agent_mission_admin(
  p_admin_id uuid,
  p_mission_id uuid,
  p_message_sha256 text,
  p_daily_cap integer default null
)
returns table (
  mission_id uuid,
  case_id uuid,
  approved_at timestamptz,
  should_send boolean,
  inbound_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mission public.information_agent_missions%rowtype;
  v_case public.information_agent_cases%rowtype;
  v_approved_time timestamptz := statement_timestamp();
  v_day_start timestamptz := ((statement_timestamp() at time zone 'Europe/Paris')::date)::timestamp at time zone 'Europe/Paris';
begin
  if p_admin_id is null or p_mission_id is null then
    raise exception using errcode = '22023', message = 'Admin and mission are required.';
  end if;
  if p_message_sha256 is null or p_message_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid approval fingerprint.';
  end if;
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = p_admin_id and profile.user_role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;

  -- Plafond de validations par administrateur et par jour : les approbations d'un même administrateur passent
  -- une à une (verrou consultatif de la transaction), donc deux validations simultanées ne dépassent jamais le plafond.
  if p_daily_cap is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('information-agent:admin-approval-cap:' || p_admin_id::text, 0)
    );
  end if;

  select * into v_mission
  from public.information_agent_missions mission
  where mission.id = p_mission_id and mission.user_id = p_admin_id
  for update;

  if v_mission.id is null or v_mission.case_id is null then
    raise exception using errcode = 'P0002', message = 'Admin information-agent mission not found.';
  end if;
  if v_mission.status not in ('draft', 'failed', 'subscribed') then
    raise exception using errcode = '55000', message = 'Mission cannot be approved in its current state.';
  end if;

  select * into v_case
  from public.information_agent_cases shared_case
  where shared_case.id = v_mission.case_id
  for update;

  if v_case.id is null then
    raise exception using errcode = 'P0002', message = 'Information-agent case not found.';
  end if;

  if v_case.status not in ('draft', 'failed') then
    update public.information_agent_missions mission
    set status = 'subscribed', approved_message_sha256 = p_message_sha256,
        failure_reason = null, updated_at = v_approved_time
    where mission.id = v_mission.id;

    return query select v_mission.id, v_case.id, v_approved_time, false, v_case.inbound_token;
    return;
  end if;

  if p_daily_cap is not null and (
    select count(*) from public.information_agent_missions approved
    where approved.user_id = p_admin_id and approved.approved_at >= v_day_start
  ) >= p_daily_cap then
    raise exception using
      errcode = '53400',
      message = 'Plafond de ' || p_daily_cap::text || ' validations par jour atteint : les envois reprennent demain.';
  end if;

  update public.information_agent_missions mission
  set status = 'sending', approved_at = v_approved_time,
      approved_message_sha256 = p_message_sha256, failure_reason = null,
      updated_at = v_approved_time
  where mission.id = v_mission.id;

  update public.information_agent_cases shared_case
  set status = 'sending', recipient_kind = v_mission.recipient_kind,
      recipient_name = v_mission.recipient_name, recipient_email = v_mission.recipient_email,
      normalized_recipient_email = lower(btrim(v_mission.recipient_email)),
      subject = v_mission.subject, body_text = v_mission.body_text,
      question_keys = v_mission.question_keys,
      missing_information = v_mission.missing_information,
      initiator_mission_id = v_mission.id, failure_reason = null,
      updated_at = v_approved_time
  where shared_case.id = v_case.id;

  update public.information_agent_case_subscribers subscriber
  set is_initiator = subscriber.mission_id = v_mission.id
  where subscriber.case_id = v_case.id;

  return query select v_mission.id, v_case.id, v_approved_time, true, v_case.inbound_token;
end;
$$;

revoke all on function public.approve_information_agent_mission_admin(uuid, uuid, text, integer)
from public, anon, authenticated;
grant execute on function public.approve_information_agent_mission_admin(uuid, uuid, text, integer)
to service_role;

notify pgrst, 'reload schema';

commit;
