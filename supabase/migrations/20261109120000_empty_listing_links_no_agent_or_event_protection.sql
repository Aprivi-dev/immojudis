begin;

set local lock_timeout = '5s';

-- Annonces vides (migrations 20261108202000, 20261108204200, 20261109110000) : décision du propriétaire du 29/10,
-- « pas de nécessité à conserver des annonces vides ». Deux familles de lignes ne protègent plus une annonce vide :
--   * account_product_events : mesure d'usage agrégée (la clé étrangère met sale_id à null à la suppression) ;
--   * information_agent_* : contacts, missions et pièces de l'agent d'information (cascade ou set null). Une
--     annonce vide n'a pas d'email exploitable : l'agent ne peut rien en tirer.
-- Restent protectrices les traces d'un utilisateur sur la vente elle-même : favori, déblocage, rapport, espace de
-- travail, annotation, analyse, relance, demande d'avocat ou de publication, et les alias revus.
create or replace function app_private.empty_listing_links(p_sale_ids uuid[])
returns table (relation_name text, link_kind text, sale_id uuid)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  -- Traces utilisateur : une vente qui y figure est gardée.
  v_user_tables constant text[] := array[
    'user_favorites', 'user_sale_unlocks', 'saved_property_reports', 'sale_workspaces',
    'sale_workspace_annotations', 'user_sale_analysis_items',
    'user_sale_change_events', 'sale_signal_feedback', 'lawyer_referral_requests',
    'lawyer_placement_events', 'listing_publication_requests', 'data_refresh_requests', 'sale_reminder_dispatches',
    'reviewed_publication_aliases', 'auction_sale_merges'
  ];
  -- Générées par le système : partent en cascade avec la vente (décision du propriétaire).
  v_accepted_tables constant text[] := array[
    'user_alert_matches', 'user_alert_notifications', 'user_sale_watch_snapshots', 'account_product_events'
  ];
  -- Tables que la rétention vide déjà avant la vente (public.purge_expired_auction_sales).
  v_cleanable_tables constant text[] := array['valuation_estimates', 'auction_observations'];
  v_foreign_key record;
  v_kind text;
begin
  for v_foreign_key in
    select constraint_row.conrelid::regclass::text as table_name,
           class_row.relname as relation_name,
           class_row.oid as relation_oid,
           referencing.attname as column_name,
           referenced.attname as referenced_column,
           constraint_row.confdeltype as delete_action
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class class_row on class_row.oid = constraint_row.conrelid
      join pg_catalog.pg_attribute referencing
        on referencing.attrelid = constraint_row.conrelid and referencing.attnum = constraint_row.conkey[1]
      join pg_catalog.pg_attribute referenced
        on referenced.attrelid = constraint_row.confrelid and referenced.attnum = constraint_row.confkey[1]
     where constraint_row.contype = 'f'
       and constraint_row.confrelid = 'public.auction_sales'::regclass
     order by 1, 4
  loop
    -- Avant le test de la colonne user_id : valuation_estimates en porte une (vide pour une estimation automatique),
    -- et ces tables sont vidées ou détachées avec la vente.
    -- L'agent d'information est accepté lui aussi : ses lignes partent en cascade ou sont détachées (set null).
    if v_foreign_key.relation_name = any(v_accepted_tables)
      or v_foreign_key.relation_name like 'information\_agent\_%'
      or v_foreign_key.relation_name = any(v_cleanable_tables)
    then
      continue;
    end if;
    if v_foreign_key.relation_name = any(v_user_tables)
      or exists (
        select 1 from pg_catalog.pg_attribute marker
         where marker.attrelid = v_foreign_key.relation_oid
           and marker.attname in ('user_id', 'account_id', 'owner_id')
           and marker.attnum > 0 and not marker.attisdropped
      )
    then
      v_kind := 'user_trace';
    elsif v_foreign_key.delete_action in ('a', 'r') then
      v_kind := 'blocking_link';
    else
      continue;
    end if;
    return query execute pg_catalog.format(
      'select %L::text, %L::text, sale.id from public.auction_sales sale '
      'where sale.id = any($1) and exists (select 1 from %s linked where linked.%I = sale.%I)',
      v_foreign_key.relation_name, v_kind, v_foreign_key.table_name, v_foreign_key.column_name,
      v_foreign_key.referenced_column
    ) using p_sale_ids;
  end loop;
end;
$function$;

commit;
