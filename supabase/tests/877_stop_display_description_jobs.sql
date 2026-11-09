-- 20261112110000 : le déclencheur de secours des ventes ne crée plus de tâche display_description
-- (synthèse rédigée par le modèle retirée) ; la tâche pdf d'une vente avec pièces reste créée.
begin;

select plan(5);

select ok(
  position('display_description' in pg_get_functiondef(
    'app_private.enqueue_auction_surface_enrichment()'::regprocedure
  )) = 0
  and position('''pdf''' in pg_get_functiondef(
    'app_private.enqueue_auction_surface_enrichment()'::regprocedure
  )) > 0,
  'the fallback trigger names no display_description job and keeps the pdf job'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.enqueue_auction_surface_enrichment()'::regprocedure
  ),
  'the trigger function keeps invoker security, an empty search_path and service-only ACLs'
);

-- Un écrivain autre que la publication Python : le déclencheur de secours s'applique.
select set_config('app.pipeline_queue_owner', '', true);

insert into public.auction_source_state(source_name, enabled, suspended_until)
values ('pgtap-877', true, null);

insert into public.auction_sales(source_name, source_url, status, sale_date, documents, content_hash, raw_payload)
values
  ('pgtap-877', 'https://example.test/pgtap/877/with-documents', 'upcoming', now() + interval '30 days',
   jsonb_build_array(jsonb_build_object('label', 'CCV', 'url', 'https://example.test/pgtap/877/ccv.pdf')),
   'pgtap-877-with-documents', '{}'::jsonb),
  ('pgtap-877', 'https://example.test/pgtap/877/without-documents', 'upcoming', now() + interval '30 days',
   '[]'::jsonb, 'pgtap-877-without-documents', '{}'::jsonb);

select is(
  (select count(*) from public.auction_enrichment_jobs
    where source_url like 'https://example.test/pgtap/877/%' and job_type = 'display_description'),
  0::bigint,
  'no display_description job is created for an upcoming sale'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/877/with-documents' and job_type = 'pdf'),
  1::bigint,
  'a sale with documents still gets its pdf job'
);

update public.auction_sales
   set content_hash = 'pgtap-877-with-documents-v2'
 where source_url = 'https://example.test/pgtap/877/with-documents';

select is(
  (select count(*) from public.auction_enrichment_jobs
    where source_url like 'https://example.test/pgtap/877/%' and job_type = 'display_description'),
  0::bigint,
  'a content change creates no display_description job either'
);

select * from finish();
rollback;
