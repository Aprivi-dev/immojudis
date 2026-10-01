begin;

select plan(29);

select is(
  (select count(*) from public.source_detail_exclusions),
  6::bigint,
  'the six audited source-detail endpoints are registered'
);

select is(
  (select count(*) from public.source_detail_exclusions where active),
  6::bigint,
  'all audited exclusions are active'
);

select is(
  (select reason
   from public.source_detail_exclusions
   where source_url = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'),
  'operator_seller_catalogue_without_listing_identity',
  'the AGRASC seller catalogue exclusion keeps its precise reason'
);

select is(
  (select count(*)
   from public.source_detail_exclusions
   where source_name = 'notaires'
     and reason = 'source_not_found'),
  4::bigint,
  'the four unavailable Notaires listings are registered separately'
);

select is(
  (select count(*)
   from public.source_detail_exclusions
   where source_url <> 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'
     and expires_at is not null),
  5::bigint,
  'the five source-not-found exclusions have a bounded recheck horizon'
);

select ok(
  (select expires_at is null
   from public.source_detail_exclusions
   where source_url = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'),
  'the structural seller-catalogue exclusion does not expire'
);

select ok(
  app_private.source_detail_url_is_excluded(
    'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'
  ),
  'the exact AGRASC seller URL is excluded'
);

select ok(
  app_private.source_detail_url_is_excluded(
    'https://cessions.immobilier-etat.gouv.fr/biens/maison-dhabitation-au-mans-72-villa-de-la-cote'
  ),
  'the exact Cessions État URL is excluded'
);

select ok(
  app_private.source_detail_url_is_excluded(
    'https://www.immo-interactif.fr/encheres-en-ligne/appartement/paris-03-75003/2041438'
  )
  and app_private.source_detail_url_is_excluded(
    'https://www.immo-interactif.fr/encheres-en-ligne/appartement/paris-09-75009/2059508'
  )
  and app_private.source_detail_url_is_excluded(
    'https://www.immo-interactif.fr/encheres-en-ligne/maison/caumont-sur-durance-84/2080922'
  )
  and app_private.source_detail_url_is_excluded(
    'https://www.immo-interactif.fr/encheres-en-ligne/maison/les-corvees-les-yys-28/2025069'
  ),
  'all four audited Notaires URLs are excluded'
);

select ok(
  not app_private.source_detail_url_is_excluded(
    'https://example.test/valid-listing'
  ),
  'an unregistered URL remains eligible'
);

update public.source_detail_exclusions
set expires_at = statement_timestamp() - interval '1 minute'
where source_url = 'https://cessions.immobilier-etat.gouv.fr/biens/maison-dhabitation-au-mans-72-villa-de-la-cote';

select ok(
  not app_private.source_detail_url_is_excluded(
    'https://cessions.immobilier-etat.gouv.fr/biens/maison-dhabitation-au-mans-72-villa-de-la-cote'
  ),
  'an expired source-not-found exclusion becomes eligible for revalidation'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.source_detail_exclusions',
    'SELECT'
  )
  and has_table_privilege(
    'service_role',
    'public.source_detail_exclusions',
    'INSERT'
  )
  and has_table_privilege(
    'service_role',
    'public.source_detail_exclusions',
    'UPDATE'
  )
  and has_table_privilege(
    'service_role',
    'public.source_detail_exclusions',
    'DELETE'
  ),
  'only the service role receives registry write access'
);

select ok(
  not has_table_privilege('anon', 'public.source_detail_exclusions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.source_detail_exclusions', 'SELECT'),
  'browser roles cannot read the exclusion registry'
);

select ok(
  to_regprocedure('app_private.source_detail_url_is_excluded(text)') is not null,
  'the private exclusion lookup function exists'
);

select ok(
  to_regprocedure('app_private.skip_excluded_source_detail_job()') is not null,
  'the insertion defense trigger function exists'
);

select ok(
  to_regprocedure('app_private.preserve_source_detail_publication_quarantine()') is not null,
  'the seller publication quarantine preservation function exists'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.auction_enrichment_jobs'::regclass
      and tgname = 'auction_enrichment_jobs_source_detail_exclusion'
      and not tgisinternal
  ),
  'the enrichment queue has the exclusion trigger installed'
);

