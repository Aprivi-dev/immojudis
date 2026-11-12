begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2b, étape B3 (plan du 11/11/2026, section 10 ; reports du lot R2a listés dans
-- docs/architecture/registre-des-pieces.md). INERTE : aucune vente ne tient de champ, le journal des décisions est
-- vide, et la relance planifiée est FERMÉE par défaut.
--
--   1. CONTRÔLE QUOTIDIEN PAR PAGES. Au lot R2a, public.check_fact_registry_consistency(p_limit) examinait au plus
--      500 ventes ; au-delà le rapport était tronqué et la tâche échouait chaque jour. Le contrôle est découpé :
--        * app_private.fact_registry_candidate_sales() : les ventes du registre, une seule définition ;
--        * app_private.fact_registry_page_checks(ventes) : les contrôles PAR VENTE d'une page (dérive de la
--          projection, colonnes tenues, valeur d'une pièce hors de ses colonnes, note de blocage, annonce qui se
--          tait). C'est elle qui appelle la projection, en simulation seulement ;
--        * app_private.fact_registry_global_checks(ventes) : ce qui ne dépend pas d'une page, calculé UNE fois
--          (déclencheurs, libellé réservé, file d'évènements, colonne interne recopiée dans raw_payload, pièces
--          reportées par une fusion sur 24 heures, relance planifiée ouverte). La lecture de raw_payload, la seule
--          qui touche une grande colonne, est bornée aux 500 premières ventes du registre ;
--        * app_private.fact_registry_report_add_page(rapport, page) : additionne une page. La liste des contrôles
--          par vente n'est écrite nulle part : ce sont ceux que rend la page.
--      public.check_fact_registry_consistency(p_limit) garde sa signature et son rapport du lot R2a (une page et
--      les contrôles généraux ; « truncated » au-delà de la borne) : c'est la lecture d'une personne.
--      public.sync_fact_registry_alerts(), sans paramètre comme avant, lit une fois les ventes du registre, enchaîne
--      les pages (500 ventes par page, 40 pages au plus), calcule une fois les contrôles généraux et tient les
--      alertes. Son rapport a la forme du lot R2a, avec « pages » en plus et « truncated » à false tant que le
--      registre compte moins de 20 000 ventes. Au-delà, le comportement du lot R2a est gardé : aucune alerte n'est
--      refermée, la tâche échoue.
--      Trois contrôles de plus (treize en tout) :
--        * « reprojection_enabled » : la relance planifiée est ouverte (avertissement tant qu'elle l'est) ;
--        * « final_decisions » : au moins une décision définitive (opposition, retrait pour autorisation retirée)
--          sur 24 heures. C'est un évènement rare, que personne ne peut défaire : avertissement, pour information ;
--        * « final_decisions_over_limit » : un auteur dépasse sur 24 heures le plafond des décisions définitives
--          (20261118100100). La fonction de décision l'interdit : critique.
--      Le rapport porte aussi l'état du réglage du second facteur des décisions
--      (« decisions_second_factor_required ») : sa levée doit se voir.
--      UNE VENTE DONT LA SIMULATION LÈVE (donnée abîmée) n'arrête pas le contrôle : elle est comptée en dérive, et
--      rendue avec son code SQLSTATE dans « simulation_failures » (vingt au plus) ; les contrôles par entrée ne la
--      lisent pas.
--      DÉRIVE DE MASSE : seules les vingt premières ventes en dérive d'une page sont rejouées (le rejeu sert à
--      écarter une décision validée pendant la passe) ; les suivantes sont comptées sans rejeu, pour tenir le
--      délai d'instruction.
--      Les deux fonctions appelées par la tâche portent un délai d'instruction (clause SET statement_timeout,
--      120 s) : PostgREST l'applique à la transaction de l'appel.
--   2. RELANCE PLANIFIÉE DE LA PROJECTION (arbitrage du 12/11/2026 sur la question laissée ouverte par le lot R2a).
--      La projection lit des colonnes que la retenue ne tient pas : un reclassement en terrain (property_type,
--      surface_scope, app_surface_kind) ou une écriture de bedrooms_count par la collecte change ce qu'elle
--      déciderait, et personne ne la rappelait. Deux relances, et aucun déclencheur :
--        * toute décision d'administrateur reprojette la vente entière (20261118100100) ;
--        * public.reproject_fact_registry_drift(), sans paramètre, réservée à service_role : pour chaque vente du
--          registre dont la simulation rend « changed », elle applique la projection. La tâche quotidienne
--          fact-registry-check l'appelle AVANT public.sync_fact_registry_alerts(), par un appel à part : la relance
--          a sa propre transaction, et ses verrous de ligne sont rendus avant que le contrôle ne commence.
--          C'EST UNE ÉCRITURE DE FICHE LANCÉE PAR UNE TÂCHE PLANIFIÉE. Elle ne fait que réappliquer des
--          décisions humaines déjà acceptées (aucune décision n'est écrite, le mode de publication reste
--          « manual », les verrous auto_locked ne bougent pas). Elle est :
--            - FERMÉE PAR DÉFAUT : réglage app_private.fact_registry_switches (20261118100100), ligne
--              « scheduled_reprojection », ouvert ou refermé sans migration de code par
--              select app_private.set_fact_registry_scheduled_reprojection(true ou false). Une ligne absente
--              vaut « fermé », et la fonction de réglage lève si la ligne manque ;
--            - sans effet tant que le journal des décisions est vide, et quand un déclencheur du registre manque ;
--            - en deux temps : toutes les ventes du registre sont d'abord simulées, sans aucun verrou ; les ventes
--              en dérive sont ensuite appliquées. Une vente écrite n'est donc tenue que le temps des écritures des
--              suivantes, plus pendant la simulation de tout le registre ;
--            - bornée : 30 ventes écrites ou occupées par passage (chaque vente est une sous-transaction) ; dès la
--              borne atteinte la passe s'arrête (« bounded » à true), et le passage suivant reprend (la tâche
--              enchaîne les passes tant qu'il reste du temps). Une vente occupée par un lot de la collecte (verrou non obtenu sous 3 secondes par attente
--              de verrou) est comptée (« busy ») ; après trois ventes occupées la passe s'arrête. Une vente dont
--              la simulation ou la projection échoue ne compte PAS dans la borne : elle ne prive pas les suivantes de leur tour.
--              Elle est comptée (« failed »), et les vingt premières sont rendues avec leur code SQLSTATE et le
--              nom de la contrainte, sans message ; le code part aussi au journal du serveur (RAISE LOG). Le
--              contrôle qui suit la signale en dérive ;
--            - journalisée : un évènement « drift_reprojected » par champ dont l'entrée a changé (à défaut, par
--              champ tenu), dans public.auction_sale_field_hold_events, distinct d'une décision et des évènements
--              de la projection elle-même.
--
-- NON FAIT À CE LOT, conditions dans docs/runbooks/registre-des-pieces-r2b.md : retirer du contrôle les copies
-- (properties, auction_surfaces, judicial_sales), à faire quand l'étape PB de la collecte sera en production ;
-- index partiel de la liste de relecture, à décider sur la mesure A4 du runbook R2a.
--
-- Verrous : création et remplacement de fonctions, une ligne de réglage. Aucun verrou sur auction_sales, sur
-- auction_fact_claims ni sur les journaux. Possible pendant un import.
--
-- Retour arrière, par une nouvelle migration : refermer la relance
-- (select app_private.set_fact_registry_scheduled_reprojection(false)) suffit à en retirer l'effet. Pour revenir
-- aux définitions du lot R2a : rétablir public.sync_fact_registry_alerts(),
-- app_private.sync_fact_registry_alerts_from_report(jsonb) et public.check_fact_registry_consistency(integer) de
-- 20261117100500, puis supprimer public.reproject_fact_registry_drift(),
-- app_private.fact_registry_report_add_page(jsonb, jsonb), app_private.fact_registry_global_checks(uuid[]),
-- app_private.fact_registry_page_checks(uuid[]), app_private.fact_registry_candidate_sales(),
-- app_private.fact_registry_failure(uuid, text, text), app_private.fact_registry_scheduled_reprojection_enabled()
-- et app_private.set_fact_registry_scheduled_reprojection(boolean). (L'alerte fact_registry.reprojection_enabled, si
-- elle a été ouverte, reste dans operational_alerts : ne pas la supprimer.)

