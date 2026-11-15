-- L'adresse de l'annonce d'origine n'est plus servie aux comptes sans l'offre Analyse
-- (20261123100000) : v_auction_sales_discovery, v_auction_sales_discovery_search et
-- v_auction_sales_unlocked passent sale_procedure (et source_blocks.sale_procedure) par
-- app_private.sale_procedure_without_listing_source ; v_auction_sales_app (offre Analyse) le sert complet.
-- La procédure de la vente est celle qu'écrit le pipeline (_case_sources, _verification_facts, horaire,
-- délai de paiement), avec le premier cas du test de parité Vitest
-- (src/lib/property-report/sale-procedure-without-listing-source.test.ts).
begin;
-- L'interrupteur de l'essai est coupé depuis 20261120100000 ; coupé ici aussi (annulé par le rollback) :
-- le test vérifie ce que lit un compte gratuit.
update app_private.launch_offer set active = false where singleton;

select plan(24);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c9020000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'free@listing902.example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c9020000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'analysis@listing902.example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c9020000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c9020000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, latitude, longitude, sale_procedure
) values (
  'c9020000-1000-4000-8000-000000000001',
  'plateforme-privee-902',
  'https://annonce-privee.example/vente/902',
  'Listing source title 902',
  'upcoming',
  '2099-01-01 12:00:00Z',
  48.85,
  2.35,
  $json${
    "schema_version": "sale_procedure_v1",
    "venue_type": "tribunal",
    "rules": {
      "lawyer_required": true,
      "payment_deadline_days": 60,
      "payment_deadline_source_url": "https://annonce-privee.example/vente/902"
    },
    "sale_session": {
      "opens_at": "2026-12-01T10:00:00+01:00",
      "closes_at": "2026-12-01T12:00:00+01:00",
      "source_url": "https://annonce-privee.example/vente/902"
    },
    "verification": {
      "status": "cross_checked",
      "verified_at": "2026-11-01T10:00:00+01:00",
      "case_source_count": 4,
      "case_sources": [
        {"kind": "listing", "label": "Plateforme privee 902", "source_name": "plateforme-privee-902",
         "url": "https://annonce-privee.example/vente/902"},
        {"kind": "document", "label": "Cahier des conditions de vente", "source_name": "plateforme-privee-902",
         "url": "https://pieces.example/902/ccv.pdf", "document_type": "ccv"},
        {"kind": "kind-inconnu", "label": "Autre", "source_name": "plateforme-privee-902",
         "url": "https://autre.example/902"},
        {"kind": "official_reference", "label": "Référentiel officiel de compétence territoriale",
         "source_name": "Ministère de la Justice", "url": "https://www.data.gouv.fr/fr/datasets/competences",
         "reference_sha256": "abc"}
      ],
      "regulatory_sources": [
        {"kind": "legal_basis", "label": "Code des procédures civiles d'exécution", "source_name": "Légifrance",
         "url": "https://www.legifrance.gouv.fr/codes/x", "checked_at": "2026-11-01"}
      ],
      "facts": [
        {"key": "venue_type", "value": "tribunal", "status": "verified", "evidence": ["Tribunal judiciaire"],
         "source_url": "https://annonce-privee.example/vente/902"},
        {"key": "competent_court", "value": "TJ Paris", "status": "verified", "evidence": ["Commune INSEE 75056"],
         "source_url": "https://www.data.gouv.fr/fr/datasets/competences"}
      ],
      "issues": []
    }
  }$json$::jsonb
);

