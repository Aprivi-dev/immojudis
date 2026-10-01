begin;

-- The recurring source-detail admission query checks both the exact revision
-- signature and the currently open identity.  Keep the open identity lookup
-- selective so each due alias does not scan the full enrichment history.
create index if not exists auction_enrichment_jobs_source_detail_open_idx
  on public.auction_enrichment_jobs (
    source_url,
    detail_source_name,
    detail_source_url
  )
  where job_type = 'source_detail'
    and (
      status in ('queued', 'running')
      or (status = 'failed' and attempt_count < max_attempts)
    );

-- Keep the public function identity stable.  Splitting the original OR into
-- two anti-joins lets PostgreSQL use the existing unique signature index for
-- completed revisions and the partial open-identity index above for active or
-- retryable work.  The two predicates are logically equivalent to the
-- original single NOT EXISTS with an OR predicate.
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
        and j.input_hash = d.signature
    )
      and not exists (
        select 1
        from public.auction_enrichment_jobs j
        where j.source_url = d.canonical_url
          and j.job_type = 'source_detail'
          and j.detail_source_name = d.source_name
          and j.detail_source_url = d.source_url
          and (
            j.status in ('queued', 'running')
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
