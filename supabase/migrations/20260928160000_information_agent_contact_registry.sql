begin;

-- A contact can be observed globally or in the context of one sale.  The
-- registry is deliberately service-role only: it is a control plane for the
-- supervised agent, not a directory exposed to browser clients.
create table if not exists public.information_agent_contacts (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.auction_sales(id) on delete set null,
  -- Immutable provenance for the sale scope.  The FK above may be nulled by
  -- sale retention, but this value keeps the row sale-scoped and prevents it
  -- from becoming a global contact.
  scope_sale_id uuid,
  email text not null,
  normalized_email text generated always as (lower(btrim(email))) stored,
  display_name text,
  role text not null default 'source_contact' check (
    role in ('lawyer', 'notary', 'organizer', 'source_contact', 'manual_professional')
  ),
  provenance jsonb not null default '[]'::jsonb,
  verification_status text not null default 'unverified' check (
    verification_status in ('unverified', 'source_observed', 'verified', 'rejected')
  ),
  opposition_status text not null default 'unknown' check (
    opposition_status in ('unknown', 'none', 'opposed')
  ),
  bounce_status text not null default 'none' check (
    bounce_status in ('none', 'temporary', 'permanent')
  ),
  source_name text,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  last_seen_at timestamptz,
  opposed_at timestamptz,
  bounced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint information_agent_contacts_email_check check (
    char_length(btrim(email)) between 3 and 320
    and email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint information_agent_contacts_display_name_check check (
    display_name is null or char_length(display_name) <= 180
  ),
  constraint information_agent_contacts_provenance_check check (
    jsonb_typeof(provenance) = 'array'
    and pg_column_size(provenance) <= 32768
  ),
  constraint information_agent_contacts_metadata_check check (
    jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 16384
  ),
  constraint information_agent_contacts_identity_unique
    unique nulls not distinct (scope_sale_id, normalized_email)
);

comment on table public.information_agent_contacts is
  'Persistent, service-managed registry of professional contacts used by the supervised information agent.';
comment on column public.information_agent_contacts.provenance is
  'Structured source observations explaining where the address and role came from.';
comment on column public.information_agent_contacts.opposition_status is
  'Explicit contact opposition state; opposed contacts are never solicited.';
comment on column public.information_agent_contacts.bounce_status is
  'Delivery state; permanent bounces are never solicited.';
comment on column public.information_agent_contacts.scope_sale_id is
  'Immutable original sale scope; NULL means global, while a non-NULL value survives sale FK retention.';

create index if not exists information_agent_contacts_email_idx
  on public.information_agent_contacts (normalized_email);
create index if not exists information_agent_contacts_sale_email_idx
  on public.information_agent_contacts (scope_sale_id, normalized_email);

alter table public.information_agent_contacts enable row level security;
revoke all on table public.information_agent_contacts from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_contacts to service_role;

create or replace function app_private.guard_information_agent_contact_scope()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.scope_sale_id is distinct from new.sale_id then
      raise exception using
        errcode = '23514',
        message = 'A contact scope must match its sale at insertion time.';
    end if;
  elsif new.scope_sale_id is distinct from old.scope_sale_id then
    raise exception using
      errcode = '55000',
      message = 'Information-agent contact scope is immutable.';
  elsif new.sale_id is distinct from old.sale_id
    and new.sale_id is not null then
    raise exception using
      errcode = '55000',
      message = 'A contact cannot be moved to another sale.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_contact_scope()
from public, anon, authenticated;
grant execute on function app_private.guard_information_agent_contact_scope()
to service_role;

drop trigger if exists immojudis_information_agent_contacts_scope_guard
on public.information_agent_contacts;
create trigger immojudis_information_agent_contacts_scope_guard
before insert or update on public.information_agent_contacts
for each row
execute function app_private.guard_information_agent_contact_scope();

drop trigger if exists immojudis_information_agent_contacts_updated_at
on public.information_agent_contacts;
create trigger immojudis_information_agent_contacts_updated_at
before update on public.information_agent_contacts
for each row
execute function app_private.set_user_profiles_updated_at();

create or replace function app_private.information_agent_contact_is_blocked(
  p_sale_id uuid,
  p_email text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.information_agent_contacts contact
    where contact.normalized_email = lower(btrim(p_email))
      and (contact.scope_sale_id is null or contact.scope_sale_id = p_sale_id)
      and (
        contact.opposition_status = 'opposed'
        or contact.bounce_status = 'permanent'
      )
  );
$$;

revoke all on function app_private.information_agent_contact_is_blocked(uuid, text)
from public, anon, authenticated;
grant execute on function app_private.information_agent_contact_is_blocked(uuid, text)
to service_role;

-- Keep the database guard in place for direct RPC callers and for a future
-- worker. The application performs the same read before approval so the
-- admin receives a useful error before any outbound provider call.
create or replace function app_private.guard_information_agent_mission_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_check boolean;
begin
  if tg_op = 'INSERT' then
    should_check := true;
  else
    should_check := old.status not in ('sending', 'sent')
      or new.recipient_email is distinct from old.recipient_email
      or new.sale_id is distinct from old.sale_id;
  end if;

  if new.status in ('sending', 'sent')
     and should_check
     and app_private.information_agent_contact_is_blocked(new.sale_id, new.recipient_email) then
    raise exception using
      errcode = '23514',
      message = 'Information-agent contact is opposed or permanently bounced.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_mission_contact()
from public, anon, authenticated;

drop trigger if exists information_agent_missions_contact_guard
on public.information_agent_missions;
create trigger information_agent_missions_contact_guard
before insert or update of status, recipient_email, sale_id
on public.information_agent_missions
for each row
execute function app_private.guard_information_agent_mission_contact();

notify pgrst, 'reload schema';

commit;
