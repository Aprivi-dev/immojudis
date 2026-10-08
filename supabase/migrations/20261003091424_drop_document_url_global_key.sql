begin;

-- Phase 2: run only after the worker using the composite target is deployed
-- and old workers have drained.  The function replacement is in the same
-- transaction as the constraint removal so reviewed information-agent
-- documents never reach an ON CONFLICT target that no longer exists.
do $$
declare
  function_definition text;
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.auction_documents'::regclass
      and conname = 'auction_documents_source_url_document_url_key'
  ) then
    raise exception 'Composite auction_documents conflict target is missing';
  end if;

  if to_regprocedure(
    'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'
  ) is not null then
    select pg_get_functiondef(
      to_regprocedure(
        'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'
      )
    )
    into function_definition;
    if function_definition ~* 'on[[:space:]]+conflict[[:space:]]*[(][[:space:]]*document_url[[:space:]]*[)]' then
      execute regexp_replace(
        function_definition,
        'on[[:space:]]+conflict[[:space:]]*[(][[:space:]]*document_url[[:space:]]*[)]',
        'on conflict (source_url, document_url)',
        'gi'
      );
    end if;
  end if;
end;
$$;

alter table public.auction_documents
  drop constraint if exists auction_documents_document_url_key;

commit;
