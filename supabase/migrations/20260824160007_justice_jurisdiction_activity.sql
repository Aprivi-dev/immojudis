begin;

create table public.justice_jurisdiction_activity_imports (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  source_url text not null,
  source_version text not null,
  parser_version text not null,
  period_start_year integer not null,
  period_end_year integer not null,
  fetched_at timestamptz not null,
  content_hash text not null,
  source_row_count integer not null,
  matched_row_count integer not null,
  unmatched_row_count integer not null,
  national_new_cases_status text not null,
  national_new_cases_value integer,
  national_terminated_cases_status text not null,
  national_terminated_cases_value integer,
  created_at timestamptz not null default now(),
  constraint justice_jurisdiction_activity_imports_period_check check (
    period_start_year between 1900 and 2100
    and period_end_year = period_start_year
  ),
  constraint justice_jurisdiction_activity_imports_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint justice_jurisdiction_activity_imports_version_check check (
    source_version ~ '^v[0-9]{2}\.[0-9]{2}\.[0-9]+$'
    and nullif(btrim(parser_version), '') is not null
  ),
  constraint justice_jurisdiction_activity_imports_counts_check check (
    source_row_count >= 0
    and matched_row_count >= 0
    and unmatched_row_count >= 0
    and source_row_count = matched_row_count + unmatched_row_count
  ),
  constraint justice_jurisdiction_activity_imports_new_metric_check check (
    (
      national_new_cases_status = 'observed'
      and national_new_cases_value is not null
      and national_new_cases_value >= 0
    )
    or (
      national_new_cases_status in ('suppressed', 'missing')
      and national_new_cases_value is null
    )
  ),
  constraint justice_jurisdiction_activity_imports_terminated_metric_check check (
    (
      national_terminated_cases_status = 'observed'
      and national_terminated_cases_value is not null
      and national_terminated_cases_value >= 0
    )
    or (
      national_terminated_cases_status in ('suppressed', 'missing')
      and national_terminated_cases_value is null
    )
  ),
  unique (source_id, content_hash, parser_version)
);

