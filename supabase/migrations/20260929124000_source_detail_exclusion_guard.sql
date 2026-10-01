begin;

-- A cancelled source-detail job is not an exclusion.  The recurring admission
-- path deliberately ignores historical job status, so unavailable listing
-- identities need a durable, service-role-only registry with expiry where
-- the source may later return.
create table if not exists public.source_detail_exclusions (
  source_url text primary key
    check (char_length(btrim(source_url)) between 1 and 4096),
  source_name text not null
    check (char_length(btrim(source_name)) between 2 and 64),
  reason text not null
    check (char_length(btrim(reason)) between 2 and 200),
  active boolean not null default true,
  -- A source-not-found decision is a bounded suppression.  The seller
  -- catalogue identity exclusion is structural and therefore has no expiry.
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.source_detail_exclusions is
  'Service-role-only source-detail endpoints excluded until expiry or explicit registry change.';

create index if not exists source_detail_exclusions_active_idx
  on public.source_detail_exclusions (source_name, source_url)
  where active;

alter table public.source_detail_exclusions enable row level security;
revoke all on table public.source_detail_exclusions from public, anon, authenticated;
grant select, insert, update, delete on table public.source_detail_exclusions to service_role;

-- These six endpoints were verified during the production exhausted-queue
-- audit.  They are deliberately seeded by URL, rather than by a broad source
-- flag, so other valid listings from the same providers remain refreshable.
-- The five source-not-found records expire seven days after this migration is
-- applied; an inventory recheck can then reactivate them or renew the bounded
-- exclusion.  The seller catalogue identity exclusion is structural.
insert into public.source_detail_exclusions (
  source_url,
  source_name,
  reason,
  expires_at,
  metadata
)
values
  (
    'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
    'agrasc',
    'operator_seller_catalogue_without_listing_identity',
    null,
    jsonb_build_object(
      'job_id', 'c4be8774-db69-4323-aa3e-6e0841de8fb5',
      'evidence', 'AGRASC seller catalogue has no individual listing identity'
    )
  ),
  (
    'https://cessions.immobilier-etat.gouv.fr/biens/maison-dhabitation-au-mans-72-villa-de-la-cote',
    'cessions_etat',
    'source_not_found',
    statement_timestamp() + interval '7 days',
    jsonb_build_object(
      'job_id', '9f608de1-0a22-409d-9847-11d6963ae276',
      'evidence', 'Source detail returned HTTP 404'
    )
  ),
  (
    'https://www.immo-interactif.fr/encheres-en-ligne/appartement/paris-03-75003/2041438',
    'notaires',
    'source_not_found',
    statement_timestamp() + interval '7 days',
    jsonb_build_object(
      'job_id', '5a830a8f-b0e5-4388-8a9d-575e75f94e7f',
      'api_id', '2041438',
      'evidence', 'Notaires detail API returned HTTP 400 and listing is absent from the current inventory'
    )
  ),
  (
    'https://www.immo-interactif.fr/encheres-en-ligne/appartement/paris-09-75009/2059508',
    'notaires',
    'source_not_found',
    statement_timestamp() + interval '7 days',
    jsonb_build_object(
      'job_id', '46abb2a7-f3b6-4e5f-b74c-6d0b00b7c0a7',
      'api_id', '2059508',
      'evidence', 'Notaires detail API returned HTTP 400 and listing is absent from the current inventory'
    )
  ),
  (
    'https://www.immo-interactif.fr/encheres-en-ligne/maison/caumont-sur-durance-84/2080922',
    'notaires',
    'source_not_found',
    statement_timestamp() + interval '7 days',
    jsonb_build_object(
      'job_id', '4f02febf-ec48-4165-9e37-da711d42c86e',
      'api_id', '2080922',
      'evidence', 'Notaires detail API returned HTTP 400 and listing is absent from the current inventory'
    )
  ),
  (
    'https://www.immo-interactif.fr/encheres-en-ligne/maison/les-corvees-les-yys-28/2025069',
    'notaires',
    'source_not_found',
    statement_timestamp() + interval '7 days',
    jsonb_build_object(
      'job_id', '8337251f-aa38-4ccc-84cc-e1f675e39547',
      'api_id', '2025069',
      'evidence', 'Notaires detail API returned HTTP 400 and listing is absent from the current inventory'
    )
  )
on conflict (source_url) do update set
  source_name = excluded.source_name,
  reason = excluded.reason,
  active = true,
  expires_at = excluded.expires_at,
  metadata = excluded.metadata,
  updated_at = now();

create or replace function app_private.source_detail_url_is_excluded(p_source_url text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.source_detail_exclusions exclusion
    where exclusion.active
      and exclusion.source_url = p_source_url
      and (
        exclusion.expires_at is null
        or exclusion.expires_at > statement_timestamp()
      )
  );
$$;

revoke all on function app_private.source_detail_url_is_excluded(text)
  from public, anon, authenticated;
grant execute on function app_private.source_detail_url_is_excluded(text)
  to service_role;

comment on function app_private.source_detail_url_is_excluded(text) is
  'Returns true only for an active exact source-detail URL exclusion.';

-- The seller catalogue row is already quarantined in production.  Keep that
-- marker durable when a later catalogue upsert reuses the same canonical URL
-- and would otherwise remove publication_quarantine as part of normalization.
-- Only the seller-catalogue reason owns this marker; the five unavailable
-- listing URLs retain their historical sale rows and are not hidden here.
create or replace function app_private.preserve_source_detail_publication_quarantine()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.source_detail_exclusions exclusion
    where exclusion.active
      and exclusion.source_url = new.source_url
      and exclusion.reason = 'operator_seller_catalogue_without_listing_identity'
      and (
        exclusion.expires_at is null
        or exclusion.expires_at > statement_timestamp()
      )
  ) and coalesce(new.raw_payload->>'publication_quarantine', '') = '' then
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb)
      || jsonb_build_object('publication_quarantine', 'source_detail_excluded');
  end if;
  return new;
