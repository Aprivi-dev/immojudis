begin;

create table if not exists public.referenced_lawyers (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  paid_placement_status text not null default 'not_started' check (
    paid_placement_status in ('not_started', 'trial', 'active', 'past_due', 'paused', 'cancelled')
  ),
  display_name text not null,
  firm_name text,
  email text,
  phone text,
  website_url text,
  bar_association text,
  bar_number text,
  city text,
  department text,
  address text,
  profile_summary text,
  practice_tags text[] not null default array['adjudication']::text[],
  accepts_judicial_auctions boolean not null default true,
  accepts_remote_contact boolean not null default true,
  priority_weight integer not null default 0,
  paid_placement_starts_at timestamptz,
  paid_placement_ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.referenced_lawyers is
  'Avocats référencés par ImmoJudis. Ne pas confondre avec les contacts source renseignés sur les annonces.';

create table if not exists public.referenced_lawyer_coverage (
  id uuid primary key default gen_random_uuid(),
  lawyer_id uuid not null references public.referenced_lawyers(id) on delete cascade,
  tribunal_code text,
  tribunal_name text,
  city text,
  department text,
  postal_code_prefix text,
  created_at timestamptz not null default now(),
  check (
    tribunal_code is not null
    or department is not null
    or city is not null
    or postal_code_prefix is not null
  )
);

create table if not exists public.lawyer_referral_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  requester_email text,
  sale_id uuid references public.auction_sales(id) on delete set null,
  sale_snapshot jsonb not null default '{}'::jsonb,
  requested_lawyer_id uuid references public.referenced_lawyers(id) on delete set null,
  status text not null default 'new' check (
    status in ('new', 'manual_review', 'sent_to_lawyer', 'responded', 'closed', 'cancelled')
  ),
  matching_status text not null default 'unmatched' check (
    matching_status in ('unmatched', 'matched', 'manual_review')
  ),
  preferred_contact_method text not null default 'email' check (
    preferred_contact_method in ('email', 'phone', 'either')
  ),
  phone text,
  message text,
  financing_ready boolean,
  max_bid_eur numeric,
  metadata jsonb not null default '{}'::jsonb,
  admin_notes text,
  assigned_at timestamptz,
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lawyer_referral_requests is
  'Demandes de mise en relation avec les avocats référencés ImmoJudis, indépendantes des avocats/contacts source des annonces.';

create index if not exists referenced_lawyers_status_paid_idx
on public.referenced_lawyers (status, paid_placement_status, priority_weight desc);

create index if not exists referenced_lawyer_coverage_lawyer_id_idx
on public.referenced_lawyer_coverage (lawyer_id);

create index if not exists referenced_lawyer_coverage_tribunal_code_idx
on public.referenced_lawyer_coverage (tribunal_code)
where tribunal_code is not null;

create index if not exists referenced_lawyer_coverage_department_idx
on public.referenced_lawyer_coverage (department)
where department is not null;

create index if not exists lawyer_referral_requests_requester_created_idx
on public.lawyer_referral_requests (requester_id, created_at desc);

create index if not exists lawyer_referral_requests_sale_requester_idx
on public.lawyer_referral_requests (sale_id, requester_id)
where sale_id is not null;

create index if not exists lawyer_referral_requests_status_created_idx
on public.lawyer_referral_requests (status, created_at desc);

alter table public.referenced_lawyers enable row level security;
alter table public.referenced_lawyer_coverage enable row level security;
alter table public.lawyer_referral_requests enable row level security;

revoke all on table public.referenced_lawyers from anon, authenticated;
revoke all on table public.referenced_lawyer_coverage from anon, authenticated;
revoke all on table public.lawyer_referral_requests from anon, authenticated;

grant select on table public.referenced_lawyers to authenticated;
grant select on table public.referenced_lawyer_coverage to authenticated;
grant select, insert on table public.lawyer_referral_requests to authenticated;
grant insert, update, delete on table public.referenced_lawyers to authenticated;
grant insert, update, delete on table public.referenced_lawyer_coverage to authenticated;
grant update (
  requested_lawyer_id,
  status,
  matching_status,
  metadata,
  admin_notes,
  assigned_at,
  sent_at,
  responded_at,
  updated_at
) on public.lawyer_referral_requests to authenticated;

drop trigger if exists immojudis_referenced_lawyers_updated_at
on public.referenced_lawyers;
create trigger immojudis_referenced_lawyers_updated_at
before update on public.referenced_lawyers
for each row
execute function app_private.set_user_profiles_updated_at();

drop trigger if exists immojudis_lawyer_referral_requests_updated_at
on public.lawyer_referral_requests;
create trigger immojudis_lawyer_referral_requests_updated_at
before update on public.lawyer_referral_requests
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists referenced_lawyers_select_active_or_admin
on public.referenced_lawyers;
create policy referenced_lawyers_select_active_or_admin
on public.referenced_lawyers
for select
to authenticated
using (
  public.is_admin()
  or (
    status = 'active'
    and paid_placement_status in ('trial', 'active')
    and accepts_judicial_auctions = true
  )
);

drop policy if exists referenced_lawyers_admin_insert
on public.referenced_lawyers;
create policy referenced_lawyers_admin_insert
on public.referenced_lawyers
for insert
to authenticated
with check (public.is_admin());

drop policy if exists referenced_lawyers_admin_update
on public.referenced_lawyers;
create policy referenced_lawyers_admin_update
on public.referenced_lawyers
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists referenced_lawyers_admin_delete
on public.referenced_lawyers;
create policy referenced_lawyers_admin_delete
on public.referenced_lawyers
for delete
to authenticated
using (public.is_admin());

drop policy if exists referenced_lawyer_coverage_select_active_or_admin
on public.referenced_lawyer_coverage;
create policy referenced_lawyer_coverage_select_active_or_admin
on public.referenced_lawyer_coverage
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.referenced_lawyers lawyer
    where lawyer.id = referenced_lawyer_coverage.lawyer_id
      and lawyer.status = 'active'
      and lawyer.paid_placement_status in ('trial', 'active')
      and lawyer.accepts_judicial_auctions = true
  )
);

drop policy if exists referenced_lawyer_coverage_admin_insert
on public.referenced_lawyer_coverage;
create policy referenced_lawyer_coverage_admin_insert
on public.referenced_lawyer_coverage
for insert
to authenticated
with check (public.is_admin());

drop policy if exists referenced_lawyer_coverage_admin_update
on public.referenced_lawyer_coverage;
create policy referenced_lawyer_coverage_admin_update
on public.referenced_lawyer_coverage
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists referenced_lawyer_coverage_admin_delete
on public.referenced_lawyer_coverage;
create policy referenced_lawyer_coverage_admin_delete
on public.referenced_lawyer_coverage
for delete
to authenticated
using (public.is_admin());

drop policy if exists lawyer_referral_requests_select_authorized
on public.lawyer_referral_requests;
create policy lawyer_referral_requests_select_authorized
on public.lawyer_referral_requests
for select
to authenticated
using (
  requester_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists lawyer_referral_requests_insert_own
on public.lawyer_referral_requests;
create policy lawyer_referral_requests_insert_own
on public.lawyer_referral_requests
for insert
to authenticated
with check (requester_id = (select auth.uid()));

drop policy if exists lawyer_referral_requests_update_admin
on public.lawyer_referral_requests;
create policy lawyer_referral_requests_update_admin
on public.lawyer_referral_requests
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

notify pgrst, 'reload schema';

commit;
