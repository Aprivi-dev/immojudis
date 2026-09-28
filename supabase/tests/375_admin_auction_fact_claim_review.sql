begin;

select plan(15);

select has_function(
  'public',
  'review_auction_fact_claim',
  array['uuid', 'uuid', 'text', 'text'],
  'the admin review function exists with an explicit decision contract'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.review_auction_fact_claim(uuid,uuid,text,text)',
    'EXECUTE'
  ),
  'only the trusted server role can invoke the review function'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.review_auction_fact_claim(uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.review_auction_fact_claim(uuid,uuid,text,text)',
    'EXECUTE'
  ),
  'browser roles cannot invoke the review function'
);

insert into auth.users(id) values
  ('37400000-4000-4000-8000-000000000001'),
  ('37400000-4000-4000-8000-000000000002');

insert into public.user_profiles(user_id, email, user_role)
values
  ('37400000-4000-4000-8000-000000000001', 'fact-review-admin@example.test', 'admin'),
  ('37400000-4000-4000-8000-000000000002', 'fact-review-user@example.test', 'user');

insert into public.auction_sales(
  id, source_name, source_url, title, city, sale_date,
  starting_price_eur, surface_m2, occupancy_status, status
)
values (
  '37400000-1000-4000-8000-000000000001',
  'fact-review-pgtap',
  'https://example.test/fact-review/sale',
  'Fact review test sale',
  'Bordeaux',
  '2026-10-10T10:00:00Z',
  92000,
  72,
  'vacant',
  'upcoming'
);

insert into public.auction_fact_claims(
  id, auction_sale_id, field_key, value_jsonb, claim_status,
  evidence_kind, source_url, evidence_locator, confidence_score
)
values
  (
    '37400000-3000-4000-8000-000000000001',
    '37400000-1000-4000-8000-000000000001',
    'sale.starting_price_eur',
    '92000'::jsonb,
    'candidate',
    'source_listing',
    'https://example.test/fact-review/sale',
    '{"quote":"Mise à prix : 92 000 €"}'::jsonb,
    0.95
  ),
  (
    '37400000-3000-4000-8000-000000000002',
    '37400000-1000-4000-8000-000000000001',
    'property.surface_m2',
    '70'::jsonb,
    'candidate',
    'source_listing',
    'https://example.test/fact-review/sale',
    '{"quote":"Surface : 70 m²"}'::jsonb,
    0.90
  ),
  (
    '37400000-3000-4000-8000-000000000003',
    '37400000-1000-4000-8000-000000000001',
    'property.occupancy_status',
    '"occupied"'::jsonb,
    'candidate',
    'source_listing',
    'https://example.test/fact-review/sale',
    '{"quote":"Bien occupé"}'::jsonb,
    0.80
  ),
  (
    '37400000-3000-4000-8000-000000000004',
    '37400000-1000-4000-8000-000000000001',
    'property.occupancy_status',
    '"vacant"'::jsonb,
    'candidate',
    'source_listing',
    'https://example.test/fact-review/sale',
    '{"quote":"Libre"}'::jsonb,
    0.88
  );

set local role service_role;

select lives_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000001',
    '37400000-3000-4000-8000-000000000001',
    'accepted',
    null
  )$$,
  'an admin can accept a candidate matching the current canonical value'
);
select is(
  (select claim_status from public.auction_fact_claims
   where id = '37400000-3000-4000-8000-000000000001'),
  'accepted',
  'matching candidates become accepted'
);
select is(
  (select starting_price_eur from public.auction_sales
   where id = '37400000-1000-4000-8000-000000000001'),
  92000::numeric,
  'review does not rewrite the canonical sale field'
);

select throws_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000001',
    '37400000-3000-4000-8000-000000000002',
    'accepted',
    null
  )$$,
  '55000',
  'The candidate no longer matches the current canonical sale field.',
  'a stale candidate cannot be accepted'
);
select is(
  (select claim_status from public.auction_fact_claims
   where id = '37400000-3000-4000-8000-000000000002'),
  'candidate',
  'a failed acceptance remains unresolved for a deliberate admin decision'
);

select throws_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000001',
    '37400000-3000-4000-8000-000000000003',
    'rejected',
    null
  )$$,
  '22023',
  'A rejection or conflict requires a resolution reason.',
  'rejections require a reason'
);
select lives_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000001',
    '37400000-3000-4000-8000-000000000003',
    'rejected',
    'La source contredit le statut canonique.'
  )$$,
  'an admin can reject a candidate with a reason'
);
select is(
  (select resolution_note from public.auction_fact_claims
   where id = '37400000-3000-4000-8000-000000000003'),
  'La source contredit le statut canonique.',
  'the rejection reason is retained on the claim decision'
);

select lives_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000001',
    '37400000-3000-4000-8000-000000000004',
    'conflicted',
    'La valeur source nécessite une vérification humaine.'
  )$$,
  'an admin can mark an unresolved candidate as conflicted'
);
select ok(
  (select conflict_group is not null from public.auction_fact_claims
   where id = '37400000-3000-4000-8000-000000000004'),
  'a conflict decision receives a stable conflict group'
);

select throws_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000002',
    '37400000-3000-4000-8000-000000000002',
    'accepted',
    null
  )$$,
  '42501',
  'Only an administrator can resolve a fact claim.',
  'a non-admin cannot resolve a candidate'
);
select throws_ok(
  $$select public.review_auction_fact_claim(
    '37400000-4000-4000-8000-000000000001',
    '37400000-3000-4000-8000-000000000001',
    'rejected',
    'A second decision must not overwrite the first.'
  )$$,
  '55000',
  'Only an unresolved candidate can be reviewed.',
  'a resolved decision is immutable'
);

rollback;
