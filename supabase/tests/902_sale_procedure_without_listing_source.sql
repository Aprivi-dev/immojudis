-- L'adresse de l'annonce d'origine n'est plus servie aux comptes sans l'offre Analyse
-- (20261123100000) : v_auction_sales_discovery, v_auction_sales_discovery_search et
-- v_auction_sales_unlocked passent sale_procedure (et source_blocks.sale_procedure), source_conflicts et
-- source_presence par leurs fonctions de projection ; la vue découverte retire aussi l'adresse des pièces.
-- source_checks suit la même règle depuis 20261124100000 (ses valeurs portaient le nom de la plateforme).
-- v_auction_sales_app (offre Analyse) sert les trois champs complets.
-- La procédure de la vente est celle qu'écrit le pipeline (_case_sources, _verification_facts, horaire,
-- délai de paiement), avec le premier cas du test de parité Vitest
-- (src/lib/property-report/sale-procedure-without-listing-source.test.ts) ; le conflit est celui qu'écrit
-- dedupe.py ; la présence porte des extras hérités (une adresse d'annonce).
begin;
-- L'interrupteur de l'essai est coupé depuis 20261120100000 ; coupé ici aussi (annulé par le rollback) :
-- le test vérifie ce que lit un compte gratuit.
update app_private.launch_offer set active = false where singleton;

select plan(34);

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
  id, source_name, source_url, title, status, sale_date, latitude, longitude, raw_payload, sale_procedure
) values (
  'c9020000-1000-4000-8000-000000000001',
  'plateforme-privee-902',
  'https://annonce-privee.example/vente/902',
  'Listing source title 902',
  'upcoming',
  '2099-01-01 12:00:00Z',
  48.85,
  2.35,
  $json${"source_conflicts": [
    {"field": "sale_date", "selected": "2099-01-01", "observed_primary": "2099-01-02", "alternative": "2099-01-02",
     "selected_source": "https://annonce-privee.example/vente/902",
     "alternative_source": "https://annonce-privee.example/vente/902-bis",
     "observed_primary_source": "https://annonce-privee.example/vente/902"}
  ],
  "source_checks": {
    "https://annonce-privee.example/vente/902": {
      "checked_at": "2026-11-01T08:00:00+00:00", "source_name": "plateforme-privee-902",
      "fingerprint": "empreinte-902", "evidence_fingerprint": "preuve-902",
      "extractor_version": "source_extraction_20260913_v3", "capture_kind": "detail",
      "capture_fingerprints": {"detail": {"facts": "empreinte-902"}}, "detail_status": "complete"}
  }}$json$::jsonb,
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

-- La présence de la vente chez sa source, avec un extra hérité qui porte l'adresse de l'annonce.
insert into app_private.auction_sale_source_presence (
  sale_id, source_name, availability, state, attempted_at, checked_at, run_id, extras
) values (
  'c9020000-1000-4000-8000-000000000001', 'plateforme-privee-902', 'available', 'present', now(), now(),
  'run-902', '{"url": "https://annonce-privee.example/vente/902"}'::jsonb
)
on conflict (sale_id, source_name) do update
  set availability = excluded.availability, state = excluded.state, extras = excluded.extras;

-- Structure ------------------------------------------------------------------------------------
select ok(
  to_regprocedure('app_private.sale_procedure_without_listing_source(jsonb, boolean)') is not null
  and to_regprocedure('app_private.source_conflicts_without_listing_source(jsonb)') is not null
  and to_regprocedure('app_private.source_presence_without_listing_source(jsonb)') is not null,
  'the projection functions exist'
);
select ok(
  (select bool_and(p.provolatile = 'i' and not p.prosecdef and p.proconfig = array['search_path=""'])
     from pg_catalog.pg_proc p
    where p.oid in (
      'app_private.sale_procedure_without_listing_source(jsonb, boolean)'::regprocedure,
      'app_private.jsonb_without_source_url_keys(jsonb)'::regprocedure,
      'app_private.source_conflicts_without_listing_source(jsonb)'::regprocedure,
      'app_private.source_presence_without_listing_source(jsonb)'::regprocedure
    )),
  'the four functions are immutable, security invoker, with an empty search_path'
);
select ok(
  (select bool_and(
       has_function_privilege('authenticated', f, 'EXECUTE')
       and has_function_privilege('service_role', f, 'EXECUTE')
       and not has_function_privilege('anon', f, 'EXECUTE'))
     from unnest(array[
       'app_private.sale_procedure_without_listing_source(jsonb, boolean)',
       'app_private.jsonb_without_source_url_keys(jsonb)',
       'app_private.source_conflicts_without_listing_source(jsonb)',
       'app_private.source_presence_without_listing_source(jsonb)'
     ]::regprocedure[]) as f),
  'the definer views run them as an account or the server; anon cannot'
);
select ok(
  strpos(pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true),
    'app_private.sale_procedure_without_listing_source(s.sale_procedure, false) AS sale_procedure,') > 0
  and strpos(pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true),
    'jsonb_build_object(''sale_procedure'', app_private.sale_procedure_without_listing_source(s.sale_procedure, false)) AS source_blocks') > 0
  and strpos(pg_get_viewdef('public.v_auction_sales_unlocked'::regclass, true),
    'app_private.sale_procedure_without_listing_source(s.sale_procedure, true) AS sale_procedure,') > 0,
  'discovery passes sale_procedure through the strict projection, unlocked through the one keeping the documents'
);
select ok(
  (select bool_and(
       strpos(pg_get_viewdef(v, true),
         'app_private.source_conflicts_without_listing_source(s.raw_payload -> ''source_conflicts''::text) AS source_conflicts') > 0
       and strpos(pg_get_viewdef(v, true),
         'app_private.source_presence_without_listing_source(app_private.auction_sale_source_presence_json(s.id)) AS source_presence') > 0)
     from unnest(array['public.v_auction_sales_discovery', 'public.v_auction_sales_unlocked']::regclass[]) as v),
  'both views pass source_conflicts and source_presence through their projections'
);
select ok(
  (select bool_and(
       pg_get_viewdef(v, true) !~ E'\\n    s\\.sale_procedure,'
       and pg_get_viewdef(v, true) !~ 'jsonb_build_object\(''sale_procedure'', s\.sale_procedure\)'
       and pg_get_viewdef(v, true) !~ 'COALESCE\(s\.raw_payload -> ''source_conflicts'''
       and pg_get_viewdef(v, true) !~ E'\\n    app_private\\.auction_sale_source_presence_json')
     from unnest(array['public.v_auction_sales_discovery', 'public.v_auction_sales_unlocked']::regclass[]) as v),
  'neither view serves the raw columns any more'
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
  pg_get_viewdef('public.v_auction_sales_app'::regclass, true) ~ 'without_listing_source',
  false,
  'the Analyse view is unchanged: it serves the full fields'
);

