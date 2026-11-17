-- 20261205100000 (17/11/2026), famille de revendication enrichment_pdf : les lectures de pièces seules. Après un refus
-- du budget IA, les processus généraux continuent sur les pièces (aucun appel IA) sans toucher aux passes de faits,
-- qui restent en file sans perdre d'essai ; l'un des processus généraux sert les pièces d'abord.
begin;

select plan(9);

set local role service_role;

-- Rollback-only fixture: isolate the queue.
delete from public.auction_enrichment_jobs;
update public.auction_pipeline_control
   set enabled = true, source_details_enabled = true, queue_claim_not_before = null
 where id;

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-909-origin', 'https://example.test/pgtap/909/facts', 'upcoming', statement_timestamp() + interval '3 days',
   '{}'::jsonb),
  ('pgtap-909-origin', 'https://example.test/pgtap/909/near', 'upcoming', statement_timestamp() + interval '3 days',
   '{}'::jsonb),
  ('pgtap-909-origin', 'https://example.test/pgtap/909/far', 'upcoming', statement_timestamp() + interval '60 days',
   '{}'::jsonb);

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, locked_at, created_at, updated_at
)
values
  -- A fact pass whose sale has no document reading left: the best score of the queue (100 + 168).
  ('https://example.test/pgtap/909/facts', 'fact_extraction', 'queued', 100, 'pgtap-909-facts', 0, 4,
   statement_timestamp() - interval '1 minute', null, statement_timestamp() - interval '1 minute',
   statement_timestamp() - interval '1 minute'),
  -- Today's document reading of a sale in three days (10 + 24 + 168).
  ('https://example.test/pgtap/909/near', 'pdf', 'queued', 10, 'pgtap-909-near', 0, 4,
   statement_timestamp() - interval '1 minute', null, statement_timestamp() - interval '1 minute',
   statement_timestamp() - interval '1 minute'),
  -- A document reading of a distant sale whose worker died an hour ago (10 + 24 + 2).
  ('https://example.test/pgtap/909/far', 'pdf', 'running', 10, 'pgtap-909-far', 1, 4,
   statement_timestamp() - interval '2 hours', statement_timestamp() - interval '1 hour',
   statement_timestamp() - interval '2 hours', statement_timestamp() - interval '1 hour');

select is(
  (
    select count(*)::integer
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('claim_auction_enrichment_jobs_family', 'claim_auction_enrichment_jobs_request')
  ),
  2,
  'one signature per claim function: no new PostgREST overload'
);

select is(
  (select job_type from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  'fact_extraction',
  'the enrichment family keeps its order: the fact pass of the best score first'
);

-- Fixture reset: the fact pass is back in the queue, untouched.
update public.auction_enrichment_jobs
   set status = 'queued', attempt_count = 0, locked_at = null
 where input_hash = 'pgtap-909-facts';

create temporary table pgtap_909_request (request_id uuid primary key) on commit drop;
insert into pgtap_909_request values (gen_random_uuid());

create temporary table pgtap_909_claims (ordinal serial, input_hash text, job_type text) on commit drop;
insert into pgtap_909_claims (input_hash, job_type)
select input_hash, job_type
  from public.claim_auction_enrichment_jobs_request((select request_id from pgtap_909_request), 'enrichment_pdf', 10);

select is(
  (select array_agg(input_hash order by ordinal) from pgtap_909_claims),
  array['pgtap-909-near', 'pgtap-909-far'],
  'enrichment_pdf returns the document readings only, in the enrichment score order'
);

select ok(
  (
    select status = 'queued' and attempt_count = 0 and locked_at is null
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-909-facts'
  ),
  'the fact pass stays in the queue without spending an attempt'
);

select ok(
  (
    select status = 'running' and attempt_count = 2 and locked_at >= statement_timestamp() - interval '5 minutes'
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-909-far'
  ),
  'an expired document-reading lease is taken again with one more attempt'
);

select is(
  (
    select family
      from app_private.auction_enrichment_claim_receipts
     where request_id = (select request_id from pgtap_909_request)
  ),
  'enrichment_pdf',
  'the idempotency receipt records the new family'
);

select is(
  (
    select count(*)::integer
      from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment_pdf', 10)
  ),
  0,
  'with only a fact pass left, enrichment_pdf returns nothing (the worker stops instead of looping)'
);

select is(
  (select count(*)::integer from public.claim_auction_enrichment_jobs_family('source_detail', 10)),
  0,
  'source_detail never returns a document reading or a fact pass'
);

select throws_ok(
  $$select * from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment_facts', 1)$$,
  '22023',
  null,
  'an unknown family is still refused with 22023 (the worker falls back on it)'
);

select * from finish();

rollback;
