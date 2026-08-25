begin;

-- Ordinary catalogue scans now generate only the public description with the
-- pinned, low-cost Qwen2 7B model. PDF jobs remain independent; full factual
-- extraction can still be launched explicitly by the worker when required.
create or replace function app_private.enqueue_auction_surface_enrichment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input_hash text := md5(
    coalesce(new.content_hash, new.source_url || coalesce(new.documents::text, '[]'))
    || ':auction_display_v8:qwen2_7b_instruct'
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
  values (new.source_url, 'display_description', 20, v_input_hash)
  on conflict (source_url, job_type, input_hash) do nothing;
  return new;
end;
$$;

revoke all on function app_private.enqueue_auction_surface_enrichment() from public, anon, authenticated;
grant execute on function app_private.enqueue_auction_surface_enrichment() to service_role;

-- Give currently visible sales one job under the new model/prompt fingerprint.
-- The unique constraint makes this migration and subsequent upserts idempotent.
insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
select
  sale.source_url,
  'display_description',
  20,
  md5(
    coalesce(sale.content_hash, sale.source_url || coalesce(sale.documents::text, '[]'))
    || ':auction_display_v8:qwen2_7b_instruct'
  )
from public.auction_sales as sale
where sale.status in ('active', 'upcoming')
on conflict (source_url, job_type, input_hash) do nothing;

commit;
