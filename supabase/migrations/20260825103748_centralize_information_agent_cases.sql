begin;

-- Version aligned with the migration recorded on the production project.

-- One external conversation is shared by every subscriber interested in the
-- same sale/contact. Missions remain the per-user consent and quota ledger.
create table public.information_agent_cases (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'draft' check (
    status in ('draft', 'sending', 'sent', 'replied', 'review', 'completed', 'failed')
  ),
  recipient_kind text not null default 'source_contact' check (
    recipient_kind in ('source_lawyer', 'source_contact', 'manual_professional')
  ),
  recipient_name text,
  recipient_email text not null,
  normalized_recipient_email text not null,
  subject text not null,
  body_text text not null,
  question_keys text[] not null default '{}'::text[],
  missing_information text[] not null default '{}'::text[],
  inbound_token uuid not null default gen_random_uuid() unique,
  initiator_mission_id uuid,
  provider_message_id text,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  replied_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sale_id, normalized_recipient_email),
  constraint information_agent_cases_recipient_email_check check (
    char_length(recipient_email) between 3 and 320
    and recipient_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    and normalized_recipient_email = lower(btrim(recipient_email))
  ),
  constraint information_agent_cases_subject_check check (char_length(subject) between 3 and 200),
  constraint information_agent_cases_body_check check (char_length(body_text) between 20 and 8000),
  constraint information_agent_cases_questions_check check (cardinality(question_keys) between 1 and 8),
  constraint information_agent_cases_metadata_check check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 32768
  )
);

alter table public.information_agent_missions
  add column case_id uuid references public.information_agent_cases(id) on delete set null;
alter table public.information_agent_missions
  alter column share_requester_email set default false;

alter table public.information_agent_cases
  add constraint information_agent_cases_initiator_mission_id_fkey
  foreign key (initiator_mission_id)
  references public.information_agent_missions(id)
  on delete set null;

alter table public.information_agent_missions
  drop constraint if exists information_agent_missions_status_check;
alter table public.information_agent_missions
  add constraint information_agent_missions_status_check check (
    status in (
      'draft', 'approved', 'sending', 'sent', 'subscribed',
      'replied', 'completed', 'failed', 'cancelled'
    )
  );

create table public.information_agent_case_subscribers (
  case_id uuid not null references public.information_agent_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mission_id uuid not null references public.information_agent_missions(id) on delete cascade,
  requested_question_keys text[] not null default '{}'::text[],
  notify_on_reply boolean not null default true,
  is_initiator boolean not null default false,
  subscribed_at timestamptz not null default now(),
  last_notified_at timestamptz,
  primary key (case_id, user_id),
  unique (mission_id),
  constraint information_agent_case_subscribers_questions_check check (
    cardinality(requested_question_keys) between 1 and 8
  )
);

alter table public.information_agent_messages
  add column case_id uuid references public.information_agent_cases(id) on delete cascade;

create table public.information_agent_evidence_assets (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.information_agent_cases(id) on delete cascade,
  message_id uuid not null references public.information_agent_messages(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  provider_attachment_id text,
  storage_bucket text not null default 'information-agent-evidence',
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 41943040),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  review_status text not null default 'pending' check (
    review_status in ('pending', 'accepted', 'rejected')
  ),
  rights_status text not null default 'unverified' check (
    rights_status in ('unverified', 'authorized', 'restricted')
  ),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
  ),
  created_at timestamptz not null default now(),
  unique (message_id, provider_attachment_id)
);

create table public.information_agent_fact_candidates (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.information_agent_cases(id) on delete cascade,
  message_id uuid not null references public.information_agent_messages(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  fact_key text not null check (
    fact_key in ('surface_m2', 'rooms_count', 'occupancy_status', 'visit_information', 'document', 'photo')
  ),
  proposed_value jsonb not null,
  display_value text not null check (char_length(display_value) between 1 and 500),
  evidence_excerpt text check (evidence_excerpt is null or char_length(evidence_excerpt) <= 2000),
  confidence numeric not null check (confidence between 0 and 1),
  extraction_method text not null default 'deterministic_v1',
  status text not null default 'pending' check (
    status in ('pending', 'accepted', 'rejected', 'conflict')
  ),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text check (review_notes is null or char_length(review_notes) <= 2000),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, fact_key, display_value)
);

