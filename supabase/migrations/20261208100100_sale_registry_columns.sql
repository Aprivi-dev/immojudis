-- 20261208100100 : colonnes d'une vente que le registre des pièces tient ou a tenues (lot V3b-1).
--
-- La passe d'écriture de la lecture des pièces par Claude (services/data-pipeline/src/document_vision_pass.py)
-- n'écrit jamais un champ que le registre connaît pour la vente : valeur tenue (état held ou conflicted), ou valeur
-- libérée qui garde sa mémoire d'écho (état released). La base retiendrait sinon la valeur écrite, avec un évènement
-- echo_suppressed et son alerte. Le pipeline ne lit pas lui-même l'état du registre (invariant de
-- scripts/check-security-invariants-fact-registry.mjs) : cette fonction lui rend les seules colonnes des champs
-- concernés, tirées de auction_fact_fields.held_columns. Jamais une valeur, une pièce, une décision ni une origine.
--
-- Fonction interne (schéma app_private), comme app_private.sale_is_fully_withdrawn que lit déjà la même requête du
-- pipeline : aucune route de l'API ne l'atteint. security invoker : elle lit avec les droits de l'appelant (la
-- connexion directe du pipeline) ; exécutable par service_role seul parmi les rôles de l'API.
--
-- Retour arrière : `drop function if exists app_private.sale_registry_columns(text);` (avec le code qui l'appelle).
begin;

create or replace function app_private.sale_registry_columns(p_source_url text)
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct held.column_name order by held.column_name), '{}'::text[])
  from public.auction_sales sale
  cross join lateral pg_catalog.jsonb_object_keys(
    case when pg_catalog.jsonb_typeof(sale.held_fields) = 'object' then sale.held_fields else '{}'::jsonb end
  ) entry(field_key)
  join public.auction_fact_fields field on field.field_key = entry.field_key
  cross join lateral pg_catalog.unnest(field.held_columns) held(column_name)
  where sale.source_url = p_source_url;
$$;

comment on function app_private.sale_registry_columns(text) is
  'Registre des pièces : les colonnes des champs que la vente tient ou a tenus (valeur tenue, ou libérée avec mémoire d''écho). Jamais une valeur. Pour la passe d''écriture de la lecture des pièces du pipeline.';

revoke all on function app_private.sale_registry_columns(text) from public, anon, authenticated;
grant execute on function app_private.sale_registry_columns(text) to service_role;

commit;
