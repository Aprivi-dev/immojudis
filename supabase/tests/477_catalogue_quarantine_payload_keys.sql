-- catalogue_quarantined suit les trois clés de quarantaine du pipeline (20261028110200) :
-- publication_quarantine, publication_identity_conflict et source_identity_mismatch, avec la « vérité » de
-- Python (src/admission.py, _QUARANTINE_PAYLOAD_KEYS) : absent, null, '', false, 0, [] et {} ne comptent pas.
begin;

select plan(17);

-- Équivalence avec Python : un cas par type de valeur, pour chacune des trois clés ----------------------
create temporary table pgtap_477_cases on commit drop as
select * from (values
  ('absent', '{}'::jsonb, false),
  ('clé étrangère', '{"autre": true}'::jsonb, false),
  ('quarantaine : chaîne', '{"publication_quarantine": "multi_lot"}'::jsonb, true),
  ('quarantaine : chaîne vide', '{"publication_quarantine": ""}'::jsonb, false),
  ('quarantaine : null', '{"publication_quarantine": null}'::jsonb, false),
  ('conflit : objet', '{"publication_identity_conflict": {"reason": "same_address"}}'::jsonb, true),
  ('conflit : objet vide', '{"publication_identity_conflict": {}}'::jsonb, false),
  ('conflit : null', '{"publication_identity_conflict": null}'::jsonb, false),
  ('écart : true', '{"source_identity_mismatch": true}'::jsonb, true),
  ('écart : false', '{"source_identity_mismatch": false}'::jsonb, false),
  ('écart : objet', '{"source_identity_mismatch": {"expected": "a", "found": "b"}}'::jsonb, true),
  ('écart : chaîne', '{"source_identity_mismatch": "title"}'::jsonb, true),
  ('écart : zéro', '{"source_identity_mismatch": 0}'::jsonb, false),
  ('écart : zéro décimal', '{"source_identity_mismatch": 0.0}'::jsonb, false),
  ('écart : un', '{"source_identity_mismatch": 1}'::jsonb, true),
  ('écart : tableau vide', '{"source_identity_mismatch": []}'::jsonb, false),
  ('écart : tableau', '{"source_identity_mismatch": ["a"]}'::jsonb, true),
  ('deux clés, une fausse', '{"publication_quarantine": "", "source_identity_mismatch": true}'::jsonb, true),
  ('payload non objet : tableau', '[1, 2]'::jsonb, false),
  ('payload non objet : null JSON', 'null'::jsonb, false),
  ('payload nul', null::jsonb, false)
) as cases(label, payload, expected);

select is(
  (select string_agg(label, ', ') from pgtap_477_cases
    where app_private.catalogue_quarantine_from_payload(payload) is distinct from expected),
  null,
  'the rule gives the Python answer for every kind of value of the three keys'
);

