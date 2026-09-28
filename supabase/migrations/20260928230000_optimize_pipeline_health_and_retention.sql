begin;

-- Historic embedded aliases predate the normalized observation writer. Copy
-- only aliases without an existing owner; a conflicting owner needs review.
-- Future observations are written to auction_observations by the pipeline.
insert into public.auction_observations (
  source_url, source_name, canonical_source_url, observed_at
)
select distinct on (item->>'source_url')
  item->>'source_url',
  item->>'source_name',
  s.source_url,
  null
from public.auction_sales s
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(s.observations) = 'array'
    then s.observations else '[]'::jsonb end
) item
where nullif(item->>'source_url', '') is not null
  and nullif(item->>'source_name', '') is not null
order by item->>'source_url', s.updated_at desc nulls last
on conflict (source_url) do nothing;

-- Read compact normalized observation links instead of repeatedly detoasting and
-- expanding the large auction_sales.observations payload during every health tick.
-- The source_checks map remains the authority for the last successful check.
create or replace function public.auction_all_source_freshness(p_now timestamptz default now())
returns table(source_name text, active_listings bigint, fresh_listings bigint)
language sql stable security definer set search_path = '' as $$
  with active as materialized (
    select s.source_url, s.source_name, s.sale_date,
      case when jsonb_typeof(s.raw_payload->'source_checks') = 'object'
        then s.raw_payload->'source_checks' else '{}'::jsonb end as checks
    from public.auction_sales s
    where s.status in ('active', 'upcoming', 'postponed', 'unknown')
  ), links as (
    select a.source_url as canonical_url, a.source_name,
      a.source_url as checked_url, a.sale_date, a.checks
    from active a
    union all
    select a.source_url, o.source_name, o.source_url, a.sale_date, a.checks
    from active a
    join public.auction_observations o on o.canonical_source_url = a.source_url
    union all
    select a.source_url, c.value->>'source_name', c.key, a.sale_date, a.checks
    from active a
    cross join lateral jsonb_each(a.checks) c
  ), checked as materialized (
    select l.canonical_url, l.source_name, l.sale_date,
      app_private.pipeline_checked_at(l.checks->l.checked_url->>'checked_at') as checked_at
    from links l
    where l.source_name is not null and l.checked_url is not null
  ), latest as (
    select c.canonical_url, c.source_name, c.sale_date,
      max(c.checked_at) filter (where c.checked_at <= p_now) as checked_at
    from checked c
    group by c.canonical_url, c.source_name, c.sale_date
  )
  select l.source_name, count(*),
    count(*) filter (where l.checked_at >= p_now -
      case when l.sale_date between p_now and p_now + interval '7 days'
        then interval '6 hours' else interval '24 hours' end)
  from latest l
  group by l.source_name;
$$;
revoke all on function public.auction_all_source_freshness(timestamptz)
  from public, anon, authenticated;
grant execute on function public.auction_all_source_freshness(timestamptz)
  to service_role;

-- Only complete observations are candidates for the historical inventory
-- baseline used by observe_autonomous_pipeline().
create index if not exists auction_pipeline_observations_complete_source_time_idx
  on public.auction_pipeline_observations(source_name, observed_at desc)
  where metrics->>'inventory_complete' = 'true';

-- The deadline function can involve JSON and Paris date calculations. Exclude
-- rows that cannot yet be due before calling it for each candidate. Explicit
-- sale windows remain eligible even when the headline sale_date is in future.
create or replace function public.purge_expired_auction_sales(p_now timestamptz default statement_timestamp(), p_limit integer default 25)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  sale_row public.auction_sales%rowtype;
  previous_id uuid;
  bridge_result record;
  deleted_count integer := 0;
  remaining_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 or p_now is null then
    raise exception using errcode='22023',message='Retention requires a timestamp and batch size between 1 and 25.';
  end if;
  -- Same lock order as the existing archival bridge. Protect against concurrent
  -- collection updates while rechecking the deadline, bridging and deleting.
  if not pg_try_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0)) then
    return jsonb_build_object('deleted',0,'busy',true,'remaining',null);
  end if;
  lock table public.auction_sales in share row exclusive mode;
  for sale_row in
    select * from public.auction_sales s
    where (
      s.sale_date <= p_now - interval '24 hours'
      or s.sale_procedure ? 'sale_window'
      or s.sale_procedure ? 'sale_session'
      or s.raw_payload ? 'source_sale_schedule'
    )
    and app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) <= p_now
    order by s.sale_date,s.id limit p_limit
  loop
    select id into previous_id from public.auction_sales where id < sale_row.id order by id desc limit 1;
    select * into bridge_result from public.bridge_auction_sales_to_outcome_graph_batch(previous_id,1);
    if not bridge_result.complete or bridge_result.next_cursor <> sale_row.id then
      raise exception 'Incomplete statistical archive before retention';
    end if;

    insert into public.sale_retention_storage_queue(bucket,object_path)
      select storage_bucket,storage_path from public.information_agent_evidence_assets
      where sale_id=sale_row.id and storage_bucket='information-agent-evidence'
      union
      select 'information-agent-approved', metadata->>'approved_public_path'
      from public.information_agent_evidence_assets where sale_id=sale_row.id
        and nullif(metadata->>'approved_public_path','') is not null
      union
      select 'information-agent-approved',file_path from public.auction_documents
      where source_url=sale_row.source_url and file_path like sale_row.id::text || '/%'
        and document_url like '%/storage/v1/object/public/information-agent-approved/%'
      on conflict(bucket,object_path) do nothing;

    -- These FKs use SET NULL and would otherwise keep personal snapshots.
    delete from public.valuation_estimates where auction_sale_id=sale_row.id;
    delete from public.information_agent_missions where sale_id=sale_row.id;
    delete from public.lawyer_placement_events where sale_id=sale_row.id;
    delete from public.lawyer_referral_requests where sale_id=sale_row.id;
    delete from public.auction_observations where canonical_source_url=sale_row.source_url or source_url=sale_row.source_url;
    -- Reports, simulations/workspaces, favorites, documents, enrichments and
    -- information-agent cases cascade. Outcome Graph lineage remains preserved.
    delete from public.auction_sales where id=sale_row.id;
    deleted_count := deleted_count+1;
  end loop;
  select count(*) into remaining_count from public.auction_sales s
    where (
      s.sale_date <= p_now - interval '24 hours'
      or s.sale_procedure ? 'sale_window'
      or s.sale_procedure ? 'sale_session'
      or s.raw_payload ? 'source_sale_schedule'
    )
    and app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) <= p_now;
  return jsonb_build_object('deleted',deleted_count,'remaining',remaining_count,'busy',false);
end;
$$;
revoke all on function public.purge_expired_auction_sales(timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.purge_expired_auction_sales(timestamptz,integer)
  to service_role;

commit;
