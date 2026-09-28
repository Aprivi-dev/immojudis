begin;

-- A data_refresh_requests row only runs cadastre and DPE enrichment. The
-- information agent needs a verified re-read of the listing itself, so its
-- preflight owns a source_detail job in the existing enrichment queue.
alter table public.auction_enrichment_jobs
  add column if not exists request_origin text not null default 'system',
  add column if not exists requested_by uuid references auth.users(id) on delete set null;

alter table public.auction_enrichment_jobs
  drop constraint if exists auction_enrichment_jobs_request_origin_check;

alter table public.auction_enrichment_jobs
  add constraint auction_enrichment_jobs_request_origin_check
  check (request_origin in ('system', 'admin_information_agent'));

create index if not exists auction_enrichment_jobs_admin_request_idx
  on public.auction_enrichment_jobs (requested_by, created_at desc)
  where request_origin = 'admin_information_agent';

create or replace function public.enqueue_admin_source_detail_bounded(
  p_admin_id uuid,
  p_sale_id uuid,
  p_force boolean default true
)
returns table (job_id uuid, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_value text;
  source_name_value text;
  pipeline_enabled boolean;
  source_details_enabled boolean;
  source_enabled boolean;
  suspended_until_value timestamptz;
  existing_id uuid;
  created_id uuid;
  admin_active_count integer;
  admin_daily_count integer;
  global_active_count integer;
  signature text;
  admin_active_limit constant integer := 3;
  admin_daily_limit constant integer := 12;
  global_active_limit constant integer := 12;
begin
  if p_admin_id is null or p_sale_id is null then
    raise exception using errcode = '22023', message = 'Admin source refresh user and sale are required.';
  end if;
  if not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = p_admin_id
      and profile.user_role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Admin access is required.';
  end if;

  select
    sale.source_url,
    sale.source_name,
    control.enabled,
    control.source_details_enabled,
    state.enabled,
    state.suspended_until
  into
    source_value,
    source_name_value,
    pipeline_enabled,
    source_details_enabled,
    source_enabled,
    suspended_until_value
  from public.auction_sales sale
  left join public.auction_pipeline_control control on control.id
  left join public.auction_source_state state on state.source_name = sale.source_name
  where sale.id = p_sale_id;

  if source_value is null or source_name_value is null then
    raise exception using errcode = 'P0002', message = 'Source detail unavailable for this sale.';
  end if;
  if not coalesce(pipeline_enabled, false) or not coalesce(source_details_enabled, false) then
    raise exception using errcode = 'P0001', message = 'ADMIN_SOURCE_DETAIL_PAUSED';
  end if;
  if not coalesce(source_enabled, false) then
    raise exception using errcode = 'P0001', message = 'ADMIN_SOURCE_DETAIL_SOURCE_DISABLED';
  end if;
  if suspended_until_value is not null and suspended_until_value > statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'ADMIN_SOURCE_DETAIL_SOURCE_SUSPENDED';
  end if;

  -- Serialize admission with the recurring source-detail wrapper below and
  -- with other admin requests. The active identity query is therefore atomic
  -- across both admission paths.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('source-detail:global', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('source-detail:sale:' || source_value, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('source-detail:admin:' || p_admin_id::text, 0)
  );

  select job.id
  into existing_id
  from public.auction_enrichment_jobs job
  where job.source_url = source_value
    and job.job_type = 'source_detail'
    and job.detail_source_name = source_name_value
    and job.detail_source_url = source_value
    and job.status in ('queued', 'running')
  order by job.priority desc, job.created_at desc
  limit 1;
  if existing_id is not null then
    return query select existing_id, true;
    return;
  end if;

  if not coalesce(p_force, true) then
    select job.id
    into existing_id
    from public.auction_enrichment_jobs job
    where job.source_url = source_value
      and job.job_type = 'source_detail'
      and job.detail_source_name = source_name_value
      and job.detail_source_url = source_value
      and job.status = 'completed'
    order by job.completed_at desc nulls last, job.created_at desc
    limit 1;
    if existing_id is not null then
      return query select existing_id, true;
      return;
    end if;
  end if;

  select count(*)::integer
  into admin_active_count
  from public.auction_enrichment_jobs job
  where job.requested_by = p_admin_id
    and job.request_origin = 'admin_information_agent'
    and job.status in ('queued', 'running');
  if admin_active_count >= admin_active_limit then
    raise exception using errcode = 'P0001', message = 'ADMIN_SOURCE_DETAIL_ADMIN_ACTIVE_LIMIT';
  end if;

  select count(*)::integer
  into admin_daily_count
  from public.auction_enrichment_jobs job
  where job.requested_by = p_admin_id
    and job.request_origin = 'admin_information_agent'
    and job.created_at >= statement_timestamp() - interval '24 hours';
  if admin_daily_count >= admin_daily_limit then
    raise exception using errcode = 'P0001', message = 'ADMIN_SOURCE_DETAIL_ADMIN_DAILY_LIMIT';
  end if;

  select count(*)::integer
  into global_active_count
  from public.auction_enrichment_jobs job
  where job.job_type = 'source_detail'
    and job.status in ('queued', 'running');
  if global_active_count >= global_active_limit then
    raise exception using errcode = 'P0001', message = 'ADMIN_SOURCE_DETAIL_GLOBAL_BACKPRESSURE';
  end if;

  signature := 'admin_source_detail_v1:' ||
    md5(p_sale_id::text || ':' || source_value || ':' || gen_random_uuid()::text);

  insert into public.auction_enrichment_jobs (
    source_url,
    job_type,
    input_hash,
    detail_source_name,
    detail_source_url,
    priority,
    request_origin,
    requested_by
  ) values (
    source_value,
    'source_detail',
    signature,
    source_name_value,
    source_value,
    120,
    'admin_information_agent',
    p_admin_id
  )
  returning id into created_id;

  return query select created_id, false;
end;
$$;

revoke all on function public.enqueue_admin_source_detail_bounded(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_admin_source_detail_bounded(uuid, uuid, boolean)
  to service_role;

comment on function public.enqueue_admin_source_detail_bounded(uuid, uuid, boolean) is
  'Service-role-only, admin-gated bounded admission for an exact listing source_detail re-read.';

-- The recurring enqueue function predates the admin path and did not take the
-- same admission lock. Preserve the public function's identity and OID while
-- moving its implementation under an internal name. A rename would leave
-- cached callers able to invoke the old OID without the new wrapper lock.
do $$
begin
  perform pg_catalog.set_config(
    'immojudis.enqueue_due_source_details_oid',
    ('public.enqueue_due_source_details(timestamptz,integer)'::regprocedure)::oid::text,
    true
  );
end;
$$;

create function public.enqueue_due_source_details_unlocked(
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
        when jsonb_typeof(s.observations) = 'array' then s.observations
        else '[]'::jsonb
      end as observations,
      case
        when jsonb_typeof(s.raw_payload->'source_checks') = 'object'
          then s.raw_payload->'source_checks'
        else '{}'::jsonb
      end as checks,
      app_private.sale_retention_deadline(
        s.sale_date,
        s.status,
        s.sale_procedure,
        s.raw_payload
      ) as retention_deadline
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
        o.value->>'source_name' as source_name,
        o.value->>'source_url' as source_url
      from jsonb_array_elements(b.observations) o

      union

      select
        c.value->>'source_name' as source_name,
        c.key as source_url
      from jsonb_each(b.checks) c
    ) u
    join public.auction_source_state state
      on state.source_name = u.source_name
    where u.source_url is not null
      and state.enabled
      and (
        state.suspended_until is null
        or state.suspended_until <= p_now
      )
      and (
        b.retention_deadline is null
        or b.retention_deadline > p_now
      )
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

create or replace function public.enqueue_due_source_details(
  p_now timestamptz default now(),
  p_limit integer default 500
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('source-detail:global', 0)
  );
  return public.enqueue_due_source_details_unlocked(p_now, p_limit);
end;
$$;

do $$
declare
  before_oid oid :=
    pg_catalog.current_setting(
      'immojudis.enqueue_due_source_details_oid',
      true
    )::oid;
  after_oid oid :=
    ('public.enqueue_due_source_details(timestamptz,integer)'::regprocedure)::oid;
begin
  if before_oid is null or after_oid is distinct from before_oid then
    raise exception
      'enqueue_due_source_details OID changed during wrapper installation (before %, after %)',
      before_oid,
      after_oid;
  end if;
end;
$$;

revoke all on function public.enqueue_due_source_details_unlocked(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_due_source_details_unlocked(timestamptz, integer)
  to service_role;
revoke all on function public.enqueue_due_source_details(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_due_source_details(timestamptz, integer)
  to service_role;

comment on function public.enqueue_due_source_details(timestamptz, integer) is
  'Recurring source_detail admission serialized with bounded admin source refresh admission.';

notify pgrst, 'reload schema';

commit;
