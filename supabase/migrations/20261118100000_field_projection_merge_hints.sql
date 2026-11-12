begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2b, étape B0 (plan du 11/11/2026, section 10 ; annexe 08, point 6). INERTE : rien
-- n'appelle la projection avec un indice de fusion avant 20261118100200, et aucune vente ne tient de champ.
--
-- app_private.project_sale_fields est remplacée (même signature, mêmes droits). Seul le traitement de l'indice de
-- fusion (quatrième paramètre : les entrées held_fields de la vente absorbée) change ; sans indice, la projection
-- se comporte comme celle de 20261117100200.
--
-- 1. FUSION SANS GAGNANT. Une fusion écrit la vente conservée avant de supprimer l'absorbée : ses colonnes peuvent
--    déjà porter la valeur que tenait l'absorbée. Au lot R2a, l'indice ne servait que si une pièce prenait le champ.
--    Quand aucune ne le prend (pièce de l'absorbée délogée par l'annonce, contredite par une pièce de la vente
--    conservée, refusée par le nombre de chambres, ou vente de terrain), la valeur de la pièce restait dans la
--    colonne comme une valeur d'annonce, sans mémoire d'écho. Désormais, si l'absorbée tenait le champ, que la vente
--    conservée ne le tient pas et qu'une de ses colonnes de valeur porte la valeur ou un écho de l'indice :
--      * les colonnes du champ reprennent le bloc « listing » de l'indice (NULL si l'annonce ne disait rien) ;
--      * l'entrée devient « released », released_by « merge », avec « restored » (les valeurs rendues) ;
--      * la valeur que tenait l'absorbée entre en mémoire d'écho (7 jours ; sans échéance si sa pièce a reçu une
--        opposition ou un retrait pour autorisation retirée : la boucle des décisions l'inscrit ainsi) ;
--      * un évènement projection_released est journalisé pour la vente conservée.
--    Si aucune colonne ne porte la valeur de l'indice, rien n'est affirmé des colonnes : seule la mémoire est
--    reprise (entrée « released », released_by « merge », sans « restored »).
-- 2. MÉMOIRE DE L'INDICE, DANS TOUS LES CAS. La valeur que tenait l'absorbée entre en mémoire d'écho dès qu'elle
--    n'est pas celle qui tient le champ à l'issue de la passe (au lot R2a : seulement quand une pièce prenait le
--    champ). Un indice à l'état « released » n'apporte que sa mémoire d'écho, avec ses propres échéances.
-- 3. STABILITÉ. Une valeur déjà en mémoire n'est pas rajoutée : son échéance ne bouge pas. Rappeler la projection
--    avec le même indice rend « changed » à false (au lot R2a, chaque appel prolongeait l'échéance).
-- 4. CONTAMINATION JUGÉE À L'ÉGALITÉ EXACTE. « Une colonne porte déjà la valeur de la pièce » se juge sans tolérance :
--    une annonce à 53,5 m² n'est pas la pièce à 54 m² recopiée par la fusion, et la prendre pour telle remplacerait
--    une vraie valeur d'annonce par celle de la vente absorbée.
-- 5. VENTE DE TERRAIN, UNE SEULE DÉFINITION : app_private.sale_is_land_sale(type de bien, portée de la surface,
--    nature de la surface, held_fields), celle de l'annexe 08 (point 2) et de l'application (src/lib/surface.ts) :
--    property_type, surface_scope ou app_surface_kind vaut « land ». Au lot R2a la projection ne lisait pas la
--    nature de la surface, que la fonction de décision lisait : une maison dont l'annonce dit « terrain » pour la
--    nature était refusée à la décision et aurait été tenue par la projection. Quand la surface est tenue, la
--    projection a écrit « built » dans app_surface_kind : la nature lue est alors celle de l'annonce, gardée dans
--    le bloc « listing » de l'entrée. La projection reste donc stable d'un passage à l'autre. La fonction sert à
--    la projection, à la fonction de décision (20261118100100) et au contrôle quotidien (20261118100300).
-- 6. PIÈCE REPORTÉE PAR UNE FUSION : évènement « merge_carried ». Quand la projection pose sur une vente une pièce
--    dont la décision nomme une AUTRE vente (une vente absorbée), elle journalise, en plus de projection_held, un
--    évènement merge_carried : valeur posée, décision, et vente d'origine dans incoming_value
--    ({"from_sale_id": …}). Le contrôle quotidien les compte sur 24 heures.
--    La contrainte de la colonne event est recréée avec « merge_carried » et « drift_reprojected » (relance
--    planifiée, 20261118100300), par la méthode de 20261117100100.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.auction_sale_field_hold_events, à la première application seulement
-- (table vide en production : le contrôle de la contrainte est immédiat ; seuls la retenue et la projection y
-- écrivent, pour une vente du registre), sous un lock_timeout de 2 s. Puis remplacement de fonctions. Aucun verrou
-- sur auction_sales ni sur auction_fact_claims. Possible pendant un import.
--
-- Retour arrière, par une nouvelle migration : réappliquer la définition de app_private.project_sale_fields de
-- 20261117100200 (après le retour arrière de 20261118100200, qui est son seul appelant avec un indice), puis
-- supprimer app_private.sale_is_land_sale(text, text, text, jsonb). Les deux valeurs d'évènement restent admises
-- par la contrainte (un journal en ajout seul ne perd pas une valeur écrite).

-- Évènements merge_carried et drift_reprojected -----------------------------------------------------------------------
set local lock_timeout = '2s';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_sale_field_hold_events'::regclass
      and constraint_row.conname = 'auction_sale_field_hold_events_event_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%drift_reprojected%'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%merge_carried%'
  ) then
    alter table public.auction_sale_field_hold_events
      drop constraint if exists auction_sale_field_hold_events_event_check;
    alter table public.auction_sale_field_hold_events
      add constraint auction_sale_field_hold_events_event_check check (
        event in (
          'listing_changed_kept', 'listing_changed_released', 'projection_held', 'projection_released',
          'projection_blocked', 'conflicted', 'echo_suppressed', 'drift_reprojected', 'merge_carried'
        )
      );
  end if;
end;
$$;

comment on table public.auction_sale_field_hold_events is
  'Registre des pièces : file de relecture en ajout seul des champs tenus (l''annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction, retour écarté d''une ancienne valeur tenue, pièce reportée par une fusion, projection réappliquée par la tâche planifiée). Valeurs de champs seulement (occupation : vacant, occupied ou rented) : ni extrait, ni email, ni nom.';

-- Vente de terrain : une seule définition -----------------------------------------------------------------------------
create or replace function app_private.sale_is_land_sale(
  p_property_type text,
  p_surface_scope text,
  p_app_surface_kind text,
  p_held_fields jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_property_type = 'land'
      or p_surface_scope = 'land'
      or case
        -- Surface tenue : la colonne porte « built », écrit par la projection ; la nature de l'annonce est dans
        -- le bloc « listing » de l'entrée.
        when p_held_fields #>> '{property.surface_m2,state}' in ('held', 'conflicted')
          then p_held_fields #>> '{property.surface_m2,listing,app_surface_kind}'
        else p_app_surface_kind
      end = 'land',
    false
  );
$$;

comment on function app_private.sale_is_land_sale(text, text, text, jsonb) is
  'Registre des pièces : la vente est-elle un terrain (type de bien, portée ou nature de la surface à « land ») ? Quand la surface est tenue, la nature lue est celle de l''annonce (bloc listing de l''entrée). Seule définition, pour la décision, la projection et le contrôle quotidien.';

revoke all on function app_private.sale_is_land_sale(text, text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function app_private.project_sale_fields(
  p_sale_id uuid,
  p_fields text[] default null,
  p_apply boolean default false,
  p_listing_hints jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_memory interval := app_private.sale_field_echo_memory();
  v_sale record;
  v_sales uuid[];
  v_field public.auction_fact_fields%rowtype;
  v_candidate record;
  -- Le gagnant du champ en cours, en scalaires remis à zéro à chaque champ (jamais un enregistrement, qui ne se
  -- lit pas avant sa première affectation et garderait le gagnant du champ précédent).
  v_has_winner boolean;
  v_winner_claim_id uuid;
  v_winner_decision_id uuid;
  -- Vente que nomme la décision gagnante : une autre vente que celle-ci après une fusion.
  v_winner_sale_id uuid;
  v_winner_source_kind text;
  v_winner_rank smallint;
  v_winner_received_at timestamptz;
  v_winner_publication_mode text;
  v_winner_recipient_kind text;
  v_winner_confidence numeric;
  v_winner_value jsonb;
  v_origins text[];
  v_value jsonb;
  v_conflicting jsonb;
  v_invalid jsonb;
  v_conflict boolean;
  v_blocked jsonb;
  -- v_stored : l'entrée du champ, quel que soit son état ; v_current : la même, seulement si elle tient le champ.
  v_stored jsonb;
  v_current jsonb;
  v_current_still_accepted boolean;
  v_entry jsonb;
  v_echo jsonb;
  v_hint jsonb;
  v_hint_echo jsonb;
  -- Indice de fusion : v_hint_holds, la vente absorbée tenait le champ ; v_hint_listing, sa valeur d'annonce (colonnes
  -- du champ seulement) ; v_hint_contaminated, une colonne de valeur de cette vente porte déjà, exactement, la valeur
  -- ou un écho de l'indice (la fusion a écrit la vente conservée avant de supprimer l'absorbée) ; v_merge_release, le champ est
  -- libéré au nom de l'indice (aucune pièce ne le prend).
  v_hint_holds boolean;
  v_hint_listing jsonb;
  v_hint_contaminated boolean;
  v_merge_release boolean;
  v_element jsonb;
  -- Valeurs opposées du champ ({"seq":…,"value":…}), ajoutées à la mémoire de la plus ancienne à la plus récente.
  v_opposed jsonb;
  v_released_by text;
  v_listing jsonb;
  v_listing_value jsonb;
  v_neighbors jsonb;
  v_restored jsonb;
  v_incompatible boolean;
  -- Vente de terrain : la surface (bâtie) n'y est jamais tenue.
  v_land_sale boolean;
  v_land_block boolean;
  v_state text;
  v_holds boolean;
  v_old_held jsonb;
  v_base_held jsonb;
  v_new_held jsonb;
  v_result jsonb := '{}'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_event jsonb;
  v_changed boolean;
  t_surface_m2 numeric;
  t_app_surface_m2 numeric;
  t_app_surface_kind text;
  t_surface_source text;
  t_surface_confidence numeric;
  t_land_surface_m2 numeric;
  t_rooms_count integer;
  t_occupancy_status text;
  t_visit_dates jsonb;
begin
  if p_sale_id is null or p_apply is null then
    raise exception using errcode = '22023', message = 'A sale and an apply flag are required.';
  end if;
  if p_fields is not null and (
    cardinality(p_fields) = 0
    or array_position(p_fields, null) is not null
    or exists (
      select 1 from unnest(p_fields) requested(field_key)
      where not exists (
        select 1 from public.auction_fact_fields field where field.field_key = requested.field_key
      )
    )
  ) then
    raise exception using errcode = '22023', message = 'Unknown fact registry field.';
  end if;
  if p_listing_hints is not null and jsonb_typeof(p_listing_hints) <> 'object' then
    raise exception using errcode = '22023', message = 'Listing hints must be a JSON object.';
  end if;

  -- 1. La vente, verrouillée en écriture seulement (FOR NO KEY UPDATE : les clés étrangères qui la visent
  --    restent possibles). Jamais raw_payload.
  if p_apply then
    select sale.id, sale.held_fields, sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind,
      sale.surface_source, sale.surface_confidence, sale.habitable_surface_m2, sale.carrez_surface_m2,
      sale.land_surface_m2, sale.rooms_count, sale.bedrooms_count, sale.occupancy_status, sale.visit_dates,
      sale.property_type, sale.surface_scope
    into v_sale
    from public.auction_sales sale
    where sale.id = p_sale_id
    for no key update;
  else
    select sale.id, sale.held_fields, sale.surface_m2, sale.app_surface_m2, sale.app_surface_kind,
      sale.surface_source, sale.surface_confidence, sale.habitable_surface_m2, sale.carrez_surface_m2,
      sale.land_surface_m2, sale.rooms_count, sale.bedrooms_count, sale.occupancy_status, sale.visit_dates,
      sale.property_type, sale.surface_scope
    into v_sale
    from public.auction_sales sale
    where sale.id = p_sale_id;
  end if;
  if not found then
    raise exception using errcode = 'P0002', message = 'Auction sale not found.';
  end if;
  v_land_sale := app_private.sale_is_land_sale(
    v_sale.property_type, v_sale.surface_scope, v_sale.app_surface_kind, v_sale.held_fields
  );

  t_surface_m2 := v_sale.surface_m2;
  t_app_surface_m2 := v_sale.app_surface_m2;
  t_app_surface_kind := v_sale.app_surface_kind;
  t_surface_source := v_sale.surface_source;
  t_surface_confidence := v_sale.surface_confidence;
  t_land_surface_m2 := v_sale.land_surface_m2;
  t_rooms_count := v_sale.rooms_count;
  t_occupancy_status := v_sale.occupancy_status;
  t_visit_dates := v_sale.visit_dates;
  v_old_held := v_sale.held_fields;
  -- Ce qui est échu ne compte plus (valeurs d'écho, note de blocage ancienne). Son seul retrait n'est pas un
  -- changement : la projection ne réécrit pas une vente pour cela (la retenue le retire à la prochaine écriture
  -- d'une des colonnes qu'elle surveille) ; une projection qui écrit pour une autre raison écrit l'état élagué.
  v_base_held := app_private.sale_field_echo_prune(v_old_held, v_now);
  v_new_held := coalesce(v_base_held, '{}'::jsonb);

  -- 2. Ventes visées : la vente et celles qu'elle a absorbées par fusion. La table des fusions est tenue à plat
  --    (une fiche absorbée pointe toujours la fiche conservée finale) : un niveau suffit.
  select array_agg(visited.sale_id) into v_sales
  from (
    select p_sale_id as sale_id
    union
    select merge.old_sale_id
    from app_private.auction_sale_merges merge
    where merge.canonical_sale_id = p_sale_id
  ) visited;

  for v_field in
    select * from public.auction_fact_fields field
    where p_fields is null or field.field_key = any(p_fields)
    order by field.field_key
  loop
    v_has_winner := false;
    v_winner_claim_id := null;
    v_winner_decision_id := null;
    v_winner_sale_id := null;
    v_winner_source_kind := null;
    v_winner_rank := null;
    v_winner_received_at := null;
    v_winner_publication_mode := null;
    v_winner_recipient_kind := null;
    v_winner_confidence := null;
    v_winner_value := null;
    v_origins := array[]::text[];
    v_conflicting := '[]'::jsonb;
    v_invalid := '[]'::jsonb;
    v_blocked := null;
    v_listing_value := null;
    v_incompatible := false;
    v_opposed := '[]'::jsonb;
    v_land_block := false;
    v_stored := v_new_held -> v_field.field_key;
    v_current := case when v_stored ->> 'state' in ('held', 'conflicted') then v_stored end;
    v_current_still_accepted := false;
    v_echo := case
      when jsonb_typeof(v_stored -> 'echo') = 'array' then v_stored -> 'echo' else '[]'::jsonb
    end;

    -- Indice de fusion : la mémoire d'écho de la vente absorbée est reprise (valeurs non échues).
    v_hint := case
      when jsonb_typeof(p_listing_hints -> v_field.field_key) = 'object'
        then p_listing_hints -> v_field.field_key
    end;
    v_hint_echo := '[]'::jsonb;
    v_hint_holds := coalesce(v_hint ->> 'state' in ('held', 'conflicted'), false);
    v_hint_listing := null;
    v_hint_contaminated := false;
    v_merge_release := false;
    if v_hint is not null then
      v_hint_echo := coalesce(
        app_private.sale_field_echo_prune(
          jsonb_build_object('hint', jsonb_build_object('state', 'held', 'echo', v_hint -> 'echo')), v_now
        ) #> '{hint,echo}',
        '[]'::jsonb
      );
      -- De la plus ancienne à la plus récente, pour garder l'ordre de la liste.
      for v_element in
        select item.value
        from jsonb_array_elements(v_hint_echo) with ordinality item(value, position)
        order by item.position desc
      loop
        v_echo := app_private.sale_field_echo_add(
          v_echo, v_field.field_key, v_element -> 'value', (v_element ->> 'until')::timestamptz,
          v_field.abs_tolerance, v_field.rel_tolerance
        );
      end loop;
      if jsonb_typeof(v_hint -> 'listing') = 'object' then
        -- Seules les colonnes du champ sont reprises de l'indice.
        select coalesce(jsonb_object_agg(hinted.key, hinted.value), '{}'::jsonb) into v_hint_listing
        from jsonb_each(jsonb_strip_nulls(v_hint -> 'listing')) hinted
        where hinted.key = any(v_field.held_columns);
        v_hint_contaminated := exists (
          select 1
          from (
            select case v_field.field_key
              when 'property.surface_m2' then to_jsonb(v_sale.app_surface_m2)
              when 'property.land_surface_m2' then to_jsonb(v_sale.land_surface_m2)
              when 'property.rooms_count' then to_jsonb(v_sale.rooms_count)
              when 'property.occupancy_status' then to_jsonb(v_sale.occupancy_status)
              else v_sale.visit_dates
            end as value
            union all
            select to_jsonb(v_sale.surface_m2) where v_field.field_key = 'property.surface_m2'
          ) displayed
          -- Égalité exacte (tolérances nulles) : une valeur proche est une autre valeur d'annonce.
          where app_private.sale_field_incoming_class(
            v_field.field_key, displayed.value, v_hint -> 'value', null, v_hint_echo, 0, 0
          ) in ('held', 'echo')
        );
      end if;
    end if;

    -- 3. Candidats : dernière décision (seq) de chaque observation décidée pour ces ventes ; seulement une
    --    acceptation, d'un lot identifié, d'une origine qui peut tenir ce champ, si le champ est tenable, et que
    --    l'annonce n'a pas délogée depuis. L'ordre entre l'évènement et la décision est celui de la séquence
    --    commune aux deux journaux (jamais une date). Un évènement listing_changed_released de la vente de la
    --    décision l'écarte s'il la nomme ou la suit ; un évènement de la vente projetée (la vente conservée)
    --    écarte toute décision plus ancienne de l'ensemble, donc aussi celles d'une vente absorbée. La libération
    --    d'une vente absorbée ne déloge pas les pièces de la vente conservée. Il faut alors une nouvelle décision
    --    humaine.
    for v_candidate in
      with decided as (
        select distinct decision.claim_id
        from public.auction_fact_claim_decisions decision
        where decision.sale_id = any(v_sales) and decision.field_key = v_field.field_key
      ),
      latest as (
        select distinct on (decision.claim_id) decision.*
        from public.auction_fact_claim_decisions decision
        join decided on decided.claim_id = decision.claim_id
        order by decision.claim_id, decision.seq desc
      )
      select
        latest.id as decision_id,
        latest.sale_id as decision_sale_id,
        latest.claim_id,
        latest.decision,
        latest.reason_code,
        latest.lot_attachment,
        latest.received_at,
        latest.publication_mode,
        latest.recipient_kind,
        claim.value_jsonb,
        claim.confidence_score,
        origin.source_kind,
        precedence.rank,
        coalesce(precedence.can_hold, false) as can_hold,
        exists (
          select 1 from public.auction_sale_field_hold_events released
          where released.field_key = v_field.field_key
            and released.event = 'listing_changed_released'
            and (
              (released.sale_id = latest.sale_id
                and (released.decision_id = latest.id or released.seq > latest.seq))
              or (released.sale_id = p_sale_id and released.seq > latest.seq)
            )
        ) as dislodged,
        latest.seq,
        -- La pièce a-t-elle déjà tenu ce champ (pour une opposition prononcée après l'expiration de l'entrée) ?
        case
          when latest.decision in ('opposed', 'withdrawn') then exists (
            select 1
            from public.auction_sale_field_hold_events taken
            join public.auction_fact_claim_decisions prior on prior.id = taken.decision_id
            where taken.sale_id = any(v_sales)
              and taken.field_key = v_field.field_key
              and taken.event = 'projection_held'
              and prior.claim_id = latest.claim_id
          )
          else false
        end as was_held,
        case
          when origin.source_kind = 'admin' then 'admin'
          when jsonb_typeof(claim.evidence_locator -> 'case_id') = 'string'
            then 'case:' || (claim.evidence_locator ->> 'case_id')
          when claim.raw_artifact_id is not null then 'artifact:' || claim.raw_artifact_id::text
          when claim.source_url is not null then 'url:' || claim.source_url
          else 'claim:' || claim.id::text
        end as origin_key
      from latest
      join public.auction_fact_claims claim
        on claim.id = latest.claim_id and claim.field_key = latest.field_key
      cross join lateral (
        select app_private.fact_claim_source_kind(
          claim.evidence_kind, claim.extractor_name, claim.evidence_locator
        ) as source_kind
      ) origin
      left join public.auction_fact_source_precedence precedence
        on precedence.field_key = latest.field_key and precedence.source_kind = origin.source_kind
      order by precedence.rank, coalesce(latest.received_at, latest.decided_at) desc, latest.seq desc
    loop
      v_value := app_private.sale_field_claim_value(v_field.field_key, v_candidate.value_jsonb);
      -- Opposition, ou autorisation d'affichage retirée : la valeur entre en mémoire d'écho sans échéance dès que
      -- le champ a une entrée À L'ISSUE de cette passe (tenue ou libérée). « bound » : le champ avait déjà une
      -- entrée, ou cette pièce a déjà tenu le champ ; une telle valeur suffit à créer une entrée libérée, même
      -- après l'expiration de la précédente (une opposition bloque le retour pour la vie de la vente). La valeur
      -- d'une pièce jamais affichée ne crée pas d'entrée à elle seule. La décision ne se lit pas sur l'entrée
      -- d'avant la passe seule : la projection doit être stable en une application.
      if v_candidate.decision = 'opposed'
        or (v_candidate.decision = 'withdrawn' and v_candidate.reason_code = 'authorization_withdrawn')
      then
        if v_value is not null then
          v_opposed := v_opposed || jsonb_build_array(jsonb_build_object(
            'seq', v_candidate.seq, 'value', v_value, 'bound', v_stored is not null or v_candidate.was_held
          ));
        end if;
        continue;
      end if;
      continue when not (
        v_field.hold_enabled
        and v_candidate.decision = 'accepted'
        and v_candidate.lot_attachment in ('single_lot', 'matched')
        and v_candidate.can_hold
        and not v_candidate.dislodged
      );
      if v_value is null then
        -- Refusé à l'acceptation par le déclencheur de validation ; signalé si une ligne plus ancienne y échappe.
        v_invalid := v_invalid || jsonb_build_array(v_candidate.claim_id);
        continue;
      end if;
      if v_current ->> 'claim_id' = v_candidate.claim_id::text then
        v_current_still_accepted := true;
      end if;
      if not v_has_winner then
        v_has_winner := true;
        v_winner_claim_id := v_candidate.claim_id;
        v_winner_decision_id := v_candidate.decision_id;
        v_winner_sale_id := v_candidate.decision_sale_id;
        v_winner_source_kind := v_candidate.source_kind;
        v_winner_rank := v_candidate.rank;
        v_winner_received_at := v_candidate.received_at;
        v_winner_publication_mode := v_candidate.publication_mode;
        v_winner_recipient_kind := v_candidate.recipient_kind;
        v_winner_confidence := v_candidate.confidence_score;
        v_winner_value := v_value;
        v_origins := array[v_candidate.origin_key];
        continue;
      end if;
      -- 4. Un rang plus faible ne compte pas ; au même rang, une origine déjà vue est remplacée par sa pièce
      --    la plus récente ; une autre origine qui dit autre chose est une contradiction.
      continue when v_candidate.rank > v_winner_rank;
      continue when v_candidate.origin_key = any(v_origins);
      v_origins := v_origins || v_candidate.origin_key;
      if not app_private.sale_field_values_match(
        v_field.field_key, v_value, v_winner_value, v_field.abs_tolerance, v_field.rel_tolerance
      ) then
        v_conflicting := v_conflicting || jsonb_build_array(jsonb_build_object(
          'claim_id', v_candidate.claim_id, 'decision_id', v_candidate.decision_id, 'value', v_value
        ));
      end if;
    end loop;

    -- Les valeurs opposées entrent en mémoire de la plus ancienne décision à la plus récente : chaque valeur
    -- nouvelle entre en tête, la liste reste donc « la plus récente d'abord ». Les valeurs à échéance de cette
    -- projection (remplacement, libération) entrent après, en tête elles aussi.
    for v_element in
      select item.value
      from jsonb_array_elements(v_opposed) item(value)
      order by (item.value ->> 'seq')::bigint
    loop
      v_echo := app_private.sale_field_echo_add(
        v_echo, v_field.field_key, v_element -> 'value', null, v_field.abs_tolerance, v_field.rel_tolerance
      );
    end loop;

    v_conflict := jsonb_array_length(v_conflicting) > 0;
    if v_has_winner and v_land_sale and v_field.field_key = 'property.surface_m2' then
      -- Vente de terrain : la surface d'une pièce est une surface bâtie, que l'application afficherait comme
      -- celle du terrain. Elle n'est ni posée ni gardée, même si une pièce toujours acceptée tenait le champ
      -- avant le reclassement de la vente (blocage propre à ce champ). Une contradiction entre pièces n'a alors
      -- plus d'objet.
      v_land_block := true;
      v_conflict := false;
      v_conflicting := '[]'::jsonb;
      v_blocked := jsonb_build_object(
        'claim_id', v_winner_claim_id, 'decision_id', v_winner_decision_id, 'value', v_winner_value,
        'reason', 'land_sale'
      );
    elsif v_conflict then
      v_conflicting := jsonb_build_array(jsonb_build_object(
        'claim_id', v_winner_claim_id, 'decision_id', v_winner_decision_id, 'value', v_winner_value
      )) || v_conflicting;
    elsif v_has_winner
      and v_field.field_key = 'property.rooms_count'
      and v_sale.bedrooms_count is not null
      and (v_winner_value #>> '{}')::integer < v_sale.bedrooms_count
    then
      -- La fiche compte plus de chambres que la pièce ne compte de pièces : la table refuserait la ligne.
      v_blocked := jsonb_build_object(
        'claim_id', v_winner_claim_id, 'decision_id', v_winner_decision_id, 'value', v_winner_value,
        'bedrooms_count', v_sale.bedrooms_count
      );
    end if;

    -- FUSION SANS GAGNANT. La vente absorbée tenait le champ, cette vente ne le tient pas, aucune pièce ne le prend
    -- (pièce de l'absorbée délogée, contredite, refusée par la fiche, ou vente de terrain), et une colonne de valeur
    -- porte déjà la valeur que tenait l'absorbée : sans rien faire, la valeur d'une pièce resterait affichée comme
    -- une valeur d'annonce. Le champ est traité comme un champ que l'absorbée tenait ici : la valeur d'annonce de
    -- l'indice revient (étape 6), et la valeur tenue entre en mémoire d'écho.
    if v_current is null and v_hint_holds and v_hint_contaminated
      and (v_conflict or v_blocked is not null or not v_has_winner)
    then
      v_merge_release := true;
      v_current := jsonb_strip_nulls(jsonb_build_object(
        'value', v_hint -> 'value', 'listing', v_hint_listing, 'decision_id', v_hint -> 'decision_id',
        'claim_id', v_hint -> 'claim_id'
      ));
    end if;

    if (v_conflict or v_blocked is not null) and v_current is not null and v_current_still_accepted
      and not v_land_block
    then
      -- Contradiction, ou pièce que la fiche refuse, sur un champ tenu par une pièce toujours acceptée : rien ne
      -- bascule, la valeur affichée reste, relecture. (Pas sur une vente de terrain : la surface y est libérée.)
      if v_conflict then
        v_state := 'conflicted';
        v_new_held := jsonb_set(v_new_held, array[v_field.field_key, 'state'], to_jsonb('conflicted'::text));
      else
        v_state := 'blocked';
      end if;
    elsif not v_conflict and v_blocked is null and v_has_winner then
      -- 5. Pièce posée. Première prise : le bloc « listing » est l'instantané des colonnes actuelles (celles de
      --    l'annonce, puisque le champ n'était pas tenu), ou celui de l'indice de fusion quand une colonne porte
      --    déjà la valeur que tenait la vente absorbée ; champ déjà tenu : son bloc est repris.
      v_listing := v_current -> 'listing';
      if v_listing is null then
        v_listing := jsonb_strip_nulls(case v_field.field_key
          when 'property.surface_m2' then jsonb_build_object(
            'surface_m2', v_sale.surface_m2,
            'app_surface_m2', v_sale.app_surface_m2,
            'app_surface_kind', v_sale.app_surface_kind,
            'surface_source', v_sale.surface_source,
            'surface_confidence', v_sale.surface_confidence
          )
          when 'property.land_surface_m2' then jsonb_build_object('land_surface_m2', v_sale.land_surface_m2)
          when 'property.rooms_count' then jsonb_build_object('rooms_count', v_sale.rooms_count)
          when 'property.occupancy_status' then
            jsonb_build_object('occupancy_status', v_sale.occupancy_status)
          else jsonb_build_object('visit_dates', v_sale.visit_dates)
        end);
        if v_hint_contaminated then
          v_listing := v_hint_listing;
        end if;
      end if;
      -- Colonnes voisines à la première prise (celles de l'annonce : la retenue n'y laisse entrer ensuite ni la
      -- valeur tenue ni un écho). Une colonne voisine qui portait déjà la valeur de la pièce n'est pas un écho :
      -- la retenue et le contrôle quotidien l'exceptent. Terrain : les colonnes de la surface principale, ou
      -- leur valeur d'annonce si la surface est elle-même tenue.
      v_neighbors := coalesce(v_current -> 'neighbors', jsonb_strip_nulls(case v_field.field_key
        when 'property.surface_m2' then jsonb_build_object(
          'habitable_surface_m2', v_sale.habitable_surface_m2,
          'carrez_surface_m2', v_sale.carrez_surface_m2
        )
        when 'property.land_surface_m2' then
          case
            when v_new_held #>> '{property.surface_m2,state}' in ('held', 'conflicted') then jsonb_build_object(
              'app_surface_m2', v_new_held #> '{property.surface_m2,listing,app_surface_m2}',
              'surface_m2', v_new_held #> '{property.surface_m2,listing,surface_m2}'
            )
            else jsonb_build_object('app_surface_m2', v_sale.app_surface_m2, 'surface_m2', v_sale.surface_m2)
          end
        else '{}'::jsonb
      end));
      -- Remplacement : la valeur que le champ tenait entre en mémoire d'écho.
      if v_current is not null and not app_private.sale_field_values_match(
        v_field.field_key, v_current -> 'value', v_winner_value, v_field.abs_tolerance, v_field.rel_tolerance
      ) then
        v_echo := app_private.sale_field_echo_add(
          v_echo, v_field.field_key, v_current -> 'value', v_now + v_memory,
          v_field.abs_tolerance, v_field.rel_tolerance
        );
      end if;
      v_entry := jsonb_strip_nulls(jsonb_build_object(
        'v', 2,
        'value', v_winner_value,
        'state', 'held',
        'listing', v_listing,
        'neighbors', v_neighbors,
        'listing_silent_since', v_current -> 'listing_silent_since',
        'claim_id', v_winner_claim_id,
        'decision_id', v_winner_decision_id,
        'source_kind', v_winner_source_kind,
        'rank', v_winner_rank,
        'received_on', (v_winner_received_at at time zone 'Europe/Paris')::date,
        'publication_mode', v_winner_publication_mode,
        'recipient_kind', v_winner_recipient_kind,
        'tolerance', jsonb_build_object('abs', v_field.abs_tolerance, 'rel', v_field.rel_tolerance),
        'on_listing_change', v_field.on_listing_change
      ));
      -- Même pièce, même décision : seuls les réglages du champ (recopiés dans l'entrée), sa version, sa mémoire
      -- d'écho ou le relevé de ses colonnes voisines ont pu changer. L'entrée est mise à jour sans évènement.
      v_state := case
        when v_current is not null
          and (v_current - 'tolerance' - 'on_listing_change' - 'echo' - 'v' - 'neighbors')
            = (v_entry - 'tolerance' - 'on_listing_change' - 'echo' - 'v' - 'neighbors')
          then 'unchanged'
        else 'held'
      end;
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, v_entry);
      if v_field.field_key = 'property.surface_m2' then
        t_surface_m2 := (v_winner_value #>> '{}')::numeric;
        t_app_surface_m2 := (v_winner_value #>> '{}')::numeric;
        -- Valeurs neutres : ni l'origine de la pièce, ni une nature de surface que la pièce n'affirme pas.
        t_app_surface_kind := 'built';
        t_surface_source := 'fact_registry';
        -- Même plancher que le noyau de publication pour une valeur acceptée par une personne.
        t_surface_confidence := greatest(v_winner_confidence, 0.85);
      elsif v_field.field_key = 'property.land_surface_m2' then
        t_land_surface_m2 := (v_winner_value #>> '{}')::numeric;
      elsif v_field.field_key = 'property.rooms_count' then
        t_rooms_count := (v_winner_value #>> '{}')::integer;
      elsif v_field.field_key = 'property.occupancy_status' then
        t_occupancy_status := v_winner_value #>> '{}';
      else
        t_visit_dates := v_winner_value;
      end if;
      if v_state = 'held' then
        v_listing_value := case v_field.field_key
          when 'property.surface_m2' then coalesce(v_listing -> 'app_surface_m2', v_listing -> 'surface_m2')
          when 'property.land_surface_m2' then v_listing -> 'land_surface_m2'
          when 'property.rooms_count' then v_listing -> 'rooms_count'
          when 'property.occupancy_status' then
            app_private.sale_field_comparable(v_field.field_key, v_listing -> 'occupancy_status')
          else v_listing -> 'visit_dates'
        end;
        v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'field_key', v_field.field_key, 'event', 'projection_held', 'held_value', v_winner_value,
          'listing_value', v_listing_value, 'decision_id', v_winner_decision_id
        )));
        -- Pièce reportée par une fusion : sa décision nomme une vente absorbée.
        if v_winner_sale_id is distinct from p_sale_id then
          v_events := v_events || jsonb_build_array(jsonb_build_object(
            'field_key', v_field.field_key, 'event', 'merge_carried', 'held_value', v_winner_value,
            'incoming_value', jsonb_build_object('from_sale_id', v_winner_sale_id),
            'decision_id', v_winner_decision_id
          ));
        end if;
      end if;
    elsif v_current is not null then
      -- 6. La pièce qui tenait le champ n'est plus acceptée et aucune autre ne la remplace (plus de pièce, des
      --    pièces qui se contredisent, ou une pièce que la fiche refuse) : la valeur de l'annonce revient (NULL
      --    si l'annonce ne disait rien).
      v_state := case when v_conflict then 'conflicted' when v_blocked is not null then 'blocked' else 'released' end;
      v_listing := coalesce(v_current -> 'listing', '{}'::jsonb);
      if v_field.field_key = 'property.surface_m2' then
        t_surface_m2 := (v_listing ->> 'surface_m2')::numeric;
        t_app_surface_m2 := (v_listing ->> 'app_surface_m2')::numeric;
        t_app_surface_kind := v_listing ->> 'app_surface_kind';
        t_surface_source := v_listing ->> 'surface_source';
        t_surface_confidence := (v_listing ->> 'surface_confidence')::numeric;
        v_listing_value := coalesce(v_listing -> 'app_surface_m2', v_listing -> 'surface_m2');
      elsif v_field.field_key = 'property.land_surface_m2' then
        t_land_surface_m2 := (v_listing ->> 'land_surface_m2')::numeric;
        v_listing_value := v_listing -> 'land_surface_m2';
      elsif v_field.field_key = 'property.rooms_count' then
        t_rooms_count := (v_listing ->> 'rooms_count')::integer;
        v_listing_value := v_listing -> 'rooms_count';
        -- Un retrait ne peut pas échouer : une valeur d'annonce devenue incompatible avec les chambres de la
        -- fiche n'est pas restaurée.
        if t_rooms_count is not null and v_sale.bedrooms_count is not null
          and t_rooms_count < v_sale.bedrooms_count
        then
          t_rooms_count := null;
          v_incompatible := true;
        end if;
      elsif v_field.field_key = 'property.occupancy_status' then
        t_occupancy_status := v_listing ->> 'occupancy_status';
        v_listing_value := app_private.sale_field_comparable(
          v_field.field_key, v_listing -> 'occupancy_status');
      else
        t_visit_dates := v_listing -> 'visit_dates';
        v_listing_value := v_listing -> 'visit_dates';
      end if;
      -- L'entrée ne disparaît pas : elle garde en mémoire d'écho la valeur que la pièce tenait (7 jours, ou sans
      -- échéance si sa pièce a reçu une opposition : la boucle des décisions l'a déjà inscrite).
      v_echo := app_private.sale_field_echo_add(
        v_echo, v_field.field_key, v_current -> 'value', v_now + v_memory,
        v_field.abs_tolerance, v_field.rel_tolerance
      );
      select decision.decision into v_released_by
      from public.auction_fact_claim_decisions decision
      where decision.claim_id = (v_current ->> 'claim_id')::uuid
      order by decision.seq desc
      limit 1;
      -- « restored » : les valeurs rendues aux colonnes du champ, celles de l'annonce. Le contrôle quotidien les
      -- distingue ainsi d'une valeur de la mémoire revenue dans la colonne.
      v_restored := case v_field.field_key
        when 'property.surface_m2' then
          jsonb_build_object('surface_m2', t_surface_m2, 'app_surface_m2', t_app_surface_m2)
        when 'property.land_surface_m2' then jsonb_build_object('land_surface_m2', t_land_surface_m2)
        when 'property.rooms_count' then jsonb_build_object('rooms_count', t_rooms_count)
        when 'property.occupancy_status' then jsonb_build_object('occupancy_status', t_occupancy_status)
        else jsonb_build_object('visit_dates', t_visit_dates)
      end;
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
        'v', 2,
        'state', 'released',
        'released_by', case
          when v_merge_release then 'merge'
          when v_land_block then 'blocked'
          when v_released_by is null or v_released_by = 'accepted' then 'other'
          else v_released_by
        end,
        'decision_id', v_current -> 'decision_id',
        'tolerance', jsonb_build_object('abs', v_field.abs_tolerance, 'rel', v_field.rel_tolerance),
        'neighbors', coalesce(v_current -> 'neighbors', v_stored -> 'neighbors'),
        'restored', v_restored
      )));
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'projection_released', 'held_value', v_current -> 'value',
        'listing_value', v_listing_value,
        -- Valeur d'annonce non restaurée : le nombre de chambres de la fiche qui l'en empêche.
        'incoming_value', case when v_incompatible then
          jsonb_build_object('bedrooms_count', v_sale.bedrooms_count) end,
        'decision_id', v_current -> 'decision_id'
      )));
    elsif v_conflict then
      -- Contradiction sur un champ libre : il le reste.
      v_state := 'conflicted';
    elsif v_blocked is not null then
      v_state := 'blocked';
    else
      v_state := 'pass_through';
    end if;

    -- Fusion : la valeur que tenait la vente absorbée entre en mémoire d'écho, sauf si c'est celle qui tient
    -- désormais le champ. Une valeur déjà en mémoire n'est pas rajoutée : son échéance ne bouge pas, et rappeler la
    -- projection avec le même indice ne change rien.
    if v_hint_holds
      and not (
        coalesce(v_new_held #>> array[v_field.field_key, 'state'] in ('held', 'conflicted'), false)
        and app_private.sale_field_values_match(
          v_field.field_key, v_hint -> 'value', v_new_held #> array[v_field.field_key, 'value'],
          v_field.abs_tolerance, v_field.rel_tolerance
        )
      )
      and not app_private.sale_field_echo_matches(
        v_field.field_key, v_hint -> 'value', v_echo, v_field.abs_tolerance, v_field.rel_tolerance
      )
    then
      v_echo := app_private.sale_field_echo_add(
        v_echo, v_field.field_key, v_hint -> 'value', v_now + v_memory,
        v_field.abs_tolerance, v_field.rel_tolerance
      );
    end if;

    -- Mémoire d'écho. Un champ sans entrée n'en reçoit une (libérée) que par un indice de fusion, ou par
    -- l'opposition à une pièce qui a tenu le champ et dont l'entrée a expiré ; une entrée libérée sans mémoire
    -- disparaît. Opposition tardive : le champ est libre depuis l'expiration, ses colonnes sont donc celles de
    -- l'annonce (« restored »). Indice de fusion dont aucune colonne ne porte la valeur : rien n'est affirmé des
    -- colonnes.
    if not v_new_held ? v_field.field_key and jsonb_array_length(v_echo) > 0
      and (v_hint_holds or jsonb_array_length(v_hint_echo) > 0 or v_opposed @> '[{"bound": true}]'::jsonb)
    then
      v_new_held := v_new_held || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
        'v', 2,
        'state', 'released',
        'released_by', case
          when v_hint_holds or jsonb_array_length(v_hint_echo) > 0 then 'merge' else 'opposed'
        end,
        'tolerance', jsonb_build_object('abs', v_field.abs_tolerance, 'rel', v_field.rel_tolerance),
        'restored', case
          when v_hint_holds or jsonb_array_length(v_hint_echo) > 0 then null
          else case v_field.field_key
            when 'property.surface_m2' then
              jsonb_build_object('surface_m2', v_sale.surface_m2, 'app_surface_m2', v_sale.app_surface_m2)
            when 'property.land_surface_m2' then jsonb_build_object('land_surface_m2', v_sale.land_surface_m2)
            when 'property.rooms_count' then jsonb_build_object('rooms_count', v_sale.rooms_count)
            when 'property.occupancy_status' then
              jsonb_build_object('occupancy_status', v_sale.occupancy_status)
            else jsonb_build_object('visit_dates', v_sale.visit_dates)
          end
        end
      )));
    end if;
    if v_new_held ? v_field.field_key then
      if jsonb_array_length(v_echo) > 0 then
        v_new_held := jsonb_set(v_new_held, array[v_field.field_key, 'echo'], v_echo);
      elsif v_new_held #>> array[v_field.field_key, 'state'] = 'released' then
        v_new_held := v_new_held - v_field.field_key;
      else
        v_new_held := v_new_held #- array[v_field.field_key, 'echo'];
      end if;
    end if;
    v_holds := coalesce(v_new_held #>> array[v_field.field_key, 'state'] in ('held', 'conflicted'), false);

    if v_conflict then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'conflicted',
        'held_value', case when v_holds then v_new_held #> array[v_field.field_key, 'value'] end,
        'incoming_value', v_conflicting, 'decision_id', v_winner_decision_id
      )));
    elsif v_blocked is not null then
      v_events := v_events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'field_key', v_field.field_key, 'event', 'projection_blocked',
        'held_value', case when v_holds then v_new_held #> array[v_field.field_key, 'value'] end,
        'incoming_value', v_blocked - 'claim_id' - 'decision_id', 'decision_id', v_winner_decision_id
      )));
    end if;

    v_result := v_result || jsonb_build_object(v_field.field_key, jsonb_strip_nulls(jsonb_build_object(
      'state', v_state,
      -- Valeur tenue après la projection (absente si le champ n'est pas tenu).
      'value', case when v_holds then v_new_held #> array[v_field.field_key, 'value'] end,
      'claim_id', case when v_holds then v_new_held #> array[v_field.field_key, 'claim_id'] end,
      'decision_id', case when v_holds then v_new_held #> array[v_field.field_key, 'decision_id'] end,
      -- Valeur de l'annonce rendue aux colonnes quand le champ est libéré (absente si elle était incompatible
      -- avec les chambres de la fiche : NULL a été restauré).
      'released', case when v_current is not null and not v_holds then true end,
      'listing_value', case
        when v_current is not null and not v_holds and not v_incompatible then v_listing_value
      end,
      'listing_value_incompatible', case when v_incompatible then true end,
      'conflicting', case when v_conflict then v_conflicting end,
      'blocked', v_blocked,
      'invalid_claims', case when jsonb_array_length(v_invalid) > 0 then v_invalid end
    )));
  end loop;

  if v_new_held = '{}'::jsonb then
    v_new_held := null;
  end if;
  v_changed := v_new_held is distinct from v_base_held
    or t_surface_m2 is distinct from v_sale.surface_m2
    or t_app_surface_m2 is distinct from v_sale.app_surface_m2
    or t_app_surface_kind is distinct from v_sale.app_surface_kind
    or t_surface_source is distinct from v_sale.surface_source
    or t_surface_confidence is distinct from v_sale.surface_confidence
    or t_land_surface_m2 is distinct from v_sale.land_surface_m2
    or t_rooms_count is distinct from v_sale.rooms_count
    or t_occupancy_status is distinct from v_sale.occupancy_status
    or t_visit_dates is distinct from v_sale.visit_dates;

  if p_apply and v_changed then
    -- 7. Un seul UPDATE, identifié auprès du déclencheur de retenue par un réglage local à la transaction,
    --    remis à vide aussitôt après. updated_at avance toujours, même si l'horloge de l'instruction recule.
    perform pg_catalog.set_config('app.sale_field_projection', p_sale_id::text, true);
    update public.auction_sales sale set
      surface_m2 = t_surface_m2,
      app_surface_m2 = t_app_surface_m2,
      app_surface_kind = t_app_surface_kind,
      surface_source = t_surface_source,
      surface_confidence = t_surface_confidence,
      land_surface_m2 = t_land_surface_m2,
      rooms_count = t_rooms_count,
      occupancy_status = t_occupancy_status,
      visit_dates = t_visit_dates,
      held_fields = v_new_held,
      updated_at = greatest(pg_catalog.statement_timestamp(), sale.updated_at + interval '1 microsecond')
    where sale.id = p_sale_id;
    perform pg_catalog.set_config('app.sale_field_projection', '', true);
  end if;

  if p_apply then
    for v_event in select value from jsonb_array_elements(v_events) loop
      -- Une contradiction ou un refus déjà signalé à l'identique (dernier évènement du champ, dans l'ordre de
      -- seq) n'est pas rejournalisé.
      if v_event ->> 'event' in ('conflicted', 'projection_blocked') and exists (
        select 1
        from (
          select latest.event, latest.incoming_value
          from public.auction_sale_field_hold_events latest
          where latest.sale_id = p_sale_id and latest.field_key = v_event ->> 'field_key'
          order by latest.seq desc
          limit 1
        ) last_event
        where last_event.event = v_event ->> 'event'
          and last_event.incoming_value = v_event -> 'incoming_value'
      ) then
        continue;
      end if;
      insert into public.auction_sale_field_hold_events (
        sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id
      ) values (
        p_sale_id,
        v_event ->> 'field_key',
        v_event ->> 'event',
        v_event -> 'held_value',
        v_event -> 'listing_value',
        v_event -> 'incoming_value',
        (v_event ->> 'decision_id')::uuid
      );
    end loop;
  end if;

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'applied', p_apply,
    'changed', v_changed,
    'fields', v_result
  );
end;
$$;

comment on function app_private.project_sale_fields(uuid, text[], boolean, jsonb) is
  'Registre des pièces : seule écriture qui pose ou retire une pièce sur une fiche (colonnes tenues, held_fields, updated_at), à partir des acceptations du journal des décisions. p_apply = false : simulation sans verrou ni écriture. p_listing_hints : entrées held_fields d''une vente absorbée par fusion (valeur d''annonce et mémoire d''écho reprises, champ libéré si aucune pièce ne le prend). Exécutable par aucun rôle de l''API.';

revoke all on function app_private.project_sale_fields(uuid, text[], boolean, jsonb)
  from public, anon, authenticated, service_role;

commit;
