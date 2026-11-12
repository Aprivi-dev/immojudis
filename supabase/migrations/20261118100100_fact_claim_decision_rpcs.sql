begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2b, étape B1 (plan du 11/11/2026, section 10 ; annexe 08, point 2). INERTE : les
-- quatre fonctions de décision existent SANS AUCUN DROIT D'EXÉCUTION (ni anon, ni authenticated, ni service_role).
-- Personne ne peut écrire une décision tant que le lot R2c n'a pas ouvert ces droits aux administrateurs.
--
--   0. RÉGLAGES DU REGISTRE. Table app_private.fact_registry_switches (même forme que
--      app_private.security_switches, 20261010002000), deux lignes possibles :
--        * decisions_require_second_factor, posée ici à TRUE : la fonction de décision refuse un jeton qui n'est
--          pas « aal2 » (42501 « second_factor_required »). Indépendant de l'interrupteur global
--          admin_mfa_required, que public.is_admin() lit de son côté. Le sens sûr est « exigé » : une ligne
--          absente vaut « exigé », et seul le propriétaire le lève, sans migration de code, par
--          select app_private.set_fact_registry_decisions_second_factor(false) ;
--        * scheduled_reprojection (20261118100300).
--      Les fonctions de réglage lèvent si leur ligne manque : un réglage ne se perd pas en silence.
--      app_private.fact_registry_hourly_decision_limit() : plafond de décisions par administrateur et par heure
--      (20), une seule constante.
--      PRÉSÉANCE : l'origine « document » passe à can_hold = false dans public.auction_fact_source_precedence.
--      Une pièce de document ne s'accepte pas avant le lot R3, qui la repassera à true par sa propre migration ;
--      la fonction de décision ne nomme aucune origine, elle lit cette table.
--   1. app_private.lock_sale_for_registry(vente) : le verrou de ligne de la vente (FOR NO KEY UPDATE), pris AVANT
--      toute autre écriture du registre. Le délai de 3 secondes est un réglage de la fonction elle-même (clause
--      SET) : PostgreSQL le pose à l'entrée et rend la valeur de l'appelant à la sortie, réussite ou échec. Un
--      lot de publication de la collecte tient ce verrou 20 à 29 secondes : au-delà de 3 secondes l'appelant
--      reçoit 55P03 « sale_busy » et réessaie. Rend false si la vente n'existe pas.
--   2. app_private.decide_auction_fact_claim(…) : la seule fonction qui écrit une décision. Toute la fonction
--      tourne sous lock_timeout = 3 s (clause SET) : verrou de la vente, verrou de l'observation, verrous de la
--      projection. Chaque attente de verrou est bornée à 3 secondes ; un verrou de ligne peut en compter deux
--      (la ligne, puis la transaction qui la tient). Dans l'ordre :
--        a. l'auteur est (select auth.uid()), JAMAIS un paramètre, et public.is_admin() doit être vrai, sinon
--           42501 « admin_required » ; puis le second facteur du registre (point 0) ;
--        b. app_private.assert_fact_registry_triggers() : sans retenue active, rien n'est écrit (55000
--           « registry_unavailable ») ;
--        c. plafond : 20 décisions par administrateur sur l'heure écoulée, sinon 53400 « rate_limited » ;
--        d. la vente de l'observation est lue sans verrou, puis verrouillée (1), puis l'observation est verrouillée
--           et relue : si elle a changé de vente entre-temps, 40001 « retry ». Une observation détachée par une
--           fusion se décide pour la vente que nomme sa dernière décision, et c'est la vente conservée
--           (app_private.auction_sale_merges) qui est verrouillée et projetée ; détachée et jamais décidée : 55000
--           « claim_detached » (la collecte la réémet pour la vente conservée) ;
--        e. la transition est contrôlée contre la DERNIÈRE décision de l'observation (ordre de seq) :
--             accepter   : aucune décision ; ou rejected, withdrawn, contradicted, accepted (correction du lot), en
--                          nommant cette décision dans p_supersedes_decision_id ; jamais après une opposition
--                          (« opposed_final ») ni après un retrait pour autorisation retirée
--                          (« withdrawal_final ») : ces deux décisions sont définitives, comme dans la projection,
--                          qui garde leur valeur en mémoire d'écho sans échéance ;
--             rejeter    : aucune, accepted, contradicted ;
--             retirer    : accepted ;
--             opposition : toute sauf opposed ;
--           sinon 55000 « invalid_transition » ;
--        f. refus propres à l'acceptation : origine qui ne peut pas tenir (55000 « origin_cannot_hold » : origine
--           non classée, ou can_hold à false dans la table de préséance pour ce champ ; pour un champ que le
--           registre ne tient pas, l'origine doit pouvoir tenir au moins un champ) ; property.surface_m2 sur une
--           vente de terrain (« field_not_applicable », app_private.sale_is_land_sale : un terrain se tient par
--           property.land_surface_m2) ; valeur que le registre ne peut pas tenir (22023 « invalid_argument ») ;
--        g. la décision est insérée (actor_kind « admin »). Pour rejeter, retirer ou s'opposer, lot_attachment
--           reprend celui de la dernière décision, sinon « unknown ». Le fait de l'agent, la nature du destinataire
--           et la date de réception de la dernière décision sont repris (une correction du lot ne fait pas tomber
--           la provenance), SAUF quand l'autorisation d'affichage est retirée : ni le retrait
--           authorization_withdrawn ni les décisions qui le suivent ne reprennent la provenance. lot_ref suit le
--           contrat de docs/architecture/registre-des-pieces.md : espaces insécables remplacées, suites d'espaces
--           réduites, bords retirés, puis NULL si le libellé ne passe pas la contrainte (jamais d'échec, jamais de
--           troncature) ;
--        h. la projection de TOUTE la vente est appliquée dans la même transaction : une décision relance donc
--           aussi les champs que la collecte a fait dériver (reclassement en terrain, nombre de chambres).
--      Les listes fermées (motifs, rattachements, format du lot, origines) ne sont pas recopiées ici : ce sont les
--      contraintes et les données de la table qui jugent, et la fonction traduit leur nom en code.
--      CHAMP QUE LE REGISTRE NE TIENT PAS (mise à prix, date de vente, type de bien) : la décision est ADMISE et
--      enregistrée, rien n'est affiché (« state » nul). C'est la règle écrite du plan (section 10, « choix faits
--      par délégation » : « enregistrés, non affichés ») et de l'annexe 08 (point 1, tableau des clés : observation
--      oui, décision accepted, projection non). La refuser ici empêcherait le noyau du lot R2c de l'appliquer.
--      ERREURS : liste fermée, message = code, sans DETAIL ni HINT. 42501 admin_required, second_factor_required ;
--      22023 invalid_reason_code, invalid_lot_attachment, invalid_argument ; P0002 claim_not_found,
--      sale_not_found ; 55000 invalid_transition, opposed_final, withdrawal_final, claim_detached,
--      origin_cannot_hold, field_not_applicable, registry_unavailable ; 53400 rate_limited ; 55P03 sale_busy ;
--      40001 retry ; P0001 registry_write_failed (toute autre erreur : la fonction ne lit que son code SQLSTATE et
--      le nom de la contrainte, jamais son message ni son détail, qui peuvent porter une ligne de auction_sales ;
--      ces deux éléments, et eux seuls, sont écrits au journal du serveur par RAISE LOG).
--      Le code « origin_not_open » de l'annexe 08 n'existe plus : l'origine « document » est fermée par la table
--      de préséance, comme toute autre origine qui ne tient pas.
--      Retour : claim_id, decision_id, decision, sale_id (la vente projetée), field_key, state (état du champ
--      rendu par la projection ; nul pour un champ que le registre ne tient pas). Aucune colonne de la vente.
--   3. Quatre fonctions publiques, qui fixent chacune le type de décision et n'ont AUCUN paramètre d'auteur :
--      public.accept_auction_fact_claim, reject_auction_fact_claim, withdraw_auction_fact_claim,
--      oppose_auction_fact_claim.
--   4. public.review_auction_fact_claim (20260928180000), retouchée : la vente est verrouillée AVANT l'observation
--      (même fonction de verrou, FOR NO KEY UPDATE, même délai, posé sur toute la fonction) ; la vente est lue par
--      colonnes nommées (plus de « sale.* », qui lisait raw_payload et held_fields) ; une observation d'origine
--      réservée (email ou formulaire d'un professionnel, saisie d'un administrateur), ou déjà décidée au journal
--      du registre, est refusée (55000). Signature, droits (service_role) et messages existants inchangés. Cette
--      fonction ne tient jamais un champ. EFFET VISIBLE DÈS L'APPLICATION : pendant un lot de publication qui
--      tient la vente, l'écran de relecture reçoit 55P03 au lieu d'attendre ; la route de l'application le
--      traduit en « Import en cours sur cette vente, réessayez dans une minute. ».
--
-- Publication automatique : rien ne change. Les contraintes auction_fact_claim_decisions_auto_locked et
-- auction_fact_claim_decisions_accepted_by_admin ne sont pas touchées, et ces fonctions n'écrivent que le mode
-- « manual » (valeur par défaut de la colonne).
--
-- Verrous : création et remplacement de fonctions, création d'une petite table de réglage dans app_private, une
-- mise à jour de cinq lignes de public.auction_fact_source_precedence (que seule la projection lit). Aucun verrou
-- sur auction_sales ni sur auction_fact_claims. Possible pendant un import.
--
-- Retour arrière, par une nouvelle migration (tant qu'aucun droit n'a été ouvert, sans effet) :
--   drop function if exists public.accept_auction_fact_claim(uuid, text, text, uuid);
--   drop function if exists public.reject_auction_fact_claim(uuid, text);
--   drop function if exists public.withdraw_auction_fact_claim(uuid, text);
--   drop function if exists public.oppose_auction_fact_claim(uuid, text);
--   drop function if exists app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid);
--   -- rétablir public.review_auction_fact_claim de 20260928180000, puis (après le retour arrière de
--   -- 20261118100300, qui appelle la fonction de verrou et lit la table de réglage) :
--   drop function if exists app_private.lock_sale_for_registry(uuid);
--   drop function if exists app_private.fact_registry_hourly_decision_limit();
--   drop function if exists app_private.set_fact_registry_decisions_second_factor(boolean);
--   drop table if exists app_private.fact_registry_switches;
--   update public.auction_fact_source_precedence set can_hold = true where source_kind = 'document';

