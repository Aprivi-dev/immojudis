begin;

set local lock_timeout = '5s';

-- La visibilité publique d'une annonce relisait raw_payload (85 Ko compressés en moyenne, jusqu'à
-- 2,7 Mo) pour chaque ligne examinée :
--   * v_auction_sales_app et v_auction_sales_discovery lisaient raw_payload->>'publication_quarantine'
--     et passaient raw_payload à sale_catalogue_entry_is_live_materialized (count(*) de la carte :
--     5,4 s et 4,7 s en production) ;
--   * la recherche publique (search_auction_sales_preview_v3 et _v4) retombait, pour les annonces dont
--     la date limite matérialisée est nulle (193 en production), sur sale_catalogue_entry_is_live, qui
--     relit raw_payload et le concatène à un objet : 1 315 ms de filtre, contre 16 ms sans ce repli.
-- Ici, tout ce qui décide de la visibilité ne lit plus que des colonnes ordinaires :
--   1. la quarantaine lit catalogue_quarantined (colonne matérialisée par
--      zzzz_auction_sales_catalogue_projection_*, 20261009180000) ;
--   2. le repli « sans date limite » lit trois colonnes matérialisées à l'écriture, voir ci-dessous.
--
-- Cas « sans date limite » (catalogue_expiry_materialized et catalogue_expiry_deadline nul).
-- sale_catalogue_entry_is_live(sale_date, raw_payload || sale_procedure) décide alors ainsi :
--   * sale_date nulle : app_private.state_listing_is_live(raw_payload), c'est-à-dire la fiche « cessions
--     de l'État » observée active depuis moins de 14 jours (et au plus un jour dans le futur), avec une
--     fin de publication estimée non dépassée ;
--   * sale_date renseignée (vente reportée, conflit de dates, calendrier en ligne illisible) :
--     sale_catalogue_expiry(sale_date, raw_payload || sale_procedure) > maintenant.
-- Le résultat dépend de l'heure courante, il ne peut donc pas être figé en booléen : on matérialise
-- les seules valeurs que cette décision compare à l'heure, et la comparaison reste faite à la lecture,
-- avec les mêmes expressions que state_listing_is_live (14 jours, un jour, minuit à Paris) :
--   * catalogue_expiry_fallback : sale_catalogue_expiry(...) de la ligne, utile seulement quand
--     catalogue_expiry_deadline est nul et sale_date renseignée ;
--   * catalogue_state_observed_at et catalogue_state_end_estimate : le seul état de la fiche de l'État
--     (state_listing.observed_at et state_listing.listing_end_estimate), non nuls seulement quand la
--     fiche passe les contrôles statiques de state_listing_is_live (source cessions_etat, active,
--     formats valides) et que sale_date est nulle.
-- Ces trois colonnes restent nulles pour toute ligne dont la date limite est matérialisée. Elles sont
-- recalculées par un déclencheur dédié, sous le déclencheur de date limite, à chaque changement de
-- sale_date, raw_payload, sale_procedure ou de la date limite. La stratégie d'expiration par défaut
-- (réglage app.date_only_catalogue_policy) est donc figée à l'écriture, comme la date limite.
--
-- Une ligne dont catalogue_expiry_materialized est faux n'est visible nulle part : le déclencheur de
-- date limite la matérialise à chaque écriture et la migration 20261003130000 a refusé d'aboutir tant
-- qu'il en restait. Les anciens prédicats l'évaluaient en relisant raw_payload ; le nouveau échoue
-- fermé (jamais d'annonce masquée rendue visible).

alter table public.auction_sales
  add column if not exists catalogue_expiry_fallback timestamptz,
  add column if not exists catalogue_state_observed_at timestamptz,
  add column if not exists catalogue_state_end_estimate date;

comment on column public.auction_sales.catalogue_expiry_fallback is
  'Matérialisé : app_private.sale_catalogue_expiry(sale_date, raw_payload || sale_procedure). Renseigné seulement quand catalogue_expiry_deadline est nul et sale_date renseignée ; la visibilité compare cette valeur à l''heure courante sans relire raw_payload.';
comment on column public.auction_sales.catalogue_state_observed_at is
  'Matérialisé : raw_payload.state_listing.observed_at d''une fiche cessions_etat active, quand sale_date et catalogue_expiry_deadline sont nuls. Nul sinon.';
comment on column public.auction_sales.catalogue_state_end_estimate is
  'Matérialisé : raw_payload.state_listing.listing_end_estimate (fin de publication estimée) de cette même fiche. Nul sinon, ou quand aucune fin n''est annoncée.';

-- Calcule les trois valeurs à partir des seules entrées de la décision d'origine. Même source de vérité
-- pour le déclencheur, le rattrapage ci-dessous et la requête de contrôle.
create or replace function app_private.catalogue_visibility_projection(
  p_materialized boolean,
  p_deadline timestamptz,
  p_sale_date timestamptz,
  p_raw jsonb,
  p_sale_procedure jsonb
)
returns table (
  expiry timestamptz,
  state_observed_at timestamptz,
  state_end_estimate date
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_raw jsonb := case
    when jsonb_typeof(coalesce(p_raw, '{}'::jsonb)) = 'object' then coalesce(p_raw, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_state jsonb;
begin
  expiry := null;
  state_observed_at := null;
  state_end_estimate := null;

  -- Date limite matérialisée : la branche rapide des prédicats suffit, rien à conserver.
  if coalesce(p_materialized, false) and p_deadline is not null then
    return next;
    return;
  end if;

  -- Même objet que celui des anciens appels : raw_payload complété par la procédure de la ligne.
  expiry := app_private.sale_catalogue_expiry(
    p_sale_date,
    v_raw || jsonb_build_object('sale_procedure', coalesce(p_sale_procedure, '{}'::jsonb))
  );

  -- Contrôles statiques de app_private.state_listing_is_live (20261015100000). Une valeur qui passe
  -- les formats mais n'existe pas au calendrier (2026-02-30) faisait lever l'ancien prédicat à chaque
  -- lecture ; ici elle laisse les colonnes nulles : l'annonce est masquée, jamais l'écriture refusée.
  v_state := v_raw -> 'state_listing';
  if p_sale_date is null
     and jsonb_typeof(v_state) = 'object'
     and coalesce(v_raw ->> 'source_name', '') = 'cessions_etat'
     and coalesce(v_state ->> 'active', '') = 'true'
     and coalesce(v_state ->> 'observed_at', '')
       ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
     and coalesce(v_state ->> 'listing_end_estimate', '') ~ '^(\d{4}-\d{2}-\d{2})?$' then
    begin
      state_observed_at := (v_state ->> 'observed_at')::timestamptz;
      state_end_estimate := nullif(v_state ->> 'listing_end_estimate', '')::date;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        state_observed_at := null;
        state_end_estimate := null;
    end;
  end if;

  return next;
end;
$function$;

comment on function app_private.catalogue_visibility_projection(boolean, timestamptz, timestamptz, jsonb, jsonb) is
  'Valeurs matérialisées (catalogue_expiry_fallback, catalogue_state_*) qui remplacent la relecture de raw_payload par le repli de sale_catalogue_entry_is_live_materialized.';

revoke all on function app_private.catalogue_visibility_projection(
  boolean, timestamptz, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function app_private.catalogue_visibility_projection(
  boolean, timestamptz, timestamptz, jsonb, jsonb
) to service_role;

-- Le prédicat de visibilité par date, en colonnes seules. Équivalent de
-- sale_catalogue_entry_is_live_materialized(materialized, deadline, sale_date, raw_payload,
-- sale_procedure) pour toute ligne matérialisée, mais vrai/faux (jamais nul) et sans raw_payload.
create or replace function app_private.sale_catalogue_projection_is_live(
  p_materialized boolean,
  p_deadline timestamptz,
  p_sale_date timestamptz,
  p_fallback_expiry timestamptz,
  p_state_observed_at timestamptz,
  p_state_end_estimate date
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    case
      -- Échoue fermé : une ligne non matérialisée n'existe pas en base (voir l'en-tête).
      when not coalesce(p_materialized, false) then false
      when p_deadline is not null then p_deadline > current_timestamp
      -- Fiche de l'État sans échéance : mêmes expressions que state_listing_is_live.
      when p_sale_date is null then
        p_state_observed_at > current_timestamp - interval '14 days'
        and p_state_observed_at <= current_timestamp + interval '1 day'
        and (
          p_state_end_estimate is null
          or p_state_end_estimate >= (current_timestamp at time zone 'Europe/Paris')::date
        )
      else p_fallback_expiry > current_timestamp
    end,
    false
  );
$function$;

comment on function app_private.sale_catalogue_projection_is_live(boolean, timestamptz, timestamptz, timestamptz, timestamptz, date) is
  'Visibilité par date lue sur des colonnes seules (catalogue_expiry_deadline, catalogue_expiry_fallback, catalogue_state_*), sans raw_payload. Remplace sale_catalogue_entry_is_live_materialized dans les vues et fonctions publiques.';

revoke all on function app_private.sale_catalogue_projection_is_live(
  boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
) from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_projection_is_live(
  boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
) to anon, authenticated, service_role;

create or replace function app_private.sync_auction_sale_catalogue_visibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_projection record;
begin
  select projection.*
    into v_projection
    from app_private.catalogue_visibility_projection(
      new.catalogue_expiry_materialized,
      new.catalogue_expiry_deadline,
      new.sale_date,
      new.raw_payload,
      new.sale_procedure
    ) projection;
  new.catalogue_expiry_fallback := v_projection.expiry;
  new.catalogue_state_observed_at := v_projection.state_observed_at;
  new.catalogue_state_end_estimate := v_projection.state_end_estimate;
  return new;
end;
$function$;

revoke all on function app_private.sync_auction_sale_catalogue_visibility()
  from public, anon, authenticated;
grant execute on function app_private.sync_auction_sale_catalogue_visibility() to service_role;

-- Rattrapage des lignes existantes, sans déclencher le journal des ventes, la relecture IA ni les
-- contrôles de source (même méthode que 20261009180000 : projection de données existantes, pas un
-- changement de vente). Il recalcule aussi catalogue_quarantined : son déclencheur le dérive de
-- raw_payload à chaque insertion et à chaque changement de raw_payload, la colonne est donc déjà
-- strictement équivalente à coalesce(raw_payload->>'publication_quarantine', '') <> '' ; ce passage
-- ne corrige que d'éventuelles lignes écrites hors déclencheur. Les lignes à corriger sont repérées
-- avant de désactiver les déclencheurs, pour que le verrou ne couvre que l'écriture.
do $backfill$
declare
  v_ids uuid[];
begin
  select array_agg(drift.id)
    into v_ids
    from (
      select sale.id
      from public.auction_sales sale
      cross join lateral app_private.catalogue_visibility_projection(
        sale.catalogue_expiry_materialized,
        sale.catalogue_expiry_deadline,
        sale.sale_date,
        sale.raw_payload,
        sale.sale_procedure
      ) projection
      where sale.catalogue_quarantined
              is distinct from (coalesce(sale.raw_payload ->> 'publication_quarantine', '') <> '')
         or sale.catalogue_expiry_fallback is distinct from projection.expiry
         or sale.catalogue_state_observed_at is distinct from projection.state_observed_at
         or sale.catalogue_state_end_estimate is distinct from projection.state_end_estimate
    ) drift;

  if v_ids is not null then
    alter table public.auction_sales disable trigger user;

    update public.auction_sales sale
    set catalogue_quarantined = target.quarantined,
        catalogue_expiry_fallback = target.expiry,
        catalogue_state_observed_at = target.state_observed_at,
        catalogue_state_end_estimate = target.state_end_estimate
    from (
      select
        source.id,
        coalesce(source.raw_payload ->> 'publication_quarantine', '') <> '' as quarantined,
        projection.expiry,
        projection.state_observed_at,
        projection.state_end_estimate
      from public.auction_sales source
      cross join lateral app_private.catalogue_visibility_projection(
        source.catalogue_expiry_materialized,
        source.catalogue_expiry_deadline,
        source.sale_date,
        source.raw_payload,
        source.sale_procedure
      ) projection
      where source.id = any (v_ids)
    ) target
    where sale.id = target.id;

    alter table public.auction_sales enable trigger user;
  end if;
end;
$backfill$;

-- « zzzzz_ » se classe après « zzzz_ » : ces déclencheurs voient la date limite que
-- zzzz_auction_sales_retention_deadline_* vient de calculer. Le WHEN est évalué après les déclencheurs
-- précédents, et il couvre aussi une écriture directe des colonnes matérialisées (elle est recalculée).
drop trigger if exists zzzzz_auction_sales_catalogue_visibility_insert on public.auction_sales;
create trigger zzzzz_auction_sales_catalogue_visibility_insert
  before insert on public.auction_sales
  for each row execute function app_private.sync_auction_sale_catalogue_visibility();

drop trigger if exists zzzzz_auction_sales_catalogue_visibility_update on public.auction_sales;
create trigger zzzzz_auction_sales_catalogue_visibility_update
  before update on public.auction_sales
  for each row
  when (
    old.sale_date is distinct from new.sale_date
    or old.raw_payload is distinct from new.raw_payload
    or old.sale_procedure is distinct from new.sale_procedure
    or old.catalogue_expiry_materialized is distinct from new.catalogue_expiry_materialized
    or old.catalogue_expiry_deadline is distinct from new.catalogue_expiry_deadline
    or old.catalogue_expiry_fallback is distinct from new.catalogue_expiry_fallback
    or old.catalogue_state_observed_at is distinct from new.catalogue_state_observed_at
    or old.catalogue_state_end_estimate is distinct from new.catalogue_state_end_estimate
  )
  execute function app_private.sync_auction_sale_catalogue_visibility();

-- v_auction_sales_app est une vue security_invoker : le rôle authenticated lit ces colonnes
-- directement (le grant de colonnes de 20261010003000 ne contenait pas catalogue_quarantined, jamais
-- lue par une vue jusqu'ici). Les vues « découverte » sont security definer et n'en ont pas besoin.
-- Aucune de ces colonnes ne contient de donnée de la fiche : ce sont des dates et un booléen.
grant select (
  catalogue_quarantined,
  catalogue_expiry_fallback,
  catalogue_state_observed_at,
  catalogue_state_end_estimate
) on table public.auction_sales to authenticated;

-- Politique de lecture des comptes connectés : elle relisait raw_payload à chaque ligne examinée pour
-- tout compte non administrateur. Mêmes conditions, la quarantaine lue sur la colonne matérialisée.
alter policy auction_sales_authenticated_read on public.auction_sales
using (
  public.is_admin()
  or (
    public.has_analysis_access()
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
    and coalesce(status, 'unknown') <> 'quarantined'
    and not catalogue_quarantined
  )
);

-- Les définitions actuelles sont relues et réécrites plutôt que recopiées (méthode de
-- 20261003170000) : projections, droits et options des vues, signatures et corps des fonctions restent
-- intacts. Seuls changent le prédicat de date et le prédicat de quarantaine. Trois motifs, tolérants à
-- la mise en forme de pg_get_viewdef / pg_get_functiondef et à l'alias de la table :
--   1. l'appel avec les colonnes de la ligne (vues, fonctions à une ligne) ;
--   2. l'appel de repli « (false, null, ...) » de la branche sinon des recherches ;
--   3. la quarantaine lue dans raw_payload.
-- Si une définition garde un de ces motifs ou n'en reçoit aucun, la migration échoue.
do $rewrite$
declare
  v_live_call constant text := $re$app_private\.sale_catalogue_entry_is_live_materialized\(\s*((?:\w+\.)?)catalogue_expiry_materialized\s*,\s*(?:\w+\.)?catalogue_expiry_deadline\s*,\s*(?:\w+\.)?sale_date\s*,\s*(?:\w+\.)?raw_payload\s*,\s*(?:\w+\.)?sale_procedure\s*\)$re$;
  v_live_fallback constant text := $re$app_private\.sale_catalogue_entry_is_live_materialized\(\s*false\s*,\s*null\s*,\s*((?:\w+\.)?)sale_date\s*,\s*(?:\w+\.)?raw_payload\s*,\s*(?:\w+\.)?sale_procedure\s*\)$re$;
  v_live_new constant text := $new$app_private.sale_catalogue_projection_is_live(\1catalogue_expiry_materialized, \1catalogue_expiry_deadline, \1sale_date, \1catalogue_expiry_fallback, \1catalogue_state_observed_at, \1catalogue_state_end_estimate)$new$;
  v_quarantine constant text := $re$coalesce\(\s*\(?\s*((?:\w+\.)?)raw_payload\s*->>\s*'publication_quarantine'(?:::text)?\s*\)?\s*,\s*''(?:::text)?\s*\)\s*=\s*''(?:::text)?$re$;
  v_quarantine_new constant text := $new$NOT \1catalogue_quarantined$new$;
  -- Le commentaire laissé par 20261009180000 dans les corps des recherches décrit l'ancien repli.
  v_comment constant text := $re$--[^\n]*sale_catalogue_entry_is_live_materialized, but(?:\n[ \t]*--[^\n]*)*$re$;
  v_comment_new constant text := $new$-- Même règle que app_private.sale_catalogue_projection_is_live, en colonnes seules : ni raw_payload ni détoastage.$new$;
  v_function_names constant text[] := array[
    'auction_sale_is_publicly_visible',
    'search_auction_sales_preview',
    'search_auction_sales_preview_v2',
    'search_auction_sales_preview_v3',
    'search_auction_sales_preview_v4',
    'list_public_sale_sitemap_entries',
    'get_public_sale_summary',
    'get_public_sale_details',
    'get_public_tribunal_activity',
    'get_public_sale_indexability',
    'get_public_sale_calendar_event',
    'sale_photo_mirrors'
  ];
  v_function_name text;
  v_function regprocedure;
  v_before text;
  v_after text;
  v_found integer;
  v_view_name text;
  v_view_options text;
  v_views integer := 0;
begin
  foreach v_function_name in array v_function_names loop
    v_found := 0;
    for v_function in
      select procedure_row.oid::regprocedure
      from pg_catalog.pg_proc procedure_row
      join pg_catalog.pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
      where schema_row.nspname = 'app_private'
        and procedure_row.proname = v_function_name
      order by procedure_row.oid::regprocedure::text
    loop
      v_found := v_found + 1;
      v_before := pg_catalog.pg_get_functiondef(v_function);
      v_after := regexp_replace(v_before, v_live_call, v_live_new, 'gi');
      v_after := regexp_replace(v_after, v_live_fallback, v_live_new, 'gi');
      v_after := regexp_replace(v_after, v_quarantine, v_quarantine_new, 'gi');
      v_after := regexp_replace(v_after, v_comment, v_comment_new, 'g');

      if v_after ~* 'sale_catalogue_entry_is_live_materialized\('
         or v_after ~* 'publication_quarantine'
         or v_after !~ 'sale_catalogue_projection_is_live\('
         or v_after !~ 'catalogue_quarantined' then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected definition of %s; catalogue visibility without raw_payload was not installed.',
            v_function
          );
      end if;
      if v_after <> v_before then
        execute v_after;
      end if;
    end loop;

    -- Les versions 1 et 2 de la recherche sont des anciennes versions : absentes, elles ne bloquent pas.
    if v_found = 0 and v_function_name not in ('search_auction_sales_preview', 'search_auction_sales_preview_v2') then
      raise exception using
        errcode = '42883',
        message = format('Missing app_private.%s.', v_function_name);
    end if;
  end loop;

  for v_view_name, v_before, v_view_options in
    select
      view_row.relname,
      pg_catalog.pg_get_viewdef(view_row.oid, true),
      pg_catalog.array_to_string(view_row.reloptions, ', ')
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relkind = 'v'
      and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_discovery')
    order by view_row.relname
  loop
    v_views := v_views + 1;
    v_after := regexp_replace(v_before, v_live_call, v_live_new, 'gi');
    v_after := regexp_replace(v_after, v_live_fallback, v_live_new, 'gi');
    v_after := regexp_replace(v_after, v_quarantine, v_quarantine_new, 'gi');

    if v_after ~* 'sale_catalogue_entry_is_live_materialized\('
       or v_after ~* 'publication_quarantine'
       or v_after !~ 'sale_catalogue_projection_is_live\('
       or v_after !~ 'catalogue_quarantined' then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Unexpected definition of public.%s; catalogue visibility without raw_payload was not installed.',
          v_view_name
        );
    end if;
    -- Les options (security_invoker, security_barrier) sont celles de la vue actuelle.
    if v_after <> v_before then
      execute 'create or replace view public.' || quote_ident(v_view_name)
        || case when coalesce(v_view_options, '') <> '' then ' with (' || v_view_options || ')' else '' end
        || ' as ' || rtrim(v_after, E';\n ');
    end if;
  end loop;

  if v_views <> 2 then
    raise exception using
      errcode = '42P01',
      message = 'Missing public.v_auction_sales_app or public.v_auction_sales_discovery.';
  end if;
end;
$rewrite$;

notify pgrst, 'reload schema';

commit;
