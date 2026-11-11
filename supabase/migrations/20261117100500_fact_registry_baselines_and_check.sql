begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A7 (plan du 11/11/2026, section 10 ; annexe 08, points 3 c et 12).
-- INERTE : aucun champ n'est tenu, les trois fonctions rendent zéro ligne ou un rapport vide.
--
--   1. public.get_sale_field_baselines(p_sale_ids) : pour chaque champ TENU (state held ou conflicted) des ventes
--      demandées (toutes si l'argument est nul), les colonnes du champ et la dernière valeur connue de l'annonce
--      (bloc « listing » ; une clé absente = colonne nulle). Elle ne rend jamais la valeur tenue, la pièce, la
--      décision ni l'origine. SEUL usage (arbitrage du plan) : la fusion de doublons de la collecte, qui doit
--      fusionner deux fiches sur leurs valeurs d'annonce et non sur la valeur d'une pièce. La collecte continue
--      de juger une vente sur la valeur affichée : la base n'exige rien d'autre d'elle. Serveur seul.
--   2. public.check_fact_registry_consistency(p_limit) : le contrôle quotidien. Il n'écrit rien : la fonction
--      est STABLE (PostgreSQL refuse toute instruction d'écriture dans son propre corps) et elle n'appelle la
--      projection qu'en simulation, p_apply = false écrit en dur (une fonction stable peut appeler une fonction
--      volatile : la garantie vient de ce littéral, vérifié par l'invariant fact-registry-check-read-only et par
--      le test pgTAP 889). Elle lit held_fields sans ce qui est échu (app_private.sale_field_echo_prune), entrées
--      tenues ET libérées. Elle rend un rapport JSON de comptes et d'identifiants de vente (20 au plus par
--      contrôle), jamais une valeur :
--        projection_drift        la simulation de projection rendrait « changed » pour une vente qui tient ou
--                                mémorise un champ, ou dont une pièce a pour dernière décision une acceptation
--                                d'un lot identifié. Les ventes en dérive sont rejouées une fois avant d'être
--                                rendues : la simulation lit sans verrou, une décision validée pendant la passe
--                                ne doit pas lever une alerte critique ;
--        triggers_not_always     un déclencheur du registre manque, n'est plus en mode « always », ou n'est plus
--                                lié à sa fonction ;
--        column_mismatch         une colonne tenue diffère de la valeur de son entrée, ou les libellés d'une
--                                surface tenue ne sont plus les valeurs neutres (fact_registry, built) ;
--        registry_label          surface_source = 'fact_registry' sur une vente dont aucune pièce ne tient la
--                                surface (toutes les ventes sont lues : une insertion directe échappe à la
--                                retenue) ;
--        echo_suspected          la valeur d'une pièce (valeur tenue, ou valeur non échue de la mémoire d'écho)
--                                est ailleurs que dans une colonne tenue : colonne voisine de la vente, copie
--                                (properties, auction_surfaces, judicial_sales), ou colonne d'un champ LIBÉRÉ.
--                                Ne sont pas signalées : la valeur d'annonce (mémorisée pour un champ tenu,
--                                rendue à la libération pour un champ libéré, comparaison exacte), et une colonne
--                                voisine qui portait déjà cette valeur à la première prise (« neighbors ») ;
--        internal_column_copied  raw_payload d'une vente du registre contient une clé held_fields ;
--        events_burst            plus de 50 évènements d'écriture directe en 24 heures (listing_changed_kept,
--                                listing_changed_released, echo_suppressed) ; les évènements de la projection ne
--                                comptent pas : une séance d'acceptations n'est pas une rafale ;
--        echo_suppressed         au moins un évènement echo_suppressed en 48 heures (deux passages du contrôle :
--                                le plan Hobby décale un passage jusqu'à 59 minutes) : un chemin de la collecte a
--                                échappé à sa garde d'écho ; l'indicateur doit rester à zéro ;
--        echo_blocked            une entrée libérée porte une note de blocage (echo_blocked_since) : une écriture
--                                y a été retenue comme un écho il y a moins de 7 jours. Si l'annonce dit vraiment
--                                cette valeur, la note est renouvelée à chaque passage de la collecte et l'alerte
--                                reste ouverte : la fiche affiche une valeur d'annonce périmée ;
--        stale_listing           l'annonce s'est tue sur un champ tenu (listing_silent_since : la valeur d'annonce
--                                mémorisée est peut-être périmée, arbitrage du plan sur le point 8), ou une
--                                surface est encore tenue sur une vente devenue un terrain (la projection
--                                suivante la libère).
--      Le nombre de ventes examinées est borné par p_limit ; au-delà, « truncated » vaut true.
--   3. public.sync_fact_registry_alerts() : appelée par la tâche /api/cron/fact-registry-check, sans paramètre
--      (l'appelant ne choisit ni la borne, ni le rapport). Elle lance le contrôle puis ouvre ou referme une
--      alerte opérationnelle par contrôle (clé fact_registry.<contrôle>), par le mécanisme existant
--      (app_private.sync_operational_alert : notification à l'ouverture, rappel au plus une fois par 24 heures,
--      fermeture deux heures après le retour au calme). La clé, la catégorie et la gravité sont fixées dans
--      app_private.sync_fact_registry_alerts_from_report (fonction interne, exécutable par aucun rôle de l'API).
--      Critique : projection_drift, triggers_not_always, column_mismatch, registry_label. Avertissement : les six
--      autres. Catégorie « import », celle des autres contrôles du catalogue (operational_alerts_category_check
--      n'est pas touchée).
--      RAPPORT TRONQUÉ : un contrôle inactif sur les premières ventes ne dit rien des suivantes. Seuls les
--      contrôles ACTIFS sont alors synchronisés (aucune alerte n'est refermée), le rapport est rendu avec
--      « truncated » à true, et la tâche échoue (src/lib/fact-registry-check.ts) au lieu de tenir un rapport
--      partiel pour complet.
--
-- Verrous : création de fonctions seulement. Possible pendant un import.
--
-- Retour arrière :
--   begin;
--   drop function if exists public.sync_fact_registry_alerts();
--   drop function if exists app_private.sync_fact_registry_alerts_from_report(jsonb);
--   drop function if exists public.check_fact_registry_consistency(integer);
--   drop function if exists public.get_sale_field_baselines(uuid[]);
--   drop function if exists app_private.sale_field_value_leaks(text, jsonb, jsonb, jsonb, jsonb, numeric, numeric);
--   commit;
-- (les alertes fact_registry.* déjà ouvertes restent dans operational_alerts : ne pas les supprimer.)

create or replace function public.get_sale_field_baselines(p_sale_ids uuid[] default null)
returns table (sale_id uuid, field_key text, columns text[], listing jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select sale.id, entry.key, field.held_columns, coalesce(entry.value -> 'listing', '{}'::jsonb)
  from public.auction_sales sale
  cross join lateral pg_catalog.jsonb_each(sale.held_fields) entry
  join public.auction_fact_fields field on field.field_key = entry.key
  where sale.held_fields is not null
    and (p_sale_ids is null or sale.id = any(p_sale_ids))
    and entry.value ->> 'state' in ('held', 'conflicted')
  order by sale.id, entry.key;
$$;

comment on function public.get_sale_field_baselines(uuid[]) is
  'Registre des pièces : pour chaque champ tenu des ventes demandées, ses colonnes et la dernière valeur connue de l''annonce. Jamais la valeur tenue, la pièce, la décision ni l''origine. Réservée à la fusion de doublons de la collecte (service_role).';

revoke all on function public.get_sale_field_baselines(uuid[]) from public, anon, authenticated;
grant execute on function public.get_sale_field_baselines(uuid[]) to service_role;

-- Une valeur qui n'est pas celle d'un champ tenu (colonne voisine, copie, ou colonne d'un champ libéré)
-- porte-t-elle la valeur d'une pièce : la valeur tenue ou une valeur de la mémoire d'écho, à la tolérance du champ,
-- sans être EXACTEMENT une des valeurs de référence (les valeurs d'annonce connues pour cette colonne) ? La
-- comparaison aux références est exacte : une pièce qui confirme l'annonce à la tolérance près (annonce 50, pièce
-- 50,4) laisserait sinon passer 50,4 pour la valeur d'annonce.
drop function if exists
  app_private.sale_field_value_leaks(text, jsonb, jsonb, jsonb, jsonb, jsonb, numeric, numeric);

create or replace function app_private.sale_field_value_leaks(
  p_field_key text,
  p_value jsonb,
  p_held jsonb,
  p_references jsonb,
  p_echo jsonb,
  p_abs_tolerance numeric,
  p_rel_tolerance numeric
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select app_private.sale_field_incoming_class(
      p_field_key, p_value, p_held, null, p_echo, p_abs_tolerance, p_rel_tolerance
    ) in ('held', 'echo')
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_references) = 'array' then p_references else '[]'::jsonb end
      ) reference
      where app_private.sale_field_values_match(p_field_key, p_value, reference.value, 0, 0)
    );
$$;

revoke all on function
  app_private.sale_field_value_leaks(text, jsonb, jsonb, jsonb, jsonb, numeric, numeric)
  from public, anon, authenticated, service_role;

create or replace function public.check_fact_registry_consistency(p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_candidates integer;
  v_sale_ids uuid[];
  v_sale_id uuid;
  v_drift_first uuid[] := array[]::uuid[];
  v_drift uuid[] := array[]::uuid[];
  v_mismatch uuid[];
  v_echo uuid[];
  v_stale uuid[];
  v_blocked uuid[];
  v_copied uuid[];
  v_label uuid[];
  v_triggers text[];
  v_events_day integer;
  v_echo_events integer;
  v_echo_events_total integer;
  v_echo_event_sales uuid[];
  v_held_sales integer;
  v_held_fields integer;
begin
  -- Ventes examinées : celles qui tiennent ou mémorisent un champ, et celles dont une pièce a pour dernière
  -- décision une acceptation d'un lot identifié (rapportée à la vente conservée après une fusion).
  with accepted as (
    select distinct coalesce(merge.canonical_sale_id, latest.sale_id) as id
    from (
      select distinct on (decision.claim_id) decision.sale_id, decision.decision, decision.lot_attachment
      from public.auction_fact_claim_decisions decision
      order by decision.claim_id, decision.seq desc
    ) latest
    left join app_private.auction_sale_merges merge on merge.old_sale_id = latest.sale_id
    where latest.decision = 'accepted' and latest.lot_attachment in ('single_lot', 'matched')
  ),
  candidates as (
    select sale.id from public.auction_sales sale where sale.held_fields is not null
    union
    select sale.id from accepted join public.auction_sales sale on sale.id = accepted.id
  )
  select
    (select count(*)::integer from candidates),
    (select coalesce(pg_catalog.array_agg(bounded.id order by bounded.id), array[]::uuid[])
       from (select candidates.id from candidates order by candidates.id limit v_limit) bounded)
  into v_candidates, v_sale_ids;

  -- 1. La simulation de projection ne doit rien changer. La simulation lit sans verrou, en plusieurs
  --    instructions : une décision validée pendant la passe peut la faire rendre « changed » à tort. Les ventes
  --    en dérive sont donc rejouées une fois, et seules celles qui le sont encore sont rendues.
  foreach v_sale_id in array v_sale_ids loop
    if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
      v_drift_first := v_drift_first || v_sale_id;
    end if;
  end loop;
  foreach v_sale_id in array v_drift_first loop
    if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
      v_drift := v_drift || v_sale_id;
    end if;
  end loop;

  -- 2. Mode et fonction des déclencheurs.
  v_triggers := app_private.fact_registry_triggers_not_always();

  -- 3, 4, 8 et 9. Une lecture par entrée de held_fields, tenue ou libérée, sans ce qui est échu.
  --    * colonnes tenues (entrée tenue seulement) ;
  --    * valeur d'une pièce hors de ses colonnes : colonnes voisines et copies (entrée tenue ou libérée), et
  --      colonnes du champ lui-même pour une entrée libérée. Références exactes : pour une entrée tenue, la
  --      valeur d'annonce mémorisée ; pour une entrée libérée, les valeurs rendues aux colonnes à la libération
  --      (« restored ») et, pour une colonne voisine ou une copie, les colonnes actuelles du champ ; pour une
  --      colonne voisine, en plus, la valeur qu'elle portait à la première prise (« neighbors ») ;
  --    * annonce qui se tait, surface tenue sur un terrain ;
  --    * note de blocage d'une entrée libérée.
  select
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.mismatch), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.leak), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.stale), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(distinct checked.id) filter (where checked.blocked), array[]::uuid[]),
    (count(distinct checked.id) filter (where checked.holds))::integer,
    (count(*) filter (where checked.holds))::integer
  into v_mismatch, v_echo, v_stale, v_blocked, v_held_sales, v_held_fields
  from (
    select
      sale.id,
      piece.holds,
      piece.holds and case entry.key
        when 'property.surface_m2' then
          sale.surface_m2 is distinct from (piece.held #>> '{}')::numeric
          or sale.app_surface_m2 is distinct from (piece.held #>> '{}')::numeric
          or sale.surface_source is distinct from 'fact_registry'
          or sale.app_surface_kind is distinct from 'built'
        when 'property.land_surface_m2' then
          sale.land_surface_m2 is distinct from (piece.held #>> '{}')::numeric
        when 'property.rooms_count' then
          sale.rooms_count is distinct from (piece.held #>> '{}')::integer
        when 'property.occupancy_status' then
          sale.occupancy_status is distinct from (piece.held #>> '{}')
        else sale.visit_dates is distinct from piece.held
      end as mismatch,
      exists (
        select 1
        from (
          values
            -- (champ, valeur lue, colonne du champ lui-même, référence propre à la colonne, s'applique)
            ('property.surface_m2', pg_catalog.to_jsonb(sale.app_surface_m2), true, null::jsonb, not piece.holds),
            ('property.surface_m2', pg_catalog.to_jsonb(sale.surface_m2), true, null, not piece.holds),
            ('property.surface_m2', pg_catalog.to_jsonb(sale.habitable_surface_m2), false,
              piece.neighbors -> 'habitable_surface_m2', true),
            ('property.surface_m2', pg_catalog.to_jsonb(sale.carrez_surface_m2), false,
              piece.neighbors -> 'carrez_surface_m2', true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.app_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.habitable_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(property.carrez_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.app_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.habitable_surface_m2), false, null, true),
            ('property.surface_m2', pg_catalog.to_jsonb(surface.carrez_surface_m2), false, null, true),
            ('property.land_surface_m2', pg_catalog.to_jsonb(sale.land_surface_m2), true, null, not piece.holds),
            ('property.land_surface_m2', pg_catalog.to_jsonb(property.land_surface_m2), false, null, true),
            ('property.land_surface_m2', pg_catalog.to_jsonb(surface.land_surface_m2), false, null, true),
            -- Terrain recopié en surface principale : seulement quand la surface n'est pas elle-même tenue.
            ('property.land_surface_m2', pg_catalog.to_jsonb(sale.app_surface_m2), false,
              piece.neighbors -> 'app_surface_m2', not piece.surface_held),
            ('property.land_surface_m2', pg_catalog.to_jsonb(sale.surface_m2), false,
              piece.neighbors -> 'surface_m2', not piece.surface_held),
            ('property.rooms_count', pg_catalog.to_jsonb(sale.rooms_count), true, null, not piece.holds),
            ('property.rooms_count', pg_catalog.to_jsonb(property.rooms_count), false, null, true),
            ('property.rooms_count', pg_catalog.to_jsonb(surface.rooms_count), false, null, true),
            ('property.occupancy_status', pg_catalog.to_jsonb(sale.occupancy_status), true, null, not piece.holds),
            ('property.occupancy_status', pg_catalog.to_jsonb(property.occupancy_status), false, null, true),
            ('sale.visit_dates', sale.visit_dates, true, null, not piece.holds),
            ('sale.visit_dates', judicial.visit_dates, false, null, true)
        ) watched (field_key, value, own_column, own_reference, applies)
        where watched.field_key = entry.key
          and watched.applies
          and app_private.sale_field_value_leaks(
            entry.key,
            watched.value,
            piece.held,
            case
              when watched.own_column then piece.restored_references
              else piece.other_references || pg_catalog.jsonb_build_array(watched.own_reference)
            end,
            piece.echo,
            piece.abs_tolerance,
            piece.rel_tolerance
          )
      ) as leak,
      piece.holds and (
        entry.value ? 'listing_silent_since'
        or (
          entry.key = 'property.surface_m2'
          and (sale.property_type = 'land' or sale.surface_scope = 'land')
        )
      ) as stale,
      not piece.holds and entry.value ? 'echo_blocked_since' as blocked
    from public.auction_sales sale
    cross join lateral pg_catalog.jsonb_each(app_private.sale_field_echo_prune(sale.held_fields, v_now)) entry
    cross join lateral (
      select
        coalesce(entry.value ->> 'state' in ('held', 'conflicted'), false) as holds,
        coalesce(entry.value -> 'listing', '{}'::jsonb) as listing,
        coalesce(entry.value -> 'restored', '{}'::jsonb) as restored,
        case entry.key
          when 'property.surface_m2' then
            pg_catalog.jsonb_build_array(sale.app_surface_m2, sale.surface_m2)
          when 'property.land_surface_m2' then pg_catalog.jsonb_build_array(sale.land_surface_m2)
          when 'property.rooms_count' then pg_catalog.jsonb_build_array(sale.rooms_count)
          when 'property.occupancy_status' then pg_catalog.jsonb_build_array(sale.occupancy_status)
          else pg_catalog.jsonb_build_array(sale.visit_dates)
        end as current_columns
    ) shape
    cross join lateral (
      select
        shape.holds,
        case when shape.holds then entry.value -> 'value' end as held,
        coalesce(entry.value -> 'neighbors', '{}'::jsonb) as neighbors,
        coalesce(entry.value -> 'echo', '[]'::jsonb) as echo,
        (entry.value #>> '{tolerance,abs}')::numeric as abs_tolerance,
        (entry.value #>> '{tolerance,rel}')::numeric as rel_tolerance,
        coalesce(
          sale.held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false
        ) as surface_held,
        -- Références d'une colonne du champ libéré : les valeurs rendues à la libération.
        (
          select coalesce(pg_catalog.jsonb_agg(restored.value), '[]'::jsonb)
          from pg_catalog.jsonb_each(shape.restored) restored
        ) as restored_references,
        -- Références d'une colonne voisine ou d'une copie.
        case
          when shape.holds then (
            select coalesce(pg_catalog.jsonb_agg(listed.value), '[]'::jsonb)
            from pg_catalog.jsonb_each(shape.listing) listed
            where listed.key not in ('app_surface_kind', 'surface_source', 'surface_confidence')
          )
          else shape.current_columns || (
            select coalesce(pg_catalog.jsonb_agg(restored.value), '[]'::jsonb)
            from pg_catalog.jsonb_each(shape.restored) restored
          )
        end as other_references
    ) piece
    left join public.properties property on property.source_url = sale.source_url
    left join public.auction_surfaces surface on surface.source_url = sale.source_url
    left join public.judicial_sales judicial on judicial.source_url = sale.source_url
    where sale.held_fields is not null
      and sale.id = any(v_sale_ids)
  ) checked;

  -- 5. La colonne interne recopiée dans raw_payload.
  select coalesce(pg_catalog.array_agg(sale.id), array[]::uuid[]) into v_copied
  from public.auction_sales sale
  where sale.held_fields is not null and sale.id = any(v_sale_ids) and sale.raw_payload ? 'held_fields';

  -- 10. Le libellé réservé du registre sur une surface que rien ne tient. Toutes les ventes sont lues (une
  --     lecture par jour d'une colonne courte) : une insertion directe échappe à la retenue, qui ne voit que les
  --     mises à jour.
  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), array[]::uuid[]) into v_label
  from public.auction_sales sale
  where sale.surface_source = 'fact_registry'
    and not coalesce(sale.held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false);

  -- 6 et 7. La file de relecture. La rafale ne compte que ce qui vient d'une écriture directe (annonce qui
  -- change, écho écarté) : une séance d'acceptations (projection_held) n'est pas une rafale.
  select
    count(*) filter (
      where event.event in ('listing_changed_kept', 'listing_changed_released', 'echo_suppressed')
        and event.created_at >= v_now - interval '24 hours')::integer,
    count(*) filter (
      where event.event = 'echo_suppressed' and event.created_at >= v_now - interval '48 hours')::integer,
    count(*) filter (where event.event = 'echo_suppressed')::integer,
    coalesce(
      pg_catalog.array_agg(distinct event.sale_id) filter (
        where event.event = 'echo_suppressed' and event.created_at >= v_now - interval '48 hours'),
      array[]::uuid[]
    )
  into v_events_day, v_echo_events, v_echo_events_total, v_echo_event_sales
  from public.auction_sale_field_hold_events event;

  return pg_catalog.jsonb_build_object(
    'checked_at', v_now,
    'limit', v_limit,
    'candidate_sales', v_candidates,
    'sales_checked', pg_catalog.cardinality(v_sale_ids),
    'truncated', v_candidates > pg_catalog.cardinality(v_sale_ids),
    'held_sale_count', v_held_sales,
    'held_field_count', v_held_fields,
    'checks', pg_catalog.jsonb_build_object(
      'projection_drift', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_drift) > 0,
        'count', pg_catalog.cardinality(v_drift),
        'sale_ids', pg_catalog.to_jsonb(v_drift[1:20])
      ),
      'triggers_not_always', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_triggers) > 0,
        'count', pg_catalog.cardinality(v_triggers),
        'triggers', pg_catalog.to_jsonb(v_triggers)
      ),
      'column_mismatch', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_mismatch) > 0,
        'count', pg_catalog.cardinality(v_mismatch),
        'sale_ids', pg_catalog.to_jsonb(v_mismatch[1:20])
      ),
      'registry_label', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_label) > 0,
        'count', pg_catalog.cardinality(v_label),
        'sale_ids', pg_catalog.to_jsonb(v_label[1:20])
      ),
      'echo_suspected', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_echo) > 0,
        'count', pg_catalog.cardinality(v_echo),
        'sale_ids', pg_catalog.to_jsonb(v_echo[1:20])
      ),
      'internal_column_copied', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_copied) > 0,
        'count', pg_catalog.cardinality(v_copied),
        'sale_ids', pg_catalog.to_jsonb(v_copied[1:20])
      ),
      'events_burst', pg_catalog.jsonb_build_object(
        'active', v_events_day > 50,
        'count', v_events_day,
        'threshold', 50,
        'window_hours', 24
      ),
      'echo_suppressed', pg_catalog.jsonb_build_object(
        'active', v_echo_events > 0,
        'count', v_echo_events,
        'window_hours', 48,
        'total', v_echo_events_total,
        'sale_ids', pg_catalog.to_jsonb(v_echo_event_sales[1:20])
      ),
      'echo_blocked', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_blocked) > 0,
        'count', pg_catalog.cardinality(v_blocked),
        'sale_ids', pg_catalog.to_jsonb(v_blocked[1:20])
      ),
      'stale_listing', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_stale) > 0,
        'count', pg_catalog.cardinality(v_stale),
        'sale_ids', pg_catalog.to_jsonb(v_stale[1:20])
      )
    )
  );