-- 1. Réglage de la relance planifiée ------------------------------------------------------------------------------
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
  if not found then
    raise exception using errcode = '55000',
      message = 'The switch scheduled_reprojection has no row: restore it by a migration.';
  end if;
  return p_enabled;
end;
$$;

comment on function app_private.set_fact_registry_scheduled_reprojection(boolean) is
  'Registre des pièces : ouvre (true) ou referme (false) la relance planifiée de la projection. Réservée au propriétaire (rôle de migration). Lève si la ligne du réglage manque.';

revoke all on function app_private.set_fact_registry_scheduled_reprojection(boolean)
  from public, anon, authenticated, service_role;

-- La relance planifiée est-elle ouverte ? Ligne absente : fermée. Une seule lecture, pour la relance et pour le
-- contrôle quotidien.
create or replace function app_private.fact_registry_scheduled_reprojection_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select switch.enabled from app_private.fact_registry_switches switch
      where switch.switch_name = 'scheduled_reprojection'),
    false
  );
$$;

comment on function app_private.fact_registry_scheduled_reprojection_enabled() is
  'Registre des pièces : la relance planifiée de la projection est-elle ouverte (réglage scheduled_reprojection ; ligne absente = fermée) ? Seule lecture du réglage.';

revoke all on function app_private.fact_registry_scheduled_reprojection_enabled()
  from public, anon, authenticated, service_role;