create index information_agent_cases_sale_status_idx
  on public.information_agent_cases (sale_id, status, updated_at desc);
create index information_agent_case_subscribers_user_idx
  on public.information_agent_case_subscribers (user_id, subscribed_at desc);
create index information_agent_messages_case_created_idx
  on public.information_agent_messages (case_id, created_at asc)
  where case_id is not null;
create index information_agent_fact_candidates_review_idx
  on public.information_agent_fact_candidates (status, created_at asc);
create index information_agent_evidence_assets_case_idx
  on public.information_agent_evidence_assets (case_id, created_at asc);

-- Preserve any conversations created before mutualisation.
insert into public.information_agent_cases (
  sale_id, created_by, status, recipient_kind, recipient_name,
  recipient_email, normalized_recipient_email, subject, body_text,
  question_keys, missing_information, initiator_mission_id,
  provider_message_id, failure_reason, sent_at, replied_at, completed_at,
  created_at, updated_at, metadata
)
select distinct on (mission.sale_id, lower(btrim(mission.recipient_email)))
  mission.sale_id,
  mission.user_id,
  case mission.status
    when 'approved' then 'sending'
    when 'cancelled' then 'draft'
    when 'completed' then 'completed'
    else mission.status
  end,
  mission.recipient_kind,
  mission.recipient_name,
  mission.recipient_email,
  lower(btrim(mission.recipient_email)),
  mission.subject,
  mission.body_text,
  mission.question_keys,
  mission.missing_information,
  mission.id,
  mission.provider_message_id,
  mission.failure_reason,
  mission.sent_at,
  mission.replied_at,
  mission.completed_at,
  mission.created_at,
  mission.updated_at,
  jsonb_build_object('migrated_from_mission_id', mission.id)
from public.information_agent_missions mission
where mission.sale_id is not null
order by
  mission.sale_id,
  lower(btrim(mission.recipient_email)),
  case mission.status
    when 'completed' then 7 when 'replied' then 6 when 'sent' then 5
    when 'sending' then 4 when 'approved' then 3 when 'failed' then 2 else 1
  end desc,
  mission.created_at asc
on conflict (sale_id, normalized_recipient_email) do nothing;

update public.information_agent_missions mission
set case_id = shared_case.id
from public.information_agent_cases shared_case
where mission.sale_id = shared_case.sale_id
  and lower(btrim(mission.recipient_email)) = shared_case.normalized_recipient_email
  and mission.case_id is null;

insert into public.information_agent_case_subscribers (
  case_id, user_id, mission_id, requested_question_keys, is_initiator, subscribed_at
)
select distinct on (mission.case_id, mission.user_id)
  mission.case_id,
  mission.user_id,
  mission.id,
  mission.question_keys,
  shared_case.initiator_mission_id = mission.id,
  mission.created_at
from public.information_agent_missions mission
join public.information_agent_cases shared_case on shared_case.id = mission.case_id
order by mission.case_id, mission.user_id, mission.created_at asc
on conflict (case_id, user_id) do nothing;

update public.information_agent_messages message
set case_id = mission.case_id
from public.information_agent_missions mission
where mission.id = message.mission_id
  and message.case_id is null;

alter table public.information_agent_cases enable row level security;
alter table public.information_agent_case_subscribers enable row level security;
alter table public.information_agent_evidence_assets enable row level security;
alter table public.information_agent_fact_candidates enable row level security;

revoke all on table public.information_agent_cases from public, anon, authenticated;
revoke all on table public.information_agent_case_subscribers from public, anon, authenticated;
revoke all on table public.information_agent_evidence_assets from public, anon, authenticated;
revoke all on table public.information_agent_fact_candidates from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_cases to service_role;
grant select, insert, update, delete on table public.information_agent_case_subscribers to service_role;
grant select, insert, update, delete on table public.information_agent_evidence_assets to service_role;
grant select, insert, update, delete on table public.information_agent_fact_candidates to service_role;

