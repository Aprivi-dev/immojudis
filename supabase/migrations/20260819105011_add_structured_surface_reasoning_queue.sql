begin;

grant usage on schema app_private to service_role;

create table if not exists public.auction_surface_measurements (
  measurement_key text primary key,
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  asset_id text not null,
  lot_label text,
  level_label text,
  space_label text not null,
  category text not null check (
    category in ('habitable', 'circulation', 'sanitary', 'service', 'annex', 'exterior', 'land', 'unknown')
  ),
  value_m2 numeric not null check (value_m2 > 0 and value_m2 <= 10000),
  included_in_habitable_sum boolean,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  evidence_quote text not null,
  document_url text,
  document_label text,
  page_number integer check (page_number is null or page_number > 0),
  extraction_method text not null,
  reasoning_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auction_surface_derivations (
  derivation_key text primary key,
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  asset_id text not null,
  kind text not null check (
    kind in (
      'explicit_carrez', 'explicit_habitable', 'explicit_total', 'explicit_built',
      'calculated_room_sum', 'calculated_sale_sum', 'land', 'annex', 'unknown'
    )
  ),
  value_m2 numeric not null check (value_m2 > 0 and value_m2 <= 1000000),
  operand_measurement_keys jsonb not null default '[]'::jsonb check (
    jsonb_typeof(operand_measurement_keys) = 'array'
  ),
  formula text not null,
  validation_status text not null check (
    validation_status in ('verified', 'partial', 'contradicted', 'rejected')
  ),
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  explicit_candidate jsonb,
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  is_selected boolean not null default false,
  reasoning_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auction_enrichment_jobs (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  job_type text not null check (job_type in ('pdf', 'fact_extraction', 'display_description')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  priority integer not null default 0,
  input_hash text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 4 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_url, job_type, input_hash)
);

create index if not exists auction_surface_measurements_source_asset_idx
  on public.auction_surface_measurements (source_url, asset_id, category);
create index if not exists auction_surface_derivations_source_selected_idx
  on public.auction_surface_derivations (source_url, is_selected, validation_status);
create index if not exists auction_enrichment_jobs_claim_idx
  on public.auction_enrichment_jobs (priority desc, next_attempt_at, created_at)
  where status in ('queued', 'failed', 'running');

alter table public.auction_surface_measurements enable row level security;
alter table public.auction_surface_derivations enable row level security;
alter table public.auction_enrichment_jobs enable row level security;

revoke all on table public.auction_surface_measurements from public, anon, authenticated;
revoke all on table public.auction_surface_derivations from public, anon, authenticated;
revoke all on table public.auction_enrichment_jobs from public, anon, authenticated;

grant select, insert, update, delete on table public.auction_surface_measurements to service_role;
grant select, insert, update, delete on table public.auction_surface_derivations to service_role;
grant select, insert, update, delete on table public.auction_enrichment_jobs to service_role;
grant select on table public.auction_surface_measurements to authenticated;
grant select on table public.auction_surface_derivations to authenticated;

drop policy if exists auction_surface_measurements_analysis_read on public.auction_surface_measurements;
create policy auction_surface_measurements_analysis_read
on public.auction_surface_measurements
for select
to authenticated
using ((select public.has_analysis_access()));

drop policy if exists auction_surface_derivations_analysis_read on public.auction_surface_derivations;
create policy auction_surface_derivations_analysis_read
on public.auction_surface_derivations
for select
to authenticated
using ((select public.has_analysis_access()));

create or replace function app_private.enqueue_auction_surface_enrichment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input_hash text := md5(
    coalesce(new.content_hash, new.source_url || coalesce(new.documents::text, '[]'))
    || ':surface_reasoning_v1:auction_facts_v1:auction_display_v7:qwen3_7_plus'
  );
  v_has_documents boolean := jsonb_typeof(coalesce(new.documents, '[]'::jsonb)) = 'array'
    and jsonb_array_length(coalesce(new.documents, '[]'::jsonb)) > 0;
begin
  if v_has_documents then
    insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
    values (new.source_url, 'pdf', 30, v_input_hash)
    on conflict (source_url, job_type, input_hash) do nothing;
  end if;

  insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
  values (new.source_url, 'fact_extraction', 20, v_input_hash)
  on conflict (source_url, job_type, input_hash) do nothing;
  return new;
end;
$$;

revoke all on function app_private.enqueue_auction_surface_enrichment() from public, anon, authenticated;
grant execute on function app_private.enqueue_auction_surface_enrichment() to service_role;

drop trigger if exists auction_sales_enqueue_surface_enrichment on public.auction_sales;
create trigger auction_sales_enqueue_surface_enrichment
after insert or update of content_hash, documents on public.auction_sales
for each row execute function app_private.enqueue_auction_surface_enrichment();

create or replace function public.claim_auction_enrichment_jobs(p_limit integer default 10)
returns setof public.auction_enrichment_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select job.id
    from public.auction_enrichment_jobs as job
    where (
        job.status in ('queued', 'failed')
        or (
          job.status = 'running'
          and job.locked_at < statement_timestamp() - interval '30 minutes'
        )
      )
      and job.next_attempt_at <= statement_timestamp()
      and job.attempt_count < job.max_attempts
    order by job.priority desc, job.next_attempt_at, job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.auction_enrichment_jobs as job
  set
    status = 'running',
    attempt_count = job.attempt_count + 1,
    locked_at = statement_timestamp(),
    updated_at = statement_timestamp(),
    last_error = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

revoke all on function public.claim_auction_enrichment_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs(integer) to service_role;

insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
select
  sale.source_url,
  jobs.job_type,
  jobs.priority,
  md5(
    coalesce(sale.content_hash, sale.source_url || coalesce(sale.documents::text, '[]'))
    || ':surface_reasoning_v1:auction_facts_v1:auction_display_v7:qwen3_7_plus'
  )
from public.auction_sales as sale
cross join lateral (values ('fact_extraction'::text, 20)) as jobs(job_type, priority)
where sale.status in ('active', 'upcoming')
on conflict (source_url, job_type, input_hash) do nothing;

insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
select
  sale.source_url,
  'pdf',
  30,
  md5(
    coalesce(sale.content_hash, sale.source_url || coalesce(sale.documents::text, '[]'))
    || ':surface_reasoning_v1:auction_facts_v1:auction_display_v7:qwen3_7_plus'
  )
from public.auction_sales as sale
where sale.status in ('active', 'upcoming')
  and jsonb_typeof(coalesce(sale.documents, '[]'::jsonb)) = 'array'
  and jsonb_array_length(coalesce(sale.documents, '[]'::jsonb)) > 0
on conflict (source_url, job_type, input_hash) do nothing;

notify pgrst, 'reload schema';

commit;
