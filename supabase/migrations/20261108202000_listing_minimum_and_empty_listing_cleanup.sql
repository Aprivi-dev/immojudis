begin;

set local lock_timeout = '5s';

-- Minimum d'une annonce pour exister en base (règle du propriétaire du 28/10/2026) et suppression de celles qui
-- ne l'ont pas. Une annonce qui n'a NI voie ou lieu-dit, NI adresse email de contact, NI pièce, NI autre source
-- n'apporte rien. Le pipeline ne l'écrit plus (services/data-pipeline/src/listing_minimum.py, appliqué à
-- l'écriture, dans resolve_publication_identities) ; cette migration fournit les fonctions SQL qui traduisent la même
-- règle et qui suppriment l'existant. ELLE NE SUPPRIME RIEN ELLE-MÊME (supabase/README.md, règle 2 : pas de
-- réparation de données dans une migration) : la suppression se lance à la main avec
-- supabase/repairs/20261108202100_delete_empty_listings.sql, qui appelle app_private.delete_empty_listings
-- (comptage seul par défaut, puis application). Ordre de mise en production : le code du pipeline (règle d'entrée)
-- d'abord, la suppression ensuite ; sinon la collecte suivante recrée les annonces.
--
-- LA RÈGLE, côté SQL (traduction au plus près de la règle Python ; là où elle ne peut pas être identique, elle
-- GARDE plus : la suppression est définitive, une vente gardée à tort se supprime plus tard, l'inverse non) :
--   * voie ou lieu-dit : app_private.listing_has_street_or_lieu_dit(adresse, commune) ; la commune seule ne compte
--     pas, et le nom de la commune est retiré avant lecture (« 02400 CHÂTEAU-THIERRY » n'est pas un lieu-dit) ;
--   * email : app_private.listing_has_contact_email(texte) sur lawyer_contact et sur les blocs source de
--     contact (clé contenant avocat, contact, mail, notaire, gestionnaire, étude ou cabinet). Un nom d'avocat seul, un téléphone seul ne comptent pas (l'agent d'information ne
--     travaille que par email) ; les adresses que l'agent ne sollicite jamais (juridiction, RPVA, Ordre, CARPA,
--     noreply, dpo, rgpd) ne comptent pas ;
--   * pièce : documents (colonne ou raw_payload) non vide ;
--   * autre source : au moins deux hôtes parmi source_url et source_urls, ou deux sources parmi source_name et
--     observations, ou une ligne du registre des alias revus ou des fusions.
--
-- NE JAMAIS SUPPRIMER UNE VENTE QUI A UNE TRACE UTILISATEUR. delete_empty_listings lit au démarrage la liste réelle
-- des clés étrangères vers public.auction_sales (pg_constraint), pas une liste figée :
--   * trace utilisateur (favoris, déblocages, rapports, espaces de travail, analyses, suivis, avis, événements de
--     compte, demandes d'avocat, publications, dossiers de l'agent d'information, rappels, demandes de
--     rafraîchissement, alias revus, fusions) ou toute table liée qui porte une colonne user_id, account_id ou
--     owner_id : la vente est GARDÉE. Seules user_alert_matches et user_alert_notifications partent en cascade
--     (décision du propriétaire : alertes générées par le système) ;
--   * clé étrangère NO ACTION / RESTRICT vers une table que la rétention vide déjà (valuation_estimates,
--     auction_observations) : ses lignes sont supprimées d'abord, comme public.purge_expired_auction_sales ;
--   * clé étrangère NO ACTION / RESTRICT vers toute autre table (faits sources, graphe des issues, revues IA,
--     affectations de juridiction...) : la vente est ÉCARTÉE et comptée par table dans le compte rendu. On ne
--     vide pas des preuves statistiques ou des journaux immuables pour supprimer une annonce vide ;
--   * CASCADE ou SET NULL vers une table technique : géré par la base.
--
-- COMME LA RÉTENTION : verrou consultatif de la publication, verrou de table (aucune écriture de la collecte ne
-- peut ajouter un favori pendant la suppression), pont du graphe des issues complet exigé par le déclencheur
-- require_outcome_bridge_before_auction_sale_delete (créé au besoin par le même lot que la rétention), file de
-- nettoyage du stockage, aucune trace de rétention (l'URL n'est pas interdite : c'est la règle d'entrée du pipeline
-- qui empêche son retour). Une vente par sous-transaction : une vente que la base refuse (déclencheur) est
-- comptée et gardée, les autres continuent. Le graphe des issues garde une trace « annoncée, issue inconnue »
-- de chaque vente supprimée, comme pour toute vente purgée.

create extension if not exists unaccent with schema extensions;

-- 1. Voie ou lieu-dit ------------------------------------------------------------------------------------------
create or replace function app_private.listing_has_street_or_lieu_dit(p_address text, p_city text)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_folded text := pg_catalog.lower(extensions.unaccent(pg_catalog.btrim(coalesce(p_address, ''))));
  v_city text := pg_catalog.lower(extensions.unaccent(pg_catalog.btrim(coalesce(p_city, ''))));
  v_before_postal text;
  v_bare text;
  v_parts text[];
  v_head text;
  -- Types de voie placés en tête de l'adresse (position_quality._LEADING_STREET_TYPES, abréviations comprises).
  v_leading constant text :=
    'rue|avenue|av|boulevard|bd|bld|chemin|ch|route|rte|impasse|imp|place|pl|allee|all|quai|cours|square|passage|'
    'voie|sentier|faubourg|fbg|fg|esplanade|promenade|parvis|montee|traverse|ruelle|venelle|mail|chaussee|'
    'cheminement|sente|boucle|carrefour';
  -- Types de voie lus n'importe où dans l'adresse (listing_location._STREET_TYPES).
  v_anywhere constant text :=
    'rue|avenue|av\.?|boulevard|bd\.?|chemin|chem|route|rte|impasse|imp|allees?|place|quai|cours|faubourg|passage|'
    'square|voie|lotissement|hameau|residence|chaussee|esplanade|sentier|ruelle|traverse|rond-point|parvis|clos|'
    'cite|villa|domaine|za|zi|zac|montee|venelle|sente';
begin
  if v_folded = '' then
    return false;
  end if;

  -- a. Voie en tête, après le numéro (street_name_tokens, require_street_type) : lue avant le code postal.
  v_before_postal := (pg_catalog.regexp_split_to_array(v_folded, '\m[0-9]{5}\M'))[1];
  if v_before_postal ~ (
    '^[^[:alpha:]]*(?:(?:n[o°]|bis|ter|quater|[a-d]|et|a)(?![[:alpha:]])[^[:alpha:]]*)*(?:' || v_leading || ')(?![[:alnum:]])'
  ) then
    return true;
  end if;

  -- b. Le reste, lu sans le nom de la commune (classify_address).
  v_bare := v_folded;
  if pg_catalog.length(v_city) >= 2 then
    v_bare := pg_catalog.regexp_replace(
      v_folded,
      '(^|[^[:alnum:]])' || pg_catalog.regexp_replace(v_city, '([^[:alnum:][:space:]])', '\\\1', 'g')
        || '([^[:alnum:]]|$)',
      '\1 \2',
      'g'
    );
  end if;
  if v_bare ~ ('\m(?:' || v_anywhere || ')(?=[[:space:],.;:]|$)')
    or v_bare ~ '\m(?:lieu[[:space:]-]?dit|lieudit|quartier|hameau|ferme|moulin|mas|chateau)\M'
    or v_bare ~ '^[[:space:]]*[0-9]{1,4}[[:space:]]*(?:bis|ter|quater)?[[:space:]]*[,[:space:]][[:space:]]*[a-z]'
  then
    return true;
  end if;

  -- c. Lieu nommé suivi de la commune (« Les Prés Exemple, 18150 Autreville ») : la tête n'est ni un code postal
  -- ni la commune. Plus large que la règle Python (qui compare aussi la tête à la queue) : elle garde plus.
  v_parts := array(
    select part
    from pg_catalog.unnest(
      pg_catalog.regexp_split_to_array(pg_catalog.regexp_replace(v_folded, ',[[:space:]]*france[[:space:]]*$', ''), '[[:space:]]*,[[:space:]]*')
    ) as part
    where pg_catalog.btrim(part) <> ''
  );
  if pg_catalog.cardinality(v_parts) >= 2 then
    v_head := pg_catalog.btrim(v_parts[1]);
    if pg_catalog.length(v_head) >= 3 and v_head !~ '[0-9]{5}' and v_head <> v_city then
      return true;
    end if;
  end if;
  return false;
end;
$function$;

-- 2. Email de contact -----------------------------------------------------------------------------------------
-- Une adresse que l'agent d'information peut solliciter : syntaxe simple, et ni juridiction (justice.fr,
-- justice.gouv.fr), ni messagerie RPVA (avocat-conseil.fr), ni Ordre, barreau, CARPA, ni adresse technique.
create or replace function app_private.listing_has_contact_email(p_text text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from pg_catalog.regexp_matches(
      coalesce(p_text, ''),
      '[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}',
      'g'
    ) as found(address_parts)
    cross join lateral (
      select pg_catalog.lower(address_parts[1]) as address
    ) as normalized
    cross join lateral (
      select pg_catalog.split_part(normalized.address, '@', 1) as local_part,
             pg_catalog.split_part(normalized.address, '@', 2) as domain_part
    ) as split
    where split.domain_part !~ '(^|\.)justice\.(fr|gouv\.fr)$'
      and split.domain_part !~ '(^|\.)avocat-conseil\.fr$'
      and split.domain_part !~ '^(www\.)?((ordre|barreau|batonnat|batonnier|carpa)([.-]|$)|ordredesavocats)'
      and split.local_part !~ '^(ordre|barreau|batonnat|batonnier|carpa)([._+-]|$)'
      and split.local_part !~ '^(no[._-]?reply|do[._-]?not[._-]?reply|dpo|rgpd)([._+-]|$)'
  );
$function$;

-- 3. La règle sur une ligne de vente -------------------------------------------------------------------------
create or replace function app_private.sale_has_listing_minimum(p_sale public.auction_sales)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    app_private.listing_has_street_or_lieu_dit(p_sale.address, p_sale.city)
    or app_private.listing_has_contact_email(p_sale.lawyer_contact)
    or exists (
      select 1
      from pg_catalog.jsonb_each_text(
        case when pg_catalog.jsonb_typeof(p_sale.raw_payload -> 'source_blocks') = 'object'
             then p_sale.raw_payload -> 'source_blocks' else '{}'::jsonb end
      ) as block(key, value)
      where block.key ~* '(avocat|contact|mail|notaire|gestionnaire|[ée]tude|cabinet)'
        and app_private.listing_has_contact_email(block.value)
    )
    or (pg_catalog.jsonb_typeof(p_sale.documents) = 'array' and pg_catalog.jsonb_array_length(p_sale.documents) > 0)
    or (
      pg_catalog.jsonb_typeof(p_sale.raw_payload -> 'documents') = 'array'
      and pg_catalog.jsonb_array_length(p_sale.raw_payload -> 'documents') > 0
    )
    or (
      select pg_catalog.count(distinct host) > 1
      from (
        select pg_catalog.lower(pg_catalog.regexp_replace(
                 coalesce(pg_catalog.substring(url, '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]+)'), ''),
                 '^www\.', '')) as host
        from (
          select p_sale.source_url as url
          union all
          select element
          from pg_catalog.jsonb_array_elements_text(
            case when pg_catalog.jsonb_typeof(p_sale.source_urls) = 'array' then p_sale.source_urls else '[]'::jsonb end
          ) as element
        ) as urls
      ) as hosts
      where host <> ''
    )
    or (
      select pg_catalog.count(distinct source) > 1
      from (
        select pg_catalog.lower(pg_catalog.btrim(p_sale.source_name)) as source
        union all
        select coalesce(
                 nullif(pg_catalog.lower(pg_catalog.btrim(observation ->> 'source_name')), ''),
                 pg_catalog.lower(pg_catalog.btrim(p_sale.source_name)))
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(p_sale.observations) = 'array' then p_sale.observations else '[]'::jsonb end
        ) as observation
      ) as sources
      where source <> ''
    )
    or exists (
      select 1 from app_private.reviewed_publication_aliases alias_row
      where alias_row.alias_sale_id = p_sale.id or alias_row.canonical_sale_id = p_sale.id
    )
    or exists (
      select 1 from app_private.auction_sale_merges merged_row where merged_row.canonical_sale_id = p_sale.id
    ),
    false
  );
