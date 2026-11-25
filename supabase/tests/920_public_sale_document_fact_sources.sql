-- 20261210100000 : origine « lecture automatique des pièces » sur la fiche publique (lot V3b-2).
--   * la fonction publique est accessible sans compte ; la lecture est SECURITY DEFINER à search_path vide,
--     l'enveloppe publique SECURITY INVOKER ;
--   * la sortie se limite à la colonne, au type de la pièce, à la page et à l'empreinte de l'adresse de la pièce :
--     ni valeur, ni citation, ni adresse ;
--   * seules les traces de la lecture des pièces par Claude (reader = 'document_vision') sont rendues, pour les
--     colonnes affichées seulement, et tant que la valeur affichée est celle de la trace ;
--   * une colonne que le registre des pièces tient n'a pas de mention ;
--   * une vente hors du catalogue public ne rend rien ; une trace retirée ne rend plus rien.
begin;

select plan(12);

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
      'read_at', '2026-11-25T08:00:00+00:00', 'document_index', 2, 'document_type', 'Pièce de M. Dupont',
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

-- Le comportement ------------------------------------------------------------------------------------------------
select results_eq(
  $$select fact_key, document_type, page_number, document_key
    from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001')$$,
  $$values
      ('app_surface_m2', 'cahier_conditions_vente', 12,
        encode(sha256(convert_to('https://example.test/920/cahier.pdf', 'UTF8')), 'hex')),
      ('rooms_count', null::text, 3,
        encode(sha256(convert_to('https://example.test/920/pv.pdf', 'UTF8')), 'hex'))$$,
  'each displayed column written by the reading comes out with its piece and page; another reader, a column that is not displayed and a type that is not a code never do'
);

select ok(
  not exists (
    select 1
    from public.get_public_sale_document_fact_sources('92000000-1000-4000-8000-000000000001') source
    where row_to_json(source)::text ~* 'example\.test|dupont|62\.4|terrain'
  ),
  'the answer carries neither an address, nor a name, nor a value, nor a quote'
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