create policy information_agent_cases_subscriber_read
on public.information_agent_cases for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.information_agent_case_subscribers subscriber
    where subscriber.case_id = information_agent_cases.id
      and subscriber.user_id = (select auth.uid())
  )
);

create policy information_agent_case_subscribers_own_read
on public.information_agent_case_subscribers for select to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

create policy information_agent_evidence_assets_subscriber_read
on public.information_agent_evidence_assets for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.information_agent_case_subscribers subscriber
    where subscriber.case_id = information_agent_evidence_assets.case_id
      and subscriber.user_id = (select auth.uid())
  )
);

create policy information_agent_fact_candidates_subscriber_read
on public.information_agent_fact_candidates for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.information_agent_case_subscribers subscriber
    where subscriber.case_id = information_agent_fact_candidates.case_id
      and subscriber.user_id = (select auth.uid())
  )
);

create trigger information_agent_cases_updated_at
before update on public.information_agent_cases
for each row execute function app_private.set_user_profiles_updated_at();
create trigger information_agent_fact_candidates_updated_at
before update on public.information_agent_fact_candidates
for each row execute function app_private.set_user_profiles_updated_at();

-- Attach a user mission to the canonical case. Re-running this after editing
-- the recipient safely moves the mission before approval.
create or replace function public.subscribe_information_agent_mission(
  p_user_id uuid,
  p_mission_id uuid
)
returns table (case_id uuid, case_status text, mission_status text, inbound_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mission public.information_agent_missions%rowtype;
  v_case public.information_agent_cases%rowtype;
  v_normalized_email text;
begin
  select * into v_mission
  from public.information_agent_missions mission
  where mission.id = p_mission_id and mission.user_id = p_user_id
  for update;

  if v_mission.id is null or v_mission.sale_id is null then
    raise exception using errcode = 'P0002', message = 'Information agent mission not found.';
  end if;
  if v_mission.status not in ('draft', 'failed', 'subscribed') then
    raise exception using errcode = '55000', message = 'Information agent mission cannot change case.';
  end if;

  v_normalized_email := lower(btrim(v_mission.recipient_email));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'information-agent:case:' || v_mission.sale_id::text || ':' || v_normalized_email,
      0
    )
  );

  insert into public.information_agent_cases (
    sale_id, created_by, recipient_kind, recipient_name, recipient_email,
    normalized_recipient_email, subject, body_text, question_keys,
    missing_information, metadata
  ) values (
    v_mission.sale_id, p_user_id, v_mission.recipient_kind, v_mission.recipient_name,
    v_mission.recipient_email, v_normalized_email, v_mission.subject, v_mission.body_text,
    v_mission.question_keys, v_mission.missing_information,
    jsonb_build_object('created_from_mission_id', v_mission.id)
  )
  on conflict (sale_id, normalized_recipient_email) do nothing;

  select * into v_case
  from public.information_agent_cases shared_case
  where shared_case.sale_id = v_mission.sale_id
    and shared_case.normalized_recipient_email = v_normalized_email
  for update;

  delete from public.information_agent_case_subscribers subscriber
  where subscriber.mission_id = v_mission.id;

  update public.information_agent_missions mission
  set case_id = v_case.id,
      status = case when v_case.status in ('draft', 'failed') then 'draft' else 'subscribed' end,
      updated_at = statement_timestamp()
  where mission.id = v_mission.id;

  insert into public.information_agent_case_subscribers (
    case_id, user_id, mission_id, requested_question_keys, is_initiator
  ) values (
    v_case.id, p_user_id, v_mission.id, v_mission.question_keys,
    coalesce(v_case.initiator_mission_id = v_mission.id, false)
  )
  on conflict on constraint information_agent_case_subscribers_pkey do update set
    mission_id = excluded.mission_id,
    requested_question_keys = excluded.requested_question_keys;

  return query
  select
    v_case.id,
    v_case.status,
    case when v_case.status in ('draft', 'failed') then 'draft'::text else 'subscribed'::text end,
    v_case.inbound_token;
