begin;

alter table public.auction_sales
  add column if not exists premium_readiness_score smallint,
  add column if not exists premium_readiness_status text not null default 'unassessed',
  add column if not exists premium_readiness_policy_version text,
  add column if not exists premium_readiness_factors jsonb not null default '{}'::jsonb,
  add column if not exists premium_readiness_blockers jsonb not null default '[]'::jsonb,
  add column if not exists premium_readiness_missing_fields jsonb not null default '[]'::jsonb,
  add column if not exists premium_readiness_evaluated_at timestamptz,
  add column if not exists premium_readiness_override text,
  add column if not exists premium_readiness_override_reason text,
  add column if not exists premium_readiness_override_by uuid references auth.users(id) on delete set null,
  add column if not exists premium_readiness_override_at timestamptz,
  add column if not exists premium_readiness_override_expires_at timestamptz;

alter table public.auction_sales
  drop constraint if exists auction_sales_premium_readiness_score_check,
  add constraint auction_sales_premium_readiness_score_check
    check (premium_readiness_score is null or premium_readiness_score between 0 and 100),
  drop constraint if exists auction_sales_premium_readiness_status_check,
  add constraint auction_sales_premium_readiness_status_check
    check (premium_readiness_status in ('unassessed','internal_only','needs_enrichment','premium_ready')),
  drop constraint if exists auction_sales_premium_readiness_factors_check,
  add constraint auction_sales_premium_readiness_factors_check
    check (jsonb_typeof(premium_readiness_factors) = 'object'),
  drop constraint if exists auction_sales_premium_readiness_blockers_check,
  add constraint auction_sales_premium_readiness_blockers_check
    check (jsonb_typeof(premium_readiness_blockers) = 'array'),
  drop constraint if exists auction_sales_premium_readiness_missing_fields_check,
  add constraint auction_sales_premium_readiness_missing_fields_check
    check (jsonb_typeof(premium_readiness_missing_fields) = 'array'),
  drop constraint if exists auction_sales_premium_readiness_override_check,
  add constraint auction_sales_premium_readiness_override_check
    check (premium_readiness_override is null or premium_readiness_override in ('hold','publish')),
  drop constraint if exists auction_sales_premium_readiness_override_reason_check,
  add constraint auction_sales_premium_readiness_override_reason_check
    check (
      premium_readiness_override is null
      or char_length(btrim(coalesce(premium_readiness_override_reason, ''))) between 8 and 2000
    );

comment on column public.auction_sales.premium_readiness_score is
  'Versioned factual completeness score. It is independent from investment_score.';
comment on column public.auction_sales.premium_readiness_status is
  'Editorial readiness band used to protect the Premium catalogue without deleting collected rows.';
comment on column public.auction_sales.premium_readiness_override is
  'Audited admin-only temporary or permanent hold/publish decision; it never deletes the sale.';

create index if not exists auction_sales_premium_readiness_queue_idx
  on public.auction_sales (premium_readiness_status, premium_readiness_score desc, sale_date)
  where status in ('upcoming','unknown','postponed');

create table if not exists public.catalogue_readiness_policy (
  singleton boolean primary key default true check (singleton),
  enforcement_enabled boolean not null default false,
  policy_version text not null default 'premium_readiness_v1',
  internal_only_max smallint not null default 54 check (internal_only_max between 0 and 99),
  premium_ready_min smallint not null default 75 check (premium_ready_min between 1 and 100),
  minimum_score_confidence numeric not null default 0.70
    check (minimum_score_confidence between 0 and 1),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (internal_only_max < premium_ready_min)
);