end;
$function$;

revoke all on function app_private.preserve_source_detail_publication_quarantine()
  from public, anon, authenticated;
grant execute on function app_private.preserve_source_detail_publication_quarantine()
  to service_role;

drop trigger if exists auction_sales_source_detail_publication_quarantine
  on public.auction_sales;
create trigger auction_sales_source_detail_publication_quarantine
before insert or update of source_url, raw_payload, status
on public.auction_sales
for each row
execute function app_private.preserve_source_detail_publication_quarantine();

-- Defense in depth for direct service-role inserts and future admission paths.
-- System inserts are skipped row-by-row so one excluded URL cannot abort a
-- whole recurring batch.  An explicit admin request fails loudly instead of
-- appearing to have created a refresh job.
create or replace function app_private.skip_excluded_source_detail_job()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.job_type = 'source_detail'
    and coalesce(new.status, 'queued') in ('queued', 'running')
    and app_private.source_detail_url_is_excluded(
      coalesce(new.detail_source_url, new.source_url)
    ) then
    if coalesce(new.request_origin, 'system') = 'admin_information_agent' then
      raise exception using
        errcode = 'P0001',
        message = 'SOURCE_DETAIL_EXCLUDED';
    end if;
    return null;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.skip_excluded_source_detail_job()
  from public, anon, authenticated;
grant execute on function app_private.skip_excluded_source_detail_job()
  to service_role;

drop trigger if exists auction_enrichment_jobs_source_detail_exclusion
  on public.auction_enrichment_jobs;
create trigger auction_enrichment_jobs_source_detail_exclusion
before insert or update of source_url, job_type, detail_source_url, status, request_origin
on public.auction_enrichment_jobs
for each row
execute function app_private.skip_excluded_source_detail_job();

