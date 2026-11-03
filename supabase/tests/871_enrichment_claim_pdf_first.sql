-- File d'enrichissement : la voie générale lit les pièces avant de décrire une vente
-- (20261111050000_enrichment_claim_pdf_first.sql), avec une avance bornée de 96 h pour les pièces
-- (20261111060000_enrichment_claim_pdf_head_start.sql).
begin;

select plan(16);

set local role service_role;

select ok(
  position('pdf.job_type = ''pdf''' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) > 0
  and position('case when j.job_type = ''pdf'' then 96 else 0 end' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) > 0
  and position('(j.job_type = ''pdf'') desc' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) = 0
  and position('then 168' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) > 0
  and position('r.is_near desc' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) > 0,
  'the general lane waits for the sale''s PDF job and gives PDF jobs a 96 h head start; urgency and the detail lane remain'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role',
        'public.claim_auction_enrichment_jobs_family(text,integer)',
        'execute'
      )
      and not has_function_privilege(
        'anon',
        'public.claim_auction_enrichment_jobs_family(text,integer)',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'public.claim_auction_enrichment_jobs_family(text,integer)',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ),
  'the claim keeps invoker security, empty search_path, and service-only ACLs'
);

-- Les données ci-dessous sont annulées par le rollback final. Les déclencheurs des ventes peuvent créer leurs
-- propres tâches : la file est vidée après l'insertion des ventes et avant chaque cas.
delete from public.auction_enrichment_jobs;
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = true
 where id;
insert into public.auction_source_state(source_name, enabled, suspended_until)
values
  ('pgtap-871-a', true, null),
  ('pgtap-871-b', true, null);

insert into public.auction_sales(source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-871-a', 'https://example.test/pgtap/871/reading', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/old-display', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/new-pdf', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/near-pdf', 'upcoming', now() + interval '3 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/far-pdf', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/detail', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/round-a-1', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-a', 'https://example.test/pgtap/871/round-a-2', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-b', 'https://example.test/pgtap/871/round-b-1', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-871-b', 'https://example.test/pgtap/871/round-b-2', 'upcoming', now() + interval '30 days', '{}'::jsonb);

-- Une vente dont la tâche pdf peut encore avancer : la tâche pdf n'est pas due (rendue pour une prochaine
-- passe), ses tâches description et faits, dues et anciennes, ne sont pas prises.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/871/reading', 'pdf', 'queued', 30, 'pgtap-871-pdf', 1, 4,
   now() + interval '30 minutes', now() - interval '1 day', now() - interval '1 day'),
  ('https://example.test/pgtap/871/reading', 'display_description', 'queued', 20, 'pgtap-871-display', 0, 4,
   now() - interval '1 minute', now() - interval '40 days', now() - interval '40 days'),
  ('https://example.test/pgtap/871/reading', 'fact_extraction', 'failed', 20, 'pgtap-871-facts', 1, 4,
   now() - interval '1 minute', now() - interval '40 days', now() - interval '40 days');

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 5)),
  0::bigint,
  'description and facts are not claimed while the sale''s PDF job is queued'
);

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('all', 5)),
  0::bigint,
  'the historical all-family claim applies the same PDF prerequisite'
);

select is(
  (select array_agg(status order by job_type) from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/871/reading'),
  array['queued', 'failed', 'queued'],
  'the waiting jobs keep their state and their attempts'
);

-- Un échec avec des essais restants garde la vente en attente.
update public.auction_enrichment_jobs
   set status = 'failed', attempt_count = 3
 where input_hash = 'pgtap-871-pdf';

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 5)),
  0::bigint,
  'a failed PDF job with attempts left still holds description and facts'
);

-- Tâche pdf terminée : la vente est libérée.
update public.auction_enrichment_jobs
   set status = 'completed', completed_at = now()
 where input_hash = 'pgtap-871-pdf';

select is(
  (select array_agg(job_type order by job_type)
     from public.claim_auction_enrichment_jobs_family('enrichment', 5)),
  array['display_description', 'fact_extraction'],
  'description and facts are claimed once the PDF job is completed'
);

-- Tâche pdf à bout d'essais : la vente est libérée aussi (le pipeline passe alors la passe de faits en revue).
update public.auction_enrichment_jobs
   set status = 'queued', attempt_count = 0, locked_at = null
 where input_hash in ('pgtap-871-display', 'pgtap-871-facts');
update public.auction_enrichment_jobs
   set status = 'failed', attempt_count = 4, completed_at = null
 where input_hash = 'pgtap-871-pdf';

select is(
  (select array_agg(job_type order by job_type)
     from public.claim_auction_enrichment_jobs_family('enrichment', 5)),
  array['display_description', 'fact_extraction'],
  'description and facts are claimed once the PDF job has exhausted its retry budget'
);

