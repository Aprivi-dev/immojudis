-- 20261210100000 : origine « lecture automatique des pièces » sur la fiche publique (lot V3b-2).
--   * la fonction publique est accessible sans compte ; la lecture est SECURITY DEFINER à search_path vide,
--     l'enveloppe publique SECURITY INVOKER ;
--   * la sortie se limite à la colonne, au type de la pièce (liste fermée), à la page et à l'empreinte de l'adresse
--     de la pièce : ni valeur, ni citation, ni adresse ;
--   * l'empreinte n'est rendue qu'à un compte qui reçoit déjà les pièces (offre Analyse, vente débloquée), jamais à
--     anon ni à un compte gratuit qui n'a pas débloqué la vente ;
--   * seules les traces de la lecture des pièces par Claude (reader = 'document_vision') sont rendues, pour les
--     colonnes affichées seulement, et tant que la valeur affichée est celle de la trace ;
--   * une colonne que le registre des pièces tient n'a pas de mention ;
--   * une vente hors du catalogue public ne rend rien ; une trace retirée ne rend plus rien.
begin;

select plan(16);

-- Le contrat ---------------------------------------------------------------------------------------------------
select has_function('public', 'get_public_sale_document_fact_sources', array['uuid'], 'the public RPC exists');
select is(
  pg_get_function_result('public.get_public_sale_document_fact_sources(uuid)'::regprocedure),
  'TABLE(fact_key text, document_type text, page_number integer, document_key text)',
  'the answer is limited to the column, the type of the piece, its page and the digest of its address'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'app_private.get_public_sale_document_fact_sources(uuid)'::regprocedure)
  and not (select prosecdef from pg_proc
           where oid = 'public.get_public_sale_document_fact_sources(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'public.get_public_sale_document_fact_sources(uuid)'::regprocedure),
  'the read is security definer with an empty search_path, the wrapper security invoker'
);
select ok(
  has_function_privilege('anon', 'public.get_public_sale_document_fact_sources(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_sale_document_fact_sources(uuid)', 'execute')
  and not has_function_privilege('public', 'public.get_public_sale_document_fact_sources(uuid)', 'execute'),
  'a visitor and an account can call it, public itself cannot'
);

-- Jeu d'essai ----------------------------------------------------------------------------------------------------
-- Vente 1 : surface habitable et nombre de pièces écrits par la lecture (la surface affichée s'en déduit), terrain
-- projeté par la lecture des PDF (autre lecteur), une colonne non affichée et des traces mal formées.
-- Vente 2 : mêmes traces, mais la vente est hors du catalogue public (mise à l'écart par un opérateur).
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, habitable_surface_m2, app_surface_m2, surface_m2,
  land_surface_m2, rooms_count
)
select
  fixture.id::uuid, 'licitor', fixture.source_url, 'upcoming', current_timestamp + interval '20 days',
  'Alphaville', 'apartment', 90000,
  fixture.extra || jsonb_build_object('pdf_fact_provenance', jsonb_build_object(
    'habitable_surface_m2', jsonb_build_object(
      'value', '62.4', 'source', 'pdf', 'reader', 'document_vision', 'prompt_version', '2026-11-21.2',
      'read_at', '2026-11-25T08:00:00+00:00', 'document_index', 1, 'document_type', 'cahier_conditions_vente',
      'document_url', 'https://example.test/920/cahier.pdf', 'page_number', 12, 'baseline', null),
    'app_surface_m2', jsonb_build_object(
      'value', '62.4', 'source', 'pdf', 'reader', 'document_vision', 'prompt_version', '2026-11-21.2',
      'read_at', '2026-11-25T08:00:00+00:00', 'document_index', 1, 'document_type', 'cahier_conditions_vente',
      'document_url', 'https://example.test/920/cahier.pdf', 'page_number', 12, 'baseline', null,
      'derived_from', 'habitable_surface_m2'),
    'rooms_count', jsonb_build_object(
      'value', 3, 'source', 'pdf', 'reader', 'document_vision', 'prompt_version', '2026-11-21.2',
      'read_at', '2026-11-25T08:00:00+00:00', 'document_index', 2, 'document_type', 'pv_dupont',
      'document_url', 'https://example.test/920/pv.pdf', 'page_number', 3, 'baseline', null),
    'land_surface_m2', jsonb_build_object(
      'value', '500', 'source', 'pdf', 'evidence', 'terrain de 500 m2 appartenant a M. Dupont',
      'document_url', 'https://example.test/920/cahier.pdf', 'page_number', 4),
    'surface_m2', jsonb_build_object(
      'value', '62.4', 'source', 'pdf', 'reader', 'document_vision', 'page_number', 12,
      'document_url', 'https://example.test/920/cahier.pdf')
  )),
  '{}'::jsonb, 'tribunal', 62.4, 62.4, 62.4, 500, 3
from (
  values
    ('92000000-1000-4000-8000-000000000001', 'https://example.test/920/01', '{}'::jsonb),
    ('92000000-1000-4000-8000-000000000002', 'https://example.test/920/02',
      '{"publication_quarantine": "operator_hold"}'::jsonb)
) as fixture(id, source_url, extra);

-- Deux comptes : gratuit (Découverte) et Analyse. L'offre de lancement est coupée dans la base de test (comme 741).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('92000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pieces-free-920@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('92000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pieces-analysis-920@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('92000000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('92000000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

-- Le comportement ------------------------------------------------------------------------------------------------
-- Visiteur sans compte (le chemin du serveur, mis en cache) : la pièce et la page, jamais l'empreinte.
set local role anon;
select results_eq(
  $$select fact_key, document_type, page_number, document_key
    from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')$$,
  $$values
      ('app_surface_m2', 'cahier_conditions_vente', 12, null::text),
      ('rooms_count', null::text, 3, null::text)$$,
  'a visitor gets each displayed column written by the reading with its piece and page, never the digest; another reader, a column that is not displayed and a type outside the closed list (pv_dupont) never come out'
);

select ok(
  not exists (
    select 1
    from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001') source
    where row_to_json(source)::text ~* 'example\.test|dupont|62\.4|terrain'
  ),
  'the answer carries neither an address, nor a name, nor a value, nor a quote'
);
reset role;

-- Compte gratuit : pas d'empreinte tant que la vente n'est pas débloquée, l'empreinte ensuite.
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '92000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')
    where document_key is not null),
  0,
  'a free account that did not unlock the sale gets no digest'
);
reset role;
insert into public.user_sale_unlocks (user_id, sale_id)
values ('92000000-0000-4000-8000-000000000001', '92000000-1000-4000-8000-000000000001');
set local role authenticated;
select results_eq(
  $$select fact_key, document_key
    from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')$$,
  $$values
      ('app_surface_m2', encode(sha256(convert_to('https://example.test/920/cahier.pdf', 'UTF8')), 'hex')),
      ('rooms_count', encode(sha256(convert_to('https://example.test/920/pv.pdf', 'UTF8')), 'hex'))$$,
  'a free account that unlocked the sale gets the digest of each piece, as the unlocked view serves the pieces'
);