-- Keep the public function identity stable while adding the registry predicate
-- before the limit.  This prevents excluded rows from consuming the batch
-- limit and starving valid source-detail candidates.
create or replace function public.enqueue_due_source_details_unlocked(
  p_now timestamptz default now(),
  p_limit integer default 500
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted integer;
begin
  if not exists (
    select 1
      from public.auction_pipeline_control
     where id
       and enabled
       and source_details_enabled
  ) then
    return 0;
  end if;

  with base as materialized (
    select
      s.source_url as canonical_url,
      s.source_name,
      s.sale_date,
      case
        when jsonb_typeof(s.raw_payload->'source_checks') = 'object'
          then s.raw_payload->'source_checks'
        else '{}'::jsonb
      end as checks,
      -- A sale less than 24 hours old cannot have reached its retention
      -- deadline unless an explicit sale window overrides the headline date.
      -- Avoid the expensive JSON/date calculation for the common case.
      case
        when s.sale_date > p_now - interval '24 hours'
          and not coalesce(s.sale_procedure ? 'sale_window', false)
          and not coalesce(s.sale_procedure ? 'sale_session', false)
          and not coalesce(s.raw_payload ? 'source_sale_schedule', false)
          then true
        else coalesce(
          app_private.sale_retention_deadline(
            s.sale_date, s.status, s.sale_procedure, s.raw_payload
          ) > p_now,
          true
        )
      end as retention_eligible
    from public.auction_sales s
    where s.status in ('active', 'upcoming', 'postponed', 'unknown')
  ),
  eligible_aliases as materialized (
    select
      b.canonical_url,
      b.sale_date,
      b.checks,
      u.source_name,
      u.source_url
    from base b
    cross join lateral (
      select
        b.source_name as source_name,
        b.canonical_url as source_url
      where b.canonical_url is not null

      union

      select
        o.source_name,
        o.source_url
      from public.auction_observations o
      where o.canonical_source_url = b.canonical_url

      union

      select
        c.value->>'source_name' as source_name,
        c.key as source_url
      from jsonb_each(b.checks) c
    ) u
    join public.auction_source_state state
      on state.source_name = u.source_name
    where u.source_url is not null
      and not app_private.source_detail_url_is_excluded(u.source_url)
      and state.enabled
      and (
        state.suspended_until is null
        or state.suspended_until <= p_now
      )
      and b.retention_eligible
  ),
  checked as materialized (
    select
      e.*,
      app_private.pipeline_checked_at(
        e.checks->e.source_url->>'checked_at',
        p_now
      ) as checked,
      case
        when e.sale_date between p_now and p_now + interval '7 days'
          then interval '5 hours'
        else interval '23 hours'
      end as cadence
    from eligible_aliases e
  ),
  due as (
    select
      c.*,
      'source_detail_v1:' ||
        md5(
          c.source_name || ':' ||
          c.source_url || ':' ||
          coalesce(extract(epoch from c.checked)::text, 'never') || ':' ||
          (p_now at time zone 'UTC')::date::text
        ) as signature
    from checked c
    where c.checked is null
       or c.checked + c.cadence <= p_now
  ),
  chosen as (
    select d.*
    from due d
    where not exists (
      select 1
      from public.auction_enrichment_jobs j
      where j.source_url = d.canonical_url
        and j.job_type = 'source_detail'
        and j.detail_source_name = d.source_name
        and j.detail_source_url = d.source_url
        and (
          j.input_hash = d.signature
          or j.status in ('queued', 'running')
          or (
            j.status = 'failed'
            and j.attempt_count < j.max_attempts
          )
        )
    )
    order by
      d.checked nulls first,
      d.canonical_url,
      d.source_name,
      d.source_url
    limit greatest(1, least(p_limit, 1000))
  )
  insert into public.auction_enrichment_jobs (
    source_url,
    job_type,
    input_hash,
    detail_source_name,
    detail_source_url,
    priority
  )
  select
    canonical_url,
    'source_detail',
    signature,
    source_name,
    source_url,
    100
  from chosen
  on conflict (source_url, job_type, input_hash) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

notify pgrst, 'reload schema';

commit;