-- Ce qui est rendu d'une vente dont la simulation ou la projection a levé : la vente, le code SQLSTATE, le nom de
-- la contrainte s'il y en a un. Jamais le message ni le détail de l'erreur.
create or replace function app_private.fact_registry_failure(p_sale_id uuid, p_sqlstate text, p_constraint text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'sale_id', p_sale_id, 'sqlstate', p_sqlstate, 'constraint', nullif(p_constraint, '')
  ));
$$;

revoke all on function app_private.fact_registry_failure(uuid, text, text)
  from public, anon, authenticated, service_role;

-- 2. Ventes du registre ---------------------------------------------------------------------------------------------
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
    select distinct app_private.fact_registry_kept_sale(latest.sale_id) as id
    from (
      select distinct on (decision.claim_id) decision.sale_id, decision.decision, decision.lot_attachment
      from public.auction_fact_claim_decisions decision
      order by decision.claim_id, decision.seq desc
    ) latest
    where latest.decision = 'accepted' and app_private.fact_lot_attachment_holds(latest.lot_attachment)
  )
  select sale.id from public.auction_sales sale where sale.held_fields is not null
  union
  select sale.id from accepted join public.auction_sales sale on sale.id = accepted.id;
$$;

comment on function app_private.fact_registry_candidate_sales() is
  'Registre des pièces : ventes qui tiennent ou mémorisent un champ, ou dont une pièce a pour dernière décision une acceptation d''un lot identifié. Lecture seule.';

revoke all on function app_private.fact_registry_candidate_sales()
  from public, anon, authenticated, service_role;

