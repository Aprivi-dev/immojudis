begin;

select plan(28);

select has_table('public', 'information_agent_cases', 'shared information-agent cases exist');
select has_table('public', 'information_agent_case_subscribers', 'case subscribers are tracked');
select has_table('public', 'information_agent_fact_candidates', 'reply facts require review');
select has_table('public', 'information_agent_evidence_assets', 'private inbound evidence is tracked');
select has_table(
  'public',
  'information_agent_evidence_extractions',
  'private evidence has a durable analysis queue'
);
select has_function(
  'public',
  'subscribe_information_agent_mission',
  array['uuid', 'uuid'],
  'missions can atomically join a shared case'
);
select has_function(
  'public',
  'review_information_agent_fact_candidate',
  array['uuid', 'uuid', 'text', 'text'],
  'reviewed facts have one controlled application path'
);
select has_function(
  'public',
  'claim_information_agent_evidence_extractions',
  array['integer'],
  'evidence workers claim bounded batches atomically'
);
select has_function(
  'public',
  'stage_information_agent_evidence_publication',
  array['uuid', 'text', 'text'],
  'approved evidence has a controlled publication staging path'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_cases'::regclass),
  'shared cases have RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.information_agent_cases', 'SELECT'),
  'browser clients cannot query canonical cases directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.information_agent_fact_candidates', 'UPDATE'),
  'subscribers cannot self-approve extracted facts'
);
select ok(
  has_table_privilege('service_role', 'public.information_agent_fact_candidates', 'UPDATE'),
  'trusted server code can operate the review queue'
);
select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'public.information_agent_evidence_extractions'::regclass),
  'evidence extraction results have RLS enabled'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.information_agent_evidence_extractions',
    'SELECT'
  ),
  'browser clients cannot read extracted document text directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_information_agent_evidence_extractions(integer)',
    'EXECUTE'
  ),
  'the trusted worker can claim evidence analysis jobs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.approve_information_agent_mission_bounded(uuid,uuid,text)',
    'EXECUTE'
  ),
  'trusted server can run the bounded approval lock'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.review_information_agent_fact_candidate(uuid,uuid,text,text)',
    'EXECUTE'
  ),
  'browser clients cannot call the fact application function'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_information_agent_evidence_extractions(integer)',
    'EXECUTE'
  ),
  'browser clients cannot operate the document worker queue'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.stage_information_agent_evidence_publication(uuid,text,text)',
    'EXECUTE'
  ),
  'the trusted server can stage approved evidence publication'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.stage_information_agent_evidence_publication(uuid,text,text)',
    'EXECUTE'
  ),
  'browser clients cannot publish evidence directly'
);
select col_is_fk(
  'public',
  'information_agent_fact_candidates',
  'evidence_asset_id',
  'document facts retain their source asset'
);
select has_column(
  'public',
  'information_agent_fact_candidates',
  'source_page',
  'document facts retain page-level provenance'
);
select results_eq(
  $$select public from storage.buckets where id = 'information-agent-evidence'$$,
  $$values (false)$$,
  'the inbound evidence bucket is private'
);
select results_eq(
  $$select public from storage.buckets where id = 'information-agent-approved'$$,
  $$values (true)$$,
  'only the separately approved evidence bucket is public'
);
select is(
  (select file_size_limit::bigint from storage.buckets where id = 'information-agent-evidence'),
  41943040::bigint,
  'evidence uploads have a forty-megabyte hard limit'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname ilike '%information_agent%'
  ),
  'no public Storage policy exposes inbound evidence'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.information_agent_cases'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (sale_id, normalized_recipient_email)'
  ),
  'sale and normalized recipient uniquely identify the shared conversation'
);

select * from finish();

rollback;
