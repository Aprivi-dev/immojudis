-- 20261208100100 : app_private.sale_registry_columns rend les colonnes des champs que le registre des pièces tient
-- ou a tenus sur une vente (valeur tenue ou libérée avec mémoire d'écho), jamais une valeur ; aucun rôle du
-- navigateur ne l'exécute.
begin;

select plan(7);

select has_function('app_private', 'sale_registry_columns', array['text'], 'the function exists');

select ok(
  not has_function_privilege('anon', 'app_private.sale_registry_columns(text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.sale_registry_columns(text)', 'execute')
  and has_function_privilege('service_role', 'app_private.sale_registry_columns(text)', 'execute'),
  'no browser role executes the function'
);

select is(
  (select pg_catalog.format_type(prorettype, null) from pg_catalog.pg_proc
    where oid = 'app_private.sale_registry_columns(text)'::regprocedure),
  'text[]',
  'it returns column names only'
);

select is(
  app_private.sale_registry_columns('https://example.test/vente-inconnue-913'),
  '{}'::text[],
  'an unknown sale has no registry column'
);

-- Trois ventes : un champ tenu, un champ libéré avec sa mémoire d'écho, rien au registre. Le registre ne s'écrit que
-- sous le marqueur de la projection, posé ici par le propriétaire comme dans 885 ; les valeurs ne sont jamais lues.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, surface_m2, app_surface_m2, rooms_count
) values
  ('91300000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/913/held', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal',
   50, 50, 2),
  ('91300000-1000-4000-8000-000000000002', 'licitor', 'https://example.test/913/released', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal',
   null, null, 3),
  ('91300000-1000-4000-8000-000000000003', 'licitor', 'https://example.test/913/none', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb, 'tribunal',
   50, 50, 2);

select set_config('app.sale_field_projection', '91300000-1000-4000-8000-000000000001', true);
update public.auction_sales
   set held_fields = '{"property.rooms_count": {"state": "held", "value": 2}}'::jsonb
 where id = '91300000-1000-4000-8000-000000000001';
select set_config('app.sale_field_projection', '91300000-1000-4000-8000-000000000002', true);
update public.auction_sales
   set held_fields = '{"property.surface_m2": {"state": "released", "echo": [{"value": 54, "until": null}]}}'::jsonb
 where id = '91300000-1000-4000-8000-000000000002';
select set_config('app.sale_field_projection', '', true);

select is(
  app_private.sale_registry_columns('https://example.test/913/held'),
  array['rooms_count']::text[],
  'a held field gives its columns'
);

select is(
  app_private.sale_registry_columns('https://example.test/913/released'),
  array['app_surface_kind', 'app_surface_m2', 'surface_confidence', 'surface_m2', 'surface_source']::text[],
  'a field released with its echo memory gives its columns too'
);

select is(
  app_private.sale_registry_columns('https://example.test/913/none'),
  '{}'::text[],
  'a sale without any registry entry (held_fields null) has no registry column'
);

select * from finish();
rollback;