-- 3. Contrôles par vente, pour une page de ventes (requête du contrôle de 20261117100500, inchangée hormis le test
--    « vente de terrain », qui passe par app_private.sale_is_land_sale) ----------------------------------------------
create or replace function app_private.fact_registry_page_checks(p_sale_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_sale_ids uuid[] := coalesce(p_sale_ids, array[]::uuid[]);
  v_sale_id uuid;
  v_drift_first uuid[] := array[]::uuid[];
  v_drift uuid[] := array[]::uuid[];
  -- Ventes dont la simulation lève : comptées en dérive, rendues avec leur code, écartées des lectures par entrée.
  v_failed uuid[] := array[]::uuid[];
  v_failures jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_mismatch uuid[];
  v_echo uuid[];
  v_stale uuid[];
  v_blocked uuid[];
  v_held_sales integer;
  v_held_fields integer;
begin
  -- 1. La simulation de projection ne doit rien changer. La simulation lit sans verrou, en plusieurs
  --    instructions : une décision validée pendant la passe peut la faire rendre « changed » à tort. Les ventes
  --    en dérive sont donc rejouées une fois, et seules celles qui le sont encore sont rendues.
  --    Une vente dont la simulation lève (donnée abîmée) n'arrête pas le contrôle : elle est en dérive.
  foreach v_sale_id in array v_sale_ids loop
    begin
      if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
        v_drift_first := v_drift_first || v_sale_id;
      end if;
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      v_failed := v_failed || v_sale_id;
      if pg_catalog.cardinality(v_failed) <= 20 then
        v_failures := v_failures
          || pg_catalog.jsonb_build_array(app_private.fact_registry_failure(v_sale_id, v_sqlstate, null));
      end if;
    end;
  end loop;
  --    Dérive de masse : seules les vingt premières sont rejouées, les suivantes sont comptées telles quelles.
  foreach v_sale_id in array v_drift_first[1:20] loop
    begin
      if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
        v_drift := v_drift || v_sale_id;
      end if;
    exception when others then
      v_drift := v_drift || v_sale_id;
    end;
  end loop;
  select coalesce(pg_catalog.array_agg(drifting.id order by drifting.id), array[]::uuid[]) into v_drift
  from pg_catalog.unnest(v_drift || v_drift_first[21:] || v_failed) drifting(id);

  -- 2. Une lecture par entrée de held_fields, tenue ou libérée, sans ce qui est échu.
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
          and app_private.sale_is_land_sale(
            sale.property_type, sale.surface_scope, sale.app_surface_kind, sale.held_fields)
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
      and sale.id <> all(v_failed)
  ) checked;

  return pg_catalog.jsonb_build_object(
    'sales_checked', pg_catalog.cardinality(v_sale_ids),
    'simulation_failures', v_failures,
    'held_sale_count', v_held_sales,
    'held_field_count', v_held_fields,
    'checks', pg_catalog.jsonb_build_object(
      'projection_drift', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_drift) > 0,
        'count', pg_catalog.cardinality(v_drift),
        'sale_ids', pg_catalog.to_jsonb(v_drift[1:20])
      ),
      'column_mismatch', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_mismatch) > 0,
        'count', pg_catalog.cardinality(v_mismatch),
        'sale_ids', pg_catalog.to_jsonb(v_mismatch[1:20])
      ),
      'echo_suspected', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_echo) > 0,
        'count', pg_catalog.cardinality(v_echo),
        'sale_ids', pg_catalog.to_jsonb(v_echo[1:20])
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

comment on function app_private.fact_registry_page_checks(uuid[]) is
  'Registre des pièces : contrôles par vente du contrôle quotidien, pour une page de ventes (dérive de la projection, appelée en simulation seulement ; colonnes tenues ; valeur d''une pièce hors de ses colonnes ; note de blocage ; annonce qui se tait). Lecture seule.';

revoke all on function app_private.fact_registry_page_checks(uuid[])
  from public, anon, authenticated, service_role;