$function$;

-- 4. Suppression des annonces vides ---------------------------------------------------------------------------
create or replace function app_private.delete_empty_listings(
  p_limit integer default 1000,
  p_apply boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  -- Traces utilisateur : une vente qui y figure est gardée.
  v_user_tables constant text[] := array[
    'user_favorites', 'user_sale_unlocks', 'saved_property_reports', 'sale_workspaces',
    'sale_workspace_annotations', 'user_sale_analysis_items', 'user_sale_watch_snapshots',
    'user_sale_change_events', 'sale_signal_feedback', 'account_product_events', 'lawyer_referral_requests',
    'lawyer_placement_events', 'listing_publication_requests', 'data_refresh_requests', 'sale_reminder_dispatches',
    'reviewed_publication_aliases', 'auction_sale_merges'
  ];
  -- Générées par le système : partent en cascade avec la vente (décision du propriétaire).
  v_accepted_tables constant text[] := array['user_alert_matches', 'user_alert_notifications'];
  -- Tables que la rétention vide déjà avant la vente (public.purge_expired_auction_sales).
  v_cleanable_tables constant text[] := array['valuation_estimates', 'auction_observations'];
  v_batch_size constant integer := 25;
  v_candidates uuid[];
  v_protected uuid[] := '{}';
  v_blocked uuid[] := '{}';
  v_todo uuid[];
  v_batch uuid[];
  v_found uuid[];
  v_protected_by jsonb := '{}';
  v_blocked_by jsonb := '{}';
  v_errors jsonb := '{}';
  v_deleted integer := 0;
  v_skipped integer := 0;
  v_sale public.auction_sales%rowtype;
  v_id uuid;
  v_previous uuid;
  v_bridge record;
  v_is_user boolean;
  v_foreign_key record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception using errcode = '22023', message = 'The cleanup limit must be between 1 and 5000.';
  end if;

  if p_apply then
    -- Même verrou que les publications et que la rétention, puis verrou de table : plus aucune écriture (un favori
    -- ajouté entre le contrôle et la suppression disparaîtrait en cascade) avant la fin de la transaction.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0));
    lock table public.auction_sales in share row exclusive mode;
  end if;

  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), '{}')
    into v_candidates
    from public.auction_sales sale
   where not app_private.sale_has_listing_minimum(sale);

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
    if v_foreign_key.relation_name = any(v_accepted_tables) then
      continue;
    end if;
    v_is_user := v_foreign_key.relation_name = any(v_user_tables)
      or v_foreign_key.relation_name like 'information\_agent\_%'
      or exists (
        select 1 from pg_catalog.pg_attribute marker
         where marker.attrelid = v_foreign_key.relation_oid
           and marker.attname in ('user_id', 'account_id', 'owner_id')
           and marker.attnum > 0 and not marker.attisdropped
      );
    -- Les ventes de la liste que cette table référence.
    execute pg_catalog.format(
      'select coalesce(pg_catalog.array_agg(distinct sale.id), ''{}'') from public.auction_sales sale '
      'where sale.id = any($1) and exists (select 1 from %s linked where linked.%I = sale.%I)',
      v_foreign_key.table_name, v_foreign_key.column_name, v_foreign_key.referenced_column
    ) into v_found using v_candidates;
    if pg_catalog.cardinality(v_found) = 0 then
      continue;
    end if;
    if v_is_user then
      v_protected := v_protected || v_found;
      v_protected_by := v_protected_by || pg_catalog.jsonb_build_object(
        v_foreign_key.relation_name, pg_catalog.cardinality(v_found)
      );
    elsif v_foreign_key.delete_action in ('a', 'r') and not (v_foreign_key.relation_name = any(v_cleanable_tables)) then
      v_blocked := v_blocked || v_found;
      v_blocked_by := v_blocked_by || pg_catalog.jsonb_build_object(
        v_foreign_key.relation_name, pg_catalog.cardinality(v_found)
      );
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(candidate order by candidate), '{}')
    into v_todo
    from (
      select pg_catalog.unnest(v_candidates) as candidate
      except
      select pg_catalog.unnest(v_protected || v_blocked)
    ) as deletable;
  v_todo := v_todo[1:p_limit];

  if p_apply then
    for offset_index in 0 .. greatest(pg_catalog.cardinality(v_todo) - 1, 0) / v_batch_size loop
      v_batch := v_todo[offset_index * v_batch_size + 1 : (offset_index + 1) * v_batch_size];
      exit when v_batch is null or pg_catalog.cardinality(v_batch) = 0;
      foreach v_id in array v_batch loop
        begin
          select * into v_sale from public.auction_sales where id = v_id for no key update;
          -- Vente disparue ou devenue suffisante depuis le contrôle : on n'y touche pas.
          if not found or app_private.sale_has_listing_minimum(v_sale) then
            v_skipped := v_skipped + 1;
            continue;
          end if;

          select id into v_previous from public.auction_sales where id < v_id order by id desc limit 1;
          select * into v_bridge from public.bridge_auction_sales_to_outcome_graph_batch(v_previous, 1);
          if not v_bridge.complete or v_bridge.next_cursor <> v_id then
            raise exception using errcode = '55000', message = 'Incomplete statistical archive before cleanup';
          end if;

          insert into public.sale_retention_storage_queue(bucket, object_path)
            select storage_bucket, storage_path
              from public.information_agent_evidence_assets
             where sale_id = v_id and storage_bucket = 'information-agent-evidence'
            union
            select 'information-agent-approved', metadata ->> 'approved_public_path'
              from public.information_agent_evidence_assets
             where sale_id = v_id and nullif(metadata ->> 'approved_public_path', '') is not null
            union
            select 'information-agent-approved', file_path
              from public.auction_documents
             where source_url = v_sale.source_url
               and file_path like v_id::text || '/%'
               and document_url like '%/storage/v1/object/public/information-agent-approved/%'
            on conflict (bucket, object_path) do nothing;

          delete from public.valuation_estimates where auction_sale_id = v_id;
          delete from public.auction_observations
           where canonical_source_url = v_sale.source_url or source_url = v_sale.source_url;
          delete from public.auction_sales where id = v_id;
          v_deleted := v_deleted + 1;
        exception when others then
          v_skipped := v_skipped + 1;
          v_errors := v_errors || pg_catalog.jsonb_build_object(
            sqlstate, coalesce((v_errors ->> sqlstate)::integer, 0) + 1
          );
        end;
      end loop;
      raise notice 'delete_empty_listings: % deleted, % skipped so far', v_deleted, v_skipped;
    end loop;
  end if;

  raise notice 'delete_empty_listings (%): % empty listings, % kept (user trace), % set aside (blocking link), % %',
    case when p_apply then 'applied' else 'count only' end,
    pg_catalog.cardinality(v_candidates),
    (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_protected) as id),
    (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_blocked) as id),
    case when p_apply then 'deleted' else 'would be deleted' end,
    case when p_apply then v_deleted else pg_catalog.cardinality(v_todo) end;

  return pg_catalog.jsonb_build_object(
    'applied', p_apply,
    'empty_listings', pg_catalog.cardinality(v_candidates),
    'kept_for_user_trace', (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_protected) as id),
    'kept_for_user_trace_by_table', v_protected_by,
    'set_aside_by_blocking_link', (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_blocked) as id),
    'set_aside_by_table', v_blocked_by,
    'deletable', pg_catalog.cardinality(v_todo),
    'deleted', v_deleted,
    'skipped', v_skipped,
    'errors_by_sqlstate', v_errors
  );