create table public.justice_jurisdiction_activity (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.justice_jurisdiction_activity_imports(id) on delete restrict,
  court_id uuid references public.outcome_courts(id) on delete restrict,
  source_court_code text not null,
  source_court_name text not null,
  activity_year integer not null,
  match_status text not null,
  match_details jsonb not null default '{}'::jsonb,
  new_cases_status text not null,
  new_cases_value integer,
  terminated_cases_status text not null,
  terminated_cases_value integer,
  canonical_hash text not null,
  created_at timestamptz not null default now(),
  constraint justice_jurisdiction_activity_source_code_check check (
    source_court_code ~ '^[0-9]{8}$' and source_court_code <> '00000000'
  ),
  constraint justice_jurisdiction_activity_year_check check (
    activity_year between 1900 and 2100
  ),
  constraint justice_jurisdiction_activity_hash_check check (
    canonical_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint justice_jurisdiction_activity_match_check check (
    (match_status in ('exact_official_reference', 'exact_code', 'exact_name') and court_id is not null)
    or (match_status in ('ambiguous', 'unmatched') and court_id is null)
  ),
  constraint justice_jurisdiction_activity_match_details_check check (
    jsonb_typeof(match_details) = 'object'
  ),
  constraint justice_jurisdiction_activity_new_metric_check check (
    (new_cases_status = 'observed' and new_cases_value is not null and new_cases_value >= 0)
    or (new_cases_status in ('suppressed', 'missing') and new_cases_value is null)
  ),
  constraint justice_jurisdiction_activity_terminated_metric_check check (
    (
      terminated_cases_status = 'observed'
      and terminated_cases_value is not null
      and terminated_cases_value >= 0
    )
    or (terminated_cases_status in ('suppressed', 'missing') and terminated_cases_value is null)
  ),
  unique (import_id, source_court_code, activity_year)
);

create index justice_jurisdiction_activity_court_year_idx
on public.justice_jurisdiction_activity(court_id, activity_year desc)
where court_id is not null;

create index justice_jurisdiction_activity_import_idx
on public.justice_jurisdiction_activity(import_id);

create or replace function app_private.validate_justice_jurisdiction_activity_import()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  source_policy public.data_sources%rowtype;
begin
  select source.* into source_policy
  from public.data_sources source
  where source.id = new.source_id
  for share;

  if not found
    or source_policy.name <> 'justice_jurisdiction_statistics'
    or not source_policy.official
    or not source_policy.active
    or source_policy.legal_review_status <> 'approved'
    or source_policy.ingestion_policy <> 'allowed_automated' then
    raise exception using
      errcode = '23514',
      message = 'Justice jurisdiction activity imports require the approved active automated source policy.';
  end if;

  if new.source_url <> 'https://www.stats.justice.gouv.fr/statjur/html/ajaxService.php' then
    raise exception using
      errcode = '23514',
      message = 'Justice jurisdiction activity imports require the reviewed StatJur endpoint.';
  end if;

  return new;
end;
$$;

create or replace function app_private.reject_justice_jurisdiction_activity_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Justice jurisdiction activity evidence is append-only.';
end;
$$;

create or replace function app_private.validate_justice_jurisdiction_activity_record()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  import_row public.justice_jurisdiction_activity_imports%rowtype;
begin
  select import_record.* into import_row
  from public.justice_jurisdiction_activity_imports import_record
  where import_record.id = new.import_id
  for share;

  if not found or new.activity_year <> import_row.period_start_year then
    raise exception using
      errcode = '23514',
      message = 'Justice jurisdiction activity year must match its immutable import period.';
  end if;
  return new;
end;
$$;

create trigger justice_jurisdiction_activity_import_policy
before insert on public.justice_jurisdiction_activity_imports
for each row execute function app_private.validate_justice_jurisdiction_activity_import();

create trigger justice_jurisdiction_activity_imports_immutable
before update or delete on public.justice_jurisdiction_activity_imports
for each row execute function app_private.reject_justice_jurisdiction_activity_mutation();

create trigger justice_jurisdiction_activity_imports_no_truncate
before truncate on public.justice_jurisdiction_activity_imports
for each statement execute function app_private.reject_justice_jurisdiction_activity_mutation();

create trigger justice_jurisdiction_activity_immutable
before update or delete on public.justice_jurisdiction_activity
for each row execute function app_private.reject_justice_jurisdiction_activity_mutation();

create trigger justice_jurisdiction_activity_record_guard
before insert on public.justice_jurisdiction_activity
for each row execute function app_private.validate_justice_jurisdiction_activity_record();

create trigger justice_jurisdiction_activity_no_truncate
before truncate on public.justice_jurisdiction_activity
for each statement execute function app_private.reject_justice_jurisdiction_activity_mutation();

insert into public.data_sources (
  name,
  publisher,
  official,
  base_url,
  terms_url,
  legal_review_status,
  ingestion_policy,
  rate_limit,
  personal_data_possible,
  active
) values (
  'justice_jurisdiction_statistics',
  'Ministère de la Justice',
  true,
  'https://www.stats.justice.gouv.fr/statjur/html',
  'https://www.stats.justice.gouv.fr/statjur/html/index.php',
  'pending',
  'disabled',
  '{"requests_per_second": 0.25, "burst": 1}'::jsonb,
  false,
  false
)
on conflict (name) do nothing;

do $$
begin
  if not exists (
    select 1
    from public.data_sources source
    where source.name = 'justice_jurisdiction_statistics'
      and source.publisher = 'Ministère de la Justice'
      and source.official
      and source.base_url = 'https://www.stats.justice.gouv.fr/statjur/html'
      and source.terms_url = 'https://www.stats.justice.gouv.fr/statjur/html/index.php'
      and source.license is null
      and source.legal_review_status = 'pending'
      and source.ingestion_policy = 'disabled'
      and not source.personal_data_possible
      and not source.active
  ) then
    raise exception using
      errcode = '23514',
      message = 'The StatJur source policy conflicts with the reviewed disabled default.';
  end if;
end;
$$;

alter table public.justice_jurisdiction_activity_imports enable row level security;
alter table public.justice_jurisdiction_activity enable row level security;

revoke all on table
  public.justice_jurisdiction_activity_imports,
  public.justice_jurisdiction_activity
from public, anon, authenticated;

grant select, insert on table
  public.justice_jurisdiction_activity_imports,
  public.justice_jurisdiction_activity
to service_role;

revoke all on function app_private.validate_justice_jurisdiction_activity_import()
from public, anon, authenticated;
revoke all on function app_private.reject_justice_jurisdiction_activity_mutation()
from public, anon, authenticated;
revoke all on function app_private.validate_justice_jurisdiction_activity_record()
from public, anon, authenticated;

comment on table public.justice_jurisdiction_activity_imports is
  'Immutable import evidence for historical StatJur TGI/TJ civil activity. National metrics are historical references, not current catalogue denominators.';
comment on table public.justice_jurisdiction_activity is
  'Immutable historical counts of new and terminated real-estate seizure/sale matters by jurisdiction; NC remains distinct from missing and zero.';
comment on column public.justice_jurisdiction_activity.new_cases_status is
  'observed, suppressed (official NC: non-zero value below five), or missing.';
comment on column public.justice_jurisdiction_activity.terminated_cases_status is
  'observed, suppressed (official NC: non-zero value below five), or missing.';

commit;