-- 0. Réglages du registre -------------------------------------------------------------------------------------------
create table if not exists app_private.fact_registry_switches (
  switch_name text primary key check (
    switch_name in ('decisions_require_second_factor', 'scheduled_reprojection')
  ),
  -- Pas de valeur par défaut : chaque ligne est posée par sa migration, dans son sens sûr.
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table app_private.fact_registry_switches is
  'Registre des pièces : interrupteurs d''exploitation, changés par le propriétaire sans migration de code. decisions_require_second_factor : une décision exige un jeton aal2 (vrai par défaut ; ligne absente = exigé). scheduled_reprojection : la tâche planifiée fact-registry-check réapplique la projection aux ventes en dérive (faux par défaut ; ligne absente = fermé).';

alter table app_private.fact_registry_switches enable row level security;
revoke all on table app_private.fact_registry_switches from public, anon, authenticated, service_role;

insert into app_private.fact_registry_switches (switch_name, enabled)
values ('decisions_require_second_factor', true)
on conflict (switch_name) do nothing;

create or replace function app_private.set_fact_registry_decisions_second_factor(p_required boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_required is null then
    raise exception using errcode = '22023', message = 'The switch is set to true or false.';
  end if;
  update app_private.fact_registry_switches
     set enabled = p_required,
         updated_at = pg_catalog.now(),
         updated_by = current_user
   where switch_name = 'decisions_require_second_factor';
  if not found then
    raise exception using errcode = '55000',
      message = 'The switch decisions_require_second_factor has no row: restore it by a migration.';
  end if;
  return p_required;
end;
$$;

comment on function app_private.set_fact_registry_decisions_second_factor(boolean) is
  'Registre des pièces : exige (true) ou lève (false) le second facteur pour les décisions du registre. Réservée au propriétaire (rôle de migration). Lève si la ligne du réglage manque.';

revoke all on function app_private.set_fact_registry_decisions_second_factor(boolean)
  from public, anon, authenticated, service_role;

-- Plafond de décisions par administrateur et par heure. Une seule constante.
create or replace function app_private.fact_registry_hourly_decision_limit()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 20;
$$;

revoke all on function app_private.fact_registry_hourly_decision_limit()
  from public, anon, authenticated, service_role;

-- Une pièce de document ne s'accepte pas avant le lot R3 : la préséance le dit, la décision la lit.
update public.auction_fact_source_precedence
   set can_hold = false
 where source_kind = 'document' and can_hold;

-- 1. Verrou de la vente -------------------------------------------------------------------------------------------
create or replace function app_private.lock_sale_for_registry(p_sale_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
set lock_timeout = '3s'
as $$
begin
  perform 1 from public.auction_sales sale where sale.id = p_sale_id for no key update;
  return found;
exception when lock_not_available then
  raise exception using errcode = '55P03', message = 'sale_busy';
end;
$$;

comment on function app_private.lock_sale_for_registry(uuid) is
  'Registre des pièces : verrouille la ligne de la vente (FOR NO KEY UPDATE) avant toute écriture du registre, sous un délai de 3 secondes posé par la fonction elle-même ; 55P03 « sale_busy » au-delà. Rend false si la vente n''existe pas.';

revoke all on function app_private.lock_sale_for_registry(uuid)
  from public, anon, authenticated, service_role;

-- 2. Écriture d'une décision --------------------------------------------------------------------------------------
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
begin
  if v_actor is null or not public.is_admin() then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  -- Second facteur du registre : exigé tant que le propriétaire ne l'a pas levé (ligne absente = exigé).
  if coalesce(
      (select switch.enabled from app_private.fact_registry_switches switch
        where switch.switch_name = 'decisions_require_second_factor'),
      true
    )
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

    -- c. Plafond par administrateur, sur l'heure écoulée.
    if (
      select count(*) from public.auction_fact_claim_decisions decision
      where decision.actor_id = v_actor
        and decision.decided_at > pg_catalog.clock_timestamp() - interval '1 hour'
    ) >= app_private.fact_registry_hourly_decision_limit() then
      v_refusal := 'rate_limited';
      raise exception 'refused';
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
    v_target := coalesce(
      (select merge.canonical_sale_id from app_private.auction_sale_merges merge
        where merge.old_sale_id = v_decision_sale),
      v_decision_sale
    );

    -- La vente d'abord, puis l'observation. Si l'une des deux a bougé entre la lecture et le verrou (fusion en
    -- cours), l'appelant réessaie.
    if not app_private.lock_sale_for_registry(v_target) then
      v_refusal := case
        when exists (
          select 1 from public.auction_fact_claims claim
          where claim.id = p_claim_id and claim.auction_sale_id is not distinct from v_claim.auction_sale_id
        ) and v_target is not distinct from coalesce(
          (select merge.canonical_sale_id from app_private.auction_sale_merges merge
            where merge.old_sale_id = v_decision_sale),
          v_decision_sale
        ) then 'sale_not_found'
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
    if v_has_latest and v_latest.decision = 'opposed' then
      v_refusal := case when p_decision = 'accepted' then 'opposed_final' else 'invalid_transition' end;
      raise exception 'refused';
    end if;
    -- Autorisation d'affichage retirée : définitif, comme une opposition.
    if v_has_latest and p_decision = 'accepted'
      and v_latest.decision = 'withdrawn' and v_latest.reason_code = 'authorization_withdrawn'
    then
      v_refusal := 'withdrawal_final';
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
          when v_refusal = 'rate_limited' then '53400'
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
  'Registre des pièces : seule fonction qui écrit une décision d''administrateur (acceptée, rejetée, retirée, opposition). Auteur tiré de auth.uid(), jamais d''un paramètre ; public.is_admin() en tête, puis second facteur du registre ; contrôle des déclencheurs ; plafond horaire ; vente verrouillée d''abord ; transition contrôlée ; projection de toute la vente. Erreurs en liste fermée, sans détail. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.decide_auction_fact_claim(uuid, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;

-- 3. Les quatre fonctions publiques. Chacune fixe le type de décision ; aucune n'a de paramètre d'auteur. Aucun
--    droit d'exécution à ce lot.
create or replace function public.accept_auction_fact_claim(
  p_claim_id uuid,
  p_lot_attachment text,
  p_lot_ref text default null,
  p_supersedes_decision_id uuid default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select app_private.decide_auction_fact_claim(
    p_claim_id, 'accepted', null, p_lot_attachment, p_lot_ref, p_supersedes_decision_id
  );
$$;

create or replace function public.reject_auction_fact_claim(p_claim_id uuid, p_reason_code text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select app_private.decide_auction_fact_claim(p_claim_id, 'rejected', p_reason_code, null, null, null);
$$;

create or replace function public.withdraw_auction_fact_claim(p_claim_id uuid, p_reason_code text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select app_private.decide_auction_fact_claim(p_claim_id, 'withdrawn', p_reason_code, null, null, null);
$$;

create or replace function public.oppose_auction_fact_claim(
  p_claim_id uuid,
  p_reason_code text default 'professional_opposition'
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select app_private.decide_auction_fact_claim(p_claim_id, 'opposed', p_reason_code, null, null, null);
$$;

comment on function public.accept_auction_fact_claim(uuid, text, text, uuid) is
  'Registre des pièces : un administrateur accepte une observation (rattachement au lot obligatoire ; une nouvelle acceptation nomme la décision qu''elle remplace). L''auteur est celui du jeton. Aucun droit d''exécution avant le lot R2c.';
comment on function public.reject_auction_fact_claim(uuid, text) is
  'Registre des pièces : un administrateur rejette une observation (motif d''une liste fermée). L''auteur est celui du jeton. Aucun droit d''exécution avant le lot R2c.';
comment on function public.withdraw_auction_fact_claim(uuid, text) is
  'Registre des pièces : un administrateur retire une observation acceptée (motif d''une liste fermée) ; la valeur de l''annonce revient. L''auteur est celui du jeton. Aucun droit d''exécution avant le lot R2c.';
comment on function public.oppose_auction_fact_claim(uuid, text) is
  'Registre des pièces : un administrateur enregistre l''opposition d''un professionnel à l''affichage d''une observation ; elle ne peut plus être acceptée. L''auteur est celui du jeton. Aucun droit d''exécution avant le lot R2c.';

revoke all on function public.accept_auction_fact_claim(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.reject_auction_fact_claim(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.withdraw_auction_fact_claim(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.oppose_auction_fact_claim(uuid, text)
  from public, anon, authenticated, service_role;

-- 4. Relecture des observations de la collecte (définition de 20260928180000, retouchée) -----------------------------
create or replace function public.review_auction_fact_claim(
  p_reviewer_id uuid,
  p_claim_id uuid,
  p_decision text,
  p_resolution_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '3s'
as $function$
declare
  v_claim public.auction_fact_claims%rowtype;
  v_seen record;
  v_sale record;
  v_canonical_match boolean := false;
  v_scalar text;
  v_conflict_group text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_decision not in ('accepted', 'rejected', 'conflicted') then
    raise exception using
      errcode = '22023',
      message = 'Fact claim decisions must be accepted, rejected or conflicted.';
  end if;

  if not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = p_reviewer_id
      and profile.user_role = 'admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator can resolve a fact claim.';
  end if;

  -- Lecture sans verrou : la vente doit être verrouillée avant l'observation.
  select claim.auction_sale_id, claim.claim_status
  into v_seen
  from public.auction_fact_claims claim
  where claim.id = p_claim_id;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Fact claim not found.';
  end if;

  if v_seen.claim_status <> 'candidate' then
    raise exception using
      errcode = '55000',
      message = 'Only an unresolved candidate can be reviewed.';
  end if;

  if p_decision in ('rejected', 'conflicted')
    and nullif(pg_catalog.btrim(p_resolution_note), '') is null then
    raise exception using
      errcode = '22023',
      message = 'A rejection or conflict requires a resolution reason.';
  end if;

  if v_seen.auction_sale_id is null then
    raise exception using
      errcode = '55000',
      message = 'A claim without a current sale target cannot be reviewed.';
  end if;

  if not app_private.lock_sale_for_registry(v_seen.auction_sale_id) then
    raise exception using
      errcode = '55000',
      message = 'The claim sale no longer exists.';
  end if;

  select claim.*
  into v_claim
  from public.auction_fact_claims claim
  where claim.id = p_claim_id
  for update;

  if not found or v_claim.auction_sale_id is distinct from v_seen.auction_sale_id then
    raise exception using errcode = '40001', message = 'retry';
  end if;

  -- Le registre des pièces décide seul des observations d'origine réservée (professionnel, saisie d'un
  -- administrateur), et de celles qu'il a déjà décidées.
  if app_private.fact_claim_source_kind(
    v_claim.evidence_kind, v_claim.extractor_name, v_claim.evidence_locator
  ) in ('lawyer_email', 'lawyer_form', 'admin') then
    raise exception using
      errcode = '55000',
      message = 'A professional or administrator fact claim is decided through the fact registry.';
  end if;

  if exists (
    select 1 from public.auction_fact_claim_decisions decision where decision.claim_id = p_claim_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'A fact claim already decided in the fact registry cannot be reviewed here.';
  end if;

  select sale.sale_date, sale.starting_price_eur, sale.surface_m2, sale.habitable_surface_m2,
    sale.carrez_surface_m2, sale.land_surface_m2, sale.occupancy_status
  into v_sale
  from public.auction_sales sale
  where sale.id = v_claim.auction_sale_id;

  if p_decision = 'accepted' then
    v_scalar := v_claim.value_jsonb #>> '{}';
    v_canonical_match := case v_claim.field_key
      when 'sale.sale_date' then
        jsonb_typeof(v_claim.value_jsonb) = 'string'
        and v_sale.sale_date is not null
        and pg_catalog.pg_input_is_valid(v_scalar, 'timestamptz')
        and v_scalar::timestamptz = v_sale.sale_date
      when 'sale.starting_price_eur' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.starting_price_eur is not null
        and v_scalar::numeric = v_sale.starting_price_eur
      when 'property.surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.surface_m2 is not null
        and v_scalar::numeric = v_sale.surface_m2
      when 'property.habitable_surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.habitable_surface_m2 is not null
        and v_scalar::numeric = v_sale.habitable_surface_m2
      when 'property.carrez_surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.carrez_surface_m2 is not null
        and v_scalar::numeric = v_sale.carrez_surface_m2
      when 'property.land_surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.land_surface_m2 is not null
        and v_scalar::numeric = v_sale.land_surface_m2
      when 'property.occupancy_status' then
        jsonb_typeof(v_claim.value_jsonb) = 'string'
        and v_sale.occupancy_status is not null
        and lower(pg_catalog.btrim(v_scalar)) = lower(pg_catalog.btrim(v_sale.occupancy_status))
      else false
    end;

    if not v_canonical_match then
      raise exception using
        errcode = '55000',
        message = 'The candidate no longer matches the current canonical sale field.';
    end if;
  end if;

  v_conflict_group := case
    when p_decision = 'conflicted' then coalesce(
      v_claim.conflict_group,
      pg_catalog.left(
        pg_catalog.format('sale:%s:%s', v_claim.auction_sale_id, v_claim.field_key),
        200
      )
    )
    else null
  end;

  update public.auction_fact_claims claim
  set claim_status = p_decision,
      conflict_group = v_conflict_group,
      resolution_actor_type = 'human',
      resolution_actor_id = p_reviewer_id,
      resolution_note = nullif(pg_catalog.btrim(p_resolution_note), ''),
      resolved_at = v_now
  where claim.id = p_claim_id
    and claim.claim_status = 'candidate';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'The fact claim was resolved concurrently.';
  end if;

  return pg_catalog.jsonb_build_object(
    'claim_id', p_claim_id,
    'claim_status', p_decision,
    'canonical_match', v_canonical_match,
    'resolved_at', v_now
  );
end;
$function$;

revoke all on function public.review_auction_fact_claim(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.review_auction_fact_claim(uuid, uuid, text, text)
to service_role;

comment on function public.review_auction_fact_claim(uuid, uuid, text, text) is
  'Atomically resolves one source-backed fact candidate after an admin decision; accepted values must still match auction_sales. The sale row is locked before the claim (3 s at most per lock wait); professional and administrator claims, and claims already decided in the fact registry, are refused.';

notify pgrst, 'reload schema';

commit;