end;
$function$;

-- Droits : fonctions internes, comme celles des migrations voisines (service_role seul).
revoke all on function app_private.listing_has_street_or_lieu_dit(text, text) from public, anon, authenticated;
revoke all on function app_private.listing_has_contact_email(text) from public, anon, authenticated;
revoke all on function app_private.sale_has_listing_minimum(public.auction_sales) from public, anon, authenticated;
revoke all on function app_private.delete_empty_listings(integer, boolean) from public, anon, authenticated;
grant execute on function app_private.listing_has_street_or_lieu_dit(text, text) to service_role;
grant execute on function app_private.listing_has_contact_email(text) to service_role;
grant execute on function app_private.sale_has_listing_minimum(public.auction_sales) to service_role;
grant execute on function app_private.delete_empty_listings(integer, boolean) to service_role;

comment on function app_private.listing_has_street_or_lieu_dit(text, text) is
  'Vrai si l''adresse désigne une voie ou un lieu-dit (jamais la commune seule). Traduction SQL de services/data-pipeline/src/listing_minimum.has_street_or_lieu_dit ; garde plus quand la règle Python ne se traduit pas exactement.';
comment on function app_private.listing_has_contact_email(text) is
  'Vrai si le texte contient une adresse email que l''agent d''information peut solliciter (hors juridiction, RPVA, Ordre, CARPA, adresses techniques).';
comment on function app_private.sale_has_listing_minimum(public.auction_sales) is
  'Minimum d''une annonce : voie ou lieu-dit, email de contact, pièce, ou autre source. Même règle que services/data-pipeline/src/listing_minimum.py.';
comment on function app_private.delete_empty_listings(integer, boolean) is
  'Supprime les annonces sans voie, sans email de contact, sans pièce et sans autre source, jamais celles qui ont une trace utilisateur. p_apply faux : comptage seul. Lancée par supabase/repairs/20261108202100_delete_empty_listings.sql, jamais par une migration.';

notify pgrst, 'reload schema';

commit;
