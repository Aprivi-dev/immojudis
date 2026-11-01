begin;

set local lock_timeout = '5s';

-- Minimum d'une annonce pour exister en base (règle du propriétaire du 28/10/2026) et suppression de celles qui
-- ne l'ont pas. Une annonce qui n'a NI voie ou lieu-dit, NI adresse email de contact, NI parcelle, NI pièce, NI autre source
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
--   * cadastre : une ou plusieurs parcelles lisibles : cadastre_location de la fiche ou de source_property_features
--     sous ses trois formes (candidates[].parcels : cessions, notaires, Petites Affiches ; parcels[] : Avoventes ;
--     references[] : Info-Enchères), référence cadastrale d'un bloc source, adresse qui EST une référence cadastrale
--     (« Section AB n° 123 Autreville », « AB 123 », app_private.listing_is_cadastral_reference ; le Python la garde
--     par classify_address == 'parcel'), parcelles de auction_cadastre_parcels trouvées par référence ou à la main :
--     la vente est localisable à la parcelle, sans voie ;
--   * pièce : documents (colonne ou raw_payload) non vide ;
--   * autre source : au moins deux hôtes parmi source_url et source_urls, ou deux sources parmi source_name et
--     observations, ou une ligne du registre des alias revus ou des fusions.
--
-- NE JAMAIS SUPPRIMER UNE VENTE QUI A UNE TRACE UTILISATEUR. app_private.empty_listing_links lit la liste réelle
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
-- JAMAIS NON PLUS une vente qui a un prix d'adjudication (adjudication_price_eur) ou une issue connue dans le graphe
-- des issues (app_private.sale_has_known_outcome) : décision du coordinateur du 28/10/2026. Les ventes passées SANS
-- résultat restent concernées.
--
-- LE CONTRÔLE EST REFAIT POUR CHAQUE VENTE, juste avant son delete. Le calcul initial des ventes protégées est une
-- photo : il ne voit pas une trace posée ensuite. Le verrou de table SHARE ROW EXCLUSIVE sur auction_sales ne
-- l'empêche pas non plus : un insert dans user_favorites ne prend qu'un verrou ROW SHARE sur auction_sales (contrôle
-- de la clé étrangère), compatible avec lui. La boucle verrouille donc la ligne FOR UPDATE (un insert qui la
-- référence attend la fin de la transaction, puis échoue sur la clé étrangère au lieu de partir en cascade), puis
-- relit les traces, les liens bloquants et l'issue de CETTE vente : une vente devenue protégée est gardée et comptée
-- dans kept_after_recheck.
--
-- COMME LA RÉTENTION : verrou consultatif de la publication, verrou de table (aucune écriture de la collecte sur
-- auction_sales), pont du graphe des issues complet exigé par le déclencheur
-- require_outcome_bridge_before_auction_sale_delete (créé au besoin par le même lot que la rétention), file de
-- nettoyage du stockage, aucune trace de rétention (l'URL n'est pas interdite : c'est la règle d'entrée du pipeline
-- qui empêche son retour). Une vente par sous-transaction : une vente que la base refuse (déclencheur) est
-- comptée et gardée, les autres continuent. Le graphe des issues garde une trace « annoncée, issue inconnue »
-- de chaque vente supprimée, comme pour toute vente purgée.
--
-- PRÉREQUIS DE LA RÉPARATION : le balayage de dédoublonnage des annonces sans voie (services/data-pipeline/src/
-- dedupe_streetless.py : rapport « candidates », puis application) passe AVANT elle. Une annonce Vench ou Petites
-- Affiches dont la vente jumelle (Licitor...) est en base serait sinon supprimée alors qu'elle se rattache.

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
  -- Types de voie placés en tête de l'adresse (position_quality._LEADING_STREET_TYPES, abréviations comprises : le
  -- Python ramène ave, bvd, boul, chem, pass, sq, esp et crs au mot entier avant de comparer).
  v_leading constant text :=
    'rue|avenue|av|ave|boulevard|bd|bld|bvd|boul|chemin|chem|ch|route|rte|impasse|imp|place|pl|allee|all|quai|cours|crs|'
    'square|sq|passage|pass|voie|sentier|faubourg|fbg|fg|esplanade|esp|promenade|parvis|montee|traverse|ruelle|venelle|'
    'mail|chaussee|cheminement|sente|boucle|carrefour';
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