insert into public.catalogue_readiness_policy (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.catalogue_readiness_policy enable row level security;
revoke all on table public.catalogue_readiness_policy from public, anon, authenticated;
grant select on table public.catalogue_readiness_policy to authenticated;
grant select, insert, update, delete on table public.catalogue_readiness_policy to service_role;

drop policy if exists catalogue_readiness_policy_authenticated_read
  on public.catalogue_readiness_policy;
create policy catalogue_readiness_policy_authenticated_read
  on public.catalogue_readiness_policy for select
  to authenticated
  using (true);

create table if not exists public.auction_sale_readiness_history (
  id bigint generated always as identity primary key,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  readiness_score smallint,
  readiness_status text not null,
  policy_version text,
  factors jsonb not null default '{}'::jsonb,
  blockers jsonb not null default '[]'::jsonb,
  missing_fields jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz,
  override_decision text,
  override_reason text,
  override_by uuid references auth.users(id) on delete set null,
  override_at timestamptz,
  override_expires_at timestamptz,
  recorded_at timestamptz not null default now()
);

create index if not exists auction_sale_readiness_history_sale_idx
  on public.auction_sale_readiness_history (sale_id, recorded_at desc);

alter table public.auction_sale_readiness_history enable row level security;
revoke all on table public.auction_sale_readiness_history from public, anon, authenticated;
grant select, insert on table public.auction_sale_readiness_history to service_role;

create or replace function app_private.record_auction_sale_readiness_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and
     new.premium_readiness_score is not distinct from old.premium_readiness_score and
     new.premium_readiness_status is not distinct from old.premium_readiness_status and
     new.premium_readiness_policy_version is not distinct from old.premium_readiness_policy_version and
     new.premium_readiness_factors is not distinct from old.premium_readiness_factors and
     new.premium_readiness_blockers is not distinct from old.premium_readiness_blockers and
     new.premium_readiness_missing_fields is not distinct from old.premium_readiness_missing_fields and
     new.premium_readiness_evaluated_at is not distinct from old.premium_readiness_evaluated_at and
     new.premium_readiness_override is not distinct from old.premium_readiness_override and
     new.premium_readiness_override_reason is not distinct from old.premium_readiness_override_reason and
     new.premium_readiness_override_expires_at is not distinct from old.premium_readiness_override_expires_at then
    return new;
  end if;

  insert into public.auction_sale_readiness_history (
    sale_id, readiness_score, readiness_status, policy_version, factors,
    blockers, missing_fields, evaluated_at, override_decision, override_reason,
    override_by, override_at, override_expires_at
  ) values (
    new.id, new.premium_readiness_score, new.premium_readiness_status,
    new.premium_readiness_policy_version, new.premium_readiness_factors,
    new.premium_readiness_blockers, new.premium_readiness_missing_fields,
    new.premium_readiness_evaluated_at, new.premium_readiness_override,
    new.premium_readiness_override_reason, new.premium_readiness_override_by,
    new.premium_readiness_override_at, new.premium_readiness_override_expires_at
  );
  return new;
end;
$$;

drop trigger if exists auction_sales_record_readiness_history on public.auction_sales;
create trigger auction_sales_record_readiness_history
after insert or update of
  premium_readiness_score,
  premium_readiness_status,
  premium_readiness_policy_version,
  premium_readiness_factors,
  premium_readiness_blockers,
  premium_readiness_missing_fields,
  premium_readiness_evaluated_at,
  premium_readiness_override,
  premium_readiness_override_reason,
  premium_readiness_override_expires_at
on public.auction_sales
for each row execute function app_private.record_auction_sale_readiness_history();

create or replace function public.catalogue_readiness_allows_premium(
  p_readiness_status text,
  p_override text,
  p_override_expires_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not coalesce((
      select policy.enforcement_enabled
      from public.catalogue_readiness_policy policy
      where policy.singleton
    ), false) then true
    when p_override = 'hold'
      and (p_override_expires_at is null or p_override_expires_at > statement_timestamp()) then false
    when p_override = 'publish'
      and (p_override_expires_at is null or p_override_expires_at > statement_timestamp()) then true
    else p_readiness_status = 'premium_ready'
  end;
$$;

revoke all on function public.catalogue_readiness_allows_premium(text,text,timestamptz)
  from public, anon;
grant execute on function public.catalogue_readiness_allows_premium(text,text,timestamptz)
  to authenticated, service_role;

create or replace function public.set_catalogue_readiness_enforcement(p_enabled boolean)
returns public.catalogue_readiness_policy
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.catalogue_readiness_policy%rowtype;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;

  if p_enabled and exists (
    select 1
    from public.auction_sales sale
    where sale.status in ('upcoming','unknown','postponed')
      and (
        sale.premium_readiness_status = 'unassessed'
        or sale.premium_readiness_evaluated_at is null
        or sale.premium_readiness_policy_version is distinct from (
          select policy.policy_version
          from public.catalogue_readiness_policy policy
          where policy.singleton
        )
      )
  ) then
    raise exception using errcode = '55000',
      message = 'Catalogue readiness cannot be enforced while active sales remain unassessed.';
  end if;

  update public.catalogue_readiness_policy policy
  set enforcement_enabled = p_enabled,
      updated_by = (select auth.uid()),
      updated_at = statement_timestamp()
  where policy.singleton
  returning * into result;
  return result;
end;
$$;

revoke all on function public.set_catalogue_readiness_enforcement(boolean)
  from public, anon;
grant execute on function public.set_catalogue_readiness_enforcement(boolean)
  to authenticated, service_role;

create or replace function public.set_auction_sale_readiness_override(
  p_sale_id uuid,
  p_decision text,
  p_reason text,
  p_expires_at timestamptz default null
)
returns public.auction_sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.auction_sales%rowtype;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_decision not in ('hold','publish') then
    raise exception using errcode = '22023', message = 'Invalid readiness override.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 8 and 2000 then
    raise exception using errcode = '22023', message = 'A meaningful override reason is required.';
  end if;

  update public.auction_sales sale
  set premium_readiness_override = p_decision,
      premium_readiness_override_reason = btrim(p_reason),
      premium_readiness_override_by = (select auth.uid()),
      premium_readiness_override_at = statement_timestamp(),
      premium_readiness_override_expires_at = p_expires_at
  where sale.id = p_sale_id
  returning * into result;
  if result.id is null then
    raise exception using errcode = 'P0002', message = 'Sale not found.';
  end if;
  return result;
end;
$$;

revoke all on function public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)
  from public, anon;
grant execute on function public.set_auction_sale_readiness_override(uuid,text,text,timestamptz)
  to authenticated, service_role;

create or replace function public.clear_auction_sale_readiness_override(p_sale_id uuid)
returns public.auction_sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.auction_sales%rowtype;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  update public.auction_sales sale
  set premium_readiness_override = null,
      premium_readiness_override_reason = null,
      premium_readiness_override_by = null,
      premium_readiness_override_at = null,
      premium_readiness_override_expires_at = null
  where sale.id = p_sale_id
  returning * into result;
  if result.id is null then
    raise exception using errcode = 'P0002', message = 'Sale not found.';
  end if;
  return result;
end;
$$;

revoke all on function public.clear_auction_sale_readiness_override(uuid) from public, anon;
grant execute on function public.clear_auction_sale_readiness_override(uuid)
  to authenticated, service_role;

-- Premium full-detail reads become quality-gated only when the operator enables
-- the policy. Discovery remains unchanged during the shadow/calibration phase.
drop policy if exists auction_sales_authenticated_read on public.auction_sales;
create policy auction_sales_authenticated_read
on public.auction_sales for select
to authenticated
using (
  public.is_admin()
  or (
    public.has_analysis_access()
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
  )
);

commit;
