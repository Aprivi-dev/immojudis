begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2b, étape B3 (plan du 11/11/2026, section 10 ; reports du lot R2a listés dans
-- docs/architecture/registre-des-pieces.md). INERTE : aucune vente ne tient de champ, le journal des décisions est
-- vide, et la relance planifiée est FERMÉE par défaut.
--
--   1. CONTRÔLE QUOTIDIEN PAGINÉ. Au lot R2a, public.check_fact_registry_consistency(p_limit) examinait au plus 500
--      ventes ; au-delà le rapport était tronqué et la tâche échouait chaque jour. La fonction prend un second
--      paramètre, p_after : elle examine la page des ventes du registre qui suit cet identifiant, et rend
--      « next_after » (l'identifiant à passer pour la page suivante) quand il en reste. Elle reste en LECTURE SEULE
--      (STABLE, projection appelée en simulation seulement). Les contrôles qui ne dépendent pas d'une vente
--      (déclencheurs, libellé réservé, file d'évènements) sont rendus à chaque page, à l'identique.
--      public.sync_fact_registry_alerts(), sans paramètre comme avant, enchaîne les pages (500 ventes par page,
--      40 pages au plus) et additionne leurs rapports (app_private.fact_registry_report_add_page) : le rapport
--      rendu à la tâche a la même forme qu'au lot R2a, avec « truncated » à false tant que le registre compte moins
--      de 20 000 ventes. Au-delà, le comportement du lot R2a est gardé : aucune alerte n'est refermée, la tâche
--      échoue. L'ancienne signature à un paramètre est supprimée (une seule fonction de ce nom pour PostgREST).
--   2. RELANCE PLANIFIÉE DE LA PROJECTION (arbitrage du 12/11/2026 sur la question laissée ouverte par le lot R2a).
--      La projection lit des colonnes que la retenue ne tient pas : un reclassement en terrain (property_type,
--      surface_scope) ou une écriture de bedrooms_count par la collecte change ce qu'elle déciderait, et personne
--      ne la rappelait. Deux relances, et aucun déclencheur :
--        * toute décision d'administrateur reprojette la vente entière (20261118100100) ;
--        * app_private.reproject_drifted_sales(p_max), appelée par public.sync_fact_registry_alerts() AVANT le
--          contrôle : pour chaque vente du registre dont la simulation rend « changed », elle applique la
--          projection. C'EST UNE ÉCRITURE DE FICHE LANCÉE PAR UNE TÂCHE PLANIFIÉE. Elle ne fait que réappliquer des
--          décisions humaines déjà acceptées (aucune décision n'est écrite, le mode de publication reste
--          « manual », les verrous auto_locked ne bougent pas). Elle est :
--            - FERMÉE PAR DÉFAUT : réglage app_private.fact_registry_switches, ligne « scheduled_reprojection »,
--              ouvert ou refermé sans migration de code par
--              select app_private.set_fact_registry_scheduled_reprojection(true ou false) ;
--            - sans effet tant que le journal des décisions est vide, et quand un déclencheur du registre manque ;
--            - bornée : p_max ventes par passage (50), les suivantes sont comptées (« deferred ») et reprises au
--              passage suivant ; une vente occupée par un lot de la collecte (verrou non obtenu en 3 secondes) est
--              comptée (« busy ») et reprise au passage suivant, et après trois ventes occupées le reste de la
--              passe est reporté (la tâche n'attend jamais plus de 9 secondes derrière la collecte) ; une vente
--              dont la projection échoue est comptée (« failed ») sans arrêter la passe, et le contrôle qui suit
--              la signale en dérive ;
--            - journalisée : un évènement « drift_reprojected » par champ dont l'entrée a changé (à défaut, par
--              champ tenu), dans public.auction_sale_field_hold_events, distinct d'une décision et des évènements
--              de la projection elle-même.
--          Son compte rendu est joint au rapport sous la clé « reprojection ».
--      La contrainte de la colonne event est recréée avec « drift_reprojected » (même méthode que 20261117100100).
--
-- NON FAIT À CE LOT, conditions dans docs/runbooks/registre-des-pieces-r2b.md : retirer du contrôle les copies
-- (properties, auction_surfaces, judicial_sales), à faire quand l'étape PB de la collecte sera en production ;
-- index partiel de la liste de relecture, à décider sur la mesure A4 du runbook R2a.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.auction_sale_field_hold_events, à la première application seulement
-- (table vide en production : le contrôle de la contrainte est immédiat ; seuls la retenue et la projection y
-- écrivent, pour une vente du registre). lock_timeout ramené à 2 s pour cette instruction. Création d'une petite
-- table de réglage dans app_private. Aucun verrou sur auction_sales ni sur auction_fact_claims. Possible pendant
-- un import.
--
-- Retour arrière, par une nouvelle migration : refermer la relance
-- (select app_private.set_fact_registry_scheduled_reprojection(false)) suffit à en retirer l'effet. Pour revenir
-- aux définitions du lot R2a : rétablir public.sync_fact_registry_alerts() et
-- public.check_fact_registry_consistency(integer) de 20261117100500 (en supprimant la signature à deux
-- paramètres), puis supprimer app_private.reproject_drifted_sales(integer),
-- app_private.fact_registry_report_add_page(jsonb, jsonb), app_private.fact_registry_candidate_sales(),
-- app_private.set_fact_registry_scheduled_reprojection(boolean) et app_private.fact_registry_switches. La valeur
-- « drift_reprojected » reste admise par la contrainte (un journal en ajout seul ne perd pas une valeur écrite).

-- 1. Évènement drift_reprojected ---------------------------------------------------------------------------------
set local lock_timeout = '2s';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_sale_field_hold_events'::regclass
      and constraint_row.conname = 'auction_sale_field_hold_events_event_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%drift_reprojected%'
  ) then
    alter table public.auction_sale_field_hold_events
      drop constraint if exists auction_sale_field_hold_events_event_check;
    alter table public.auction_sale_field_hold_events
      add constraint auction_sale_field_hold_events_event_check check (
        event in (
          'listing_changed_kept', 'listing_changed_released', 'projection_held', 'projection_released',
          'projection_blocked', 'conflicted', 'echo_suppressed', 'drift_reprojected'
        )
      );
  end if;
end;
$$;

comment on table public.auction_sale_field_hold_events is
  'Registre des pièces : file de relecture en ajout seul des champs tenus (l''annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction, retour écarté d''une ancienne valeur tenue, projection réappliquée par la tâche planifiée). Valeurs de champs seulement (occupation : vacant, occupied ou rented) : ni extrait, ni email, ni nom.';

-- 2. Réglage de la relance planifiée ------------------------------------------------------------------------------
-- Même forme que app_private.security_switches (20261010002000) : une ligne par interrupteur, fermé par défaut,
-- changé par une fonction réservée à l'opérateur. Une ligne absente vaut « fermé ».
create table if not exists app_private.fact_registry_switches (
  switch_name text primary key check (switch_name = 'scheduled_reprojection'),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table app_private.fact_registry_switches is
  'Registre des pièces : interrupteurs d''exploitation. scheduled_reprojection : la tâche planifiée fact-registry-check réapplique la projection aux ventes en dérive (fermé par défaut).';

alter table app_private.fact_registry_switches enable row level security;
revoke all on table app_private.fact_registry_switches from public, anon, authenticated, service_role;

insert into app_private.fact_registry_switches (switch_name, enabled)
values ('scheduled_reprojection', false)
on conflict (switch_name) do nothing;

create or replace function app_private.set_fact_registry_scheduled_reprojection(p_enabled boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_enabled is null then
    raise exception using errcode = '22023', message = 'The switch is set to true or false.';
  end if;
  update app_private.fact_registry_switches
     set enabled = p_enabled,
         updated_at = pg_catalog.now(),
         updated_by = current_user
   where switch_name = 'scheduled_reprojection';
  return p_enabled;
end;
$$;

comment on function app_private.set_fact_registry_scheduled_reprojection(boolean) is
  'Registre des pièces : ouvre (true) ou referme (false) la relance planifiée de la projection. Réservée à l''opérateur (rôle de migration).';

revoke all on function app_private.set_fact_registry_scheduled_reprojection(boolean)
  from public, anon, authenticated, service_role;

-- 3. Ventes du registre ---------------------------------------------------------------------------------------------
-- Celles qui tiennent ou mémorisent un champ, et celles dont une pièce a pour dernière décision une acceptation
-- d'un lot identifié (rapportée à la vente conservée après une fusion). Une seule définition, pour le contrôle et
-- pour la relance.
create or replace function app_private.fact_registry_candidate_sales()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with accepted as (
    select distinct coalesce(merge.canonical_sale_id, latest.sale_id) as id
    from (
      select distinct on (decision.claim_id) decision.sale_id, decision.decision, decision.lot_attachment
      from public.auction_fact_claim_decisions decision
      order by decision.claim_id, decision.seq desc
    ) latest
    left join app_private.auction_sale_merges merge on merge.old_sale_id = latest.sale_id
    where latest.decision = 'accepted' and latest.lot_attachment in ('single_lot', 'matched')
  )
  select sale.id from public.auction_sales sale where sale.held_fields is not null
  union
  select sale.id from accepted join public.auction_sales sale on sale.id = accepted.id;
$$;

comment on function app_private.fact_registry_candidate_sales() is
  'Registre des pièces : ventes qui tiennent ou mémorisent un champ, ou dont une pièce a pour dernière décision une acceptation d''un lot identifié. Lecture seule.';

revoke all on function app_private.fact_registry_candidate_sales()
  from public, anon, authenticated, service_role;

-- 4. Contrôle quotidien, par page (définition de 20261117100500 ; seuls changent le choix des ventes examinées et
--    les clés « truncated » et « next_after » du rapport) -----------------------------------------------------------
drop function if exists public.check_fact_registry_consistency(integer);

create or replace function public.check_fact_registry_consistency(
  p_limit integer default 500,
  p_after uuid default null
)
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
  v_truncated boolean;
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
  -- Ventes examinées : une page des ventes du registre (app_private.fact_registry_candidate_sales), dans l'ordre
  -- de leur identifiant, après p_after. Une vente de plus que la borne est lue pour savoir s'il reste une page.
  select
    (select count(*)::integer from app_private.fact_registry_candidate_sales()),
    (select coalesce(pg_catalog.array_agg(bounded.id order by bounded.id), array[]::uuid[])
       from (
         select candidate.id
         from app_private.fact_registry_candidate_sales() candidate(id)
         where p_after is null or candidate.id > p_after
         order by candidate.id
         limit v_limit + 1
       ) bounded)
  into v_candidates, v_sale_ids;
  v_truncated := pg_catalog.cardinality(v_sale_ids) > v_limit;
  v_sale_ids := v_sale_ids[1:v_limit];

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
    'truncated', v_truncated,
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
  ) || case
    -- Page suivante : après la dernière vente de celle-ci. Clé absente quand il n'en reste pas.
    when v_truncated then
      pg_catalog.jsonb_build_object('next_after', v_sale_ids[pg_catalog.cardinality(v_sale_ids)])
    else '{}'::jsonb
  end;
end;
$$;

comment on function public.check_fact_registry_consistency(integer, uuid) is
  'Registre des pièces : contrôle quotidien en lecture seule (la projection n''y est appelée qu''en simulation), par page de ventes du registre (p_after : identifiant après lequel reprendre ; « next_after » rendu quand il reste une page). Rapport JSON de comptes et d''identifiants de vente, jamais une valeur. Serveur seul (service_role).';

revoke all on function public.check_fact_registry_consistency(integer, uuid) from public, anon, authenticated;
grant execute on function public.check_fact_registry_consistency(integer, uuid) to service_role;

-- 5. Addition de deux pages du rapport ------------------------------------------------------------------------------
-- Les contrôles par vente s'additionnent (compte, état, vingt premiers identifiants) ; les autres clés sont celles
-- de la première page (contrôles qui ne dépendent pas d'une vente, date, total des ventes du registre), sauf
-- « truncated » et « next_after », qui sont ceux de la dernière page lue.
create or replace function app_private.fact_registry_report_add_page(p_report jsonb, p_page jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_report || pg_catalog.jsonb_build_object(
    'sales_checked', (p_report ->> 'sales_checked')::integer + (p_page ->> 'sales_checked')::integer,
    'held_sale_count', (p_report ->> 'held_sale_count')::integer + (p_page ->> 'held_sale_count')::integer,
    'held_field_count', (p_report ->> 'held_field_count')::integer + (p_page ->> 'held_field_count')::integer,
    'truncated', p_page -> 'truncated',
    'next_after', p_page -> 'next_after',
    'checks', (p_report -> 'checks') || (
      select pg_catalog.jsonb_object_agg(
        paged.check_key,
        (p_report #> array['checks', paged.check_key]) || pg_catalog.jsonb_build_object(
          'active',
          (p_report #>> array['checks', paged.check_key, 'active'])::boolean
            or (p_page #>> array['checks', paged.check_key, 'active'])::boolean,
          'count',
          (p_report #>> array['checks', paged.check_key, 'count'])::integer
            + (p_page #>> array['checks', paged.check_key, 'count'])::integer,
          'sale_ids', (
            select coalesce(pg_catalog.jsonb_agg(listed.value order by listed.position), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(
              (p_report #> array['checks', paged.check_key, 'sale_ids'])
                || (p_page #> array['checks', paged.check_key, 'sale_ids'])
            ) with ordinality listed(value, position)
            where listed.position <= 20
          )
        )
      )
      from pg_catalog.unnest(array[
        'projection_drift', 'column_mismatch', 'echo_suspected', 'internal_column_copied', 'echo_blocked',
        'stale_listing'
      ]) paged(check_key)
    )
  );
$$;

comment on function app_private.fact_registry_report_add_page(jsonb, jsonb) is
  'Registre des pièces : additionne une page au rapport du contrôle quotidien (contrôles par vente additionnés, autres clés de la première page).';

revoke all on function app_private.fact_registry_report_add_page(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- 6. Relance planifiée de la projection -----------------------------------------------------------------------------
create or replace function app_private.reproject_drifted_sales(p_max integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_enabled boolean := coalesce(
    (select switch.enabled from app_private.fact_registry_switches switch
      where switch.switch_name = 'scheduled_reprojection'),
    false
  );
  v_max integer := greatest(coalesce(p_max, 0), 0);
  v_sale_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_drifted integer := 0;
  v_applied integer := 0;
  v_busy integer := 0;
  v_failed integer := 0;
  v_deferred integer := 0;
  v_events integer;
begin
  -- Fermée, journal des décisions vide, ou retenue hors service : rien n'est simulé ni écrit.
  if v_enabled
    and exists (select 1 from public.auction_fact_claim_decisions)
    and pg_catalog.cardinality(app_private.fact_registry_triggers_not_always()) = 0
  then
    for v_sale_id in
      select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id
    loop
      continue when not (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean;
      v_drifted := v_drifted + 1;
      -- Borne du passage ; et après trois ventes occupées par la collecte, le reste attend le passage suivant.
      if v_applied + v_busy + v_failed >= v_max or v_busy >= 3 then
        v_deferred := v_deferred + 1;
        continue;
      end if;
      -- Une vente par bloc : un verrou non obtenu ou une erreur n'annule que cette vente, et la passe continue. Le
      -- contrôle qui suit signale en dérive ce qui n'a pas été appliqué.
      begin
        continue when not app_private.lock_sale_for_registry(v_sale_id);
        select sale.held_fields into v_before from public.auction_sales sale where sale.id = v_sale_id;
        if (app_private.project_sale_fields(v_sale_id, null, true) ->> 'changed')::boolean then
          select sale.held_fields into v_after from public.auction_sales sale where sale.id = v_sale_id;
          -- Un évènement par champ dont l'entrée a changé ; à défaut (colonnes remises seules), par champ tenu.
          insert into public.auction_sale_field_hold_events (sale_id, field_key, event, held_value, decision_id)
          select v_sale_id, field.field_key, 'drift_reprojected',
            case when after_entry.value ->> 'state' in ('held', 'conflicted') then after_entry.value -> 'value' end,
            coalesce(after_entry.value ->> 'decision_id', before_entry.value ->> 'decision_id')::uuid
          from public.auction_fact_fields field
          left join lateral (select v_before -> field.field_key as value) before_entry on true
          left join lateral (select v_after -> field.field_key as value) after_entry on true
          where before_entry.value is distinct from after_entry.value;
          get diagnostics v_events = row_count;
          if v_events = 0 then
            insert into public.auction_sale_field_hold_events (sale_id, field_key, event, held_value, decision_id)
            select v_sale_id, entry.key, 'drift_reprojected', entry.value -> 'value',
              (entry.value ->> 'decision_id')::uuid
            from pg_catalog.jsonb_each(coalesce(v_after, '{}'::jsonb)) entry
            where entry.value ->> 'state' in ('held', 'conflicted');
          end if;
          v_applied := v_applied + 1;
        end if;
      exception
        when lock_not_available then
          v_busy := v_busy + 1;
        when others then
          v_failed := v_failed + 1;
      end;
    end loop;
  end if;

  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'max', v_max,
    'drifted', v_drifted,
    'applied', v_applied,
    'busy', v_busy,
    'failed', v_failed,
    'deferred', v_deferred
  );
end;
$$;

comment on function app_private.reproject_drifted_sales(integer) is
  'Registre des pièces : réapplique la projection aux ventes du registre dont la simulation rend « changed » (reclassement en terrain, nombre de chambres corrigé par la collecte), p_max ventes au plus par passage. Écriture de fiche lancée par la tâche planifiée fact-registry-check ; fermée par défaut (app_private.fact_registry_switches) ; n''écrit aucune décision. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.reproject_drifted_sales(integer)
  from public, anon, authenticated, service_role;

-- 7. La tâche quotidienne : relance, contrôle page par page, alertes -------------------------------------------------
create or replace function public.sync_fact_registry_alerts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reprojection jsonb := app_private.reproject_drifted_sales(50);
  v_report jsonb;
  v_page jsonb;
  v_after uuid;
  v_pages integer := 0;
begin
  loop
    v_page := public.check_fact_registry_consistency(500, v_after);
    v_report := case
      when v_report is null then v_page
      else app_private.fact_registry_report_add_page(v_report, v_page)
    end;
    v_pages := v_pages + 1;
    v_after := (v_page ->> 'next_after')::uuid;
    exit when v_after is null or v_pages >= 40;
  end loop;
  v_report := (v_report - 'next_after')
    || pg_catalog.jsonb_build_object('pages', v_pages, 'reprojection', v_reprojection);
  perform app_private.sync_fact_registry_alerts_from_report(v_report);
  return v_report;
end;
$$;

comment on function public.sync_fact_registry_alerts() is
  'Registre des pièces : tâche quotidienne. Réapplique d''abord la projection aux ventes en dérive si la relance planifiée est ouverte (fermée par défaut), lance le contrôle page par page, puis ouvre ou referme les alertes opérationnelles fact_registry.*. Sans paramètre : l''appelant ne choisit ni la borne, ni le rapport. Rend le rapport additionné ; s''il est tronqué, aucune alerte n''est refermée et la tâche doit échouer. Serveur seul (service_role).';

revoke all on function public.sync_fact_registry_alerts() from public, anon, authenticated;
grant execute on function public.sync_fact_registry_alerts() to service_role;

notify pgrst, 'reload schema';

commit;
