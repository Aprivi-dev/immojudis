-- 20261208100000 : ventes exclues de la lecture automatique des pièces. Table fermée aux rôles du navigateur
-- (RLS sans politique, aucun droit), motif en liste fermée, demande d'exercice des droits facultative dont la purge
-- laisse l'exclusion en place, une seule exclusion par URL source.
begin;

select plan(12);

select has_table('public', 'document_reading_exclusions', 'the exclusions table exists');

select columns_are(
  'public', 'document_reading_exclusions',
  array['source_url', 'reason', 'data_subject_request_id', 'created_at'],
  'the table holds the source URL, a closed reason, an optional request and its date, nothing else'
);

select col_is_pk('public', 'document_reading_exclusions', 'source_url', 'one exclusion per source URL');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.document_reading_exclusions'::regclass)
  and not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'document_reading_exclusions'
  ),
  'row level security is on, without any policy'
);

select ok(
  not has_table_privilege('anon', 'public.document_reading_exclusions', 'SELECT')
  and not has_table_privilege('anon', 'public.document_reading_exclusions', 'INSERT')
  and not has_table_privilege('authenticated', 'public.document_reading_exclusions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.document_reading_exclusions', 'INSERT')
  and not has_table_privilege('authenticated', 'public.document_reading_exclusions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.document_reading_exclusions', 'DELETE'),
  'no browser role reaches the table'
);

select ok(
  has_table_privilege('service_role', 'public.document_reading_exclusions', 'SELECT')
  and has_table_privilege('service_role', 'public.document_reading_exclusions', 'INSERT')
  and not has_table_privilege('service_role', 'public.document_reading_exclusions', 'UPDATE'),
  'the service role reads and adds exclusions, and never rewrites one'
);

select ok(
  not has_table_privilege('service_role', 'public.document_reading_exclusions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.document_reading_exclusions', 'DELETE')
  and not has_table_privilege('service_role', 'public.document_reading_exclusions', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.document_reading_exclusions', 'REFERENCES')
  and not has_table_privilege('service_role', 'public.document_reading_exclusions', 'TRIGGER'),
  'the service role can neither update, delete nor truncate an exclusion'
);

set local role service_role;

insert into public.data_subject_requests (id, requester_email, request_type)
values ('91200000-0000-4000-8000-000000000001', 'opposition@example.test', 'objection');

select lives_ok(
  $$insert into public.document_reading_exclusions (source_url, reason, data_subject_request_id)
    values ('https://example.test/vente-1', 'opposition', '91200000-0000-4000-8000-000000000001')$$,
  'an opposition is recorded with its request'
);

select lives_ok(
  $$insert into public.document_reading_exclusions (source_url, reason)
    values ('https://example.test/vente-2', 'correction')$$,
  'a correction is recorded without a request'
);

select throws_ok(
  $$insert into public.document_reading_exclusions (source_url, reason)
    values ('https://example.test/vente-3', 'Monsieur Dupont a appelé')$$,
  '23514',
  null,
  'a reason outside the closed list is refused'
);

select throws_ok(
  $$insert into public.document_reading_exclusions (source_url, reason)
    values ('https://example.test/vente-1', 'autre')$$,
  '23505',
  null,
  'a sale is excluded once'
);

reset role;

delete from public.data_subject_requests where id = '91200000-0000-4000-8000-000000000001';

select ok(
  exists (
    select 1 from public.document_reading_exclusions
     where source_url = 'https://example.test/vente-1' and data_subject_request_id is null
  ),
  'the purge of the request leaves the exclusion in place'
);

select * from finish();
rollback;
