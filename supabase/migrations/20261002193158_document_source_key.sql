begin;

-- Phase 1: add the replacement conflict target while the old worker may still
-- send ON CONFLICT (document_url).  Both targets coexist during rollout.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.auction_documents'::regclass
      and conname = 'auction_documents_source_url_document_url_key'
  ) then
    alter table public.auction_documents
      add constraint auction_documents_source_url_document_url_key
      unique (source_url, document_url);
  end if;
end;
$$;

commit;
