begin;

set local lock_timeout = '5s';

-- Page /audiences-a-venir en panne (point 2 de la session du 20/10/2026, chantier W1).
--
-- Constat en production : public.get_public_upcoming_hearings(30) met 20 s (4,4 s pour 7 jours) alors
-- que anon a statement_timeout = 3 s, et la page affiche « Audiences momentanément indisponibles ».
-- Causes :
--   1. « cross join lateral app_private.get_public_sale_calendar_event(s.id) » : une fonction
--      SECURITY DEFINER (donc jamais intégrée à la requête), appelée par vente, qui relit la ligne et
--      détoaste raw_payload (85 Ko compressés en moyenne, jusqu'à 2,7 Mo) une dizaine de fois : une
--      fois par clé lue (précision, date brute, statut, date rejetée, conflits, calendrier source).
--   2. « limit 1000 » alors qu'il y a 1 014 audiences : la liste était tronquée (et PostgREST plafonne
--      lui aussi les lignes d'un résultat à 1 000).
--
-- Réécriture, en SQL ensembliste, de ce que calcule get_public_sale_calendar_event pour une vente au
-- tribunal « exportable » (mêmes règles, voir 20261025150000, dans la forme que lui a donnée
-- 20261027100200 : visibilité lue sur les colonnes matérialisées, sans raw_payload) :
--   * étape 1 : un filtre sur des colonnes ordinaires seulement (statut, type de vente, date, mise en
--     quarantaine, conflit de vérification, visibilité par date, fenêtre de vente en ligne, drapeaux de
--     qualité). raw_payload n'est pas lu ;
--   * étape 2 : sur ce qui reste seulement, raw_payload est lu UNE fois par ligne (jsonb_to_record
--     extrait d'un seul passage les sept clés utiles) au lieu d'une dizaine de fois ;
--   * étape 3 : les règles qui dépendent de ces clés (statut brut, date rejetée, conflit sur la date,
--     calendrier source, heure connue ou non).
-- Écart voulu, sans effet sur les données du pipeline : une clé « sale_date_unverified » valant JSON null
-- est lue comme absente (le pipeline n'écrit qu'un objet, voir sale_date_plausibility.py).
-- Le test pgTAP 531 compare le résultat à get_public_sale_calendar_event, la règle d'origine.
--
-- Contrat :
--   * la fonction rend UN document jsonb { total_count, hearings: [...] } : plus de limite de lignes de
--     PostgREST, et total_count dit quand la liste est plafonnée (5 000 audiences, jamais atteint avec
--     une fenêtre de 60 jours) ;
--   * elle ne rend plus source_url ni source_urls (les vues publiques les masquent : c'était une fuite).
--     À la place, « source_keys » : les adresses sources normalisées comme le fait
--     src/lib/upcoming-hearings.ts (normalizeSourceUrl), puis condensées par
--     encode(sha256(convert_to(clé, 'utf8')), 'hex'). La page ne fusionne deux lignes que sur une clé en
--     commun, sans jamais voir une adresse ;
--   * elle n'est plus exécutable par anon ni authenticated : la page la lit côté serveur
--     (supabaseAdmin, src/lib/upcoming-hearings.server.ts) ; la limite de 3 s de anon ne s'applique plus.
--
-- Le type de retour change : les deux fonctions sont recréées. L'application sait lire l'ancienne forme
-- (tableau de lignes) comme la nouvelle. Tant que la migration n'est pas appliquée, le serveur lit
-- l'ancienne fonction (service_role y a droit) ; une fois appliquée, un ancien déploiement (qui lit en
-- anonyme) échoue et la dernière bonne page reste servie.

-- 1. Clé d'une adresse source -------------------------------------------------------------------------
-- Mêmes règles que normalizeSourceUrl (src/lib/upcoming-hearings.ts) : sans protocole, informations de
-- connexion, port, « www. », paramètres, ancre ni barre finale, en minuscules ; nulle si l'adresse n'a
-- pas de nom de domaine (un point). Deux écritures d'une même annonce ont la même clé.
create or replace function app_private.normalize_source_url(p_url text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select
    case
      when pg_catalog.position('.' in parts.host) > 0 then pg_catalog.lower(parts.host || parts.path)
    end
  from (
    select
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(split.authority, '^[^@]*@', ''),
          ':[0-9]*$',
          ''
        ),
        '^www\.',
        '',
        'i'
      ) as host,
      pg_catalog.regexp_replace(split.path, '/+$', '') as path
    from (
      select
        coalesce((pg_catalog.regexp_match(rest.value, '^([^/?#]*)'))[1], '') as authority,
        coalesce((pg_catalog.regexp_match(rest.value, '^[^/?#]*(/[^?#]*)'))[1], '') as path
      from (
        select pg_catalog.regexp_replace(
          pg_catalog.btrim(coalesce(p_url, '')),
          '^[a-zA-Z][a-zA-Z0-9+.-]*://',
          ''
        ) as value
      ) rest
    ) split
  ) parts;
$function$;

revoke all on function app_private.normalize_source_url(text) from public, anon, authenticated;
grant execute on function app_private.normalize_source_url(text) to service_role;

comment on function app_private.normalize_source_url(text) is
  'Adresse source réduite à ce qui l''identifie (sans protocole, www., paramètres, ancre ni barre finale, en minuscules). Même règle que normalizeSourceUrl (src/lib/upcoming-hearings.ts).';

-- 2. Audiences à venir ----------------------------------------------------------------------------------
drop function if exists public.get_public_upcoming_hearings(integer);
drop function if exists app_private.get_public_upcoming_hearings(integer);

create function app_private.get_public_upcoming_hearings(p_days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with bounds as (
    select
      statement_timestamp() as now_at,
      (statement_timestamp() at time zone 'Europe/Paris')::date as today,
      least(greatest(coalesce(p_days, 30), 1), 60) as days
  ),
  -- Étape 1 : colonnes ordinaires seulement. Tout ce qui écarte une vente sans lire raw_payload.
  candidates as (
    select
      s.id,
      s.sale_date,
      s.property_type,
      s.city,
      s.department,
      s.tribunal_code,
      s.tribunal,
      s.starting_price_eur,
      s.source_url,
      s.source_urls,
      s.raw_payload,
      b.now_at,
      b.today
    from bounds b
    join public.auction_sales s
      on s.sale_venue_type = 'tribunal'
     and s.status = 'upcoming'
     and s.sale_date >= b.now_at - interval '2 days'
     and s.sale_date < b.now_at + (b.days + 2) * interval '1 day'
     and (s.sale_date at time zone 'Europe/Paris')::date between b.today and b.today + b.days
     and (not s.catalogue_quarantined)
     and coalesce(s.sale_verification_status, '') <> 'conflict'
     and app_private.sale_catalogue_projection_is_live(
       s.catalogue_expiry_materialized,
       s.catalogue_expiry_deadline,
       s.sale_date,
       s.catalogue_expiry_fallback,
       s.catalogue_state_observed_at,
       s.catalogue_state_end_estimate
     )
     and coalesce(s.sale_procedure->'sale_window', 'null'::jsonb) = 'null'::jsonb
     and coalesce(s.sale_procedure->'sale_session', 'null'::jsonb) = 'null'::jsonb
     and not exists (
       select 1
       from jsonb_array_elements_text(
         case when jsonb_typeof(s.quality_flags) = 'array' then s.quality_flags else '[]'::jsonb end
       ) as flag(value)
       where flag.value in (
         'date_conflict', 'sale_date_conflict', 'sale_time_conflict', 'sale_date_implausible'
       )
     )
  ),
  -- Étape 2 : raw_payload, lu une fois par ligne restante.
  parsed as (
    select
      c.id,
      c.sale_date,
      c.property_type,
      c.city,
      c.department,
      c.tribunal_code,
      c.tribunal,
      c.starting_price_eur,
      c.source_url,
      c.source_urls,
      c.now_at,
      c.today,
      lower(coalesce(
        nullif(btrim(r.date_precision), ''),
        nullif(btrim(r.sale_date_precision), ''),
        ''
      )) as raw_precision,
      coalesce(r.sale_date, '') as raw_date,
      lower(coalesce(r.status, '')) as raw_status,
      r.sale_date_unverified as unverified,
      r.source_conflicts as conflicts,
      r.source_sale_schedule as schedule
    from candidates c
    cross join lateral jsonb_to_record(
      case when jsonb_typeof(c.raw_payload) = 'object' then c.raw_payload else '{}'::jsonb end
    ) as r(
      date_precision text,
      sale_date_precision text,
      sale_date text,
      status text,
      sale_date_unverified jsonb,
      source_conflicts jsonb,
      source_sale_schedule jsonb
    )
  ),
  -- Étape 3 : les règles de get_public_sale_calendar_event qui dépendent de ces clés.
  hearings as (
    select
      p.id,
      p.sale_date,
      p.property_type,
      p.city,
      p.department,
      p.tribunal_code,
      p.tribunal,
      p.starting_price_eur,
      p.source_url,
      p.source_urls,
      flags.day_only
    from parsed p
    cross join lateral (
      select (
        p.raw_precision in ('day', 'date', 'day_only', 'date_only', 'unknown_time', 'time_unknown')
        or (p.raw_date <> '' and p.raw_date !~ '[0-9]{1,2}[[:space:]]*([hH]|:[0-9]{2})')
        or (p.sale_date at time zone 'UTC')::time = time '00:00'
        or (p.sale_date at time zone 'Europe/Paris')::time = time '00:00'
      ) as day_only
    ) flags
    where p.raw_status !~ '(postponed|reported|report[eé]e?|cancel|annul|withdrawn|retir)'
      and p.unverified is null
      and not coalesce(
        jsonb_path_exists(p.conflicts, '$[*] ? (@.field == "sale_date")'),
        false
      )
      and coalesce(p.schedule, 'null'::jsonb) = 'null'::jsonb
      and case
        when flags.day_only then (p.sale_date at time zone 'Europe/Paris')::date >= p.today
        else p.sale_date > p.now_at
      end
  ),
  ranked as (
    select
      h.id,
      h.sale_date::timestamptz as sale_date,
      h.day_only as date_only,
      h.property_type,
      h.city,
      h.department,
      h.tribunal_code,
      coalesce(t.canonical_name, h.tribunal) as tribunal_name,
      t.city as tribunal_city,
      h.starting_price_eur::numeric as starting_price_eur,
      hash_list.hashes as source_keys,
      count(*) over () as total_count
    from hearings h
    left join public.tribunals t on t.code = h.tribunal_code
    cross join lateral (
      select coalesce(jsonb_agg(k.url_hash order by k.url_hash), '[]'::jsonb) as hashes
      from (
        select distinct
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(n.url_key, 'utf8')), 'hex') as url_hash
        from (
          select app_private.normalize_source_url(h.source_url) as url_key
          union all
          select app_private.normalize_source_url(src_item.value #>> '{}')
          from jsonb_array_elements(
            case when jsonb_typeof(h.source_urls) = 'array' then h.source_urls else '[]'::jsonb end
          ) as src_item(value)
          where jsonb_typeof(src_item.value) = 'string'
        ) n
        where n.url_key is not null
      ) k
    ) hash_list
  ),
  capped as (
    select r.*
    from ranked r
    order by r.sale_date, r.tribunal_name, r.id
    limit 5000
  )
  select jsonb_build_object(
    'total_count', coalesce(max(c.total_count), 0),
    'hearings', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'sale_date', c.sale_date,
          'date_only', c.date_only,
          'property_type', c.property_type,
          'city', c.city,
          'department', c.department,
          'tribunal_code', c.tribunal_code,
          'tribunal_name', c.tribunal_name,
          'tribunal_city', c.tribunal_city,
          'starting_price_eur', c.starting_price_eur,
          'source_keys', c.source_keys
        )
        order by c.sale_date, c.tribunal_name, c.id
      ),
      '[]'::jsonb
    )
  )
  from capped c;
$function$;

revoke all on function app_private.get_public_upcoming_hearings(integer)
  from public, anon, authenticated;
grant execute on function app_private.get_public_upcoming_hearings(integer) to service_role;

create function public.get_public_upcoming_hearings(p_days integer default 30)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select app_private.get_public_upcoming_hearings(p_days);
$function$;

-- Les droits par défaut de Supabase donnent EXECUTE à anon et authenticated sur une nouvelle fonction :
-- ils sont retirés explicitement (revoke from public ne les enlève pas).
revoke all on function public.get_public_upcoming_hearings(integer)
  from public, anon, authenticated;
grant execute on function public.get_public_upcoming_hearings(integer) to service_role;

comment on function public.get_public_upcoming_hearings(integer) is
  'Audiences à date sourcée des p_days prochains jours (1 à 60), en un document { total_count, hearings } ; service_role seul (page /audiences-a-venir, lue côté serveur). Aucune adresse source : des clés opaques (source_keys).';

notify pgrst, 'reload schema';

commit;