-- Structure ------------------------------------------------------------------------------------
select has_function(
  'app_private', 'sale_procedure_without_listing_source', array['jsonb'],
  'the projection function exists'
);
select ok(
  (select bool_and(p.provolatile = 'i' and not p.prosecdef and p.proconfig = array['search_path=""'])
     from pg_catalog.pg_proc p
    where p.oid in (
      'app_private.sale_procedure_without_listing_source(jsonb)'::regprocedure,
      'app_private.jsonb_without_source_url_keys(jsonb)'::regprocedure
    )),
  'both functions are immutable, security invoker, with an empty search_path'
);
select ok(
  has_function_privilege('authenticated', 'app_private.sale_procedure_without_listing_source(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.sale_procedure_without_listing_source(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'app_private.jsonb_without_source_url_keys(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.jsonb_without_source_url_keys(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.sale_procedure_without_listing_source(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.jsonb_without_source_url_keys(jsonb)', 'EXECUTE'),
  'the definer views run them as an account or the server; anon cannot'
);
select ok(
  strpos(pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true),
    'app_private.sale_procedure_without_listing_source(s.sale_procedure) AS sale_procedure,') > 0
  and strpos(pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true),
    'jsonb_build_object(''sale_procedure'', app_private.sale_procedure_without_listing_source(s.sale_procedure)) AS source_blocks') > 0
  and strpos(pg_get_viewdef('public.v_auction_sales_unlocked'::regclass, true),
    'app_private.sale_procedure_without_listing_source(s.sale_procedure) AS sale_procedure,') > 0,
  'the discovery and unlocked views pass sale_procedure through the projection'
);
select ok(
  pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true) !~ E'\\n    s\\.sale_procedure,'
  and pg_get_viewdef('public.v_auction_sales_unlocked'::regclass, true) !~ E'\\n    s\\.sale_procedure,'
  and pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true) !~ 'jsonb_build_object\(''sale_procedure'', s\.sale_procedure\)',
  'neither view serves the raw column any more'
);
select ok(
  (select bool_and(c.reloptions @> array['security_invoker=false', 'security_barrier=true'])
     from pg_catalog.pg_class c
    where c.oid in ('public.v_auction_sales_discovery'::regclass, 'public.v_auction_sales_unlocked'::regclass))
  and has_table_privilege('authenticated', 'public.v_auction_sales_discovery', 'SELECT')
  and has_table_privilege('authenticated', 'public.v_auction_sales_unlocked', 'SELECT')
  and not has_table_privilege('anon', 'public.v_auction_sales_discovery', 'SELECT')
  and not has_table_privilege('anon', 'public.v_auction_sales_unlocked', 'SELECT')
  and obj_description('public.v_auction_sales_unlocked'::regclass, 'pg_class') like 'SECURITY DEFINER by design%',
  'the views keep their options, their grants and their comment'
);
select is(
  pg_get_viewdef('public.v_auction_sales_app'::regclass, true) ~ 'sale_procedure_without_listing_source',
  false,
  'the Analyse view is unchanged: it serves the full procedure'
);

-- Parity cases (Vitest: the same inputs give the same outputs in TypeScript) -------------------
select is(
  app_private.sale_procedure_without_listing_source($json${"verification": {"case_sources": [
    {"kind": "kind-inconnu", "source_name": "autre", "url": "https://autre.example"},
    {"label": "sans kind", "url": "https://sans-kind.example"},
    {"kind": ["document"], "url": "https://tableau.example"},
    {"kind": "DOCUMENT", "url": "https://majuscules.example"},
    "document", null,
    {"kind": "document", "label": "Pièce", "url": "https://pieces.example/pv.pdf"}]}}$json$::jsonb),
  $json${"verification": {"case_sources": [
    {"url": "https://pieces.example/pv.pdf", "kind": "document", "label": "Pièce"}]}}$json$::jsonb,
  'an unknown or malformed case source is removed (closed by default)'
);
select is(
  app_private.sale_procedure_without_listing_source(
    '{"verification": {"case_sources": {"kind": "listing", "url": "https://annonce.example/3"}}}'::jsonb),
  '{"verification": {"case_sources": []}}'::jsonb,
  'case_sources that is not an array keeps nothing'
);
select ok(
  app_private.sale_procedure_without_listing_source(null) is null
  and app_private.sale_procedure_without_listing_source('{}'::jsonb) = '{}'::jsonb,
  'an empty or missing procedure stays as it is'
);

-- A free account, no unlock: the discovery view ------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c9020000-0000-4000-8000-000000000001';