-- Parity cases (Vitest: the same inputs give the same outputs in TypeScript) -------------------
select is(
  app_private.sale_procedure_without_listing_source($json${"verification": {"case_sources": [
    {"kind": "kind-inconnu", "source_name": "autre", "url": "https://autre.example"},
    {"label": "sans kind", "url": "https://sans-kind.example"},
    {"kind": ["document"], "url": "https://tableau.example"},
    {"kind": "DOCUMENT", "url": "https://majuscules.example"},
    "document", null,
    {"kind": "document", "label": "Pièce", "url": "https://pieces.example/pv.pdf"}]}}$json$::jsonb, true),
  $json${"verification": {"case_sources": [
    {"url": "https://pieces.example/pv.pdf", "kind": "document", "label": "Pièce"}]}}$json$::jsonb,
  'an unknown or malformed case source is removed (closed by default)'
);
select is(
  app_private.sale_procedure_without_listing_source(
    '{"verification": {"case_sources": [{"kind": "document", "label": "Pièce", "url": "https://pieces.example/pv.pdf"}]}}'::jsonb,
    false),
  '{"verification": {"case_sources": [{"kind": "document", "label": "Pièce"}]}}'::jsonb,
  'the strict variant keeps the label and the nature of a case document, not its url'
);
select is(
  app_private.sale_procedure_without_listing_source(
    '{"verification": {"case_sources": {"kind": "listing", "url": "https://annonce.example/3"}}}'::jsonb, true),
  '{"verification": {"case_sources": []}}'::jsonb,
  'case_sources that is not an array keeps nothing'
);
select is(
  app_private.source_conflicts_without_listing_source($json$[
    {"selected_source": "https://annonce-privee.example/a"}, "texte", null, [1], {"field": 12},
    {"field": "tribunal"}]$json$::jsonb),
  '[{}, {}, {}, {}, {}, {"field": "tribunal"}]'::jsonb,
  'a conflict keeps its field only; a malformed one stays an empty object'
);
select is(
  app_private.source_presence_without_listing_source($json${
    "vench": {"availability": "available", "state": "present", "checked_at": "2026-11-01T10:00:00Z",
              "attempted_at": "2026-11-01T10:00:00Z", "run_id": "run-1", "url": "https://annonce-privee.example/a",
              "_raw_entry": "https://annonce-privee.example/a"},
    "licitor": {"availability": "unavailable", "state": null, "source_name": "licitor"},
    "Avoventes": {"_raw_entry": "x"}}$json$::jsonb),
  '{"source_1": {}, "source_2": {"state": null, "availability": "unavailable"}, "source_3": {"state": "present", "availability": "available"}}'::jsonb,
  'the presence is re-keyed in the order of the names, with availability and state only'
);
select ok(
  app_private.sale_procedure_without_listing_source(null, false) is null
  and app_private.sale_procedure_without_listing_source('{}'::jsonb, false) = '{}'::jsonb
  and app_private.source_conflicts_without_listing_source(null) = '[]'::jsonb
  and app_private.source_presence_without_listing_source(null) = '{}'::jsonb,
  'an empty or missing value stays empty'
);