end;
$$;

revoke all on function public.subscribe_information_agent_mission(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.subscribe_information_agent_mission(uuid, uuid) to service_role;

-- The case row is the cross-user concurrency lock. Only the winner consumes a
-- quota unit and sends; every later approval becomes a free subscription.
drop function public.approve_information_agent_mission_bounded(uuid, uuid, text);

create or replace function public.approve_information_agent_mission_bounded(
  p_user_id uuid,
  p_mission_id uuid,
  p_message_sha256 text
)
returns table (
  mission_id uuid,
  case_id uuid,
  approved_at timestamptz,
  usage_count integer,
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
  v_recent_usage integer;
  v_monthly_limit constant integer := 3;
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
      select 1 from public.user_profiles profile
      where profile.user_id = p_user_id
        and (profile.account_tier = 'premium' or profile.user_role = 'admin')
    )
  ) then
    raise exception using errcode = '42501', message = 'Analyse access is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('information-agent:user:' || p_user_id::text, 0)
  );

  select * into v_mission
  from public.information_agent_missions mission
  where mission.id = p_mission_id and mission.user_id = p_user_id
  for update;

  if v_mission.id is null or v_mission.case_id is null then
    raise exception using errcode = 'P0002', message = 'Information agent mission not found.';
  end if;
  if v_mission.status not in ('draft', 'failed', 'subscribed') then
    raise exception using errcode = '55000', message = 'Information agent mission cannot be approved in its current state.';
  end if;

  select * into v_case
  from public.information_agent_cases shared_case
  where shared_case.id = v_mission.case_id
  for update;

  select count(*)::integer into v_recent_usage
  from public.information_agent_missions mission
  where mission.user_id = p_user_id
    and mission.approved_at >= v_approved_time - interval '30 days'
    and mission.status in ('approved', 'sending', 'sent', 'replied', 'completed');

  if v_case.status not in ('draft', 'failed') then
    update public.information_agent_missions mission
    set status = 'subscribed', approved_message_sha256 = p_message_sha256,
        failure_reason = null, updated_at = v_approved_time
    where mission.id = p_mission_id;

    return query select p_mission_id, v_case.id, v_approved_time, v_recent_usage, false,
      v_case.inbound_token;
    return;
  end if;

  if v_recent_usage >= v_monthly_limit then
    raise exception using errcode = 'P0001', message = 'INFORMATION_AGENT_MONTHLY_LIMIT';
  end if;

  update public.information_agent_missions mission
  set status = 'sending', approved_at = v_approved_time,
      approved_message_sha256 = p_message_sha256, failure_reason = null,
      updated_at = v_approved_time
  where mission.id = p_mission_id;

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

  return query select p_mission_id, v_case.id, v_approved_time, v_recent_usage + 1, true,
    v_case.inbound_token;
end;
$$;