select ok(
  not public.has_analysis_access(),
  'the free account has no Analyse access'
);
select ok(
  (select sale_procedure::text !~ 'annonce-privee\.example|plateforme-privee-902|autre\.example'
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery: neither the listing url nor the source name appears anywhere in sale_procedure'
);
select ok(
  (select sale_procedure::text !~ 'source_url"'
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery: no *source_url key is left at any depth'
);
select is(
  (select sale_procedure
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  $json${
    "schema_version": "sale_procedure_v1",
    "venue_type": "tribunal",
    "rules": {"lawyer_required": true, "payment_deadline_days": 60},
    "sale_session": {"opens_at": "2026-12-01T10:00:00+01:00", "closes_at": "2026-12-01T12:00:00+01:00"},
    "verification": {
      "status": "cross_checked",
      "verified_at": "2026-11-01T10:00:00+01:00",
      "case_source_count": 4,
      "case_sources": [
        {"kind": "document", "label": "Cahier des conditions de vente",
         "url": "https://pieces.example/902/ccv.pdf", "document_type": "ccv"},
        {"kind": "official_reference", "label": "Référentiel officiel de compétence territoriale",
         "source_name": "Ministère de la Justice", "url": "https://www.data.gouv.fr/fr/datasets/competences",
         "reference_sha256": "abc"}
      ],
      "regulatory_sources": [
        {"kind": "legal_basis", "label": "Code des procédures civiles d'exécution", "source_name": "Légifrance",
         "url": "https://www.legifrance.gouv.fr/codes/x", "checked_at": "2026-11-01"}
      ],
      "facts": [
        {"key": "venue_type", "value": "tribunal", "status": "verified", "evidence": ["Tribunal judiciaire"]},
        {"key": "competent_court", "value": "TJ Paris", "status": "verified", "evidence": ["Commune INSEE 75056"]}
      ],
      "issues": []
    }
  }$json$::jsonb,
  'discovery: the case document (without source name), the official reference, the legal basis, the rules and the dates stay'
);
select is(
  (select source_blocks -> 'sale_procedure'
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  (select sale_procedure
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery: source_blocks.sale_procedure is the same projection'
);
select ok(
  (select sale_procedure::text !~ 'annonce-privee\.example|plateforme-privee-902|source_url"'
      and (source_blocks -> 'sale_procedure')::text !~ 'annonce-privee\.example|plateforme-privee-902|source_url"'
     from public.v_auction_sales_discovery_search where id = 'c9020000-1000-4000-8000-000000000001'),
  'the discovery search view, read from the discovery view, serves the projection too'
);
select is(
  (select count(*) from public.v_auction_sales_unlocked where id = 'c9020000-1000-4000-8000-000000000001'),
  0::bigint,
  'the sale is not unlocked yet'
);

-- The same free account, the sale unlocked: the unlocked view ----------------------------------
select is(
  (public.unlock_sale('c9020000-1000-4000-8000-000000000001') ->> 'consumed')::boolean,
  true,
  'the free account unlocks the sale'
);
select ok(
  (select sale_procedure::text !~ 'annonce-privee\.example|plateforme-privee-902|autre\.example'
     from public.v_auction_sales_unlocked where id = 'c9020000-1000-4000-8000-000000000001'),
  'unlocked: neither the listing url nor the source name appears anywhere in sale_procedure'
);
select ok(
  (select sale_procedure::text !~ 'source_url"'
     from public.v_auction_sales_unlocked where id = 'c9020000-1000-4000-8000-000000000001'),
  'unlocked: no *source_url key is left at any depth'
);
select is(
  (select sale_procedure
     from public.v_auction_sales_unlocked where id = 'c9020000-1000-4000-8000-000000000001'),
  (select sale_procedure
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  'unlocked: the same projection as discovery (documents, official reference, legal basis, rules, dates)'
);
reset role;

-- An Analyse account: the full procedure --------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c9020000-0000-4000-8000-000000000002';

select ok(
  public.has_analysis_access(),
  'the subscriber has the Analyse access'
);
select is(
  (select sale_procedure
     from public.v_auction_sales_app where id = 'c9020000-1000-4000-8000-000000000001'),
  (select s.sale_procedure from public.auction_sales s where s.id = 'c9020000-1000-4000-8000-000000000001'),
  'Analyse: the catalogue view serves the procedure as stored'
);
select ok(
  (select sale_procedure -> 'verification' -> 'case_sources' -> 0 ->> 'url' = 'https://annonce-privee.example/vente/902'
      and sale_procedure -> 'rules' ->> 'payment_deadline_source_url' = 'https://annonce-privee.example/vente/902'
     from public.v_auction_sales_app where id = 'c9020000-1000-4000-8000-000000000001'),
  'Analyse: the listing source and its url are there'
);
reset role;

select * from finish();
rollback;