select ok(
  position(
    'source_detail_url_is_excluded' in
      pg_get_functiondef(
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
      )
  ) > 0,
  'recurring admission filters exclusions before applying its batch limit'
);

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  observations,
  raw_payload
)
values (
  'agrasc',
  'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
  'upcoming',
  '2099-01-01T12:00:00Z',
  '[]'::jsonb,
  '{}'::jsonb
);

select is(
  (select raw_payload->>'publication_quarantine'
   from public.auction_sales
   where source_url = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'),
  'source_detail_excluded',
  'the seller URL receives a durable publication quarantine marker on insert'
);

update public.auction_sales
set status = 'upcoming',
    raw_payload = raw_payload - 'publication_quarantine'
where source_url = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo';

select is(
  (select raw_payload->>'publication_quarantine'
   from public.auction_sales
   where source_url = 'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo'),
  'source_detail_excluded',
  'a later seller upsert cannot remove the publication quarantine marker'
);

select lives_ok(
  $$insert into public.auction_enrichment_jobs (
      source_url, job_type, input_hash, detail_source_name, detail_source_url, priority
    ) values (
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      'source_detail',
      'pgtap-excluded-system',
      'agrasc',
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      100
    )$$,
  'a system insertion for an excluded URL is skipped without aborting the batch'
);

select is(
  (select count(*)
   from public.auction_enrichment_jobs
   where job_type = 'source_detail'
     and input_hash = 'pgtap-excluded-system'),
  0::bigint,
  'the excluded system source-detail job was not inserted'
);

select throws_ok(
  $$insert into public.auction_enrichment_jobs (
      source_url, job_type, input_hash, detail_source_name, detail_source_url,
      priority, request_origin
    ) values (
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      'source_detail',
      'pgtap-excluded-admin',
      'agrasc',
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      120,
      'admin_information_agent'
    )$$,
  'P0001',
  'SOURCE_DETAIL_EXCLUDED',
  'an admin source refresh cannot bypass a permanent URL exclusion'
);

select is(
  (select count(*)
   from public.auction_enrichment_jobs
   where job_type = 'source_detail'
     and input_hash = 'pgtap-excluded-admin'),
  0::bigint,
  'the excluded admin source-detail job was not inserted'
);

select lives_ok(
  $$insert into public.auction_enrichment_jobs (
      source_url, job_type, input_hash, detail_source_name, detail_source_url,
      priority, status
    ) values (
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      'source_detail',
      'pgtap-excluded-historical-failure',
      'agrasc',
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      100,
      'failed'
    )$$,
  'historical failed jobs remain recordable for audit'
);

update public.auction_enrichment_jobs
set status = 'queued'
where input_hash = 'pgtap-excluded-historical-failure';

select is(
  (select status
   from public.auction_enrichment_jobs
   where input_hash = 'pgtap-excluded-historical-failure'),
  'failed',
  'an excluded historical job cannot be replayed by changing its status'
);

select lives_ok(
  $$insert into public.auction_enrichment_jobs (
      source_url, job_type, input_hash, detail_source_name, detail_source_url, priority
    ) values (
      'https://www.agorastore.fr/ventes-occasions/vendeur/agrascimmo',
      'source_detail',
      'pgtap-excluded-other-source',
      'agrasc',
      'https://example.test/valid-listing',
      100
    )$$,
  'a valid detail endpoint on a sale with an excluded canonical URL remains distinct'
);

select is(
  (select count(*)
   from public.auction_enrichment_jobs
   where job_type = 'source_detail'
     and input_hash = 'pgtap-excluded-other-source'),
  1::bigint,
  'the valid alternate detail endpoint remains enqueueable'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.source_detail_url_is_excluded(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.source_detail_url_is_excluded(text)',
    'EXECUTE'
  ),
  'browser roles cannot invoke the private exclusion lookup'
);

select * from finish();
rollback;