-- 4. Contrôles qui ne dépendent pas d'une page : calculés une fois ---------------------------------------------------
-- p_sale_ids : toutes les ventes du registre, dans l'ordre de leur identifiant. Seule la lecture de raw_payload
-- (grande colonne) s'en sert, et elle est bornée aux 500 premières.
create or replace function app_private.fact_registry_global_checks(p_sale_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_payload_ids uuid[] := (coalesce(p_sale_ids, array[]::uuid[]))[1:500];
  v_triggers text[] := app_private.fact_registry_triggers_not_always();
  v_copied uuid[];
  v_label uuid[];
  v_events_day integer;
  v_echo_events integer;
  v_echo_events_total integer;
  v_echo_event_sales uuid[];
  v_carried integer;
  v_reprojection_enabled boolean := app_private.fact_registry_scheduled_reprojection_enabled();
  v_final_limit integer := app_private.fact_registry_daily_final_decision_limit();
  v_final integer;
  v_final_over integer;
begin
  -- La colonne interne recopiée dans raw_payload (500 ventes au plus).
  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), array[]::uuid[]) into v_copied
  from public.auction_sales sale
  where sale.held_fields is not null and sale.id = any(v_payload_ids) and sale.raw_payload ? 'held_fields';

  -- Le libellé réservé du registre sur une surface que rien ne tient. Toutes les ventes sont lues (une
  --     lecture par jour d'une colonne courte) : une insertion directe échappe à la retenue, qui ne voit que les
  --     mises à jour.
  select coalesce(pg_catalog.array_agg(sale.id order by sale.id), array[]::uuid[]) into v_label
  from public.auction_sales sale
  where sale.surface_source = 'fact_registry'
    and not coalesce(sale.held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted'), false);

  -- La file de relecture. La rafale ne compte que ce qui vient d'une écriture directe (annonce qui
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

  -- Pièces reportées par une fusion sur 24 heures (information, pas une alerte).
  select count(*)::integer into v_carried
  from public.auction_sale_field_hold_events event
  where event.event = 'merge_carried' and event.created_at >= v_now - interval '24 hours';

  -- Décisions définitives sur 24 heures : leur nombre, et le nombre d'auteurs au-delà du plafond.
  select coalesce(sum(per_actor.decisions), 0)::integer,
    (count(*) filter (where per_actor.decisions > v_final_limit))::integer
  into v_final, v_final_over
  from (
    select count(*) as decisions
    from public.auction_fact_claim_decisions decision
    where app_private.fact_decision_is_final(decision.decision, decision.reason_code)
      and decision.decided_at > v_now - interval '24 hours'
    group by decision.actor_id
  ) per_actor;

  return pg_catalog.jsonb_build_object(
    'merge_carried', pg_catalog.jsonb_build_object('count', v_carried, 'window_hours', 24),
    'decisions_second_factor_required', app_private.fact_registry_decisions_second_factor_required(),
    'checks', pg_catalog.jsonb_build_object(
      'triggers_not_always', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_triggers) > 0,
        'count', pg_catalog.cardinality(v_triggers),
        'triggers', pg_catalog.to_jsonb(v_triggers)
      ),
      'registry_label', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_label) > 0,
        'count', pg_catalog.cardinality(v_label),
        'sale_ids', pg_catalog.to_jsonb(v_label[1:20])
      ),
      'internal_column_copied', pg_catalog.jsonb_build_object(
        'active', pg_catalog.cardinality(v_copied) > 0,
        'count', pg_catalog.cardinality(v_copied),
        'sales_read', pg_catalog.cardinality(v_payload_ids),
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
      'reprojection_enabled', pg_catalog.jsonb_build_object(
        'active', v_reprojection_enabled,
        'count', case when v_reprojection_enabled then 1 else 0 end
      ),
      'final_decisions', pg_catalog.jsonb_build_object(
        'active', v_final > 0,
        'count', v_final,
        'window_hours', 24
      ),
      'final_decisions_over_limit', pg_catalog.jsonb_build_object(
        'active', v_final_over > 0,
        'count', v_final_over,
        'limit', v_final_limit,
        'window_hours', 24
      )
    )
  );
end;
$$;

comment on function app_private.fact_registry_global_checks(uuid[]) is
  'Registre des pièces : contrôles du contrôle quotidien qui ne dépendent pas d''une page de ventes (déclencheurs, libellé réservé, colonne interne recopiée, file d''évènements, relance planifiée ouverte, décisions définitives sur 24 heures), compte des pièces reportées par une fusion sur 24 heures et état du réglage du second facteur. Lecture seule.';

revoke all on function app_private.fact_registry_global_checks(uuid[])
  from public, anon, authenticated, service_role;