-- source_checks (20261124100000) ---------------------------------------------------------------
select ok(
  (select p.provolatile = 'i' and not p.prosecdef and p.proconfig = array['search_path=""']
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
     from pg_catalog.pg_proc p
    where p.oid = 'app_private.source_checks_without_listing_source(jsonb)'::regprocedure),
  'the source_checks projection is immutable, security invoker, with an empty search_path, closed to anon'
);
select is(
  app_private.source_checks_without_listing_source($json${
    "https://annonce-privee.example/vente/b": {
      "checked_at": "2026-11-02T08:00:00+00:00", "source_name": "plateforme-privee", "fingerprint": "f2",
      "evidence_fingerprint": "e2", "extractor_version": "source_extraction_20260913_v3",
      "capture_kind": "detail", "capture_fingerprints": {"detail": {"facts": "x"}}, "detail_status": "complete",
      "display_invalidations": ["https://annonce-privee.example/vente/b"]},
    "https://annonce.example/vente/a": {
      "checked_at": "2026-11-01T08:00:00+00:00", "source_name": "vench", "fingerprint": "f1",
      "field": "surface", "fields": ["surface", "starting_price"]},
    "Z-en-capitale": {"source_name": "licitor"},
    "texte": "https://annonce-privee.example/a"}$json$::jsonb),
  $json${
    "source_1": {},
    "source_2": {"checked_at": "2026-11-02T08:00:00+00:00", "extractor_version": "source_extraction_20260913_v3"},
    "source_3": {"checked_at": "2026-11-01T08:00:00+00:00", "field": "surface", "fields": ["surface", "starting_price"]},
    "source_4": {}}$json$::jsonb,
  'a check is re-keyed in the order of the keys and keeps checked_at, extractor_version, field and fields only'
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
  (select to_jsonb(v)::text !~ 'annonce-privee\.example|plateforme-privee-902|autre\.example|pieces\.example'
     from public.v_auction_sales_discovery v where v.id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery: the whole row carries neither the listing url, nor the source name, nor a case document url'
);
select ok(
  (select to_jsonb(v)::text !~ 'annonce-privee\.example|plateforme-privee-902|autre\.example|pieces\.example'
     from public.v_auction_sales_discovery_search v where v.id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery search: the whole row carries neither the listing url, nor the source name, nor a case document url'
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
        {"kind": "document", "label": "Cahier des conditions de vente", "document_type": "ccv"},
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
  'discovery: the case document keeps its label and nature; the official reference, the legal basis, the rules and the dates stay'
);
select is(
  (select source_blocks -> 'sale_procedure'
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  (select sale_procedure
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery: source_blocks.sale_procedure is the same projection'
);
select ok(
  (select source_conflicts = '[{"field": "sale_date"}]'::jsonb
      and source_presence = '{"source_1": {"availability": "available", "state": "present"}}'::jsonb
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  'discovery: the conflict keeps its field, the presence its availability and state under source_1'
);
select is(
  (select source_checks
     from public.v_auction_sales_discovery where id = 'c9020000-1000-4000-8000-000000000001'),
  $json${"source_1": {"checked_at": "2026-11-01T08:00:00+00:00",
                      "extractor_version": "source_extraction_20260913_v3"}}$json$::jsonb,
  'discovery: the source check keeps its date and extractor version under source_1, without the source name'
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
  (select to_jsonb(v)::text !~ 'annonce-privee\.example|plateforme-privee-902|autre\.example'
     from public.v_auction_sales_unlocked v where v.id = 'c9020000-1000-4000-8000-000000000001'),
  'unlocked: the whole row carries neither the listing url nor the source name'
);
select ok(
  (select sale_procedure::text !~ 'source_url"'
     from public.v_auction_sales_unlocked where id = 'c9020000-1000-4000-8000-000000000001'),
  'unlocked: no *source_url key is left at any depth'
);
select is(
  (select sale_procedure -> 'verification' -> 'case_sources'
     from public.v_auction_sales_unlocked where id = 'c9020000-1000-4000-8000-000000000001'),
  $json$[
    {"kind": "document", "label": "Cahier des conditions de vente", "url": "https://pieces.example/902/ccv.pdf",
     "document_type": "ccv"},
    {"kind": "official_reference", "label": "Référentiel officiel de compétence territoriale",
     "source_name": "Ministère de la Justice", "url": "https://www.data.gouv.fr/fr/datasets/competences",
     "reference_sha256": "abc"}
  ]$json$::jsonb,
  'unlocked: the case document keeps its url (without the source name), the official reference stays'
);
select ok(
  (select u.sale_procedure - 'verification' = d.sale_procedure - 'verification'
      and u.sale_procedure -> 'verification' -> 'regulatory_sources'
        = d.sale_procedure -> 'verification' -> 'regulatory_sources'
      and u.sale_procedure -> 'verification' -> 'facts' = d.sale_procedure -> 'verification' -> 'facts'
      and u.source_conflicts = d.source_conflicts
      and u.source_presence = d.source_presence
      and u.source_checks = d.source_checks
     from public.v_auction_sales_unlocked u
     join public.v_auction_sales_discovery d on d.id = u.id
    where u.id = 'c9020000-1000-4000-8000-000000000001'),
  'unlocked: rules, dates, legal basis, facts, conflicts, presence and source checks as in discovery'
);
reset role;

-- An Analyse account: the full fields ----------------------------------------------------------
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
select ok(
  (select source_conflicts -> 0 ->> 'selected_source' = 'https://annonce-privee.example/vente/902'
      and source_presence ? 'plateforme-privee-902'
     from public.v_auction_sales_app where id = 'c9020000-1000-4000-8000-000000000001'),
  'Analyse: the conflicts and the presence are served whole'
);
reset role;

select * from finish();
rollback;
