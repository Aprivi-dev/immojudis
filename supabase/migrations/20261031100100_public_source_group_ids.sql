begin;

set local lock_timeout = '5s';

-- Chantier R1, point 1 (relecture de code du 20/10/2026) : les clés « source_keys » étaient réversibles.
--
-- get_public_tribunal_sales (20261029180000, ouverte à anon) et get_public_upcoming_hearings
-- (20261029100100, service_role seul) rendaient, pour chaque vente, le SHA-256 SANS SEL de chaque adresse
-- source normalisée. Un SHA-256 sans sel d'une adresse de forme prévisible (« licitor.com/annonce/<n>/… »)
-- se retrouve en essayant des adresses : la clé révélait donc l'adresse source que les vues publiques
-- masquent.
--
-- Plus aucune clé ne sort. À la place, un IDENTIFIANT DE GROUPE : pour chaque ligne de la liste rendue,
-- le plus petit identifiant des lignes de la liste qui partagent avec elle, de proche en proche, une
-- adresse source normalisée (A et B partagent une adresse, B et C une autre : A, B et C ont le groupe de
-- A). Deux lignes du même groupe sont la même vente publiée deux fois ; une ligne qui ne partage rien est
-- son propre groupe. Le choix (plutôt qu'un HMAC avec un secret d'app_private) : un identifiant de groupe
-- ne dérive pas de l'adresse, il ne peut donc rien en révéler même si un secret fuitait ; c'est un
-- identifiant de ligne déjà public dans la même réponse ; et il n'y a aucun secret à stocker ni à
-- renouveler. Le calcul est fait sur les lignes rendues (la liste d'un tribunal, au plus p_limit lignes ;
-- les audiences de la fenêtre), exactement ce que la page dédoublonne.
--
-- Contrat :
--   * get_public_tribunal_sales : la colonne source_keys (jsonb) devient source_group (uuid) ;
--   * get_public_upcoming_hearings : la clé « source_keys » du document devient « source_group ».
-- L'application (src/lib/upcoming-hearings.ts, tribunal-pages.server.ts) lit source_group ; absent
-- (migration pas encore appliquée), elle n'annule aucune ligne : pas de fusion, aucune donnée exposée.
-- Un ancien déploiement qui lit source_keys ne trouve plus rien : il n'annule rien non plus. L'ordre
-- migration / déploiement est donc libre ; migration d'abord évite une courte période sans fusion.
--
-- Les types de retour de get_public_tribunal_sales changent : les fonctions sont recréées avec les
-- mêmes droits qu'en 20261029180000 (visiteur sans compte compris). La fonction des audiences garde son
-- type (jsonb) : create or replace.

-- 1. Groupes d'identité --------------------------------------------------------------------------------
-- p_rows : [{ "id": uuid, "keys": [adresse normalisée, ...] }, ...]. Pour chaque id, le plus petit id de
-- sa composante connexe (deux lignes sont reliées par une adresse en commun). Les arêtes relient chaque
-- ligne au plus petit id qui porte la même adresse (étoile, linéaire) ; la propagation s'arrête dès que
-- tous les couples (ligne, membre) sont connus (union, jamais union all).
create or replace function app_private.source_group_ids(p_rows jsonb)
returns table (id uuid, group_id uuid)
language sql
stable
set search_path = ''
as $function$
  with recursive
  input_rows as (
    select row_item.value as item
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
    ) as row_item(value)
    where pg_catalog.jsonb_typeof(row_item.value) = 'object'
  ),
  ids as (
    select distinct (r.item ->> 'id')::uuid as id
    from input_rows r
  ),
  entries as (
    select distinct (r.item ->> 'id')::uuid as id, key_item.value as url_key
    from input_rows r
    cross join lateral pg_catalog.jsonb_array_elements_text(
      case when pg_catalog.jsonb_typeof(r.item -> 'keys') = 'array' then r.item -> 'keys' else '[]'::jsonb end
    ) as key_item(value)
    where pg_catalog.btrim(key_item.value) <> ''
  ),
  reps as (
    select e.url_key, (pg_catalog.array_agg(e.id order by e.id))[1] as rep_id
    from entries e
    group by e.url_key
  ),
  links as (
    select e.id as a, r.rep_id as b
    from entries e
    join reps r on r.url_key = e.url_key
    where e.id <> r.rep_id
  ),
  edges as (
    select l.a, l.b from links l
    union
    select l.b, l.a from links l
  ),
  reach(id, member) as (
    select i.id, i.id from ids i
    union
    select r.id, ed.b
    from reach r
    join edges ed on ed.a = r.member
  )
  select r.id, (pg_catalog.array_agg(r.member order by r.member))[1] as group_id
  from reach r
  group by r.id;
$function$;

revoke all on function app_private.source_group_ids(jsonb) from public, anon, authenticated;
grant execute on function app_private.source_group_ids(jsonb) to service_role;

comment on function app_private.source_group_ids(jsonb) is
  'Pour chaque ligne [{id, keys}], le plus petit id des lignes qui partagent (de proche en proche) une adresse source normalisée. Ne rend aucune clé ni adresse.';

