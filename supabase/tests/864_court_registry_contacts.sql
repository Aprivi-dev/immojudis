-- 20261110190000 et 20261110190100 : référentiel des tribunaux judiciaires et de leurs adresses email, contact de secours
-- d'une vente au tribunal.
--   * table privée : RLS activée, aucun droit pour anon ni authenticated, lecture par le rôle de service seulement ;
--   * 168 juridictions (fichier du propriétaire du 01/11/2026), 162 avec une adresse, 6 sans, Cayenne en a 2 ;
--   * les contraintes écartent une adresse en majuscules, une adresse avec espace, plus de 4 adresses, un code vide ;
--   * l'origine `court_registry_fallback` est admise dans le registre des contacts de l'agent, une origine inconnue non ;
--   * la règle SQL du minimum d'une annonce garde une vente au tribunal reconnue (confirmée par l'annonce, hors notaires,
--     cessions de l'État et AGRASC, sans incohérence de tribunal) dont le tribunal a une adresse, et rien d'autre.
begin;

select plan(35);

select has_table('public', 'court_registry_contacts', 'the court registry exists');

-- Table privée : RLS activée, aucun droit pour anon ni authenticated, droits complets pour le rôle de service.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.court_registry_contacts'::regclass),
  'court_registry_contacts has row level security'
);

select ok(
  not has_table_privilege(role, 'public.court_registry_contacts', privilege),
  format('%s has no %s right on court_registry_contacts', role, privilege)
)
from unnest(array['anon', 'authenticated']) as role
cross join unnest(array['select', 'insert', 'update', 'delete']) as privilege;

select ok(
  has_table_privilege('service_role', 'public.court_registry_contacts', privilege),
  format('service_role has %s on court_registry_contacts', privilege)
)
from unnest(array['select', 'insert', 'update', 'delete']) as privilege;

-- Contenu : 168 juridictions, 162 avec une adresse, 6 sans.
select is((select count(*)::int from public.court_registry_contacts), 168, 'the registry holds the 168 courts');

select is(
  (select count(*)::int from public.court_registry_contacts where cardinality(emails) > 0),
  162,
  '162 courts have an email address'
);

select is(
  (select array_agg(court_code order by court_code) from public.court_registry_contacts where cardinality(emails) = 0),
  array[
    'justice_tj_1_134', 'justice_tj_1_138', 'justice_tj_1_152', 'justice_tj_1_64', 'justice_tj_1_96',
    'justice_tj_9_7677'
  ]::text[],
  'the six courts without an address are Angoulême, Argentan, Béziers, Sarreguemines, Verdun and Saint-Pierre-et-Miquelon'
);

select is(
  (select cardinality(emails) from public.court_registry_contacts where court_code = 'justice_tj_1_216'),
  2,
  'Cayenne (Matoury) has two addresses'
);

select is(
  (select emails from public.court_registry_contacts where court_code = 'agen'),
  array['tj-agen@justice.fr']::text[],
  'the historical code of Agen is attached to its address'
);

select ok(
  not exists (
    select 1
    from public.court_registry_contacts contact, unnest(contact.emails) as address
    where address <> lower(address) or address !~ '@justice\.fr$'
  ),
  'every address is lower case and ends with @justice.fr'
);

select is(
  (select name from public.court_registry_contacts where court_code = 'justice_tj_1_217'),
  'Tribunal judiciaire de Saint-Denis',
  'Saint-Denis of the file is the court of Saint-Denis de La Réunion'
);

-- Les contraintes écartent une ligne mal formée.
select throws_ok(
  $$insert into public.court_registry_contacts (court_code, name, city, emails, address, source)
    values ('t864_upper', 'Tribunal d''essai', 'ESSAI', array['Greffe@Justice.fr'], '1 rue de l''Essai 00000 ESSAI', 'test')$$,
  '23514',
  null,
  'an address in capitals is refused'
);

select throws_ok(
  $$insert into public.court_registry_contacts (court_code, name, city, emails, address, source)
    values ('t864_space', 'Tribunal d''essai', 'ESSAI', array['greffe essai@justice.fr'], '1 rue de l''Essai 00000 ESSAI', 'test')$$,
  '23514',
  null,
  'an address with a space is refused'
);

select throws_ok(
  $$insert into public.court_registry_contacts (court_code, name, city, emails, address, source)
    values ('t864_many', 'Tribunal d''essai', 'ESSAI',
            array['a@justice.fr', 'b@justice.fr', 'c@justice.fr', 'd@justice.fr', 'e@justice.fr'],
            '1 rue de l''Essai 00000 ESSAI', 'test')$$,
  '23514',
  null,
  'more than four addresses are refused'
);

select throws_ok(
  $$insert into public.court_registry_contacts (court_code, name, city, emails, address, source)
    values ('  ', 'Tribunal d''essai', 'ESSAI', array['a@justice.fr'], '1 rue de l''Essai 00000 ESSAI', 'test')$$,
  '23514',
  null,
  'a blank court code is refused'
);

select throws_ok(
  $$insert into public.court_registry_contacts (court_code, name, city, emails, address, source)
    values ('t864_null', 'Tribunal d''essai', 'ESSAI', array['a@justice.fr', null], '1 rue de l''Essai 00000 ESSAI', 'test')$$,
  '23514',
  null,
  'a null address in the list is refused'
);

-- Origine d'une adresse de greffe dans le registre des contacts de l'agent.
select lives_ok(
  $$insert into public.information_agent_contacts (email, source_kind, observed_at, observed_by)
    values ('greffe-864@justice.fr', 'court_registry_fallback', now(), 'agent')$$,
  'the court registry origin is accepted without a public page'
);

