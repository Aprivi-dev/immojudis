-- Voie d'enrichissement parallèle (17/11/2026) : un processus de fiches et jusqu'à trois processus de pièces et de
-- faits revendiquent côte à côte. Aucune migration : la protection par vente existe déjà
-- (public.claim_auction_enrichment_jobs_family, 20261201100000) et toutes les revendications du pipeline passent par
-- public.claim_auction_enrichment_jobs_request, qui les sérialise par un verrou de transaction global avant la
-- revendication. Ce test prouve, à la suite des revendications que ce verrou impose : jamais deux tâches de la même
-- vente, et chaque famille ne rend que ses tâches.
begin;

select plan(9);

set local role service_role;

-- Rollback-only fixture: isolate the queue.
delete from public.auction_enrichment_jobs;
update public.auction_pipeline_control
   set enabled = true, source_details_enabled = true, queue_claim_not_before = null
 where id;

insert into public.auction_source_state (source_name, enabled, next_inventory_at)
values ('pgtap-907-src', true, statement_timestamp() + interval '1 day');

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-907-src', 'https://example.test/pgtap/907/a', 'upcoming', statement_timestamp() + interval '20 days',
   '{}'::jsonb),
  ('pgtap-907-src', 'https://example.test/pgtap/907/b', 'upcoming', statement_timestamp() + interval '20 days',
   '{}'::jsonb);

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, next_attempt_at, detail_source_name, detail_source_url
)
values
  ('https://example.test/pgtap/907/a', 'pdf', 'queued', 100, 'pgtap-907-a-pdf',
   statement_timestamp() - interval '1 minute', null, null),
  ('https://example.test/pgtap/907/a', 'fact_claims', 'queued', 90, 'pgtap-907-a-claims',
   statement_timestamp() - interval '1 minute', null, null),
  ('https://example.test/pgtap/907/a', 'source_detail', 'queued', 80, 'pgtap-907-a-detail',
   statement_timestamp() - interval '1 minute', 'pgtap-907-src', 'https://example.test/pgtap/907/a'),
  ('https://example.test/pgtap/907/b', 'pdf', 'queued', 10, 'pgtap-907-b-pdf',
   statement_timestamp() - interval '1 minute', null, null);

create temporary table pgtap_907_claims (
  ordinal integer,
  family text,
  job_id uuid,
  job_type text,
  source_url text
) on commit drop;

-- Four workers, one claim each, in the order the global claim lock serialises them: three general workers and the
-- source-detail worker.
insert into pgtap_907_claims
select 1, 'enrichment', id, job_type, source_url
  from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment', 1);
insert into pgtap_907_claims
select 2, 'enrichment', id, job_type, source_url
  from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment_oldest', 1);
insert into pgtap_907_claims
select 3, 'enrichment', id, job_type, source_url
  from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment', 1);
insert into pgtap_907_claims
select 4, 'source_detail', id, job_type, source_url
  from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'source_detail', 2);

select is(
  (select job_type || ' ' || source_url from pgtap_907_claims where ordinal = 1),
  'pdf https://example.test/pgtap/907/a',
  'the first general worker takes the best-scored job'
);

select is(
  (select source_url from pgtap_907_claims where ordinal = 2),
  'https://example.test/pgtap/907/b',
  'the second general worker skips every job of the sale the first one holds'
);

select is(
  (select count(*) from pgtap_907_claims where ordinal in (3, 4)),
  0::bigint,
  'nothing else is claimable: the other jobs of sale A (general and source-detail) wait for its running job'
);

select is(
  (
    select count(*)
      from (
        select source_url
          from public.auction_enrichment_jobs
         where status = 'running'
         group by source_url
        having count(*) > 1
      ) duplicated
  ),
  0::bigint,
  'never two running jobs of the same sale'
);

select ok(
  not exists (select 1 from pgtap_907_claims where family = 'enrichment' and job_type = 'source_detail'),
  'a general worker never receives a source-detail job'
);

-- Sale A is free again: its source-detail job goes to the source-detail worker only.
update public.auction_enrichment_jobs
   set status = 'completed', locked_at = null, completed_at = statement_timestamp()
 where status = 'running';

insert into pgtap_907_claims
select 5, 'source_detail', id, job_type, source_url
  from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'source_detail', 2);

select is(
  (select string_agg(job_type, ',') from pgtap_907_claims where ordinal = 5),
  'source_detail',
  'the source-detail worker receives the source-detail job of the freed sale, and only that one'
);

insert into pgtap_907_claims
select 6, 'enrichment', id, job_type, source_url
  from public.claim_auction_enrichment_jobs_request(gen_random_uuid(), 'enrichment', 1);

select is(
  (select count(*) from pgtap_907_claims where ordinal = 6),
  0::bigint,
  'a general worker does not take the remaining job of a sale held by the source-detail worker'
);

-- The serialisation the parallel workers rely on: the request takes the global claim lock, then claims; the family
-- claim locks the job and its sale rows, skipping rows another transaction holds.
select ok(
  position(
    'immojudis:queue-claim-backoff' in pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_request(uuid,text,integer)'::regprocedure
    )
  ) between 1 and position(
    'claim_auction_enrichment_jobs_family(v_family, v_limit)' in pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_request(uuid,text,integer)'::regprocedure
    )
  ),
  'every request takes the global claim lock before it claims'
);

select ok(
  pg_get_functiondef('public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure)
    ~ 'for update of j, s skip locked',
  'the family claim locks the job and its sale (for update of j, s skip locked)'
);

select * from finish();
rollback;
