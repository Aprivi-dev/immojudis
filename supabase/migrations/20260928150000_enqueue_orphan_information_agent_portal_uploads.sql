begin;

-- Signed portal uploads can be abandoned before /submit records an evidence
-- asset. Reuse the existing durable Storage deletion outbox after the upload
-- authorization has expired. The 24-hour delay is deliberately longer than
-- the two-hour signed-upload ticket, so an in-flight submission cannot race
-- the cleanup of its object.
create or replace function public.enqueue_orphan_information_agent_portal_uploads(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 100
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  enqueued integer;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using
      errcode = '22023',
      message = 'Portal upload cleanup requires a timestamp and batch size between 1 and 100.';
  end if;

  with orphan_objects as (
    select stored_object.name
    from storage.objects stored_object
    where stored_object.bucket_id = 'information-agent-evidence'
      and stored_object.name ~ '^[0-9a-f-]{36}/portal/[0-9a-f-]{36}/[^/]+$'
      and stored_object.created_at <= p_now - interval '24 hours'
      and not exists (
        select 1
        from public.information_agent_evidence_assets asset
        where asset.storage_bucket = 'information-agent-evidence'
          and asset.storage_path = stored_object.name
      )
    order by stored_object.created_at, stored_object.name
    limit p_limit
  )
  insert into public.sale_retention_storage_queue (bucket, object_path)
  select 'information-agent-evidence', orphan_objects.name
  from orphan_objects
  on conflict (bucket, object_path) do nothing;

  get diagnostics enqueued = row_count;
  return enqueued;
end;
$$;

revoke all on function public.enqueue_orphan_information_agent_portal_uploads(timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.enqueue_orphan_information_agent_portal_uploads(timestamptz, integer)
to service_role;

notify pgrst, 'reload schema';

commit;