select throws_ok(
  $$insert into public.information_agent_contacts (email, source_kind, observed_at, observed_by)
    values ('inconnu-864@example.test', 'search_engine', now(), 'agent')$$,
  '23514',
  null,
  'an unknown origin is still refused'
);

-- Fonctions : fermées au navigateur.
select ok(
  not has_function_privilege('anon', 'app_private.sale_has_court_registry_email(public.auction_sales)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.sale_has_court_registry_email(public.auction_sales)', 'execute')
    and has_function_privilege('service_role', 'app_private.sale_has_court_registry_email(public.auction_sales)', 'execute'),
  'the court email proof is closed to the browser and open to the service role'
);

select ok(
  not has_function_privilege('anon', 'app_private.sale_has_listing_minimum(public.auction_sales)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.sale_has_listing_minimum(public.auction_sales)', 'execute')
    and has_function_privilege('service_role', 'app_private.sale_has_listing_minimum(public.auction_sales)', 'execute'),
  'the minimum rule keeps its privileges'
);

select ok(
  not has_function_privilege('anon', 'app_private.sale_has_listing_minimum_without_court_email(public.auction_sales)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.sale_has_listing_minimum_without_court_email(public.auction_sales)', 'execute')
    and has_function_privilege('service_role', 'app_private.sale_has_listing_minimum_without_court_email(public.auction_sales)', 'execute'),
  'the original rule is closed to the browser too'
);

-- Règle SQL du minimum : la preuve court_email.
insert into public.tribunals (code, canonical_name, department, city)
values
  ('agen', 'TJ Agen', '47', 'Agen'),
  ('justice_tj_9_7677', 'TJ Tribunal de Première Instance de Saint-Pierre-et-Miquelon', '975', 'Saint-Pierre-et-Miquelon')
on conflict (code) do nothing;

insert into public.auction_sales (
  id, source_name, primary_source, source_url, title, status, sale_date, address, city, tribunal_code,
  sale_venue_type, sale_verification_status, quality_flags, lawyer_contact
) values
  ('c8640000-1000-4000-8000-000000000001', 'listing-864', 'licitor', 'https://www.licitor.test/864-1', 'Court sale', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'tribunal', 'verified', '[]', null),
  ('c8640000-1000-4000-8000-000000000002', 'listing-864', 'licitor', 'https://www.licitor.test/864-2', 'Court sale cross checked', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'tribunal', 'cross_checked', '[]', null),
  ('c8640000-1000-4000-8000-000000000003', 'listing-864', 'licitor', 'https://www.licitor.test/864-3', 'Court only guessed', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'tribunal', 'pending', '[]', null),
  ('c8640000-1000-4000-8000-000000000004', 'listing-864', 'licitor', 'https://www.licitor.test/864-4', 'Inconsistent court', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'tribunal', 'verified', '["tribunal_inconsistent"]', null),
  ('c8640000-1000-4000-8000-000000000005', 'notaires', 'notaires', 'https://www.notaires.test/864-5', 'Notarial sale', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'tribunal', 'verified', '[]', null),
  ('c8640000-1000-4000-8000-000000000006', 'listing-864', 'licitor', 'https://www.licitor.test/864-6', 'Court without an address', 'upcoming',
   '2099-01-01 12:00:00Z', '97500 SAINT-PIERRE', 'Saint-Pierre', 'justice_tj_9_7677', 'tribunal', 'verified', '[]', null),
  ('c8640000-1000-4000-8000-000000000007', 'listing-864', 'licitor', 'https://www.licitor.test/864-7', 'No court', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', null, 'tribunal', 'verified', '[]', null),
  ('c8640000-1000-4000-8000-000000000008', 'agrasc', 'agrasc', 'https://www.agrasc.test/864-8', 'AGRASC sale', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'tribunal', 'verified', '[]', null),
  ('c8640000-1000-4000-8000-000000000009', 'cessions_etat', 'cessions_etat', 'https://www.cessions.test/864-9', 'State sale', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', 'agen', 'state', 'verified', '[]', null),
  ('c8640000-1000-4000-8000-00000000000a', 'listing-864', 'licitor', 'https://www.licitor.test/864-10', 'Own email, no court', 'upcoming',
   '2099-01-01 12:00:00Z', '47000 AGEN', 'Agen', null, 'unknown', 'pending', '[]', 'contact@cabinet-modele.example');

select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name = 'listing-864' and app_private.sale_has_listing_minimum(s)),
  array['c8640000-1000-4000-8000-000000000001', 'c8640000-1000-4000-8000-000000000002',
        'c8640000-1000-4000-8000-00000000000a']::uuid[],
  'a confirmed court sale whose court has an address is kept, like a sale with its own email'
);

select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name = 'listing-864' and not app_private.sale_has_listing_minimum(s)),
  array['c8640000-1000-4000-8000-000000000003', 'c8640000-1000-4000-8000-000000000004',
        'c8640000-1000-4000-8000-000000000006', 'c8640000-1000-4000-8000-000000000007']::uuid[],
  'a court only guessed, an inconsistent court, a court without an address and a sale without court are not kept'
);

select is(
  (select array_agg(id order by id) from public.auction_sales s
    where s.source_name in ('notaires', 'agrasc', 'cessions_etat')
      and s.id::text like 'c8640000-%' and app_private.sale_has_listing_minimum(s)),
  null::uuid[],
  'notarial, AGRASC and state sales never get the court fallback'
);

select is(
  (select count(*)::int from public.auction_sales s
    where s.id::text like 'c8640000-%' and app_private.sale_has_court_registry_email(s)),
  2,
  'only the two confirmed court sales carry the court email proof'
);

select * from finish();

rollback;
