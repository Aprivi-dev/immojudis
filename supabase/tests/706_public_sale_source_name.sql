-- Fiche publique : nom de la source d'origine (migration 20261101190100).
--   * la fonction publique est accessible sans compte, la fonction privée est SECURITY DEFINER à
--     search_path vide, l'enveloppe publique est SECURITY INVOKER ;
--   * la sortie est un seul texte : le nom de la source, jamais l'adresse de l'annonce d'origine ;
--   * seules les ventes visibles du catalogue public sont concernées (une vente en quarantaine ou
--     retirée n'a rien à dire, comme une vente inconnue).
begin;

select plan(9);

-- Jeu d'essai -----------------------------------------------------------------------------------------------
--   1 vente à venir visible, source « licitor »
--   2 vente à venir visible, source « avoventes »
--   3 vente en quarantaine                  -> null
--   4 vente retirée                          -> null
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type
)
values
  ('c7060000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/706/01', 'upcoming',
    current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb,
    'tribunal'),
  ('c7060000-0000-4000-8000-000000000002', 'avoventes', 'https://example.test/706/02', 'upcoming',
    current_timestamp + interval '21 days', 'Betaville', 'house', 120000, '{}'::jsonb, '{}'::jsonb,
    'tribunal'),
  ('c7060000-0000-4000-8000-000000000003', 'licitor', 'https://example.test/706/03', 'upcoming',
    current_timestamp + interval '23 days', 'Deltaville', 'apartment', 70000,
    '{"publication_quarantine": "operator_hold"}'::jsonb, '{}'::jsonb, 'tribunal'),
  ('c7060000-0000-4000-8000-000000000004', 'licitor', 'https://example.test/706/04', 'withdrawn',
    current_timestamp + interval '24 days', 'Epsilonville', 'apartment', 70000, '{}'::jsonb, '{}'::jsonb,
    'tribunal');

-- Le contrat ---------------------------------------------------------------------------------------------------

select has_function('public', 'get_public_sale_source_name', array['uuid'], 'the public RPC exists');
select is(
  pg_get_function_result('public.get_public_sale_source_name(uuid)'::regprocedure),
  'text',
  'the answer is a single text: no URL, no raw content'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'app_private.get_public_sale_source_name(uuid)'::regprocedure)
  and not (select prosecdef from pg_proc where oid = 'public.get_public_sale_source_name(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'public.get_public_sale_source_name(uuid)'::regprocedure),
  'the read is security definer with an empty search_path, the wrapper security invoker'
);
select ok(
  has_function_privilege('anon', 'public.get_public_sale_source_name(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_sale_source_name(uuid)', 'execute')
  and not has_function_privilege('public', 'public.get_public_sale_source_name(uuid)', 'execute'),
  'a visitor and an account can call it, public itself cannot'
);
select is(
  (select pg_get_functiondef('app_private.get_public_sale_source_name(uuid)'::regprocedure)
          ~ 's\.(source_url|source_urls|address|latitude|longitude|lawyer_contact|documents|visit_dates|raw_payload|description|raw_text)\b'),
  false,
  'no URL, address, contact, document or raw content comes out'
);

-- Le comportement ----------------------------------------------------------------------------------------------

select is(
  public.get_public_sale_source_name('c7060000-0000-4000-8000-000000000001'), 'licitor',
  'a visible sale gives its source name'
);
select is(
  public.get_public_sale_source_name('c7060000-0000-4000-8000-000000000002'), 'avoventes',
  'another source, another name'
);
select is(
  array[
    public.get_public_sale_source_name('c7060000-0000-4000-8000-000000000003'),
    public.get_public_sale_source_name('c7060000-0000-4000-8000-000000000004'),
    public.get_public_sale_source_name('c7060000-0000-4000-8000-0000000000ff')
  ],
  array[null, null, null]::text[],
  'a quarantined, a withdrawn and an unknown sale give nothing'
);

-- Un visiteur anonyme ------------------------------------------------------------------------------------------

set local role anon;
select is(
  public.get_public_sale_source_name('c7060000-0000-4000-8000-000000000001'), 'licitor',
  'a signed-out visitor reads the source name'
);
reset role;

select * from finish();
rollback;