end;
$$;

comment on function public.check_fact_registry_consistency(integer) is
  'Registre des pièces : contrôle quotidien en lecture seule (la projection n''y est appelée qu''en simulation). Rapport JSON de comptes et d''identifiants de vente, jamais une valeur : dérive de la projection, mode des déclencheurs, colonnes tenues, libellé réservé sans surface tenue, valeur d''une pièce dans une colonne voisine, une copie ou un champ libéré, colonne interne recopiée, rafale d''évènements, écho écarté, valeur d''annonce retenue comme un écho, annonce qui se tait. Serveur seul (service_role).';

revoke all on function public.check_fact_registry_consistency(integer) from public, anon, authenticated;
grant execute on function public.check_fact_registry_consistency(integer) to service_role;

-- Ouvre ou referme les alertes à partir d'un rapport du contrôle. Fonction interne : aucun rôle de l'API ne fournit
-- un rapport. RAPPORT TRONQUÉ : un contrôle inactif sur une partie des ventes ne dit rien des autres ; seuls les
-- contrôles actifs sont synchronisés, aucune alerte n'est refermée.
create or replace function app_private.sync_fact_registry_alerts_from_report(p_report jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_truncated boolean;
  v_active boolean;
  v_check record;
begin
  if pg_catalog.jsonb_typeof(p_report -> 'truncated') is distinct from 'boolean' then
    raise exception using errcode = 'XX000', message = 'fact registry check returned no truncation state';
  end if;
  v_truncated := (p_report ->> 'truncated')::boolean;
  for v_check in
    select planned.check_key, planned.severity
    from (
      values
        ('projection_drift', 'critical'),
        ('triggers_not_always', 'critical'),
        ('column_mismatch', 'critical'),
        ('registry_label', 'critical'),
        ('echo_suspected', 'warning'),
        ('internal_column_copied', 'warning'),
        ('events_burst', 'warning'),
        ('echo_suppressed', 'warning'),
        ('echo_blocked', 'warning'),
        ('stale_listing', 'warning')
    ) as planned (check_key, severity)
  loop
    if pg_catalog.jsonb_typeof(p_report #> array['checks', v_check.check_key, 'active']) is distinct from 'boolean'
    then
      raise exception using errcode = 'XX000',
        message = pg_catalog.format('fact registry check %s returned no state', v_check.check_key);
    end if;
    v_active := (p_report #>> array['checks', v_check.check_key, 'active'])::boolean;
    continue when v_truncated and not v_active;
    perform app_private.sync_operational_alert(
      'fact_registry.' || v_check.check_key,
      'import',
      v_check.severity,
      (p_report #> array['checks', v_check.check_key]) - 'active'
        || pg_catalog.jsonb_build_object(
          'checked_at', p_report -> 'checked_at',
          'sales_checked', p_report -> 'sales_checked',
          'truncated', p_report -> 'truncated'
        ),
      v_active
    );
  end loop;
end;
$$;

comment on function app_private.sync_fact_registry_alerts_from_report(jsonb) is
  'Registre des pièces : ouvre ou referme les alertes opérationnelles fact_registry.* à partir d''un rapport du contrôle quotidien (clé, catégorie et gravité fixées ici). Rapport tronqué : seuls les contrôles actifs sont synchronisés. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.sync_fact_registry_alerts_from_report(jsonb)
  from public, anon, authenticated, service_role;

-- La version d'essai de ce lot prenait une borne en paramètre : un appelant pouvait refermer une alerte critique
-- avec un rapport partiel. Jamais appliquée en production ; supprimée ici pour les bases de développement.
drop function if exists public.sync_fact_registry_alerts(integer);

create or replace function public.sync_fact_registry_alerts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_report jsonb := public.check_fact_registry_consistency();
begin
  perform app_private.sync_fact_registry_alerts_from_report(v_report);
  return v_report;
end;
$$;

comment on function public.sync_fact_registry_alerts() is
  'Registre des pièces : lance le contrôle quotidien (borne par défaut) puis ouvre ou referme les alertes opérationnelles fact_registry.*. Sans paramètre : l''appelant ne choisit ni la borne, ni le rapport. Rend le rapport du contrôle ; s''il est tronqué, aucune alerte n''est refermée et la tâche doit échouer. Serveur seul (service_role).';

revoke all on function public.sync_fact_registry_alerts() from public, anon, authenticated;
grant execute on function public.sync_fact_registry_alerts() to service_role;

notify pgrst, 'reload schema';

commit;