-- Compte Analyse : l'empreinte, comme la vue de l'offre lui sert les pièces.
set local "request.jwt.claim.sub" = '92000000-0000-4000-8000-000000000002';
select is(
  (select count(*)::integer
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')
    where document_key ~ '^[0-9a-f]{64}$'),
  2,
  'an Analyse account gets the digest of each piece'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

-- Un type de pièce hors de la liste fermée devient nul, même quand il a la forme d'un code.
select is(
  (select document_type
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')
    where fact_key = 'rooms_count'),
  null::text,
  'a piece type outside the closed list (pv_dupont) is null'
);

select is(
  (select count(*)::integer
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000002')),
  0,
  'a sale outside the public catalogue gives nothing'
);

select is(
  (select count(*)::integer
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-0000000000ff')),
  0,
  'an unknown sale gives nothing'
);

-- Une valeur réécrite depuis par un autre chemin perd sa mention.
update public.auction_sales set rooms_count = 4 where id = '92000000-1000-4000-8000-000000000001';
select is(
  (select array_agg(fact_key order by fact_key)
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')),
  array['app_surface_m2'],
  'a value changed since the reading loses its mention'
);
update public.auction_sales set rooms_count = 3 where id = '92000000-1000-4000-8000-000000000001';

-- Une colonne que le registre des pièces tient n'a pas de mention, même si la valeur est celle de la trace. Le
-- registre ne s'écrit que sous le marqueur de la projection, posé ici comme dans 913.
select set_config('app.sale_field_projection', '92000000-1000-4000-8000-000000000001', true);
update public.auction_sales
   set held_fields = '{"property.rooms_count": {"state": "held", "value": 3}}'::jsonb
 where id = '92000000-1000-4000-8000-000000000001';
select set_config('app.sale_field_projection', '', true);
select is(
  (select array_agg(fact_key order by fact_key)
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')),
  array['app_surface_m2'],
  'a column held by the registry has no mention'
);

-- Le retrait efface la trace avec la valeur (src.document_vision_pass.withdraw_values) : plus de mention.
update public.auction_sales
   set raw_payload = raw_payload #- '{pdf_fact_provenance,app_surface_m2}'
                                 #- '{pdf_fact_provenance,habitable_surface_m2}',
       habitable_surface_m2 = null, app_surface_m2 = null, surface_m2 = null
 where id = '92000000-1000-4000-8000-000000000001';
select is(
  (select count(*)::integer
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')),
  0,
  'a withdrawn trace gives nothing'
);

-- Une page qui n'est pas un entier positif : pas de mention.
update public.auction_sales
   set raw_payload = jsonb_set(raw_payload, '{pdf_fact_provenance,land_surface_m2}', jsonb_build_object(
         'value', '500', 'source', 'pdf', 'reader', 'document_vision', 'page_number', 'deux',
         'document_type', 'cahier_conditions_vente'))
 where id = '92000000-1000-4000-8000-000000000001';
select is(
  (select count(*)::integer
     from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')),
  0,
  'a trace without a page number gives nothing'
);

select * from finish();
rollback;