-- 2. Audiences à venir ------------------------------------------------------------------------------------
-- Même règle de sélection qu'en 20261029100100 ; seule la sortie change (source_group, plus source_keys).
create or replace function app_private.get_public_upcoming_hearings(p_days integer default 30)
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
      key_list.url_keys,
      count(*) over () as total_count
    from hearings h
    left join public.tribunals t on t.code = h.tribunal_code
    -- Les adresses sources normalisées : elles ne servent qu'à calculer le groupe, aucune ne sort.
    cross join lateral (
      select coalesce(jsonb_agg(k.url_key order by k.url_key), '[]'::jsonb) as url_keys
      from (
        select distinct n.url_key
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
    ) key_list
  ),
  capped as (
    select r.*
    from ranked r
    order by r.sale_date, r.tribunal_name, r.id
    limit 5000
  ),
  grouped as (
    select g.id, g.group_id
    from app_private.source_group_ids(
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'keys', c.url_keys)), '[]'::jsonb)
        from capped c
      )
    ) g
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
          'source_group', coalesce(g.group_id, c.id)
        )
        order by c.sale_date, c.tribunal_name, c.id
      ),
      '[]'::jsonb
    )
  )
  from capped c
  left join grouped g on g.id = c.id;
$function$;

revoke all on function app_private.get_public_upcoming_hearings(integer)
  from public, anon, authenticated;
grant execute on function app_private.get_public_upcoming_hearings(integer) to service_role;

comment on function public.get_public_upcoming_hearings(integer) is
  'Audiences à date sourcée des p_days prochains jours (1 à 60), en un document { total_count, hearings } ; service_role seul (page /audiences-a-venir, lue côté serveur). Aucune adresse source ni clé dérivée : un identifiant de groupe (source_group) reconnaît la même vente publiée deux fois.';

-- 3. Ventes d'un tribunal -----------------------------------------------------------------------------------
drop function if exists public.get_public_tribunal_sales(text, integer);
drop function if exists app_private.get_public_tribunal_sales(text, integer);

create function app_private.get_public_tribunal_sales(
  p_tribunal_code text,
  p_limit integer default 30
)
returns table (
  id uuid,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  starting_price_eur numeric,
  surface_m2 numeric,
  status text,
  source_group uuid
)
language sql
stable
security definer
set search_path = ''
as $function$
  with listed as (
    select
      s.id,
      s.city,
      s.department,
      s.property_type,
      s.sale_date,
      s.starting_price_eur,
      s.app_surface_m2,
      s.status,
      s.source_url,
      s.source_urls
    from public.auction_sales s
    where s.tribunal_code = p_tribunal_code
      and s.sale_venue_type = 'tribunal'
      and app_private.auction_sale_is_publicly_visible(s.id)
    order by
      (s.sale_date is null or s.sale_date < statement_timestamp()),
      s.sale_date,
      s.id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ),
  -- Les adresses sources normalisées : elles ne servent qu'à calculer le groupe, aucune ne sort.
  keyed as (
    select
      l.id,
      pg_catalog.jsonb_build_object('id', l.id, 'keys', key_list.url_keys) as entry
    from listed l
    cross join lateral (
      select coalesce(pg_catalog.jsonb_agg(k.url_key order by k.url_key), '[]'::jsonb) as url_keys
      from (
        select distinct n.url_key
        from (
          select app_private.normalize_source_url(l.source_url) as url_key
          union all
          select app_private.normalize_source_url(src_item.value #>> '{}')
          from pg_catalog.jsonb_array_elements(
            case when pg_catalog.jsonb_typeof(l.source_urls) = 'array' then l.source_urls else '[]'::jsonb end
          ) as src_item(value)
          where pg_catalog.jsonb_typeof(src_item.value) = 'string'
        ) n
        where n.url_key is not null
      ) k
    ) key_list
  ),
  grouped as (
    select g.id, g.group_id
    from app_private.source_group_ids(
      (select coalesce(pg_catalog.jsonb_agg(k.entry), '[]'::jsonb) from keyed k)
    ) g
  )
  select
    l.id,
    l.city,
    l.department,
    l.property_type,
    l.sale_date::timestamptz,
    l.starting_price_eur::numeric,
    l.app_surface_m2::numeric,
    coalesce(l.status, 'unknown'),
    coalesce(g.group_id, l.id)
  from listed l
  left join grouped g on g.id = l.id
  order by
    (l.sale_date is null or l.sale_date < statement_timestamp()),
    l.sale_date,
    l.id;
$function$;

revoke all on function app_private.get_public_tribunal_sales(text, integer)
  from public, anon, authenticated;
grant execute on function app_private.get_public_tribunal_sales(text, integer)
  to anon, authenticated, service_role;

create function public.get_public_tribunal_sales(
  p_tribunal_code text,
  p_limit integer default 30
)
returns table (
  id uuid,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  starting_price_eur numeric,
  surface_m2 numeric,
  status text,
  source_group uuid
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_tribunal_sales(p_tribunal_code, p_limit);
$function$;

revoke all on function public.get_public_tribunal_sales(text, integer) from public;
grant execute on function public.get_public_tribunal_sales(text, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