-- Réglages -----------------------------------------------------------------------------------------
select ok(
  (select not prosecdef and proconfig = array['search_path=""']
     from pg_proc where oid = 'app_private.catalogue_quarantine_from_payload(jsonb)'::regprocedure)
  and (select provolatile = 'i'
         from pg_proc where oid = 'app_private.catalogue_quarantine_from_payload(jsonb)'::regprocedure),
  'the rule is SECURITY INVOKER, immutable, with an empty search_path'
);
select ok(
  has_function_privilege('service_role', 'app_private.catalogue_quarantine_from_payload(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.catalogue_quarantine_from_payload(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.catalogue_quarantine_from_payload(jsonb)', 'EXECUTE'),
  'the rule is not callable by browser roles'
);
select ok(
  not has_function_privilege('service_role', 'app_private.repair_catalogue_quarantine_drift()', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.repair_catalogue_quarantine_drift()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.repair_catalogue_quarantine_drift()', 'EXECUTE'),
  'the repair is for the migration role only'
);
select ok(
  not exists (
    select 1 from pg_proc
    where oid in (
      'app_private.sync_auction_sale_catalogue_projection()'::regprocedure,
      'app_private.sync_auction_sale_catalogue_visibility()'::regprocedure
    )
      and (prosecdef or proconfig is distinct from array['search_path=""'])
  ),
  'both projection triggers stay SECURITY INVOKER with an empty search_path'
);
select is(
  (select count(*) from pg_trigger
    where tgrelid = 'public.auction_sales'::regclass and not tgisinternal
      and tgfoid in (
        'app_private.sync_auction_sale_catalogue_projection()'::regprocedure,
        'app_private.sync_auction_sale_catalogue_visibility()'::regprocedure
      )),
  4::bigint,
  'the insert and update triggers of both projections are attached'
);

-- Comportement du déclencheur ---------------------------------------------------------------------
-- a : conflit d'identité seul (statut resté « upcoming ») ; b : écart de source seul ; c : propre.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, raw_payload)
values
  ('c4770000-1000-4000-8000-000000000001', 'quarantine-keys-test', 'https://example.test/q477/a', 'Q477 a', 'upcoming',
   '2099-01-01 12:00:00Z', '{"publication_identity_conflict": {"reason": "same_address"}}'::jsonb),
  ('c4770000-1000-4000-8000-000000000002', 'quarantine-keys-test', 'https://example.test/q477/b', 'Q477 b', 'upcoming',
   '2099-01-01 12:00:00Z', '{"source_identity_mismatch": true}'::jsonb),
  ('c4770000-1000-4000-8000-000000000003', 'quarantine-keys-test', 'https://example.test/q477/c', 'Q477 c', 'upcoming',
   '2099-01-01 12:00:00Z', '{}'::jsonb);

select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000001'),
  true,
  'an identity conflict alone quarantines the sale in the column'
);
select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000002'),
  true,
  'a source identity mismatch alone quarantines the sale in the column'
);
select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000003'),
  false,
  'a clean sale is not quarantined'
);

update public.auction_sales
   set raw_payload = raw_payload || '{"source_identity_mismatch": {"expected": "a"}}'::jsonb
 where id = 'c4770000-1000-4000-8000-000000000003';
select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000003'),
  true,
  'a key added by an update quarantines the sale'
);
update public.auction_sales
   set raw_payload = raw_payload - 'source_identity_mismatch'
 where id = 'c4770000-1000-4000-8000-000000000003';
select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000003'),
  false,
  'and removing it lifts the quarantine'
);

update public.auction_sales
   set catalogue_quarantined = false
 where id = 'c4770000-1000-4000-8000-000000000001';
select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000001'),
  true,
  'a direct write of the column is corrected by the trigger'
);

select is(
  app_private.auction_sale_is_publicly_visible('c4770000-1000-4000-8000-000000000001'),
  false,
  'a sale quarantined only by an identity conflict is out of the public catalogue even with a visible status'
);
select is(
  app_private.auction_sale_is_publicly_visible('c4770000-1000-4000-8000-000000000003'),
  true,
  'the clean sale stays public'
);

-- Recalcul des lignes en dérive ---------------------------------------------------------------------
-- Une dérive ne peut venir que d'une écriture faite déclencheurs désactivés.
alter table public.auction_sales disable trigger user;
update public.auction_sales
   set catalogue_quarantined = false
 where id = 'c4770000-1000-4000-8000-000000000001';
alter table public.auction_sales enable trigger user;

select cmp_ok(
  app_private.repair_catalogue_quarantine_drift(),
  '>=',
  1,
  'the repair corrects the drifted row'
);
select is(
  (select catalogue_quarantined from public.auction_sales where id = 'c4770000-1000-4000-8000-000000000001'),
  true,
  'the column is back in line with the payload'
);
select is(
  app_private.repair_catalogue_quarantine_drift(),
  0,
  'a second pass finds nothing to correct'
);

select * from finish();
rollback;
