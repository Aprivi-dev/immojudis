begin;

create table if not exists public.information_agent_missions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid references public.auction_sales(id) on delete set null,
  status text not null default 'draft' check (
    status in ('draft', 'approved', 'sending', 'sent', 'replied', 'completed', 'failed', 'cancelled')
  ),
  recipient_kind text not null default 'source_contact' check (
    recipient_kind in ('source_lawyer', 'source_contact', 'manual_professional')
  ),
  recipient_name text,
  recipient_email text not null,
  reply_to_email text,
  share_requester_email boolean not null default true,
  subject text not null,
  body_text text not null,
  question_keys text[] not null default '{}'::text[],
  missing_information text[] not null default '{}'::text[],
  sale_snapshot jsonb not null default '{}'::jsonb,
  approved_message_sha256 text,
  ai_disclosure_version text not null default '2026-08-24.1',
  privacy_version text not null,
  followup_count integer not null default 0 check (followup_count between 0 and 1),
  provider_message_id text,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  sent_at timestamptz,
  replied_at timestamptz,
  completed_at timestamptz,
  last_followup_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint information_agent_missions_recipient_email_check check (
    char_length(recipient_email) between 3 and 320
    and recipient_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint information_agent_missions_reply_to_email_check check (
    reply_to_email is null
    or (
      char_length(reply_to_email) between 3 and 320
      and reply_to_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  constraint information_agent_missions_recipient_name_check check (
    recipient_name is null or char_length(recipient_name) <= 180
  ),
  constraint information_agent_missions_subject_check check (
    char_length(subject) between 3 and 200
  ),
  constraint information_agent_missions_body_check check (
    char_length(body_text) between 20 and 8000
  ),
  constraint information_agent_missions_questions_check check (
    cardinality(question_keys) between 1 and 8
  ),
  constraint information_agent_missions_approval_hash_check check (
    approved_message_sha256 is null
    or approved_message_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint information_agent_missions_snapshots_check check (
    jsonb_typeof(sale_snapshot) = 'object'
    and pg_column_size(sale_snapshot) <= 32768
    and jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 16384
  )
);

comment on table public.information_agent_missions is
  'Supervised, user-approved information requests sent to professional contacts for an auction sale.';
comment on column public.information_agent_missions.approved_message_sha256 is
  'Immutable audit fingerprint of the recipient, reply-to, subject, and body explicitly approved by the user.';
comment on column public.information_agent_missions.ai_disclosure_version is
  'Version of the disclosure informing the recipient that they are interacting with an AI-assisted service.';

create table if not exists public.information_agent_messages (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.information_agent_missions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  message_kind text not null check (message_kind in ('initial', 'followup', 'reply', 'manual_note')),
  delivery_status text not null check (
    delivery_status in ('draft', 'queued', 'sent', 'received', 'failed')
  ),
  from_email text,
  to_email text,
  subject text not null,
  body_text text not null,
  provider_message_id text,
  attachments jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  constraint information_agent_messages_subject_check check (
    char_length(subject) between 3 and 200
  ),
  constraint information_agent_messages_body_check check (
    char_length(body_text) between 1 and 16000
  ),
  constraint information_agent_messages_payload_check check (
    jsonb_typeof(attachments) = 'array'
    and pg_column_size(attachments) <= 65536
    and jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 16384
  )
);

comment on table public.information_agent_messages is
  'Audit trail for outbound requests and user-imported replies. Inbound content is untrusted data.';

create index if not exists information_agent_missions_user_created_idx
  on public.information_agent_missions (user_id, created_at desc);
create index if not exists information_agent_missions_user_sale_idx
  on public.information_agent_missions (user_id, sale_id, created_at desc);
create index if not exists information_agent_missions_quota_idx
  on public.information_agent_missions (user_id, approved_at desc)
  where status in ('approved', 'sending', 'sent', 'replied', 'completed');
create index if not exists information_agent_messages_mission_created_idx
  on public.information_agent_messages (mission_id, created_at asc);
create unique index if not exists information_agent_messages_provider_id_idx
  on public.information_agent_messages (provider_message_id)
  where provider_message_id is not null;

alter table public.information_agent_missions enable row level security;
alter table public.information_agent_messages enable row level security;

revoke all on table public.information_agent_missions from public, anon, authenticated;
revoke all on table public.information_agent_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_missions to service_role;
grant select, insert, update, delete on table public.information_agent_messages to service_role;

drop policy if exists information_agent_missions_select_own
on public.information_agent_missions;
create policy information_agent_missions_select_own
on public.information_agent_missions
for select
to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists information_agent_messages_select_own
on public.information_agent_messages;
create policy information_agent_messages_select_own
on public.information_agent_messages
for select
to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

drop trigger if exists immojudis_information_agent_missions_updated_at
on public.information_agent_missions;
create trigger immojudis_information_agent_missions_updated_at
before update on public.information_agent_missions
for each row
execute function app_private.set_user_profiles_updated_at();

create or replace function app_private.enforce_information_agent_message_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mission_owner uuid;
begin
  select mission.user_id
  into mission_owner
  from public.information_agent_missions mission
  where mission.id = new.mission_id;

  if mission_owner is null or mission_owner <> new.user_id then
    raise exception using errcode = '23514', message = 'Information agent message owner mismatch.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.enforce_information_agent_message_owner()
  from public, anon, authenticated;

drop trigger if exists information_agent_messages_owner_guard
on public.information_agent_messages;
create trigger information_agent_messages_owner_guard
before insert or update on public.information_agent_messages
for each row
execute function app_private.enforce_information_agent_message_owner();

create or replace function public.approve_information_agent_mission_bounded(
  p_user_id uuid,
  p_mission_id uuid,
  p_message_sha256 text
)
returns table (mission_id uuid, approved_at timestamptz, usage_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  mission_status text;
  approved_time timestamptz := statement_timestamp();
  recent_usage integer;
  monthly_limit constant integer := 3;
begin
  if p_user_id is null or p_mission_id is null then
    raise exception using errcode = '22023', message = 'Information agent user and mission are required.';
  end if;
  if p_message_sha256 is null or p_message_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid approval fingerprint.';
  end if;
  if not (
    app_private.has_active_analysis_access(p_user_id)
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = p_user_id
        and (profile.account_tier = 'premium' or profile.user_role = 'admin')
    )
  ) then
    raise exception using errcode = '42501', message = 'Analyse access is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('information-agent:user:' || p_user_id::text, 0)
  );

  select mission.status
  into mission_status
  from public.information_agent_missions mission
  where mission.id = p_mission_id
    and mission.user_id = p_user_id
  for update;

  if mission_status is null then
    raise exception using errcode = 'P0002', message = 'Information agent mission not found.';
  end if;
  if mission_status not in ('draft', 'failed') then
    raise exception using errcode = '55000', message = 'Information agent mission cannot be approved in its current state.';
  end if;

  select count(*)::integer
  into recent_usage
  from public.information_agent_missions mission
  where mission.user_id = p_user_id
    and mission.approved_at >= approved_time - interval '30 days'
    and mission.status in ('approved', 'sending', 'sent', 'replied', 'completed');

  if recent_usage >= monthly_limit then
    raise exception using errcode = 'P0001', message = 'INFORMATION_AGENT_MONTHLY_LIMIT';
  end if;

  update public.information_agent_missions mission
  set status = 'approved',
      approved_at = approved_time,
      approved_message_sha256 = p_message_sha256,
      failure_reason = null,
      updated_at = approved_time
  where mission.id = p_mission_id
    and mission.user_id = p_user_id;

  return query select p_mission_id, approved_time, recent_usage + 1;
end;
$$;

revoke all on function public.approve_information_agent_mission_bounded(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.approve_information_agent_mission_bounded(uuid, uuid, text)
  to service_role;

create or replace function app_private.purge_information_agent_data(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_missions integer := 0;
begin
  delete from public.information_agent_missions mission
  where (
      mission.status in ('sent', 'replied', 'completed', 'cancelled', 'failed')
      and mission.updated_at < p_now - interval '24 months'
    )
    or (
      mission.status in ('draft', 'approved', 'sending')
      and mission.updated_at < p_now - interval '6 months'
    );
  get diagnostics deleted_missions = row_count;

  return jsonb_build_object('information_agent_missions', deleted_missions);
end;
$$;

revoke all on function app_private.purge_information_agent_data(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_information_agent_data(timestamptz)
  to service_role;

create or replace function public.run_data_retention(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app_private.purge_expired_operational_data(p_now)
    || app_private.purge_information_agent_data(p_now);
$$;

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
