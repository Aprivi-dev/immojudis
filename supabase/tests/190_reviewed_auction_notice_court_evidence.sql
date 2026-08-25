begin;

select plan(17);

select has_table(
  'public',
  'auction_sale_court_document_assignments',
  'reviewed auction-notice court assignments have an evidence registry'
);
select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.auction_sale_court_document_assignments'::regclass
  ),
  'auction-notice court evidence has RLS enabled'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.auction_sale_court_document_assignments',
    'SELECT'
  ),
  'anonymous users cannot read reviewed PDF evidence'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.auction_sale_court_document_assignments',
    'SELECT'
  ),
  'authenticated browsers cannot read reviewed PDF evidence'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.auction_sale_court_document_assignments',
    'SELECT'
  )
    and has_table_privilege(
      'service_role',
      'public.auction_sale_court_document_assignments',
      'INSERT'
    )
    and not has_table_privilege(
      'service_role',
      'public.auction_sale_court_document_assignments',
      'UPDATE'
    )
    and not has_table_privilege(
      'service_role',
      'public.auction_sale_court_document_assignments',
      'DELETE'
    ),
  'service role can append but not mutate reviewed PDF evidence'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.apply_reviewed_auction_notice_court_assignment(uuid,text,text,integer,text)',
    'EXECUTE'
  ),
  'authenticated users cannot apply reviewed PDF assignments'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.apply_reviewed_auction_notice_court_assignment(uuid,text,text,integer,text)',
    'EXECUTE'
  ),
  'service role can apply reviewed PDF assignments'
);

insert into public.tribunals(code, canonical_name, department, city, aliases)
values (
  'notice_testville',
  'TJ Noticeville',
  '99',
  'Noticeville',
  '["Tribunal judiciaire de Noticeville"]'::jsonb
);

insert into public.outcome_courts(id, code, name, judicial_region)
values (
  'f1000000-0000-4000-8000-000000000001',
  'notice_testville',
  'TJ Noticeville',
  'Cour d''Appel de Noticeville'
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  documents,
  sale_venue_type,
  sale_verification_status,
  property_type,
  sale_date,
  status
) values
  (
    'f2000000-0000-4000-8000-000000000001',
    'notice-test',
    'https://example.test/notice/verified',
    '[{"type":"pdf","label":"AFFICHE.pdf","url":"https://example.test/notice/affiche.pdf"}]'::jsonb,
    'tribunal',
    'verified',
    'house',
    '2026-08-10T10:00:00Z',
    'upcoming'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'notice-test',
    'https://example.test/notice/pending',
    '[{"type":"pdf","label":"AFFICHE.pdf","url":"https://example.test/notice/pending.pdf"}]'::jsonb,
    'tribunal',
    'pending',
    'house',
    '2026-08-11T10:00:00Z',
    'upcoming'
  );

select results_eq(
  $$select assigned, court_code, court_name
    from public.apply_reviewed_auction_notice_court_assignment(
      'f2000000-0000-4000-8000-000000000001',
      'https://example.test/notice/affiche.pdf',
      repeat('a', 64),
      1,
      'Tribunal judiciaire de Noticeville siégeant au palais'
    )$$,
  $$values (
      true,
      'notice_testville'::text,
      'TJ Noticeville'::text
    )$$,
  'a listed PDF with one leading court label assigns the sale'
);
select is(
  (
    select tribunal_code
    from public.auction_sales
    where id = 'f2000000-0000-4000-8000-000000000001'
  ),
  'notice_testville',
  'the reviewed PDF sets the canonical court code'
);
select is(
  (
    select tribunal
    from public.auction_sales
    where id = 'f2000000-0000-4000-8000-000000000001'
  ),
  'TJ Noticeville',
  'a missing display label is filled from the canonical court'
);
select is(
  (
    select count(*)
    from public.auction_sale_court_document_assignments
  ),
  1::bigint,
  'one immutable reviewed-document proof is appended'
);
select ok(
  (
    select document_sha256 = repeat('a', 64)
      and document_page = 1
      and observed_court_label =
        'Tribunal judiciaire de Noticeville siégeant au palais'
      and resolution_method =
        'source_auction_notice_label_unique_prefix'
      and review_method = 'rendered_pdf_visual_review'
    from public.auction_sale_court_document_assignments
  ),
  'the PDF hash, page, observed label and method remain explicit'
);
select results_eq(
  $$select assigned, court_code
    from public.apply_reviewed_auction_notice_court_assignment(
      'f2000000-0000-4000-8000-000000000001',
      'https://example.test/notice/affiche.pdf',
      repeat('a', 64),
      1,
      'Tribunal judiciaire de Noticeville siégeant au palais'
    )$$,
  $$values (false, 'notice_testville'::text)$$,
  'replaying the same reviewed proof is idempotent'
);
select throws_ok(
  $$select *
    from public.apply_reviewed_auction_notice_court_assignment(
      'f2000000-0000-4000-8000-000000000001',
      'https://example.test/notice/not-listed.pdf',
      repeat('b', 64),
      1,
      'TJ Noticeville'
    )$$,
  '23514',
  'The reviewed PDF must be listed on the sale source record.',
  'an unlisted document cannot assign a court'
);
select throws_ok(
  $$select *
    from public.apply_reviewed_auction_notice_court_assignment(
      'f2000000-0000-4000-8000-000000000002',
      'https://example.test/notice/pending.pdf',
      repeat('c', 64),
      1,
      'TJ Noticeville'
    )$$,
  '23514',
  'Only verified or cross-checked tribunal sales can use auction-notice court evidence.',
  'a pending sale remains outside reviewed assignment'
);
select throws_ok(
  $$update public.auction_sale_court_document_assignments
    set court_name = 'TJ Modifié'$$,
  '55000',
  'Court enrichment audit rows are immutable.',
  'reviewed PDF evidence cannot be updated'
);
select throws_ok(
  $$delete from public.auction_sale_court_document_assignments$$,
  '55000',
  'Court enrichment audit rows are immutable.',
  'reviewed PDF evidence cannot be deleted'
);

select * from finish();
rollback;
