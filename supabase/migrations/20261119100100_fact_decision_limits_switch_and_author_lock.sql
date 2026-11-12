begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2c, étape C1 (décisions du propriétaire du 12/11/2026 ; contre-vérification 3 du lot
-- R2b). Les quatre fonctions de décision n'ont toujours AUCUN droit d'exécution après cette migration : ils
-- s'ouvrent à l'étape C4 (20261119100400).
--
--   1. PLAFONDS : UN TROISIÈME RÉGLAGE. Le propriétaire n'applique pour l'instant ni le plafond de 20 décisions
--      par heure ni celui de 5 décisions définitives par 24 heures. Le mécanisme reste : la table
--      app_private.fact_registry_switches reçoit la ligne « decision_rate_limits_enabled », posée ici à FALSE.
--      Comme pour les deux autres réglages, le défaut sûr est le plus strict : une ligne absente vaut « plafonds
--      appliqués » (app_private.fact_registry_decision_rate_limits_enabled(), seule lecture du réglage), et la
--      fonction de réglage app_private.set_fact_registry_decision_rate_limits(true ou false), réservée au
--      propriétaire de la base, lève si la ligne manque.
--   2. SECOND FACTEUR LEVÉ. Le propriétaire n'active pas la double authentification pour l'instant : le réglage
--      « decisions_require_second_factor » passe à FALSE, par sa fonction de réglage. Le mécanisme reste, et se
--      remet par select app_private.set_fact_registry_decisions_second_factor(true).
--      RISQUE ACCEPTÉ PAR LE PROPRIÉTAIRE : sans second facteur ni plafond, un mot de passe d'administrateur volé
--      permet un nombre illimité de décisions, dont des oppositions et des retraits définitifs. Les deux contrôles
--      quotidiens « final_decisions » et « final_decisions_over_limit » restent : ils informent, ils ne bloquent
--      pas.
--   3. FONCTION DE DÉCISION (définition de 20261118100100, reprise à l'identique hormis le point c) :
--        * les plafonds ne sont comptés que si le réglage les applique ; le verrou consultatif par auteur, qui
--          n'existe que pour rendre ce compte exact, n'est pris que dans ce cas ;
--        * ce verrou est pris dans son propre bloc : au-delà de 3 secondes d'attente, l'appelant reçoit 55P03
--          « decision_in_progress » (une autre décision du même administrateur est en cours), et non plus
--          « sale_busy », qui reste réservé au verrou de la vente ;
--        * l'heure du compte est lue une fois dans une variable, après le verrou : avec clock_timestamp() dans
--          la requête, l'index (actor_id, decided_at) ne servait pas la plage de dates.
--      ERREURS : la liste fermée de 20261118100100, plus 55P03 decision_in_progress.
--
-- Verrous : remplacement et création de fonctions ; une contrainte CHECK recréée sur la table de réglage
-- app_private.fact_registry_switches (ACCESS EXCLUSIVE bref sur cette table de trois lignes, que seuls la fonction
-- de décision, la relance et le contrôle lisent) ; deux écritures de ligne dans cette table. Aucun verrou sur
-- auction_sales, sur auction_fact_claims ni sur les journaux. Possible pendant un import.
--
-- Rejouée, cette migration remet le second facteur à FALSE : si le propriétaire l'a rétabli entre-temps, il le
-- rétablit de nouveau (une migration appliquée ne se rejoue pas en production).
--
-- Retour arrière : sans migration, par le propriétaire, pour revenir au plus strict :
--   select app_private.set_fact_registry_decisions_second_factor(true);
--   select app_private.set_fact_registry_decision_rate_limits(true);
-- Par une nouvelle migration, pour revenir aux définitions du lot R2b : rétablir
-- app_private.decide_auction_fact_claim de 20261118100100, puis supprimer
-- app_private.fact_registry_decision_rate_limits_enabled() et
-- app_private.set_fact_registry_decision_rate_limits(boolean) ; la ligne du réglage peut rester.

-- 1. Troisième réglage ---------------------------------------------------------------------------------------------
alter table app_private.fact_registry_switches
  drop constraint if exists fact_registry_switches_switch_name_check;
alter table app_private.fact_registry_switches
  add constraint fact_registry_switches_switch_name_check check (
    switch_name in ('decisions_require_second_factor', 'scheduled_reprojection', 'decision_rate_limits_enabled')
  );

comment on table app_private.fact_registry_switches is
  'Registre des pièces : interrupteurs d''exploitation, changés par le propriétaire sans migration de code. decisions_require_second_factor : une décision exige un jeton aal2 (ligne absente = exigé). scheduled_reprojection : la tâche planifiée fact-registry-check réapplique la projection aux ventes en dérive (ligne absente = fermé). decision_rate_limits_enabled : les plafonds de décisions par administrateur s''appliquent (ligne absente = appliqués).';

insert into app_private.fact_registry_switches (switch_name, enabled)
values ('decision_rate_limits_enabled', false)
on conflict (switch_name) do nothing;

create or replace function app_private.set_fact_registry_decision_rate_limits(p_enabled boolean)
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
   where switch_name = 'decision_rate_limits_enabled';
  if not found then
    raise exception using errcode = '55000',
      message = 'The switch decision_rate_limits_enabled has no row: restore it by a migration.';
  end if;
  return p_enabled;
end;
$$;

comment on function app_private.set_fact_registry_decision_rate_limits(boolean) is
  'Registre des pièces : applique (true) ou lève (false) les plafonds de décisions par administrateur (20 par heure, 5 définitives par 24 heures). Réservée au propriétaire (rôle de migration). Lève si la ligne du réglage manque.';

revoke all on function app_private.set_fact_registry_decision_rate_limits(boolean)
  from public, anon, authenticated, service_role;

-- Les plafonds s'appliquent-ils ? Ligne absente : appliqués. Une seule lecture, pour la fonction de décision et
-- pour le contrôle quotidien (qui rend l'état du réglage : sa levée doit se voir).
create or replace function app_private.fact_registry_decision_rate_limits_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select switch.enabled from app_private.fact_registry_switches switch
      where switch.switch_name = 'decision_rate_limits_enabled'),
    true
  );
