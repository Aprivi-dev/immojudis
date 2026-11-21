-- 20261208100100 : app_private.sale_registry_columns rend les colonnes des champs que le registre des pièces tient
-- ou a tenus sur une vente (valeur tenue ou libérée avec mémoire d'écho), jamais une valeur ; aucun rôle du
-- navigateur ne l'exécute.
begin;

select plan(5);

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

-- Une vente inconnue n'a aucune colonne. Une vente du registre (valeur tenue ou libérée) est exercée par le test
-- Postgres du pipeline (services/data-pipeline/tests/test_document_vision_pass.py), sur la vraie fonction.
select is(
  app_private.sale_registry_columns('https://example.test/vente-inconnue-913'),
  '{}'::text[],
  'an unknown sale has no registry column'
);

select is(
  (select pg_catalog.array_agg(distinct held_column order by held_column)
     from public.auction_fact_fields field, pg_catalog.unnest(field.held_columns) held_column
    where field.field_key in ('property.surface_m2', 'property.rooms_count')),
  array['app_surface_kind', 'app_surface_m2', 'rooms_count', 'surface_confidence', 'surface_m2', 'surface_source']::text[],
  'the columns come from auction_fact_fields.held_columns (surface and rooms of the registry)'
);

select * from finish();
rollback;