-- 2 bis. Référence cadastrale ---------------------------------------------------------------------------------
-- Traduction de listing_location._PARCEL_RE (classify_address == 'parcel'), sensible à la casse comme elle : les lettres de
-- section sont des majuscules. Lue sans autre condition (le Python écarte avant les adresses de cabinet ou chiffrées en
-- euros ; ici on garde plus).
create or replace function app_private.listing_is_cadastral_reference(p_text text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_text ~ '\m[sS][eE][cC][tT][iI][oO][nN][sS]?[[:space:]]+[A-Z]{1,2}\M[[:space:]]*(?:[nN][°ºo]?[[:space:]]*)?[0-9]+'
    or p_text ~ '\m[cC][aA][dD][aA][sS][tT][rR][éeÉE][eE]?[sS]?\M[^.\n]{0,60}\m[A-Z]{1,2}[[:space:]]?[0-9]{1,4}\M'
    or p_text ~ '^[[:space:]]*[A-Z]{1,2}[[:space:]]?[0-9]{1,4}\M',
    false
  );
$function$;

-- cadastre_location sous les trois formes que les sources écrivent (listing_minimum._has_parcels) :
--   * {candidates:[{parcels:[...]}], ...} : cessions de l'État, notaires, Petites Affiches ;
--   * {insee_code, parcels:[{section, number, ...}], designation} : Avoventes (sources/avoventes_extraction.py) ;
--   * {references:[...], designation, raw} : Info-Enchères (sources/info_encheres_extraction.py).
create or replace function app_private.listing_location_has_parcels(p_location jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(p_location) = 'object'
    and (
      pg_catalog.jsonb_path_exists(p_location, '$.candidates[*].parcels[*]')
      or pg_catalog.jsonb_path_exists(p_location, '$.parcels[*]')
      or pg_catalog.jsonb_path_exists(p_location, '$.references[*]')
    ),
    false
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
    or app_private.listing_location_has_parcels(p_sale.raw_payload -> 'cadastre_location')
    or app_private.listing_location_has_parcels(p_sale.raw_payload -> 'source_property_features' -> 'cadastre_location')
    or app_private.listing_is_cadastral_reference(p_sale.address)
    or exists (
      select 1
      from pg_catalog.jsonb_each_text(
        case when pg_catalog.jsonb_typeof(p_sale.raw_payload -> 'source_blocks') = 'object'
             then p_sale.raw_payload -> 'source_blocks' else '{}'::jsonb end
      ) as block(key, value)
      where block.key in ('reference_cadastrale', 'references_cadastrales')
        and (
          block.value ~* '(^|[^[:alnum:]])[a-z]{1,2}[[:space:]]?[0-9]{1,4}([^[:alnum:]]|$)'
          or app_private.listing_is_cadastral_reference(block.value)
        )
    )
    -- Parcelles trouvées par la référence publiée ou à la main. Pas « point_intersection » : une parcelle trouvée sous
    -- le centre d'une commune (position de repli) n'est pas une localisation du bien.
    or exists (
      select 1 from public.auction_cadastre_parcels parcel
      where parcel.source_url = p_sale.source_url and parcel.match_kind in ('reference_lookup', 'manual')
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

-- 4. Issue connue -----------------------------------------------------------------------------------------------
-- Une vente qui a un prix d'adjudication ou une issue connue dans le graphe des issues n'est jamais supprimée comme
-- annonce vide (décision du coordinateur du 28/10/2026). « Issue connue » : au moins une issue autre que « unknown »
-- (ou avec un prix de marteau) sur un tour d'un lot rattaché à la vente, directement ou par le pont du catalogue.
create or replace function app_private.sale_has_known_outcome(p_sale public.auction_sales)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select p_sale.adjudication_price_eur is not null
    or exists (
      select 1
      from public.auction_lots lot_row
      join public.auction_rounds round_row on round_row.lot_id = lot_row.id
      join public.auction_outcomes outcome_row on outcome_row.round_id = round_row.id
      where (
          lot_row.auction_sale_id = p_sale.id
          or lot_row.id in (
            select bridge.lot_id from public.auction_sale_outcome_bridges bridge where bridge.auction_sale_id = p_sale.id
          )
        )
        and (
          outcome_row.outcome_status <> 'unknown'
          or outcome_row.initial_hammer_price_eur is not null
          or outcome_row.final_hammer_price_eur is not null
        )
    );
$function$;

-- 5. Liens d'une vente --------------------------------------------------------------------------------------------
-- Pour chaque vente de la liste, les tables qui la référencent et qui interdisent de la supprimer : 'user_trace'
-- (trace utilisateur) ou 'blocking_link' (clé étrangère NO ACTION / RESTRICT vers une table que la rétention ne vide
-- pas). La liste des clés étrangères est lue dans pg_constraint à chaque appel. Même fonction pour le calcul initial
-- et pour le contrôle refait juste avant chaque suppression.
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
    'sale_workspace_annotations', 'user_sale_analysis_items', 'user_sale_watch_snapshots',
    'user_sale_change_events', 'sale_signal_feedback', 'account_product_events', 'lawyer_referral_requests',
    'lawyer_placement_events', 'listing_publication_requests', 'data_refresh_requests', 'sale_reminder_dispatches',
    'reviewed_publication_aliases', 'auction_sale_merges'
  ];
  -- Générées par le système : partent en cascade avec la vente (décision du propriétaire).
  v_accepted_tables constant text[] := array['user_alert_matches', 'user_alert_notifications'];
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
    if v_foreign_key.relation_name = any(v_accepted_tables) then
      continue;
    end if;
    if v_foreign_key.relation_name = any(v_user_tables)
      or v_foreign_key.relation_name like 'information\_agent\_%'
      or exists (
        select 1 from pg_catalog.pg_attribute marker
         where marker.attrelid = v_foreign_key.relation_oid
           and marker.attname in ('user_id', 'account_id', 'owner_id')
           and marker.attnum > 0 and not marker.attisdropped
      )
    then
      v_kind := 'user_trace';
    elsif v_foreign_key.delete_action in ('a', 'r') and not (v_foreign_key.relation_name = any(v_cleanable_tables)) then
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

-- 6. Suppression des annonces vides ---------------------------------------------------------------------------
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
  v_batch_size constant integer := 25;
  v_empty uuid[];
  v_known_outcome uuid[];
  v_candidates uuid[];
  v_protected uuid[];
  v_blocked uuid[];
  v_todo uuid[];
  v_batch uuid[];
  v_protected_by jsonb;
  v_blocked_by jsonb;
  v_late_by jsonb := '{}';
  v_errors jsonb := '{}';
  v_deleted integer := 0;
  v_skipped integer := 0;
  v_late integer := 0;
  v_sale public.auction_sales%rowtype;
  v_id uuid;
  v_previous uuid;
  v_bridge record;
  v_link record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception using errcode = '22023', message = 'The cleanup limit must be between 1 and 5000.';
  end if;

  if p_apply then
    -- Même verrou que les publications et que la rétention, puis verrou de table : plus d'écriture de la collecte sur
    -- auction_sales. Il N'EMPÊCHE PAS un favori : l'insert dans user_favorites ne prend qu'un verrou ROW SHARE sur
    -- auction_sales (contrôle de la clé étrangère), compatible. D'où le contrôle refait par vente, plus bas.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0));
    lock table public.auction_sales in share row exclusive mode;
  end if;

  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), '{}')
    into v_empty
    from public.auction_sales sale
   where not app_private.sale_has_listing_minimum(sale);

  -- Une vente qui a un prix d'adjudication ou une issue connue n'est pas une annonce vide à supprimer.
  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), '{}')
    into v_known_outcome
    from public.auction_sales sale
   where sale.id = any(v_empty) and app_private.sale_has_known_outcome(sale);
  select coalesce(pg_catalog.array_agg(candidate order by candidate), '{}')
    into v_candidates
    from (
      select pg_catalog.unnest(v_empty) as candidate
      except
      select pg_catalog.unnest(v_known_outcome)
    ) as without_outcome;

  with links as materialized (select * from app_private.empty_listing_links(v_candidates))
  select coalesce(pg_catalog.array_agg(distinct links.sale_id) filter (where links.link_kind = 'user_trace'), '{}'),
         coalesce(pg_catalog.array_agg(distinct links.sale_id) filter (where links.link_kind = 'blocking_link'), '{}'),
         coalesce((
           select pg_catalog.jsonb_object_agg(per_table.relation_name, per_table.sales)
             from (
               select l.relation_name, pg_catalog.count(distinct l.sale_id) as sales
                 from links l where l.link_kind = 'user_trace' group by l.relation_name
             ) as per_table
         ), '{}'),
         coalesce((
           select pg_catalog.jsonb_object_agg(per_table.relation_name, per_table.sales)
             from (
               select l.relation_name, pg_catalog.count(distinct l.sale_id) as sales
                 from links l where l.link_kind = 'blocking_link' group by l.relation_name
             ) as per_table
         ), '{}')
    into v_protected, v_blocked, v_protected_by, v_blocked_by
    from links;

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
          -- FOR UPDATE (pas NO KEY UPDATE) : un insert qui référence la vente (favori, déblocage...) attend la fin de
          -- la transaction au lieu de passer entre le contrôle et le delete.
          select * into v_sale from public.auction_sales where id = v_id for update;
          -- Vente disparue ou devenue suffisante depuis le contrôle : on n'y touche pas.
          if not found
            or app_private.sale_has_listing_minimum(v_sale)
            or app_private.sale_has_known_outcome(v_sale)
          then
            v_skipped := v_skipped + 1;
            continue;
          end if;

          select id into v_previous from public.auction_sales where id < v_id order by id desc limit 1;
          select * into v_bridge from public.bridge_auction_sales_to_outcome_graph_batch(v_previous, 1);
          if not v_bridge.complete or v_bridge.next_cursor <> v_id then
            raise exception using errcode = '55000', message = 'Incomplete statistical archive before cleanup';
          end if;

          -- Contrôle complet des traces utilisateur et des liens bloquants, refait pour CETTE vente, juste avant la
          -- suppression : une trace posée depuis le calcul initial la fait garder (le calcul initial est une photo).
          select links.relation_name, links.link_kind into v_link from app_private.empty_listing_links(array[v_id]) links limit 1;
          if found then
            v_skipped := v_skipped + 1;
            v_late := v_late + 1;
            v_late_by := v_late_by || pg_catalog.jsonb_build_object(
              v_link.relation_name, coalesce((v_late_by ->> v_link.relation_name)::integer, 0) + 1
            );
            continue;
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

  raise notice 'delete_empty_listings (%): % empty listings, % kept (known outcome), % kept (user trace), % set aside (blocking link), % kept after recheck, % %',
    case when p_apply then 'applied' else 'count only' end,
    pg_catalog.cardinality(v_empty),
    pg_catalog.cardinality(v_known_outcome),
    (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_protected) as id),
    (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_blocked) as id),
    v_late,
    case when p_apply then 'deleted' else 'would be deleted' end,
    case when p_apply then v_deleted else pg_catalog.cardinality(v_todo) end;

  return pg_catalog.jsonb_build_object(
    'applied', p_apply,
    'empty_listings', pg_catalog.cardinality(v_empty),
    'kept_for_known_outcome', pg_catalog.cardinality(v_known_outcome),
    'kept_for_user_trace', (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_protected) as id),
    'kept_for_user_trace_by_table', v_protected_by,
    'set_aside_by_blocking_link', (select pg_catalog.count(distinct id) from pg_catalog.unnest(v_blocked) as id),
    'set_aside_by_table', v_blocked_by,
    'kept_after_recheck', v_late,
    'kept_after_recheck_by_table', v_late_by,
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
revoke all on function app_private.listing_is_cadastral_reference(text) from public, anon, authenticated;
revoke all on function app_private.listing_location_has_parcels(jsonb) from public, anon, authenticated;
revoke all on function app_private.sale_has_known_outcome(public.auction_sales) from public, anon, authenticated;
revoke all on function app_private.empty_listing_links(uuid[]) from public, anon, authenticated;
revoke all on function app_private.delete_empty_listings(integer, boolean) from public, anon, authenticated;
grant execute on function app_private.listing_has_street_or_lieu_dit(text, text) to service_role;
grant execute on function app_private.listing_has_contact_email(text) to service_role;
grant execute on function app_private.sale_has_listing_minimum(public.auction_sales) to service_role;
grant execute on function app_private.listing_is_cadastral_reference(text) to service_role;
grant execute on function app_private.listing_location_has_parcels(jsonb) to service_role;
grant execute on function app_private.sale_has_known_outcome(public.auction_sales) to service_role;
grant execute on function app_private.empty_listing_links(uuid[]) to service_role;
grant execute on function app_private.delete_empty_listings(integer, boolean) to service_role;

