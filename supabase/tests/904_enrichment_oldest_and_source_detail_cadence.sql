-- 20261201100000 (16/11/2026), file d'enrichissement :
--   * famille enrichment_oldest : une lecture de pièces au bail expiré depuis 5 jours, d'une vente lointaine, est
--     servie devant une lecture de pièces du jour d'une vente proche ; la famille enrichment garde son ordre (bonus de
--     168 points d'une vente dans les 7 jours) ; la revendication idempotente et ses reçus admettent la famille ;
--   * enqueue_due_source_details_unlocked suit la politique de relecture moins une heure : 71 h, 23 h pour Licitor,
--     5 h pour une audience dans les 7 jours (au lieu de 23 h / 5 h pour toutes).
begin;

select plan(6);

set local role service_role;

-- Rollback-only fixture: isolate the queue.
delete from public.auction_enrichment_jobs;
update public.auction_pipeline_control
   set enabled = true, source_details_enabled = true, queue_claim_not_before = null
 where id;

-- 1. enrichment_oldest ----------------------------------------------------------------------------------------------

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-904-origin', 'https://example.test/pgtap/904/far', 'upcoming', statement_timestamp() + interval '60 days',
   '{}'::jsonb),
  ('pgtap-904-origin', 'https://example.test/pgtap/904/near', 'upcoming', statement_timestamp() + interval '3 days',
   '{}'::jsonb);

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, locked_at, created_at, updated_at
)
values
  -- A worker died five days ago during the first attempt; the sale is two months away (score 10 + 144 + 24).
  ('https://example.test/pgtap/904/far', 'pdf', 'running', 10, 'pgtap-904-far', 1, 4,
   statement_timestamp() - interval '5 days 1 minute', statement_timestamp() - interval '5 days',
   statement_timestamp() - interval '6 days', statement_timestamp() - interval '5 days'),
  -- Today's document reading of a sale in three days (score 10 + 0 + 24 + 168). Due before the transaction start:
  -- the claim compares next_attempt_at with now().
  ('https://example.test/pgtap/904/near', 'pdf', 'queued', 10, 'pgtap-904-near', 0, 4,
   statement_timestamp() - interval '1 minute', null, statement_timestamp() - interval '1 minute',
   statement_timestamp() - interval '1 minute');

select throws_ok(
  $$select * from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment_newest', 1)$$,
  '22023',
  null,
  'an unknown family is still refused with 22023 (the worker falls back on it)'
);

select is(
  (select source_url from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  'https://example.test/pgtap/904/near',
  'the enrichment family keeps its order: the near sale first'
);

-- Fixture reset: today's near-sale reading is back in the queue, both jobs are claimable again.
update public.auction_enrichment_jobs
   set status = 'queued', attempt_count = 0, locked_at = null
 where input_hash = 'pgtap-904-near';

create temporary table pgtap_904_request (request_id uuid primary key) on commit drop;
insert into pgtap_904_request values (gen_random_uuid());

select is(
  (
    select source_url
      from public.claim_auction_enrichment_jobs_request(
        (select request_id from pgtap_904_request), 'enrichment_oldest', 1
      )
  ),
  'https://example.test/pgtap/904/far',
  'enrichment_oldest serves the reading whose lease expired five days ago before today''s near-sale reading'
);

select ok(
  (
    select status = 'running' and attempt_count = 2 and locked_at >= statement_timestamp() - interval '5 minutes'
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-904-far'
  ),
  'the expired lease is taken again with one more attempt'
);

select is(
  (
    select family
      from app_private.auction_enrichment_claim_receipts
     where request_id = (select request_id from pgtap_904_request)
  ),
  'enrichment_oldest',
  'the idempotency receipt records the new family'
);

-- 2. Cadence des tâches source_detail ------------------------------------------------------------------------------

delete from public.auction_enrichment_jobs;
insert into public.auction_source_state (source_name, enabled, suspended_until, next_inventory_at)
values ('pgtap-904-detail', true, null, statement_timestamp() + interval '1 day'),
       ('licitor', true, null, statement_timestamp() + interval '1 day')
on conflict (source_name) do update set enabled = true, suspended_until = null;

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
select fixture.source_name,
       fixture.url,
       'upcoming',
       statement_timestamp() + fixture.sale_in,
       jsonb_build_object(
         'source_checks',
         jsonb_build_object(
           fixture.url,
           jsonb_build_object(
             'source_name', fixture.source_name,
             'checked_at', statement_timestamp() - fixture.checked_ago
           )
         )
       )
  from (
    values
      ('pgtap-904-detail', 'https://example.test/pgtap/904/detail/far-30h', interval '60 days', interval '30 hours'),
      ('pgtap-904-detail', 'https://example.test/pgtap/904/detail/far-72h', interval '60 days', interval '72 hours'),
      ('licitor', 'https://example.test/pgtap/904/detail/licitor-20h', interval '60 days', interval '20 hours'),
      ('licitor', 'https://example.test/pgtap/904/detail/licitor-30h', interval '60 days', interval '30 hours'),
      ('pgtap-904-detail', 'https://example.test/pgtap/904/detail/near-4h', interval '3 days', interval '4 hours'),
      ('pgtap-904-detail', 'https://example.test/pgtap/904/detail/near-6h', interval '3 days', interval '6 hours')
  ) as fixture(source_name, url, sale_in, checked_ago);

delete from public.auction_enrichment_jobs;

select public.enqueue_due_source_details_unlocked(statement_timestamp(), 1000);

select is(
  (
    select array_agg(detail_source_url order by detail_source_url)
      from public.auction_enrichment_jobs
     where job_type = 'source_detail'
       and detail_source_url like 'https://example.test/pgtap/904/detail/%'
  ),
  array[
    'https://example.test/pgtap/904/detail/far-72h',
    'https://example.test/pgtap/904/detail/licitor-30h',
    'https://example.test/pgtap/904/detail/near-6h'
  ],
  'source details are due after 71 h, 23 h for Licitor and 5 h within 7 days of the hearing'
);

select * from finish();

rollback;