$$;

comment on function app_private.fact_registry_decision_rate_limits_enabled() is
  'Registre des pièces : les plafonds de décisions par administrateur s''appliquent-ils (réglage decision_rate_limits_enabled ; ligne absente = appliqués) ? Seule lecture du réglage.';

revoke all on function app_private.fact_registry_decision_rate_limits_enabled()
  from public, anon, authenticated, service_role;

-- 2. Second facteur des décisions : levé par décision du propriétaire (12/11/2026) -----------------------------------
select app_private.set_fact_registry_decisions_second_factor(false);

-- 3. Écriture d'une décision (définition de 20261118100100, hormis le point c) ----------------------------------------
create or replace function app_private.decide_auction_fact_claim(
  p_claim_id uuid,
  p_decision text,
  p_reason_code text,
  p_lot_attachment text,
  p_lot_ref text,
  p_supersedes_decision_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  v_actor uuid := (select auth.uid());
  -- Refus de la liste fermée : le code est posé juste avant « raise », et relevé tel quel par le bloc d'erreur.
  v_refusal text;
  v_sqlstate text;
  v_constraint text;
  v_claim record;
  v_latest record;
  v_has_latest boolean;
  v_allowed boolean;
  v_decision_sale uuid;
  v_target uuid;
  v_locked_sale uuid;
  v_tracked boolean;
  v_source_kind text;
  v_land boolean;
  v_carries boolean;
  v_lot_attachment text;
  v_lot_ref text;
  v_attempt integer;
  v_decision_id uuid;
  v_projection jsonb;
  v_counted_at timestamptz;
begin
  if v_actor is null or not public.is_admin() then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  -- Second facteur du registre : exigé tant que le propriétaire ne l'a pas levé (ligne absente = exigé).
  if app_private.fact_registry_decisions_second_factor_required()
    and coalesce((select auth.jwt() ->> 'aal'), 'aal1') <> 'aal2'
  then
    raise exception using errcode = '42501', message = 'second_factor_required';
  end if;

  begin
    if p_claim_id is null
      or p_decision is null
      or p_decision not in ('accepted', 'rejected', 'withdrawn', 'opposed')
    then
      v_refusal := 'invalid_argument';
      raise exception 'refused';
    end if;

    -- b. Échec fermé : pas d'écriture du registre sans ses déclencheurs. Le détail (noms d'objets) n'est pas relayé.
    begin
      perform app_private.assert_fact_registry_triggers();
    exception when object_not_in_prerequisite_state then
      v_refusal := 'registry_unavailable';
      raise exception 'refused';
    end;

    -- c. Plafonds par administrateur, tant que le propriétaire ne les a pas levés (ligne de réglage absente =
    --    appliqués). Le verrou consultatif (de transaction, par auteur) fait passer l'une après l'autre les
    --    sessions d'un même administrateur : le compte est exact, même en rafale. Il est pris dans son propre bloc :
    --    une autre session du même auteur qui le tient plus de 3 secondes donne « decision_in_progress », et non
    --    « sale_busy » (la vente n'y est pour rien). L'heure du compte est lue une fois, après le verrou : une
    --    borne constante laisse l'index (actor_id, decided_at) servir la plage.
    if app_private.fact_registry_decision_rate_limits_enabled() then
      begin
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('immojudis:fact_registry_decisions:' || v_actor::text, 0)
        );
      exception when lock_not_available then
        v_refusal := 'decision_in_progress';
        raise exception 'refused';
      end;
      v_counted_at := pg_catalog.clock_timestamp();
      if (
        select count(*) from public.auction_fact_claim_decisions decision
        where decision.actor_id = v_actor
          and decision.decided_at > v_counted_at - interval '1 hour'
      ) >= app_private.fact_registry_hourly_decision_limit() then
        v_refusal := 'rate_limited';
        raise exception 'refused';
      end if;
      -- Décisions définitives : plafond propre, sur 24 heures.
      if app_private.fact_decision_is_final(p_decision, p_reason_code) and (
        select count(*) from public.auction_fact_claim_decisions decision
        where decision.actor_id = v_actor
          and app_private.fact_decision_is_final(decision.decision, decision.reason_code)
          and decision.decided_at > v_counted_at - interval '24 hours'
      ) >= app_private.fact_registry_daily_final_decision_limit() then
        v_refusal := 'final_rate_limited';
        raise exception 'refused';
      end if;
    end if;

    -- d. L'observation et sa vente, sans verrou.
    select claim.auction_sale_id, claim.field_key, claim.value_jsonb, claim.evidence_kind, claim.extractor_name,
      claim.evidence_locator
    into v_claim
    from public.auction_fact_claims claim
    where claim.id = p_claim_id;
    if not found then
      v_refusal := 'claim_not_found';
      raise exception 'refused';
    end if;
    v_decision_sale := coalesce(v_claim.auction_sale_id, (
      select decision.sale_id
      from public.auction_fact_claim_decisions decision
      where decision.claim_id = p_claim_id
      order by decision.seq desc
      limit 1
    ));
    if v_decision_sale is null then
      v_refusal := 'claim_detached';
      raise exception 'refused';
    end if;
    v_target := app_private.fact_registry_kept_sale(v_decision_sale);

    -- La vente d'abord, puis l'observation. Si l'une des deux a bougé entre la lecture et le verrou (fusion en
    -- cours), l'appelant réessaie.
    if not app_private.lock_sale_for_registry(v_target) then
      v_refusal := case
        when exists (
          select 1 from public.auction_fact_claims claim
          where claim.id = p_claim_id and claim.auction_sale_id is not distinct from v_claim.auction_sale_id
        ) and v_target is not distinct from app_private.fact_registry_kept_sale(v_decision_sale)
        then 'sale_not_found'
        else 'retry'
      end;
      raise exception 'refused';
    end if;
    select claim.auction_sale_id into v_locked_sale
    from public.auction_fact_claims claim
    where claim.id = p_claim_id
    for no key update;
    if not found or v_locked_sale is distinct from v_claim.auction_sale_id then
      v_refusal := 'retry';
      raise exception 'refused';
    end if;

    -- e. Transition, contre la dernière décision de l'observation (lue sous le verrou de la vente).
    select decision.id, decision.decision, decision.reason_code, decision.lot_attachment,
      decision.information_agent_fact_id, decision.recipient_kind, decision.received_at
    into v_latest
    from public.auction_fact_claim_decisions decision
    where decision.claim_id = p_claim_id
    order by decision.seq desc
    limit 1;
    v_has_latest := found;
    -- Après une décision définitive (opposition, autorisation d'affichage retirée) : plus jamais d'acceptation.
    if v_has_latest and p_decision = 'accepted'
      and app_private.fact_decision_is_final(v_latest.decision, v_latest.reason_code)
    then
      v_refusal := case when v_latest.decision = 'opposed' then 'opposed_final' else 'withdrawal_final' end;
      raise exception 'refused';
    end if;
    if v_has_latest and v_latest.decision = 'opposed' then
      v_refusal := 'invalid_transition';
      raise exception 'refused';
    end if;
    v_allowed := case p_decision
      when 'accepted' then
        (not v_has_latest and p_supersedes_decision_id is null)
        or (v_has_latest and p_supersedes_decision_id is not distinct from v_latest.id)
      when 'rejected' then not v_has_latest or v_latest.decision in ('accepted', 'contradicted')
      when 'withdrawn' then v_has_latest and v_latest.decision = 'accepted'
      else true
    end;
    if not v_allowed then
      v_refusal := 'invalid_transition';
      raise exception 'refused';
    end if;

    -- f. Refus propres à l'acceptation.
    if p_decision = 'accepted' then
      if p_lot_attachment is null then
        v_refusal := 'invalid_lot_attachment';
        raise exception 'refused';
      end if;
      v_tracked := exists (
        select 1 from public.auction_fact_fields field where field.field_key = v_claim.field_key
      );
      -- L'origine doit pouvoir tenir : ce champ s'il est du registre, au moins un champ sinon (décision
      -- enregistrée, non affichée). La table de préséance juge, aucune origine n'est nommée ici.
      v_source_kind := app_private.fact_claim_source_kind(
        v_claim.evidence_kind, v_claim.extractor_name, v_claim.evidence_locator
      );
      if v_source_kind is null or not exists (
        select 1 from public.auction_fact_source_precedence precedence
        where precedence.source_kind = v_source_kind
          and precedence.can_hold
          and (not v_tracked or precedence.field_key = v_claim.field_key)
      ) then
        v_refusal := 'origin_cannot_hold';
        raise exception 'refused';
      end if;
      if v_claim.field_key = 'property.surface_m2' then
        select app_private.sale_is_land_sale(
          sale.property_type, sale.surface_scope, sale.app_surface_kind, sale.held_fields
        ) into v_land
        from public.auction_sales sale
        where sale.id = v_target;
        if v_land then
          v_refusal := 'field_not_applicable';
          raise exception 'refused';
        end if;
      end if;
      if v_tracked and app_private.sale_field_claim_value(v_claim.field_key, v_claim.value_jsonb) is null then
        v_refusal := 'invalid_argument';
        raise exception 'refused';
      end if;
    end if;

    -- g. La décision. lot_ref : forme normalisée d'abord ; si la contrainte de format la refuse, NULL. La
    --    provenance de la dernière décision est reprise, sauf autour d'un retrait de l'autorisation d'affichage.
    v_lot_attachment := case
      when p_decision = 'accepted' then p_lot_attachment
      when v_has_latest then v_latest.lot_attachment
      else 'unknown'
    end;
    v_lot_ref := case when p_decision = 'accepted' then nullif(
      pg_catalog.btrim(pg_catalog.regexp_replace(
        pg_catalog.translate(p_lot_ref, pg_catalog.chr(160) || pg_catalog.chr(8239), '  '), ' +', ' ', 'g'
      ), ' '),
      ''
    ) end;
    v_carries := v_has_latest
      and p_reason_code is distinct from 'authorization_withdrawn'
      and v_latest.reason_code is distinct from 'authorization_withdrawn';
    for v_attempt in 1..2 loop
      begin
        insert into public.auction_fact_claim_decisions (
          claim_id, sale_id, field_key, decision, lot_attachment, lot_ref, actor_kind, actor_id, reason_code,
          information_agent_fact_id, recipient_kind, received_at, supersedes_decision_id
        ) values (
          p_claim_id, v_decision_sale, v_claim.field_key, p_decision, v_lot_attachment,
          case when v_attempt = 1 then v_lot_ref end, 'admin', v_actor, p_reason_code,
          case when v_carries then v_latest.information_agent_fact_id end,
          case when v_carries then v_latest.recipient_kind end,
          case when v_carries then v_latest.received_at end,
          p_supersedes_decision_id
        )
        returning id into v_decision_id;
        exit;
      exception when check_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_attempt = 2 or v_constraint is distinct from 'auction_fact_claim_decisions_lot_ref_check' then
          raise;
        end if;
      end;
    end loop;

    -- h. Projection de toute la vente, dans la même transaction.
    v_projection := app_private.project_sale_fields(v_target, null, true);
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
    if v_refusal is not null then
      raise exception using
        message = v_refusal,
        errcode = case
          when v_refusal in ('invalid_lot_attachment', 'invalid_argument') then '22023'
          when v_refusal in ('claim_not_found', 'sale_not_found') then 'P0002'
          when v_refusal = 'retry' then '40001'
          when v_refusal in ('rate_limited', 'final_rate_limited') then '53400'
          when v_refusal = 'decision_in_progress' then '55P03'
          else '55000'
        end;
    end if;
    if v_sqlstate = '55P03' then
      raise exception using errcode = '55P03', message = 'sale_busy';
    end if;
    if v_sqlstate in ('40001', '40P01') then
      raise exception using errcode = '40001', message = 'retry';
    end if;
    if v_sqlstate = '23514' and v_constraint = 'auction_fact_claim_decisions_reason_code_check' then
      raise exception using errcode = '22023', message = 'invalid_reason_code';
    end if;
    if v_sqlstate = '23514' and v_constraint = 'auction_fact_claim_decisions_lot_attachment_check' then
      raise exception using errcode = '22023', message = 'invalid_lot_attachment';
    end if;
    -- Erreur inattendue : son code et le nom de la contrainte vont au journal du serveur, rien d'autre.
    raise log 'fact registry decision failed: sqlstate %, constraint %',
      v_sqlstate, coalesce(nullif(v_constraint, ''), '-');
    raise exception using errcode = 'P0001', message = 'registry_write_failed';
  end;

  return pg_catalog.jsonb_build_object(
    'claim_id', p_claim_id,
    'decision_id', v_decision_id,
    'decision', p_decision,
    'sale_id', v_target,
    'field_key', v_claim.field_key,
    'state', v_projection #> array['fields', v_claim.field_key, 'state']
  );
end;
$$;

comment on function app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid) is
  'Registre des pièces : seule fonction qui écrit une décision d''administrateur (acceptée, rejetée, retirée, opposition). Auteur tiré de auth.uid(), jamais d''un paramètre ; public.is_admin() en tête, puis second facteur du registre s''il est exigé ; contrôle des déclencheurs ; plafonds par administrateur s''ils sont appliqués ; vente verrouillée d''abord ; transition contrôlée ; projection de toute la vente. Erreurs en liste fermée, sans détail. Appelée par les quatre fonctions publiques de décision seulement.';

revoke all on function app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