select is(
  (select status from public.auction_enrichment_jobs where input_hash = 'pgtap-871-pdf'),
  'failed',
  'the exhausted PDF job itself is never claimed again'
);

-- Une tâche pdf récente passe devant une description plus ancienne d'une autre vente, tant que l'écart
-- d'attente reste sous l'avance de 96 h des tâches pdf (20261111060000 ; voir aussi 872).
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/871/old-display', 'display_description', 'queued', 20, 'pgtap-871-old-display',
   now() - interval '1 minute', now() - interval '3 days', now() - interval '3 days'),
  ('https://example.test/pgtap/871/new-pdf', 'pdf', 'queued', 30, 'pgtap-871-new-pdf',
   now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 hour');

select is(
  (select source_url || ' ' || job_type
     from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  'https://example.test/pgtap/871/new-pdf pdf',
  'a recent PDF job is claimed before an older description of another sale'
);

select is(
  (select source_url || ' ' || job_type
     from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  'https://example.test/pgtap/871/old-display display_description',
  'the description of a sale without a pending PDF job follows'
);

-- L'avance est bornée : une description qui attend depuis 10 jours passe devant une tâche pdf d'une heure.
-- Avec un ordre strict, les descriptions sans pièce à lire n'étaient plus prises du tout (03/11/2026 :
-- 254 descriptions et 71 passes de faits libres, 10 prises sur 10 pour des pdf).
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/871/old-display', 'display_description', 'queued', 20, 'pgtap-871-starved-display',
   now() - interval '1 minute', now() - interval '10 days', now() - interval '10 days'),
  ('https://example.test/pgtap/871/new-pdf', 'pdf', 'queued', 30, 'pgtap-871-recent-pdf',
   now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 hour');

select is(
  (select source_url || ' ' || job_type
     from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  'https://example.test/pgtap/871/old-display display_description',
  'a description waiting well beyond the PDF head start is not starved'
);

-- Entre deux tâches pdf, une vente proche passe toujours devant (bonus fini de 168 h).
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/871/far-pdf', 'pdf', 'queued', 30, 'pgtap-871-far-pdf',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days'),
  ('https://example.test/pgtap/871/near-pdf', 'pdf', 'queued', 30, 'pgtap-871-near-pdf',
   now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 hour');

select is(
  (select source_url from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  'https://example.test/pgtap/871/near-pdf',
  'between PDF jobs, a sale within seven days keeps its urgency bonus'
);

-- La voie historique « all » prend toujours une tâche source_detail avant une tâche pdf.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at, detail_source_name, detail_source_url
)
values
  ('https://example.test/pgtap/871/detail', 'source_detail', 'queued', 20, 'pgtap-871-detail',
   now() - interval '1 minute', now() - interval '1 hour', now() - interval '1 hour',
   'pgtap-871-a', 'https://example.test/pgtap/871/detail/page'),
  ('https://example.test/pgtap/871/far-pdf', 'pdf', 'queued', 30, 'pgtap-871-far-pdf-2',
   now() - interval '1 minute', now() - interval '10 days', now() - interval '10 days', null, null);

select is(
  (select job_type from public.claim_auction_enrichment_jobs_family('all', 1)),
  'source_detail',
  'the all-family claim still ranks source_detail ahead of PDF jobs'
);

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 5)
    where job_type = 'source_detail'),
  0::bigint,
  'the enrichment family still never claims source_detail jobs'
);

-- La voie source_detail garde son tour de rôle par source.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at, detail_source_name, detail_source_url
)
values
  ('https://example.test/pgtap/871/round-a-1', 'source_detail', 'queued', 20, 'round-a-1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days',
   'pgtap-871-a', 'https://example.test/pgtap/871/detail/round-a-1'),
  ('https://example.test/pgtap/871/round-a-2', 'source_detail', 'queued', 20, 'round-a-2',
   now() - interval '1 minute', now() - interval '1 day', now() - interval '1 day',
   'pgtap-871-a', 'https://example.test/pgtap/871/detail/round-a-2'),
  ('https://example.test/pgtap/871/round-b-1', 'source_detail', 'queued', 20, 'round-b-1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days',
   'pgtap-871-b', 'https://example.test/pgtap/871/detail/round-b-1'),
  ('https://example.test/pgtap/871/round-b-2', 'source_detail', 'queued', 20, 'round-b-2',
   now() - interval '1 minute', now() - interval '1 day', now() - interval '1 day',
   'pgtap-871-b', 'https://example.test/pgtap/871/detail/round-b-2');

select is(
  (select count(distinct detail_source_name)
     from public.claim_auction_enrichment_jobs_family('source_detail', 2)),
  2::bigint,
  'the source-detail lane still claims one job per source before a second one'
);

select * from finish();
rollback;