-- 5. Addition d'une page au rapport -------------------------------------------------------------------------------------
-- Les trois comptes de ventes s'additionnent, et chaque contrôle que rend la page (compte, état, vingt premiers
-- identifiants). La liste des contrôles par vente n'est pas tenue ici : ce sont les clés de la page.
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
    'simulation_failures', (
      select coalesce(pg_catalog.jsonb_agg(listed.value order by listed.position), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(
        (p_report -> 'simulation_failures') || (p_page -> 'simulation_failures')
      ) with ordinality listed(value, position)
      where listed.position <= 20
    ),
    'checks', (p_report -> 'checks') || (
      select coalesce(
        pg_catalog.jsonb_object_agg(
          paged.key,
          (p_report #> array['checks', paged.key]) || pg_catalog.jsonb_build_object(
            'active',
            (p_report #>> array['checks', paged.key, 'active'])::boolean or (paged.value ->> 'active')::boolean,
            'count',
            (p_report #>> array['checks', paged.key, 'count'])::integer + (paged.value ->> 'count')::integer,
            'sale_ids', (
              select coalesce(pg_catalog.jsonb_agg(listed.value order by listed.position), '[]'::jsonb)
              from pg_catalog.jsonb_array_elements(
                (p_report #> array['checks', paged.key, 'sale_ids']) || (paged.value -> 'sale_ids')
              ) with ordinality listed(value, position)
              where listed.position <= 20
            )
          )
        ),
        '{}'::jsonb
      )
      from pg_catalog.jsonb_each(p_page -> 'checks') paged
    )
  );
$$;

comment on function app_private.fact_registry_report_add_page(jsonb, jsonb) is
  'Registre des pièces : additionne une page de contrôles par vente au rapport du contrôle quotidien.';

revoke all on function app_private.fact_registry_report_add_page(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- 6. Le contrôle, pour une personne : une page et les contrôles généraux (signature et rapport du lot R2a) ------------
create or replace function public.check_fact_registry_consistency(p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_all uuid[] := array(
    select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id
  );
  v_page jsonb := app_private.fact_registry_page_checks(v_all[1:v_limit]);
  v_global jsonb := app_private.fact_registry_global_checks(v_all);
begin
  return pg_catalog.jsonb_build_object(
      'checked_at', pg_catalog.statement_timestamp(),
      'limit', v_limit,
      'candidate_sales', pg_catalog.cardinality(v_all),
      'truncated', pg_catalog.cardinality(v_all) > v_limit
    )
    || (v_page - 'checks')
    || (v_global - 'checks')
    || pg_catalog.jsonb_build_object('checks', (v_global -> 'checks') || (v_page -> 'checks'));
end;
$$;

comment on function public.check_fact_registry_consistency(integer) is
  'Registre des pièces : contrôle quotidien en lecture seule (la projection n''y est appelée qu''en simulation), pour les p_limit premières ventes du registre. Rapport JSON de comptes et d''identifiants de vente, jamais une valeur. Serveur seul (service_role).';

revoke all on function public.check_fact_registry_consistency(integer) from public, anon, authenticated;
grant execute on function public.check_fact_registry_consistency(integer) to service_role;

-- 7. Relance planifiée de la projection -----------------------------------------------------------------------------
create or replace function public.reproject_fact_registry_drift()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
declare
  v_enabled boolean := app_private.fact_registry_scheduled_reprojection_enabled();
  -- Ventes écrites ou occupées par passage ; ventes occupées qui arrêtent la passe ; ventes en échec détaillées.
  v_max constant integer := 30;
  v_busy_max constant integer := 3;
  v_failures_listed constant integer := 20;
  v_sale_id uuid;
  v_drifting uuid[] := array[]::uuid[];
  v_before jsonb;
  v_after jsonb;
  v_applied integer := 0;
  v_busy integer := 0;
  v_failed integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_bounded boolean := false;
  v_events integer;
  v_sqlstate text;
  v_constraint text;
begin
  -- Fermée, journal des décisions vide, ou retenue hors service : rien n'est simulé ni écrit.
  if v_enabled
    and exists (select 1 from public.auction_fact_claim_decisions)
    and pg_catalog.cardinality(app_private.fact_registry_triggers_not_always()) = 0
  then
    -- 1. Simuler toutes les ventes du registre, SANS AUCUN VERROU. Une vente dont la simulation lève (donnée
    --    abîmée) est comptée en échec avec son code et n'arrête pas la passe.
    for v_sale_id in
      select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id
    loop
      begin
        if (app_private.project_sale_fields(v_sale_id, null, false) ->> 'changed')::boolean then
          v_drifting := v_drifting || v_sale_id;
        end if;
      exception when others then
        get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
        v_failed := v_failed + 1;
        if v_failed <= v_failures_listed then
          v_failures := v_failures || pg_catalog.jsonb_build_array(
            app_private.fact_registry_failure(v_sale_id, v_sqlstate, v_constraint));
        end if;
        raise log 'fact registry scheduled reprojection failed for one sale: sqlstate %', v_sqlstate;
      end;
    end loop;

    -- 2. Appliquer aux ventes en dérive. Les verrous de ligne ne sont pris qu'ici : une vente écrite n'est tenue
    --    que le temps des écritures suivantes, jamais pendant la simulation du registre.
    foreach v_sale_id in array v_drifting loop
      -- Borne atteinte : la passe s'arrête là ; le passage suivant reprend.
      if v_applied + v_busy >= v_max or v_busy >= v_busy_max then
        v_bounded := true;
        exit;
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
          -- Une vente en échec ne compte pas dans la borne : elle ne prive pas les suivantes de leur tour. Son
          -- code et le nom de la contrainte sont rendus et journalisés, jamais son message ni son détail.
          get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
          v_failed := v_failed + 1;
          if v_failed <= v_failures_listed then
            v_failures := v_failures || pg_catalog.jsonb_build_array(
              app_private.fact_registry_failure(v_sale_id, v_sqlstate, v_constraint));
          end if;
          raise log 'fact registry scheduled reprojection failed for one sale: sqlstate %', v_sqlstate;
      end;
    end loop;
  end if;

  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'max', v_max,
    'drifted', pg_catalog.cardinality(v_drifting),
    'applied', v_applied,
    'busy', v_busy,
    'failed', v_failed,
    'failures', v_failures,
    'bounded', v_bounded
  );
end;
$$;

comment on function public.reproject_fact_registry_drift() is
  'Registre des pièces : réapplique la projection aux ventes du registre dont la simulation rend « changed » (reclassement en terrain, nombre de chambres corrigé par la collecte), 30 ventes au plus par passage. Écriture de fiche lancée par la tâche planifiée fact-registry-check, dans sa propre transaction, avant le contrôle ; fermée par défaut (app_private.fact_registry_switches) ; n''écrit aucune décision. Sans paramètre. Serveur seul (service_role).';

revoke all on function public.reproject_fact_registry_drift() from public, anon, authenticated;
grant execute on function public.reproject_fact_registry_drift() to service_role;

-- 8. Alertes : treize contrôles (définition de 20261117100500, plus les trois de ce lot) -------------------------------
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
        ('stale_listing', 'warning'),
        ('reprojection_enabled', 'warning'),
        ('final_decisions', 'warning'),
        ('final_decisions_over_limit', 'critical')
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
  'Registre des pièces : ouvre ou referme les alertes opérationnelles fact_registry.* à partir d''un rapport du contrôle quotidien (clé, catégorie et gravité fixées ici ; treize contrôles). Rapport tronqué : seuls les contrôles actifs sont synchronisés. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.sync_fact_registry_alerts_from_report(jsonb)
  from public, anon, authenticated, service_role;

-- 9. La tâche quotidienne : contrôle page par page, contrôles généraux une fois, alertes ----------------------------
create or replace function public.sync_fact_registry_alerts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
declare
  v_page_size constant integer := 500;
  v_page_max constant integer := 40;
  -- Les ventes du registre, lues une seule fois.
  v_all uuid[] := array(
    select candidate.id from app_private.fact_registry_candidate_sales() candidate(id) order by candidate.id
  );
  v_total integer := pg_catalog.cardinality(v_all);
  v_global jsonb := app_private.fact_registry_global_checks(v_all);
  v_paged jsonb;
  v_page jsonb;
  v_pages integer := 0;
  v_report jsonb;
begin
  loop
    v_page := app_private.fact_registry_page_checks(
      v_all[v_pages * v_page_size + 1 : (v_pages + 1) * v_page_size]
    );
    v_paged := case
      when v_paged is null then v_page
      else app_private.fact_registry_report_add_page(v_paged, v_page)
    end;
    v_pages := v_pages + 1;
    exit when v_pages * v_page_size >= v_total or v_pages >= v_page_max;
  end loop;
  v_report := pg_catalog.jsonb_build_object(
      'checked_at', pg_catalog.statement_timestamp(),
      'limit', v_page_size,
      'pages', v_pages,
      'candidate_sales', v_total,
      'truncated', v_pages * v_page_size < v_total
    )
    || (v_paged - 'checks')
    || (v_global - 'checks')
    || pg_catalog.jsonb_build_object('checks', (v_global -> 'checks') || (v_paged -> 'checks'));
  perform app_private.sync_fact_registry_alerts_from_report(v_report);
  return v_report;
end;
$$;

comment on function public.sync_fact_registry_alerts() is
  'Registre des pièces : tâche quotidienne. Lit une fois les ventes du registre, lance les contrôles par vente page par page et les contrôles généraux une fois, puis ouvre ou referme les alertes opérationnelles fact_registry.*. Sans paramètre : l''appelant ne choisit ni la borne, ni le rapport. N''écrit aucune fiche (la relance planifiée est un appel à part). Rend le rapport additionné ; s''il est tronqué, aucune alerte n''est refermée et la tâche doit échouer. Serveur seul (service_role).';

revoke all on function public.sync_fact_registry_alerts() from public, anon, authenticated;
grant execute on function public.sync_fact_registry_alerts() to service_role;

notify pgrst, 'reload schema';

commit;