revoke all on function public.approve_information_agent_mission_bounded(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.approve_information_agent_mission_bounded(uuid, uuid, text)
to service_role;

create or replace function public.review_information_agent_fact_candidate(
  p_reviewer_id uuid,
  p_fact_id uuid,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
  v_source_url text;
  v_value_text text;
  v_value_numeric numeric;
  v_value_integer integer;
  v_now timestamptz := statement_timestamp();
begin
  if p_decision not in ('accepted', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid fact review decision.';
  end if;
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = p_reviewer_id and profile.user_role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Administrator review is required.';
  end if;

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;

  if v_fact.id is null then
    raise exception using errcode = 'P0002', message = 'Information agent fact not found.';
  end if;
  if v_fact.status not in ('pending', 'conflict') then
    raise exception using errcode = '55000', message = 'Information agent fact was already reviewed.';
  end if;

  update public.information_agent_fact_candidates fact
  set status = p_decision, reviewed_by = p_reviewer_id, reviewed_at = v_now,
      review_notes = nullif(btrim(p_notes), ''), updated_at = v_now
  where fact.id = p_fact_id;

  if p_decision = 'rejected' then
    return jsonb_build_object('fact_id', p_fact_id, 'status', 'rejected');
  end if;

  select sale.source_url into v_source_url
  from public.auction_sales sale where sale.id = v_fact.sale_id
  for update;
  v_value_text := nullif(btrim(v_fact.proposed_value->>'value'), '');

  if v_fact.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted surface.';
    end if;
    update public.auction_sales sale set
      surface_m2 = v_value_numeric,
      app_surface_m2 = v_value_numeric,
      app_surface_kind = 'information_agent_verified',
      surface_source = 'information_agent_verified',
      surface_confidence = greatest(v_fact.confidence, 0.85),
      surface_evidence = left(coalesce(v_fact.evidence_excerpt, v_fact.display_value), 2000),
      updated_at = v_now
    where sale.id = v_fact.sale_id;
  elsif v_fact.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100 then
      raise exception using errcode = '22023', message = 'Invalid accepted room count.';
    end if;
    update public.auction_sales sale set rooms_count = v_value_integer, updated_at = v_now
    where sale.id = v_fact.sale_id;
  elsif v_fact.fact_key = 'occupancy_status' then
    if v_value_text not in ('vacant', 'occupied', 'rented', 'owner_occupied', 'squatted', 'unknown') then
      raise exception using errcode = '22023', message = 'Invalid accepted occupancy status.';
    end if;
    update public.auction_sales sale set occupancy_status = v_value_text, updated_at = v_now
    where sale.id = v_fact.sale_id;
  end if;

  update public.auction_sales sale
  set raw_payload = (
        (coalesce(sale.raw_payload, '{}'::jsonb)
          - 'llm_display_description'
          - 'llm_display_description_word_count'
          - 'llm_prompt_version')
        || jsonb_build_object(
          'information_agent_verified_facts',
          coalesce(sale.raw_payload->'information_agent_verified_facts', '{}'::jsonb)
            || jsonb_build_object(
              v_fact.fact_key,
              jsonb_build_object(
                'value', v_fact.proposed_value,
                'display_value', v_fact.display_value,
                'fact_id', v_fact.id,
                'reviewed_at', v_now,
                'source', 'professional_email'
              )
            )
        )
      ),
      updated_at = v_now
  where sale.id = v_fact.sale_id;

  if v_source_url is not null then
    insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
    values (
      v_source_url, 'display_description', 90,
      md5('information-agent:' || v_fact.id::text || ':' || v_now::text)
    )
    on conflict (source_url, job_type, input_hash) do nothing;
  end if;

  perform public.enqueue_auction_sale_market_estimate(
    p_auction_sale_id => v_fact.sale_id,
    p_priority => 90,
    p_reason => 'information_agent_verified_fact',
    p_now => v_now
  );

  return jsonb_build_object(
    'fact_id', p_fact_id,
    'status', 'accepted',
    'sale_id', v_fact.sale_id,
    'valuation_queued', true,
    'description_queued', v_source_url is not null
  );
end;
$$;

revoke all on function public.review_information_agent_fact_candidate(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.review_information_agent_fact_candidate(uuid, uuid, text, text)
to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'information-agent-evidence',
  'information-agent-evidence',
  false,
  41943040,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'image/heic', 'image/heif', 'text/plain'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant select on table storage.buckets to service_role;
grant select, insert on table storage.objects to service_role;

comment on table public.information_agent_cases is
  'Canonical shared conversation for one auction sale and one professional email address.';
comment on table public.information_agent_fact_candidates is
  'Untrusted facts extracted from replies; only an explicit administrator acceptance updates a sale.';
comment on table public.information_agent_evidence_assets is
  'Private inbound attachments retained as review evidence; never public by default.';

notify pgrst, 'reload schema';

commit;
