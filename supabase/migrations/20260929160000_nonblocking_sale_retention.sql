begin;

-- A collection writer can hold an incompatible lock longer than the HTTP
-- statement timeout. Skip this tick and retry five minutes later instead of
-- turning the retention cron into a failed job. Two due rows required almost
-- the full eight-second database statement budget in production, so process
-- at most one row per RPC while retaining the caller's bounded outer loop.
create or replace function public.purge_expired_auction_sales(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 25
)
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

  -- The bridge uses the same advisory key and takes SHARE on this table.
  -- Keep this order, but never wait behind an active sale writer.
  if not pg_try_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0)) then
    return jsonb_build_object('deleted',0,'busy',true,'remaining',null);
  end if;
  begin
    lock table public.auction_sales in share row exclusive mode nowait;
  exception when lock_not_available then
    return jsonb_build_object('deleted',0,'busy',true,'remaining',null);
  end;

  for sale_row in
    select * from public.auction_sales s
    where (
      s.sale_date <= p_now - interval '24 hours'
      or s.sale_procedure ? 'sale_window'
      or s.sale_procedure ? 'sale_session'
      or s.raw_payload ? 'source_sale_schedule'
    )
    and app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) <= p_now
    order by s.sale_date,s.id limit least(p_limit,1)
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

    delete from public.valuation_estimates where auction_sale_id=sale_row.id;
    delete from public.information_agent_missions where sale_id=sale_row.id;
    delete from public.lawyer_placement_events where sale_id=sale_row.id;
    delete from public.lawyer_referral_requests where sale_id=sale_row.id;
    delete from public.auction_observations where canonical_source_url=sale_row.source_url or source_url=sale_row.source_url;
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