comment on function app_private.listing_has_street_or_lieu_dit(text, text) is
  'Vrai si l''adresse désigne une voie ou un lieu-dit (jamais la commune seule). Traduction SQL de services/data-pipeline/src/listing_minimum.has_street_or_lieu_dit ; garde plus quand la règle Python ne se traduit pas exactement.';
comment on function app_private.listing_has_contact_email(text) is
  'Vrai si le texte contient une adresse email que l''agent d''information peut solliciter (hors juridiction, RPVA, Ordre, CARPA, adresses techniques).';
comment on function app_private.sale_has_listing_minimum(public.auction_sales) is
  'Minimum d''une annonce : voie ou lieu-dit, email de contact, parcelle cadastrale, pièce, ou autre source. Même règle que services/data-pipeline/src/listing_minimum.py.';
comment on function app_private.listing_is_cadastral_reference(text) is
  'Vrai si le texte est une référence cadastrale (« Section AB n° 123 », « AB 123 », « Cadastre AB 123 »). Traduction de listing_location._PARCEL_RE.';
comment on function app_private.listing_location_has_parcels(jsonb) is
  'Vrai si une cadastre_location porte au moins une parcelle, sous l''une des trois formes des sources (candidates[].parcels, parcels[], references[]).';
comment on function app_private.sale_has_known_outcome(public.auction_sales) is
  'Vrai si la vente a un prix d''adjudication ou une issue connue (autre que unknown) dans le graphe des issues : jamais supprimée comme annonce vide.';
comment on function app_private.empty_listing_links(uuid[]) is
  'Pour les ventes données, les tables liées (clés étrangères lues dans pg_constraint) qui interdisent la suppression : trace utilisateur ou lien bloquant.';
comment on function app_private.delete_empty_listings(integer, boolean) is
  'Supprime les annonces sans voie, sans email de contact, sans pièce et sans autre source, jamais celles qui ont une trace utilisateur, un prix d''adjudication ou une issue connue. p_apply faux : comptage seul. Lancée par supabase/repairs/20261108202100_delete_empty_listings.sql, jamais par une migration.';

notify pgrst, 'reload schema';

commit;
