begin;
select plan(4);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_document_readings'::regclass),
  'document readings are protected by row level security'
);

select ok(
  not has_table_privilege('authenticated', 'public.auction_document_readings', 'select')
    and not has_table_privilege('anon', 'public.auction_document_readings', 'select'),
  'readings are served by the Analyse API only'
);

insert into public.auction_sales (id, source_name, source_url, status, raw_payload)
values ('c4550000-0000-4000-8000-000000000001', 'pgtap', 'https://example.test/pgtap-reading', 'upcoming', '{}'::jsonb);

select lives_ok(
  $$insert into public.auction_document_readings (sale_id, source_url, input_fingerprint, prompt_version, status, points)
    values ('c4550000-0000-4000-8000-000000000001', 'https://example.test/pgtap-reading', 'f', 'document_reading_v1', 'completed', '[]')$$,
  'a completed reading is stored'
);

select throws_ok(
  $$insert into public.auction_document_readings (sale_id, source_url, input_fingerprint, prompt_version, status, points)
    values ('c4550000-0000-4000-8000-000000000001', 'x', 'f', 'v', 'completed', '{}')$$,
  '23514',
  null,
  'points must be a list'
);

select * from finish();
rollback;
