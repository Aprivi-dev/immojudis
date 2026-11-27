begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Agent d'information, étape 6 : PUBLICATION AUTOMATIQUE des informations extraites des réponses des avocats,
-- arbitrée par Claude Haiku, sans relecture humaine. Décision du propriétaire du 27/11/2026 (« tout automatique »),
-- qui remplace celle du 11/11/2026 (« R9 après R8 ») et les conditions de déverrouillage du runbook (validation
-- par un avocat, jeu d'évaluation à zéro faute). Elle vaut aussi pour les réponses à des messages déjà envoyés.
-- Le propriétaire a accepté explicitement la levée des verrous auction_fact_claim_decisions_auto_locked et
-- auction_fact_claim_decisions_accepted_by_admin, et la modification des invariants
-- information-agent-no-automatic-publication-path, registry-rpc-actor-from-jwt et
-- field-projection-not-callable-by-api.
--
-- LE MODE RESTE CE QU'IL EST (« off » en production) : cette migration n'écrit pas le réglage. Le passage en
-- « auto » se fait par l'administrateur, avec son jeton, depuis le panneau (RPC set_information_agent_auto_
-- publication_mode, tracée dans information_agent_auto_publication_mode_changes).
--
--   1. Verrous levés, remplacés par des contraintes de FORME (une ligne automatique a une forme unique) :
--        * information_agent_auto_publication_settings_auto_locked : supprimée (le mode « auto » s'enregistre) ;
--        * information_agent_fact_publications_auto_locked : remplacée par
--          information_agent_fact_publications_auto_shape (auto : ni personne, une version de règle, avocat
--          poursuivant) ;
--        * auction_fact_claim_decisions_auto_locked : remplacée par auction_fact_claim_decisions_auto_shape
--          (auto : acceptation seulement, auteur « system » sans identifiant, fait de l'agent nommé, première
--          décision de l'observation, version de règle) ;
--        * auction_fact_claim_decisions_accepted_by_admin : remplacée par
--          auction_fact_claim_decisions_accepted_by_admin_or_auto (une acceptation vient d'un administrateur
--          nommé, ou de la publication automatique, et de rien d'autre) ;
--        * auction_fact_claim_decisions reçoit la colonne policy_version (version de la règle d'une décision
--          automatique, nulle pour toute décision manuelle ; contrainte auction_fact_claim_decisions_policy_check).
--      Le journal des publications de l'agent reçoit le déclencheur information_agent_fact_publications_guard :
--      une ligne ne change que de vente (fusion de fiches), ne part qu'avec sa vente, et n'est jamais vidée.
--   2. set_information_agent_auto_publication_mode : ne refuse plus « auto » (55000). Toujours is_admin et
--      auth.uid() : le service ne peut pas changer le mode ; l'arrêt d'urgence est inchangé.
--   3. public.information_agent_auto_publication_arbitrations : verdicts de Claude Haiku (worker Python du
--      workflow information-agent-evidence.yml), en ajout seul, sans texte libre : fait, valeur jugée, issue
--      (completed, invalid_output, unavailable, skipped), publier ou non, code de motif d'une liste fermée,
--      confiance, modèle, version du prompt, code d'erreur. Écrits par la seule RPC de service
--      record_information_agent_auto_publication_arbitration, en mode simulation ou automatique, pour un fait en
--      attente du corps du message et de la liste fermée, et seulement pour sa propre valeur (Haiku ne peut pas
--      changer la valeur). Les faits à juger sont choisis en base par la RPC de service
--      list_information_agent_facts_to_arbitrate (aussi lue par le contrôle préalable du workflow) : aucun appel
--      pour un fait que les conditions structurelles écartent déjà ou dont une analyse du message n'est pas finie ;
--      un verdict passager (unavailable, invalid_output) est refait au plus 3 fois, une heure au moins après.
--   4. Journal des décisions : mode « auto » admis, issue « published » (mode auto seulement) à côté de
--      « would_publish » (simulation seulement) et « review », nouveaux codes de motifs (moteur
--      auto_publication_v2). record_information_agent_auto_publication_decision écrit en simulation et en
--      automatique (jamais « published » ni « would_publish » en automatique), et rien pour un fait qui n'est plus
--      en attente.
--   5. app_private.bridge_accepted_information_agent_fact_claim : ne refuse plus « auto ». Une publication
--      automatique n'est admise que pour un fait du corps du message, sans relecteur, avec une version de règle ;
--      l'observation porte l'origine professional_email (classée lawyer_email par le registre).
--   6. app_private.accept_information_agent_claim_automatically(observation, version) : LA SEULE fonction de
--      décision automatique du registre. Aucun droit pour aucun rôle de l'API ; appelée seulement par la RPC du
--      point 7. Elle n'accepte qu'une observation créée par le pont de l'agent (extracteur information_agent,
--      origine professional_email, fait nommé dans le localisateur, publication 'auto' de même version au
--      journal des publications), de la vente et de la valeur du fait, jamais décidée auparavant, vente à un seul
--      lot ; puis applique la projection
--      de toute la vente, comme la décision d'un administrateur. Aucune lecture du jeton.
--   7. public.publish_information_agent_fact_auto(fait, clé, version, version du prompt de l'arbitre) : LE SEUL
--      chemin d'écriture 'auto'. RPC de
--      service (service_role seul), appelée par src/lib/information-agent/auto-publication-store.ts. Dans une
--      seule transaction :
--        a. relit le mode SOUS VERROU PARTAGÉ : si ce n'est pas « auto », rien n'est écrit (l'arrêt d'urgence,
--           qui prend le verrou exclusif, attend la fin d'une publication en cours puis bloque les suivantes) ;
--        b. verrou consultatif global : deux passes simultanées publient l'une après l'autre (plafonds exacts) ;
--           un fait déjà publié rend « already_published » sans rien écrire (réponse perdue, second appel) ;
--        c. contrôles de sécurité redits en base (défense en profondeur, le moteur TypeScript les fait aussi) :
--           fait en attente du corps du message, de la liste fermée ; réponse par e-mail de l'adresse contactée,
--           DKIM et DMARC « pass », traitée sans motif de relecture bloquant, reçue moins de 30 jours après
--           l'envoi ; aucune analyse du message en file, en cours ou à reprendre ; dossier de l'avocat poursuivant,
--           répondu ou en relecture, sans opposition (dossier ou contact) ; aucun autre message entrant du dossier
--           en relecture bloquante, opposé ou mal adressé ; dernier verdict de Haiku « publier », de la version
--           courante du prompt, pour cette valeur ; champ vide sur la fiche ; vente à un seul lot ; plafonds de 10
--           publications par jour (heure de Paris) et 2 par dossier ;
--        d. fait accepté sans relecteur, noyau app_private.apply_information_agent_fact avec 'auto' (journal des
--           publications), pont rendu immédiat (observation), décision automatique du registre (point 6),
--           décision « published » au journal du moteur.
--      Un contrôle qui échoue écrit une décision « review » (avec son motif) et rien d'autre.
--
-- Retrait : par le chemin existant (« Retirer » d'une observation acceptée, withdraw_auction_fact_claim, jeton de
-- l'administrateur). Arrêt : bouton « Arrêt d'urgence » (stop_information_agent_auto_publication), inchangé.
--
-- Verrous : ACCESS EXCLUSIVE bref sur les tables dont une contrainte change (journal des publications de
-- l'agent, réglage, journal du moteur, journal des décisions du registre : ajout d'une colonne nulle sans
-- défaut et de contraintes CHECK, avec parcours des lignes existantes, peu nombreuses), création d'une table,
-- remplacement et création de fonctions. Aucun verrou sur auction_sales. À appliquer hors import.
--
-- Ordre de déploiement : appliquer la migration AVANT le code. Le code de l'étape 6 lit la table des verdicts
-- et la RPC de publication ; sans elles, la passe du moteur échoue en simulation (signalé par le cron). Le
-- worker Python n'écrit un verdict qu'en mode simulation ou automatique.
--
-- Retour arrière : d'abord l'arrêt d'urgence (mode « off »), puis le code de l'étape 3, puis, dans une
-- transaction : supprimer public.publish_information_agent_fact_auto(uuid, text, text, text),
-- public.list_information_agent_facts_to_arbitrate(text, integer),
-- app_private.accept_information_agent_claim_automatically(uuid, text),
-- public.record_information_agent_auto_publication_arbitration(uuid, numeric, text, boolean, text, numeric, text,
-- text, text) ; recréer set_information_agent_auto_publication_mode, record_information_agent_auto_publication_
-- decision et le pont dans leur définition de 20261115100000 et 20261119100900 ; garder la table des verdicts et
-- les journaux (en ajout seul). Les contraintes *_auto_locked ne peuvent être remises qu'après le retrait de toute
-- publication automatique déjà faite (les lignes 'auto' des journaux restent, et les contraintes de forme aussi).

-- 1. Verrous levés, contraintes de forme --------------------------------------------------------------------------
-- Chaque contrainte de forme est retirée puis recréée (jamais « si absente ») : une base qui aurait vu une version
-- antérieure de cette migration n'en garde aucune définition périmée.
-- Réglage : le mode « auto » s'enregistre (la contrainte de la colonne garde la liste des trois modes).
alter table public.information_agent_auto_publication_settings
  drop constraint if exists information_agent_auto_publication_settings_auto_locked;

-- Journal des publications de l'agent : une ligne 'auto' n'a ni personne ni autre version que celle du moteur, et ne
-- concerne que l'avocat poursuivant.
alter table public.information_agent_fact_publications
  drop constraint if exists information_agent_fact_publications_auto_shape;
alter table public.information_agent_fact_publications
  add constraint information_agent_fact_publications_auto_shape check (
    actor_kind <> 'auto' or (
      actor_id is null and policy_version ~ '^auto_publication_v[0-9]{1,4}$'
      and recipient_kind = 'source_lawyer'
    )
  );
alter table public.information_agent_fact_publications
  drop constraint if exists information_agent_fact_publications_auto_locked;

-- Journal des décisions du registre : version de la règle d'une décision automatique, et forme unique d'une
-- décision automatique. Une décision manuelle n'a pas de version (toutes les lignes existantes sont manuelles).
alter table public.auction_fact_claim_decisions add column if not exists policy_version text;

alter table public.auction_fact_claim_decisions
  drop constraint if exists auction_fact_claim_decisions_policy_check;
alter table public.auction_fact_claim_decisions
  add constraint auction_fact_claim_decisions_policy_check check (
    (publication_mode = 'auto') = (policy_version is not null)
    and (policy_version is null or policy_version ~ '^auto_publication_v[0-9]{1,4}$')
  );
alter table public.auction_fact_claim_decisions
  drop constraint if exists auction_fact_claim_decisions_auto_shape;
alter table public.auction_fact_claim_decisions
  add constraint auction_fact_claim_decisions_auto_shape check (
    publication_mode <> 'auto' or (
      decision = 'accepted' and actor_kind = 'system' and actor_id is null
      and information_agent_fact_id is not null and supersedes_decision_id is null
      and lot_attachment = 'single_lot' and recipient_kind = 'source_lawyer'
    )
  );
alter table public.auction_fact_claim_decisions
  drop constraint if exists auction_fact_claim_decisions_accepted_by_admin_or_auto;
alter table public.auction_fact_claim_decisions
  add constraint auction_fact_claim_decisions_accepted_by_admin_or_auto check (
    decision <> 'accepted'
    or (actor_kind = 'admin' and actor_id is not null)
    or (actor_kind = 'system' and actor_id is null and publication_mode = 'auto')
  );
alter table public.auction_fact_claim_decisions
  drop constraint if exists auction_fact_claim_decisions_auto_locked;
alter table public.auction_fact_claim_decisions
  drop constraint if exists auction_fact_claim_decisions_accepted_by_admin;

-- Journal des publications de l'agent : une ligne écrite n'est plus réécrite. Seule la vente peut changer (fusion de
-- fiches, 20261118100200 : le journal suit la fiche conservée) ; l'auteur ne passe à nul que par la suppression de
-- son compte (clé étrangère « on delete set null »). Une ligne ne part qu'avec sa vente (suppression en cascade) ;
-- aucun vidage. Ni l'auteur, ni le type d'auteur, ni la version, ni le fait d'une ligne 'admin' ou 'auto' ne peuvent
-- donc être changés après coup.
create or replace function app_private.information_agent_fact_publications_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.auction_sales sale where sale.id = old.sale_id) then
      return old;
    end if;
    raise exception using errcode = '55000',
      message = 'Le journal des publications de l''agent ne perd une ligne qu''avec sa vente.';
  end if;
  if (pg_catalog.to_jsonb(new) - 'sale_id' - 'actor_id')
      is distinct from (pg_catalog.to_jsonb(old) - 'sale_id' - 'actor_id')
    or (
      new.actor_id is distinct from old.actor_id
      and not (
        new.actor_id is null
        and not exists (select 1 from auth.users account where account.id = old.actor_id)
      )
    )
  then
    raise exception using errcode = '55000',
      message = 'Une ligne du journal des publications de l''agent ne change que de vente.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.information_agent_fact_publications_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists information_agent_fact_publications_guard on public.information_agent_fact_publications;
create trigger information_agent_fact_publications_guard
  before update or delete on public.information_agent_fact_publications
  for each row execute function app_private.information_agent_fact_publications_guard();

drop trigger if exists information_agent_fact_publications_no_truncate
  on public.information_agent_fact_publications;
create trigger information_agent_fact_publications_no_truncate
  before truncate on public.information_agent_fact_publications
  for each statement execute function app_private.information_agent_auto_publication_append_only();

comment on column public.auction_fact_claim_decisions.policy_version is
  'Version de la règle de publication automatique (auto_publication_vN) d''une décision automatique ; nulle pour toute décision manuelle.';

-- 2. Changement de mode : « auto » admis --------------------------------------------------------------------------
-- Définition de 20261115100000, sans le refus 55000 du mode automatique. Toujours un administrateur avec son jeton.
create or replace function public.set_information_agent_auto_publication_mode(p_mode text)
returns public.information_agent_auto_publication_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.information_agent_auto_publication_settings%rowtype;
  v_after public.information_agent_auto_publication_settings%rowtype;
  v_actor uuid := (select auth.uid());
begin
  if not public.is_admin() or v_actor is null then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_mode is null or p_mode not in ('off', 'simulation', 'auto') then
    raise exception using errcode = '22023', message = 'Mode inconnu.';
  end if;

  select * into v_before
  from public.information_agent_auto_publication_settings settings
  where settings.singleton
  for update;
  if v_before.singleton is null then
    raise exception using errcode = 'P0002', message = 'Réglage de publication automatique absent.';
  end if;
  if v_before.mode = p_mode then
    return v_before;
  end if;

  update public.information_agent_auto_publication_settings settings
  set mode = p_mode, updated_by = v_actor, updated_at = pg_catalog.statement_timestamp()
  where settings.singleton
  returning * into v_after;

  insert into public.information_agent_auto_publication_mode_changes (
    actor_id, previous_mode, new_mode, emergency_stop
  ) values (v_actor, v_before.mode, v_after.mode, false);
  return v_after;
end;
$$;

revoke all on function public.set_information_agent_auto_publication_mode(text)
  from public, anon, authenticated;
grant execute on function public.set_information_agent_auto_publication_mode(text)
  to authenticated, service_role;

comment on table public.information_agent_auto_publication_settings is
  'Mode de la publication automatique des informations de l''agent (ligne unique) : off (défaut), simulation, auto (étape 6, 27/11/2026). Modifié seulement par set_/stop_information_agent_auto_publication (is_admin), chaque changement tracé dans information_agent_auto_publication_mode_changes.';

-- Valeur numérique proposée d'un fait ({"value": 65} ou {"value": "65,5"}) : même lecture que proposedNumber
-- (auto-publication-policy.ts) et que le worker Python. Nulle si illisible.
create or replace function app_private.information_agent_auto_publication_value(p_proposed jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(p_proposed -> 'value') = 'number' then (p_proposed ->> 'value')::numeric
    when pg_catalog.jsonb_typeof(p_proposed -> 'value') = 'string'
      and pg_catalog.btrim(p_proposed ->> 'value') ~ '^[0-9]{1,9}([.,][0-9]{1,4})?$'
      then pg_catalog.replace(pg_catalog.btrim(p_proposed ->> 'value'), ',', '.')::numeric
    else null
  end;
$$;

revoke all on function app_private.information_agent_auto_publication_value(jsonb)
  from public, anon, authenticated, service_role;

-- État des analyses du message (pièces jointes, et corps relu par l'IA) : ce que le message dit doit être LU EN ENTIER
-- avant tout jugement ou publication (un PDF joint peut contredire le corps).
--   * 'pending' (motif evidence_pending) : une analyse est en file ou en échec avec des essais restants
--     (claim_information_agent_evidence_extractions reprend jusqu'à 3 essais), ou en cours et encore reprenable ;
--   * 'unreadable' (motif attachment_unreadable) : une analyse ne lira jamais tout le message : protégée par un mot de
--     passe (needs_password), non prise en charge (unsupported), en échec définitif, bloquée en cours avec ses essais
--     épuisés, ou terminée sans lecture complète (metadata.reading.complete différent de true : pages non lues,
--     texte coupé, lecture par l'IA bornée) ;
--   * null : toutes les analyses du message sont terminées avec une lecture complète (ou il n'y en a aucune).
-- Une analyse « pending » l'emporte : le motif dit qu'il faut attendre.
drop function if exists app_private.information_agent_message_analysis_pending(uuid);
create or replace function app_private.information_agent_message_evidence_state(p_message_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  with analyses as (
    select
      (extraction.status in ('queued', 'failed') and extraction.attempts < 3)
        or (
          extraction.status = 'processing'
          and (
            extraction.attempts < 3
            or extraction.locked_at >= pg_catalog.statement_timestamp() - interval '45 minutes'
          )
        ) as pending,
      not (
        extraction.status = 'completed'
        and coalesce(extraction.metadata #> '{reading,complete}', 'false'::jsonb) = 'true'::jsonb
      ) as incomplete
    from public.information_agent_evidence_extractions extraction
    where extraction.message_id = p_message_id
  )
  select case
    when bool_or(analyses.pending) then 'pending'
    when bool_or(analyses.incomplete) then 'unreadable'
  end
  from analyses;
$$;

revoke all on function app_private.information_agent_message_evidence_state(uuid)
  from public, anon, authenticated, service_role;

-- Message entrant traité sans motif de relecture bloquant : même règle que processedForPublication
-- (auto-publication-policy.ts). Traité sans motif ; en relecture pour le seul motif générique
-- candidate_or_attachment_review ; pour un autre message du dossier, une réponse automatique ignorée aussi.
create or replace function app_private.information_agent_message_processed_for_publication(
  p_metadata jsonb,
  p_own_message boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    case p_metadata #>> '{inbound_processing,status}'
      when 'completed' then coalesce(pg_catalog.jsonb_typeof(p_metadata #> '{inbound_processing,reason}'), 'null') = 'null'
      when 'review' then p_metadata #>> '{inbound_processing,reason}' = 'candidate_or_attachment_review'
      when 'ignored' then not p_own_message and p_metadata #>> '{inbound_processing,reason}' = 'auto_reply'
      else false
    end,
    false
  );
$$;

revoke all on function app_private.information_agent_message_processed_for_publication(jsonb, boolean)
  from public, anon, authenticated, service_role;

-- Motifs de la vente qui écartent un fait (même règle que le moteur) : vente absente (input_unreadable), champ déjà
-- renseigné dans une colonne que la fiche peut afficher (field_not_empty), vente à plusieurs lots (multi_lot_sale).
-- Lue par la RPC de publication et par la liste des faits à juger (aucun appel de Haiku pour un fait déjà écarté).
create or replace function app_private.information_agent_auto_publication_sale_blocks(
  p_sale_id uuid,
  p_fact_key text
)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_sale record;
  v_reasons text[] := '{}'::text[];
begin
  select sale.surface_m2, sale.app_surface_m2, sale.habitable_surface_m2, sale.carrez_surface_m2,
    sale.land_surface_m2, sale.rooms_count,
    coalesce(sale.quality_flags ? 'multi_lot_sale', false)
      or coalesce(pg_catalog.jsonb_typeof(sale.raw_payload -> 'source_lot_selection'), 'null') <> 'null'
      as multi_lot
  into v_sale
  from public.auction_sales sale
  where sale.id = p_sale_id;
  if not found then
    return array['input_unreadable']::text[];
  end if;
  if (p_fact_key = 'surface_m2' and (
        v_sale.surface_m2 is not null or v_sale.app_surface_m2 is not null
        or v_sale.habitable_surface_m2 is not null or v_sale.carrez_surface_m2 is not null))
    or (p_fact_key = 'land_surface_m2' and v_sale.land_surface_m2 is not null)
    or (p_fact_key = 'rooms_count' and v_sale.rooms_count is not null)
  then
    v_reasons := v_reasons || 'field_not_empty'::text;
  end if;
  if v_sale.multi_lot then
    v_reasons := v_reasons || 'multi_lot_sale'::text;
  end if;
  return v_reasons;
end;
$$;

revoke all on function app_private.information_agent_auto_publication_sale_blocks(uuid, text)
  from public, anon, authenticated, service_role;

-- 3. Verdicts de Claude Haiku ---------------------------------------------------------------------------------------
-- fact_id, case_id et message_id sans clé étrangère (même règle que le journal des décisions : la trace survit à
-- la purge des messages) ; sale_id suit la vente. Aucun texte libre : codes et nombres seulement.
create table if not exists public.information_agent_auto_publication_arbitrations (
  id uuid primary key default gen_random_uuid(),
  recorded_at timestamptz not null default statement_timestamp(),
  fact_id uuid not null,
  case_id uuid not null,
  message_id uuid not null,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  fact_key text not null check (fact_key in ('surface_m2', 'land_surface_m2', 'rooms_count')),
  -- Valeur jugée : celle du fait, jamais une valeur rendue par le modèle.
  value numeric not null,
  status text not null check (status in ('completed', 'invalid_output', 'unavailable', 'skipped')),
  publish boolean not null default false,
  -- Liste fermée : même liste que AUTO_PUBLICATION_ARBITER_REASON_CODES (TypeScript) et ARBITER_REASON_CODES
  -- (Python), comparées par un test.
  reason_code text check (
    reason_code is null or reason_code in (
      'clear_statement', 'conditional_or_approximate', 'other_lot_or_property', 'reported_or_compared_value',
      'correction_or_range', 'different_quantity', 'not_current', 'do_not_publish_requested',
      'unclear_or_ambiguous', 'inconsistent_with_record', 'possible_manipulation', 'other'
    )
  ),
  confidence numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  model text not null check (model ~ '^[a-z0-9][a-z0-9._/-]{0,99}$'),
  prompt_version text not null check (prompt_version ~ '^auto_publication_arbiter_v[0-9]{1,4}$'),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  -- Seul un verdict lu et validé peut dire « publier », et seulement avec le motif « déclaration nette ».
  constraint information_agent_auto_publication_arbitrations_verdict check (
    (status = 'completed') = (reason_code is not null)
    and (not publish or (status = 'completed' and reason_code = 'clear_statement'))
    and (publish or status <> 'completed' or reason_code <> 'clear_statement')
  )
);

create index if not exists information_agent_auto_publication_arbitrations_fact_idx
  on public.information_agent_auto_publication_arbitrations (fact_id, recorded_at desc);
create index if not exists information_agent_auto_publication_arbitrations_sale_idx
  on public.information_agent_auto_publication_arbitrations (sale_id);

comment on table public.information_agent_auto_publication_arbitrations is
  'Verdicts de Claude Haiku sur les informations extraites des réponses (publier ou non, code de motif d''une liste fermée, confiance, modèle, version du prompt). En ajout seul, sans texte libre, écrits par record_information_agent_auto_publication_arbitration. Suit la vente.';

alter table public.information_agent_auto_publication_arbitrations enable row level security;
revoke all on table public.information_agent_auto_publication_arbitrations
  from public, anon, authenticated, service_role;
grant select on table public.information_agent_auto_publication_arbitrations to service_role;

-- Ajout seul, comme le journal des décisions (même fonction : une ligne ne part qu'avec sa vente).
drop trigger if exists information_agent_auto_publication_arbitrations_append_only
  on public.information_agent_auto_publication_arbitrations;
create trigger information_agent_auto_publication_arbitrations_append_only
  before update or delete on public.information_agent_auto_publication_arbitrations
  for each row execute function app_private.information_agent_auto_publication_decisions_append_only();

drop trigger if exists information_agent_auto_publication_arbitrations_no_truncate
  on public.information_agent_auto_publication_arbitrations;
create trigger information_agent_auto_publication_arbitrations_no_truncate
  before truncate on public.information_agent_auto_publication_arbitrations
  for each statement execute function app_private.information_agent_auto_publication_append_only();

-- Écriture d'un verdict (worker Python, service_role). En mode simulation ou automatique seulement (mode relu sous
-- verrou partagé). Le fait doit être en attente, du corps du message, de la liste fermée, et la valeur jugée doit
-- être la sienne : un verdict ne change jamais la valeur. Un fait ou une vente disparus : rien n'est écrit.
create or replace function public.record_information_agent_auto_publication_arbitration(
  p_fact_id uuid,
  p_value numeric,
  p_status text,
  p_publish boolean,
  p_reason_code text,
  p_confidence numeric,
  p_model text,
  p_prompt_version text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_fact public.information_agent_fact_candidates%rowtype;
  v_value numeric;
begin
  select settings.mode into v_mode
  from public.information_agent_auto_publication_settings settings
  where settings.singleton
  for share;
  if v_mode is null or v_mode not in ('simulation', 'auto') then
    return false;
  end if;

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id;
  if v_fact.id is null or v_fact.status <> 'pending' or v_fact.reviewed_by is not null then
    return false;
  end if;
  if v_fact.fact_key not in ('surface_m2', 'land_surface_m2', 'rooms_count')
    or v_fact.evidence_asset_id is not null
  then
    raise exception using errcode = '22023',
      message = 'Only a pending body fact of the closed list can be arbitrated.';
  end if;
  v_value := app_private.information_agent_auto_publication_value(v_fact.proposed_value);
  if v_value is null or p_value is null or p_value <> v_value then
    raise exception using errcode = '22023', message = 'The verdict does not match the value of the fact.';
  end if;

  begin
    insert into public.information_agent_auto_publication_arbitrations (
      fact_id, case_id, message_id, sale_id, fact_key, value, status, publish, reason_code, confidence, model,
      prompt_version, error_code
    ) values (
      v_fact.id, v_fact.case_id, v_fact.message_id, v_fact.sale_id, v_fact.fact_key, v_value, p_status,
      coalesce(p_publish, false), p_reason_code, p_confidence, p_model, p_prompt_version, p_error_code
    );
  exception when foreign_key_violation then
    return false;
  end;
  return true;
end;
$$;

revoke all on function public.record_information_agent_auto_publication_arbitration(
  uuid, numeric, text, boolean, text, numeric, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_information_agent_auto_publication_arbitration(
  uuid, numeric, text, boolean, text, numeric, text, text, text
) to service_role;

-- Faits à juger par Haiku (worker Python, et contrôle préalable du workflow information-agent-evidence.yml), le plus
-- ancien d'abord, filtrés en base (pas de famine derrière des faits déjà jugés) : mode simulation ou automatique ;
-- fait en attente, du corps du message, de la liste fermée, reçu depuis 45 jours, valeur lisible ; réponse e-mail
-- (ni import ni portail) de l'adresse contactée, authentifiée (DKIM et DMARC « pass »), à un dossier de l'avocat
-- poursuivant répondu ou en relecture, sans opposition (dossier ou contact), champ vide sur la fiche et vente à un
-- seul lot (minimisation : aucune donnée envoyée à Haiku pour une réponse qui ne peut pas être publiée) ; message lu
-- en entier (aucune analyse en cours, à reprendre, illisible ou lue en partie) ; aucun verdict
-- final (completed, skipped) de cette version du prompt pour cette valeur ; un verdict passager (unavailable,
-- invalid_output) est refait au plus 3 fois en tout, une heure au moins après le précédent.
create or replace function public.list_information_agent_facts_to_arbitrate(
  p_prompt_version text,
  p_limit integer
)
returns table (
  fact_id uuid,
  case_id uuid,
  message_id uuid,
  sale_id uuid,
  fact_key text,
  value numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode text;
begin
  if p_prompt_version is null or p_prompt_version !~ '^auto_publication_arbiter_v[0-9]{1,4}$' then
    raise exception using errcode = '22023', message = 'Invalid prompt version.';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = '22023', message = 'The limit must be between 1 and 200.';
  end if;
  select settings.mode into v_mode
  from public.information_agent_auto_publication_settings settings
  where settings.singleton;
  if v_mode is null or v_mode not in ('simulation', 'auto') then
    return;
  end if;

  return query
  select fact.id, fact.case_id, fact.message_id, fact.sale_id, fact.fact_key, candidate.value
  from public.information_agent_fact_candidates fact
  cross join lateral (
    select app_private.information_agent_auto_publication_value(fact.proposed_value) as value
  ) candidate
  join public.information_agent_messages message on message.id = fact.message_id
  join public.information_agent_cases case_row on case_row.id = fact.case_id
  where fact.status = 'pending'
    and fact.reviewed_by is null
    and fact.evidence_asset_id is null
    and fact.fact_key in ('surface_m2', 'land_surface_m2', 'rooms_count')
    and fact.created_at >= pg_catalog.statement_timestamp() - interval '45 days'
    and candidate.value is not null
    -- Minimisation : rien n'est envoyé à Haiku pour une réponse qui ne peut pas être publiée.
    and message.direction = 'inbound'
    and (message.metadata ->> 'imported_manually') = 'false'
    and coalesce(message.metadata ->> 'channel', 'email') = 'email'
    and (message.metadata ->> 'sender_matches_recipient') = 'true'
    and (message.metadata #>> '{sender_authentication,dkim}') = 'pass'
    and (message.metadata #>> '{sender_authentication,dmarc}') = 'pass'
    and case_row.recipient_kind = 'source_lawyer'
    and case_row.status in ('replied', 'review')
    and coalesce(case_row.metadata ->> 'last_inbound_contact_opposed', 'false') = 'false'
    and not exists (
      select 1 from public.information_agent_contacts contact
      where contact.normalized_email = case_row.normalized_recipient_email
        and contact.opposition_status = 'opposed'
    )
    and cardinality(app_private.information_agent_auto_publication_sale_blocks(fact.sale_id, fact.fact_key)) = 0
    and app_private.information_agent_message_evidence_state(fact.message_id) is null
    and not exists (
      select 1 from public.information_agent_auto_publication_arbitrations verdict
      where verdict.fact_id = fact.id and verdict.prompt_version = p_prompt_version
        and verdict.value = candidate.value
        and (
          verdict.status in ('completed', 'skipped')
          or verdict.recorded_at > pg_catalog.statement_timestamp() - interval '1 hour'
        )
    )
    and (
      select count(*) from public.information_agent_auto_publication_arbitrations verdict
      where verdict.fact_id = fact.id and verdict.prompt_version = p_prompt_version
        and verdict.value = candidate.value
    ) < 3
  order by fact.created_at asc, fact.id asc
  limit p_limit;
end;
$$;

revoke all on function public.list_information_agent_facts_to_arbitrate(text, integer)
  from public, anon, authenticated;
grant execute on function public.list_information_agent_facts_to_arbitrate(text, integer)
  to service_role;

-- 4. Journal des décisions du moteur : mode « auto », issue « published », motifs du moteur v2 ---------------------
alter table public.information_agent_auto_publication_decisions
  drop constraint if exists information_agent_auto_publication_decisions_mode_check;
alter table public.information_agent_auto_publication_decisions
  drop constraint if exists information_agent_auto_publication_decisions_outcome_check;
alter table public.information_agent_auto_publication_decisions
  drop constraint if exists information_agent_auto_publication_decisions_outcome_reasons;
alter table public.information_agent_auto_publication_decisions
  drop constraint if exists information_agent_auto_publication_decisions_eligible_check;
alter table public.information_agent_auto_publication_decisions
  drop constraint if exists information_agent_auto_publication_decisions_reasons_check;
alter table public.information_agent_auto_publication_decisions
  drop constraint if exists information_agent_auto_publication_decisions_mode_outcome;

alter table public.information_agent_auto_publication_decisions
  add constraint information_agent_auto_publication_decisions_mode_check check (
    mode in ('simulation', 'auto')
  ),
  add constraint information_agent_auto_publication_decisions_outcome_check check (
    outcome in ('would_publish', 'published', 'review')
  ),
  -- « Aurait été publié » n'existe qu'en simulation, « publié » qu'en automatique.
  add constraint information_agent_auto_publication_decisions_mode_outcome check (
    (outcome <> 'would_publish' or mode = 'simulation') and (outcome <> 'published' or mode = 'auto')
  ),
  add constraint information_agent_auto_publication_decisions_outcome_reasons check (
    (outcome in ('would_publish', 'published')) = (cardinality(reasons) = 0)
  ),
  -- Liste fermée des champs éligibles : même liste que AUTO_PUBLICATION_ELIGIBLE_FIELDS (test de concordance).
  add constraint information_agent_auto_publication_decisions_eligible_check check (
    outcome not in ('would_publish', 'published')
    or fact_key in ('surface_m2', 'land_surface_m2', 'rooms_count')
  ),
  -- Codes de motifs (même liste que AUTO_PUBLICATION_REASON_LABELS, test de concordance) ; les codes du moteur v1
  -- restent admis pour les lignes déjà écrites.
  add constraint information_agent_auto_publication_decisions_reasons_check check (
    cardinality(reasons) <= 32
    and array_position(reasons, null) is null
    and reasons <@ array[
      'input_unreadable', 'field_not_eligible', 'candidate_not_pending', 'not_email_reply',
      'sender_not_contacted_address', 'sender_not_authenticated', 'reply_outside_window',
      'recipient_not_lawyer', 'case_not_replied', 'attachment_source', 'semantic_only_body',
      'semantic_not_confirmed', 'other_value_in_reply', 'other_value_for_sale',
      'later_message_in_case', 'statement_review_reason', 'reply_in_review', 'possible_manipulation',
      'do_not_publish_requested', 'private_person_named', 'field_not_empty',
      'field_already_filled_in_simulation', 'implausible_value', 'daily_cap_reached',
      'case_cap_reached', 'other_message_in_case', 'contact_opposed', 'multi_lot_sale', 'arbiter_pending',
      'arbiter_unavailable', 'arbiter_declined', 'arbiter_value_mismatch', 'publication_failed',
      'evidence_pending', 'attachment_unreadable', 'arbiter_skipped', 'publication_deferred'
    ]::text[]
  );

create index if not exists information_agent_auto_publication_decisions_published_idx
  on public.information_agent_auto_publication_decisions (decided_at desc)
  where outcome = 'published';
create index if not exists information_agent_auto_publication_decisions_case_published_idx
  on public.information_agent_auto_publication_decisions (case_id)
  where outcome = 'published';

comment on table public.information_agent_auto_publication_decisions is
  'Journal en ajout seul des décisions du moteur « publier ou relire » : simulation (would_publish, review) et mode automatique (published, review). Fait, dossier, vente, clé, issue, codes de motifs, version de la règle. Ni adresse, ni extrait, ni texte issu du message. Suit la vente.';

-- Écriture d'une décision au journal, commune aux deux RPC (aucun droit pour aucun rôle de l'API). Une décision
-- identique à la dernière du fait (issue, motifs, version) n'est pas réécrite. Une vente disparue : rien.
create or replace function app_private.write_information_agent_auto_publication_decision(
  p_fact_id uuid,
  p_case_id uuid,
  p_sale_id uuid,
  p_fact_key text,
  p_mode text,
  p_outcome text,
  p_reasons text[],
  p_policy_version text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reasons text[] := coalesce(p_reasons, '{}'::text[]);
  v_last public.information_agent_auto_publication_decisions%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('information_agent_auto_publication:' || p_fact_id::text, 0)
  );
  select * into v_last
  from public.information_agent_auto_publication_decisions decision
  where decision.fact_id = p_fact_id
  order by decision.decided_at desc, decision.id desc
  limit 1;
  if v_last.id is not null
    and v_last.outcome = p_outcome
    and v_last.reasons = v_reasons
    and v_last.policy_version = p_policy_version
  then
    return false;
  end if;

  begin
    insert into public.information_agent_auto_publication_decisions (
      mode, policy_version, fact_id, case_id, sale_id, fact_key, outcome, reasons
    ) values (
      p_mode, p_policy_version, p_fact_id, p_case_id, p_sale_id, p_fact_key, p_outcome, v_reasons
    );
  exception when foreign_key_violation then
    return false;
  end;
  return true;
end;
$$;

revoke all on function app_private.write_information_agent_auto_publication_decision(
  uuid, uuid, uuid, text, text, text, text[], text
) from public, anon, authenticated, service_role;

-- Écriture d'une décision du moteur (serveur). Définition de 20261115100000, étendue au mode automatique : le mode
-- est relu sous verrou partagé ; en automatique, seule une relecture s'écrit ici (une publication passe par
-- publish_information_agent_fact_auto, qui écrit sa propre décision dans la même transaction que la fiche). Un fait
-- qui n'est plus en attente n'en reçoit plus (rend false, rien d'écrit).
create or replace function public.record_information_agent_auto_publication_decision(
  p_fact_id uuid,
  p_fact_key text,
  p_outcome text,
  p_reasons text[],
  p_policy_version text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_fact public.information_agent_fact_candidates%rowtype;
begin
  select settings.mode into v_mode
  from public.information_agent_auto_publication_settings settings
  where settings.singleton
  for share;
  if v_mode is null or v_mode not in ('simulation', 'auto') then
    return false;
  end if;
  if p_outcome is null
    or (v_mode = 'auto' and p_outcome <> 'review')
    or (v_mode = 'simulation' and p_outcome not in ('would_publish', 'review'))
  then
    raise exception using errcode = '22023',
      message = 'This outcome cannot be recorded in the current mode.';
  end if;

  -- Verrou partagé : une publication en cours (verrou exclusif du fait) se termine avant cette lecture.
  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for share;
  if v_fact.id is null then
    -- Fait purgé ou supprimé avec sa vente depuis la lecture : rien à écrire.
    return false;
  end if;
  if v_fact.fact_key is distinct from p_fact_key then
    raise exception using errcode = '22023', message = 'The decision does not match the fact key.';
  end if;
  -- Un fait qui n'est plus en attente (publié entre-temps, réponse de la publication perdue, ou relu) : aucune
  -- décision ne s'écrit après coup.
  if v_fact.status <> 'pending' or v_fact.reviewed_by is not null then
    return false;
  end if;

  return app_private.write_information_agent_auto_publication_decision(
    v_fact.id, v_fact.case_id, v_fact.sale_id, v_fact.fact_key, v_mode, p_outcome, p_reasons,
    p_policy_version
  );
end;
$$;

revoke all on function public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)
  to service_role;

-- Source de provenance des observations publiées automatiquement (sans auteur humain, une observation exige un
-- pointeur de provenance). Inactive, jamais collectée : un simple nom.
insert into public.data_sources (
  name, publisher, official, legal_review_status, ingestion_policy, active
) values (
  'immojudis_information_agent_auto_publication', 'Immojudis', false, 'pending', 'disabled', false
)
on conflict (name) do nothing;

-- 5. Pont vers auction_fact_claims ---------------------------------------------------------------------------------
-- Définition de 20261119100900, avec quatre changements : une publication 'auto' n'est plus refusée mais encadrée
-- (fait du corps du message, aucun relecteur, version de règle) ; le contrôle de l'administrateur relecteur ne vaut
-- que pour une publication 'admin' ; un fait du corps publié automatiquement donne une observation d'origine
-- professional_email (et non « other », que le registre ne classe pas) ; son pointeur de provenance est la source
-- immojudis_information_agent_auto_publication (une observation sans auteur humain en exige un).
create or replace function app_private.bridge_accepted_information_agent_fact_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sale public.auction_sales%rowtype;
  v_field_key text;
  v_held boolean;
  v_value_text text;
  v_value_numeric numeric;
  v_value_integer integer;
  v_value_date date;
  v_value_jsonb jsonb;
  v_existing_claim_id uuid;
  v_actor_kind text;
  v_policy_version text;
  v_auto_source_id uuid;
begin
  if new.status <> 'accepted' or old.status = 'accepted' then
    return new;
  end if;

  -- Binary evidence and free-form visit/address suggestions are accepted by
  -- the existing workflow but do not have a comparable canonical scalar in
  -- auction_sales. They remain represented by the reviewed candidate and its
  -- evidence trail; they must not be mislabelled as a fiche fact claim.
  -- Même correspondance que app_private.information_agent_fact_registry_field (le test de concordance de
  -- l'application compare les deux copies à la sienne).
  v_field_key := case new.fact_key
    when 'surface_m2' then 'property.surface_m2'
    when 'land_surface_m2' then 'property.land_surface_m2'
    when 'rooms_count' then 'property.rooms_count'
    when 'occupancy_status' then 'property.occupancy_status'
    when 'starting_price_eur' then 'sale.starting_price_eur'
    when 'sale_date' then 'sale.sale_date'
    when 'property_type' then 'property.property_type'
    else null
  end;
  if v_field_key is null then
    return new;
  end if;
  -- Champ tenu par le registre : la fiche ne porte pas encore la valeur, la décision de l'administrateur et la
  -- projection l'y mettront.
  v_held := app_private.information_agent_fact_held_by_registry(new.fact_key);

  -- Auteur réel de la publication, lu au journal écrit par le noyau dans la même transaction. Sans
  -- ligne (écriture directe du statut), le pont garde son exigence d'un relecteur administrateur.
  select publication.actor_kind, publication.policy_version
  into v_actor_kind, v_policy_version
  from public.information_agent_fact_publications publication
  where publication.fact_id = new.id
  order by publication.published_at desc, publication.id desc
  limit 1;
  v_actor_kind := coalesce(v_actor_kind, 'admin');

  select sale.* into v_sale
  from public.auction_sales sale
  where sale.id = new.sale_id
  for update;

  if v_sale.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Cannot bridge an information-agent fact without its sale.';
  end if;

  if v_actor_kind = 'auto' then
    -- Publication automatique (étape 6, 27/11/2026) : seulement un fait du corps d'une réponse par e-mail (jamais
    -- une pièce jointe ni un dépôt), sans relecteur, avec la version de la règle qui l'a publié. L'observation
    -- porte l'origine « réponse d'un professionnel par e-mail » (professional_email, classée lawyer_email par le
    -- registre), sans auteur humain.
    if new.reviewed_by is not null or v_policy_version is null or new.evidence_asset_id is not null then
      raise exception using
        errcode = '55000',
        message = 'An automatic information-agent publication needs a body fact, no reviewer and a policy version.';
    end if;
    -- Pointeur de provenance d'une observation sans auteur humain : la source « publication automatique de
    -- l'agent » (même usage que la source du pont du catalogue).
    select source_row.id into v_auto_source_id
    from public.data_sources source_row
    where source_row.name = 'immojudis_information_agent_auto_publication';
    if v_auto_source_id is null then
      raise exception using
        errcode = '55000',
        message = 'The automatic publication provenance source is missing.';
    end if;
  elsif new.reviewed_by is null then
    raise exception using
      errcode = '42501',
      message = 'Accepted information-agent facts require a reviewer identity.';
  end if;

  if v_actor_kind = 'admin' and not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = new.reviewed_by
      and profile.user_role = 'admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'Accepted information-agent facts require an administrator reviewer.';
  end if;

  v_value_text := nullif(btrim(new.proposed_value->>'value'), '');
  if v_value_text is null then
    raise exception using
      errcode = '23514',
      message = 'Accepted information-agent facts require a scalar value.';
  end if;

  -- Recheck the post-review canonical value of a field that the registry does
  -- not hold. The checks intentionally use IS DISTINCT FROM so that NULL never
  -- counts as an accepted match.
  if new.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000
      or (not v_held and (
        v_sale.surface_m2 is distinct from v_value_numeric
        or v_sale.app_surface_m2 is distinct from v_value_numeric
      )) then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000
      or (not v_held and v_sale.land_surface_m2 is distinct from v_value_numeric) then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent land surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100
      or (not v_held and v_sale.rooms_count is distinct from v_value_integer) then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent room count does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_integer);
  elsif new.fact_key = 'occupancy_status' then
    if not v_held and v_sale.occupancy_status is distinct from v_value_text then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent occupancy does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_text);
  elsif new.fact_key = 'starting_price_eur' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000000
      or v_sale.starting_price_eur is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent price does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'sale_date' then
    v_value_date := v_value_text::date;
    if v_sale.sale_date is null
      or v_sale.sale_date::date is distinct from v_value_date then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent sale date does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_sale.sale_date);
  elsif new.fact_key = 'property_type' then
    if v_sale.property_type is distinct from v_value_text then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent property type does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_text);
  end if;

  -- Champ tenu : l'observation doit porter une valeur que le registre peut tenir (sinon sa décision serait
  -- refusée et la réponse acceptée ne s'afficherait jamais).
  if v_held and app_private.sale_field_claim_value(v_field_key, v_value_jsonb) is null then
    raise exception using
      errcode = '23514',
      message = 'Accepted information-agent value cannot be held by the fact registry.';
  end if;

  -- A retry or a duplicate status write must never create a second accepted
  -- observation for the same reviewed response.
  select claim.id into v_existing_claim_id
  from public.auction_fact_claims claim
  where claim.evidence_locator->>'information_agent_fact_id' = new.id::text
  limit 1;
  if v_existing_claim_id is not null then
    return new;
  end if;

  insert into public.auction_fact_claims (
    auction_sale_id,
    field_key,
    value_jsonb,
    claim_status,
    evidence_kind,
    evidence_locator,
    confidence_score,
    extractor_name,
    extractor_version,
    captured_at,
    created_by,
    resolution_actor_type,
    resolution_actor_id,
    resolution_note,
    resolved_at,
    source_id
  ) values (
    new.sale_id,
    v_field_key,
    v_value_jsonb,
    'accepted',
    case
      when new.evidence_asset_id is null then
        case when v_actor_kind = 'admin' then 'manual_review' else 'professional_email' end
      when exists (
        select 1
        from public.information_agent_evidence_assets asset
        where asset.id = new.evidence_asset_id
          and asset.provider_attachment_id like 'portal:%'
      ) then 'portal_upload'
      else 'email_attachment'
    end,
    jsonb_build_object(
      'information_agent_fact_id', new.id,
      'case_id', new.case_id,
      'message_id', new.message_id,
      'evidence_asset_id', new.evidence_asset_id,
      'fact_key', new.fact_key,
      'source_page', new.source_page,
      'source_locator', left(new.source_locator, 300)
    ),
    greatest(least(new.confidence, 1), 0),
    'information_agent',
    coalesce(nullif(btrim(new.extraction_method), ''), 'reviewed_v1'),
    coalesce(new.created_at, statement_timestamp()),
    case when v_actor_kind = 'admin' then new.reviewed_by end,
    case when v_actor_kind = 'admin' then 'human' else 'agent' end,
    case when v_actor_kind = 'admin' then new.reviewed_by end,
    case
      when v_actor_kind = 'admin' then coalesce(
        nullif(btrim(new.review_notes), ''),
        'Réponse reçue et validée par un administrateur.'
      )
      else 'Réponse reçue et publiée automatiquement, sans relecture humaine (politique '
        || coalesce(v_policy_version, 'inconnue') || ').'
    end,
    coalesce(new.reviewed_at, statement_timestamp()),
    v_auto_source_id
  );

  return new;
end;
$function$;


revoke all on function app_private.bridge_accepted_information_agent_fact_claim()
from public, anon, authenticated;

comment on function app_private.bridge_accepted_information_agent_fact_claim() is
  'Pont d''un fait accepté de l''agent d''information vers une observation acceptée de auction_fact_claims. Auteur lu au journal des publications : administrateur relecteur, ou publication automatique (fait du corps du message, sans relecteur, version de règle ; origine professional_email).';

comment on function app_private.apply_information_agent_fact(uuid, text, uuid, text) is
  'Noyau de publication d''un fait accepté de l''agent d''information : raw_payload.information_agent_verified_facts, une ligne de journal, et la fiche pour un champ que le registre des pièces ne tient pas (un champ tenu est écrit par la décision et la projection). Appelé seulement par review_information_agent_fact_candidate (auteur admin) et par publish_information_agent_fact_auto (auteur auto).';

-- 6. Décision automatique du registre ---------------------------------------------------------------------------------
-- LA SEULE fonction qui écrit une décision automatique au journal du registre. Aucun droit pour aucun rôle de l'API ;
-- appelée seulement par public.publish_information_agent_fact_auto, dans la transaction de la publication. Elle ne lit
-- pas le jeton (l'auteur est « system », la décision porte la version de la règle). Elle n'accepte qu'une observation
-- créée par le pont de l'agent pour une publication automatique de même version, jamais décidée, d'un champ que le
-- registre tient pour une réponse d'avocat, sur une vente à un seul lot ; puis elle applique la projection de toute
-- la vente, comme une décision d'administrateur. Toute autre situation lève : la publication entière est annulée.
create or replace function app_private.accept_information_agent_claim_automatically(
  p_claim_id uuid,
  p_policy_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  v_claim record;
  v_fact_id uuid;
  v_fact record;
  v_publication record;
  v_sale record;
  v_decision_id uuid;
  v_projection jsonb;
begin
  if p_claim_id is null or p_policy_version is null
    or p_policy_version !~ '^auto_publication_v[0-9]{1,4}$'
  then
    raise exception using errcode = '22023', message = 'invalid_argument';
  end if;
  -- Échec fermé : pas d'écriture du registre sans ses déclencheurs.
  perform app_private.assert_fact_registry_triggers();

  select claim.auction_sale_id, claim.field_key, claim.value_jsonb, claim.evidence_kind, claim.extractor_name,
    claim.evidence_locator
  into v_claim
  from public.auction_fact_claims claim
  where claim.id = p_claim_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'claim_not_found';
  end if;
  if v_claim.auction_sale_id is null then
    raise exception using errcode = '55000', message = 'claim_detached';
  end if;
  -- Observation du pont de l'agent, d'une réponse d'avocat par e-mail, et rien d'autre.
  if v_claim.extractor_name is distinct from 'information_agent'
    or v_claim.evidence_kind is distinct from 'professional_email'
    or app_private.fact_claim_source_kind(
      v_claim.evidence_kind, v_claim.extractor_name, v_claim.evidence_locator
    ) is distinct from 'lawyer_email'
    or coalesce(v_claim.evidence_locator ->> 'information_agent_fact_id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    raise exception using errcode = '55000', message = 'origin_not_automatic';
  end if;
  v_fact_id := (v_claim.evidence_locator ->> 'information_agent_fact_id')::uuid;

  -- L'observation porte la vente et la valeur du fait (jamais une autre).
  select fact.sale_id, app_private.information_agent_auto_publication_value(fact.proposed_value) as value
  into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = v_fact_id;
  if not found
    or v_fact.sale_id is distinct from v_claim.auction_sale_id
    or pg_catalog.jsonb_typeof(v_claim.value_jsonb) is distinct from 'number'
    or v_fact.value is null
    or (v_claim.value_jsonb #>> '{}')::numeric <> v_fact.value
  then
    raise exception using errcode = '55000', message = 'claim_does_not_match_fact';
  end if;

  -- Le fait a été publié automatiquement, avec cette version, pour l'avocat poursuivant.
  select publication.recipient_kind, publication.response_received_at
  into v_publication
  from public.information_agent_fact_publications publication
  where publication.fact_id = v_fact_id
    and publication.actor_kind = 'auto'
    and publication.policy_version = p_policy_version
  order by publication.published_at desc, publication.id desc
  limit 1;
  if not found or v_publication.recipient_kind is distinct from 'source_lawyer' then
    raise exception using errcode = '55000', message = 'not_published_automatically';
  end if;

  -- La vente d'abord, puis l'observation (même ordre que la décision d'un administrateur).
  if not app_private.lock_sale_for_registry(v_claim.auction_sale_id) then
    raise exception using errcode = 'P0002', message = 'sale_not_found';
  end if;
  perform 1 from public.auction_fact_claims claim
  where claim.id = p_claim_id and claim.auction_sale_id = v_claim.auction_sale_id
  for no key update;
  if not found then
    raise exception using errcode = '40001', message = 'retry';
  end if;
  if exists (
    select 1 from public.auction_fact_claim_decisions decision where decision.claim_id = p_claim_id
  ) then
    raise exception using errcode = '55000', message = 'already_decided';
  end if;

  -- Champ que le registre tient pour une réponse d'avocat, valeur qu'il peut tenir.
  if not exists (
    select 1
    from public.auction_fact_fields field
    join public.auction_fact_source_precedence precedence on precedence.field_key = field.field_key
    where field.field_key = v_claim.field_key
      and field.hold_enabled
      and precedence.source_kind = 'lawyer_email'
      and precedence.can_hold
  ) then
    raise exception using errcode = '55000', message = 'origin_cannot_hold';
  end if;
  if app_private.sale_field_claim_value(v_claim.field_key, v_claim.value_jsonb) is null then
    raise exception using errcode = '22023', message = 'invalid_argument';
  end if;

  -- Vente à un seul lot (seul rattachement qu'une décision sans personne peut dire), et pas de surface bâtie
  -- sur un terrain.
  select app_private.sale_is_land_sale(
      sale.property_type, sale.surface_scope, sale.app_surface_kind, sale.held_fields
    ) as land,
    coalesce(sale.quality_flags ? 'multi_lot_sale', false)
      or coalesce(pg_catalog.jsonb_typeof(sale.raw_payload -> 'source_lot_selection'), 'null') <> 'null'
      as multi_lot
  into v_sale
  from public.auction_sales sale
  where sale.id = v_claim.auction_sale_id;
  if v_sale.multi_lot then
    raise exception using errcode = '55000', message = 'multi_lot_sale';
  end if;
  if v_claim.field_key = 'property.surface_m2' and v_sale.land then
    raise exception using errcode = '55000', message = 'field_not_applicable';
  end if;

  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, information_agent_fact_id,
    recipient_kind, received_at, publication_mode, policy_version
  ) values (
    p_claim_id, v_claim.auction_sale_id, v_claim.field_key, 'accepted', 'single_lot', 'system', null, v_fact_id,
    'source_lawyer', v_publication.response_received_at, 'auto', p_policy_version
  )
  returning id into v_decision_id;

  -- Projection de toute la vente, dans la même transaction.
  v_projection := app_private.project_sale_fields(v_claim.auction_sale_id, null, true);

  return pg_catalog.jsonb_build_object(
    'claim_id', p_claim_id,
    'decision_id', v_decision_id,
    'sale_id', v_claim.auction_sale_id,
    'field_key', v_claim.field_key,
    'state', v_projection #> array['fields', v_claim.field_key, 'state']
  );
end;
$$;

comment on function app_private.accept_information_agent_claim_automatically(uuid, text) is
  'Registre des pièces : seule décision automatique (acceptation, auteur system, version de règle), pour une observation du pont de l''agent publiée automatiquement, jamais décidée, sur une vente à un seul lot ; projection de toute la vente. Appelée seulement par public.publish_information_agent_fact_auto. Aucun droit pour aucun rôle de l''API.';

revoke all on function app_private.accept_information_agent_claim_automatically(uuid, text)
  from public, anon, authenticated, service_role;

-- 7. Publication automatique : le seul chemin d'écriture 'auto' -----------------------------------------------------
-- Signature à trois arguments d'une version antérieure de cette migration : retirée, pour qu'il ne reste qu'un chemin.
drop function if exists public.publish_information_agent_fact_auto(uuid, text, text);

create or replace function public.publish_information_agent_fact_auto(
  p_fact_id uuid,
  p_fact_key text,
  p_policy_version text,
  p_arbiter_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  v_mode text;
  v_fact public.information_agent_fact_candidates%rowtype;
  v_message record;
  v_case record;
  v_arbitration record;
  v_value numeric;
  v_reasons text[] := '{}'::text[];
  v_day_start timestamptz;
  v_claim_id uuid;
  v_registry jsonb;
  v_evidence text;
begin
  if p_policy_version is null or p_policy_version !~ '^auto_publication_v[0-9]{1,4}$' then
    raise exception using errcode = '22023', message = 'Invalid policy version.';
  end if;
  if p_arbiter_version is null or p_arbiter_version !~ '^auto_publication_arbiter_v[0-9]{1,4}$' then
    raise exception using errcode = '22023', message = 'Invalid arbiter version.';
  end if;

  -- a. Mode relu sous verrou partagé : l'arrêt d'urgence (verrou exclusif) attend cette publication, puis bloque
  --    toutes les suivantes.
  select settings.mode into v_mode
  from public.information_agent_auto_publication_settings settings
  where settings.singleton
  for share;
  if v_mode is distinct from 'auto' then
    return pg_catalog.jsonb_build_object('status', 'inactive');
  end if;

  -- b. Une publication à la fois : les plafonds sont comptés exactement.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('information_agent_auto_publication:publish', 0)
  );

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;
  if v_fact.id is null then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  if v_fact.fact_key is distinct from p_fact_key then
    raise exception using errcode = '22023', message = 'The publication does not match the fact key.';
  end if;

  -- Déjà publié (second appel après une réponse perdue, ou deux passes) : rien n'est réécrit.
  if v_fact.status = 'accepted' and exists (
    select 1 from public.information_agent_auto_publication_decisions decision
    where decision.fact_id = v_fact.id and decision.outcome = 'published'
  ) then
    return pg_catalog.jsonb_build_object('status', 'already_published', 'fact_id', v_fact.id);
  end if;

  -- c. Contrôles de sécurité, redits en base.
  if v_fact.status <> 'pending' or v_fact.reviewed_by is not null then
    v_reasons := v_reasons || 'candidate_not_pending'::text;
  end if;
  if v_fact.fact_key not in ('surface_m2', 'land_surface_m2', 'rooms_count') then
    v_reasons := v_reasons || 'field_not_eligible'::text;
  end if;
  if v_fact.evidence_asset_id is not null then
    v_reasons := v_reasons || 'attachment_source'::text;
  end if;

  select message.direction, message.metadata, message.received_at into v_message
  from public.information_agent_messages message
  where message.id = v_fact.message_id;
  if not found or pg_catalog.jsonb_typeof(v_message.metadata) is distinct from 'object' then
    v_reasons := v_reasons || 'input_unreadable'::text;
  else
    if v_message.direction is distinct from 'inbound'
      or (v_message.metadata ->> 'imported_manually') is distinct from 'false'
      or coalesce(v_message.metadata ->> 'channel', 'email') <> 'email'
    then
      v_reasons := v_reasons || 'not_email_reply'::text;
    end if;
    if (v_message.metadata ->> 'sender_matches_recipient') is distinct from 'true' then
      v_reasons := v_reasons || 'sender_not_contacted_address'::text;
    end if;
    if (v_message.metadata #>> '{sender_authentication,dkim}') is distinct from 'pass'
      or (v_message.metadata #>> '{sender_authentication,dmarc}') is distinct from 'pass'
    then
      v_reasons := v_reasons || 'sender_not_authenticated'::text;
    end if;
    -- La réponse elle-même est traitée, sans autre motif de relecture que le motif générique.
    if not app_private.information_agent_message_processed_for_publication(v_message.metadata, true) then
      v_reasons := v_reasons || 'reply_in_review'::text;
    end if;
  end if;

  -- Tout le message est lu : une pièce jointe ou la lecture du corps encore en file, en cours ou à reprendre peut
  -- contredire la valeur ; une pièce illisible ou lue en partie renvoie à la relecture humaine.
  v_evidence := app_private.information_agent_message_evidence_state(v_fact.message_id);
  if v_evidence = 'pending' then
    v_reasons := v_reasons || 'evidence_pending'::text;
  elsif v_evidence is not null then
    v_reasons := v_reasons || 'attachment_unreadable'::text;
  end if;

  select case_row.recipient_kind, case_row.status, case_row.metadata, case_row.normalized_recipient_email,
    case_row.sent_at
  into v_case
  from public.information_agent_cases case_row
  where case_row.id = v_fact.case_id;
  if not found then
    v_reasons := v_reasons || 'input_unreadable'::text;
  else
    if v_case.recipient_kind is distinct from 'source_lawyer' then
      v_reasons := v_reasons || 'recipient_not_lawyer'::text;
    end if;
    if v_case.status not in ('replied', 'review')
      or coalesce(v_case.metadata ->> 'last_inbound_contact_opposed', 'false') <> 'false'
    then
      v_reasons := v_reasons || 'case_not_replied'::text;
    end if;
    if exists (
      select 1 from public.information_agent_contacts contact
      where contact.normalized_email = v_case.normalized_recipient_email
        and contact.opposition_status = 'opposed'
    ) then
      v_reasons := v_reasons || 'contact_opposed'::text;
    end if;
    -- Réponse reçue moins de 30 jours après l'envoi (même délai que le moteur).
    if v_case.sent_at is null or v_message.received_at is null then
      v_reasons := v_reasons || 'input_unreadable'::text;
    elsif v_message.received_at < v_case.sent_at
      or v_message.received_at - v_case.sent_at >= interval '30 days'
    then
      v_reasons := v_reasons || 'reply_outside_window'::text;
    end if;
  end if;

  -- Aucun autre message entrant du dossier en relecture bloquante, en cours de traitement, opposé ou adressé à un
  -- autre destinataire (la demande « ne pas publier » écrite dans un autre message est lue par le moteur).
  if exists (
    select 1 from public.information_agent_messages other
    where other.case_id = v_fact.case_id
      and other.id <> v_fact.message_id
      and other.direction = 'inbound'
      and (
        not app_private.information_agent_message_processed_for_publication(other.metadata, false)
        or coalesce(other.metadata ->> 'admin_handled_action', '') in ('record_opposition', 'wrong_recipient')
      )
  ) then
    v_reasons := v_reasons || 'other_message_in_case'::text;
  end if;

  -- Dernier verdict de Haiku : « publier », de la version courante du prompt, pour la valeur du fait.
  v_value := app_private.information_agent_auto_publication_value(v_fact.proposed_value);
  select arbitration.status, arbitration.publish, arbitration.value, arbitration.prompt_version
  into v_arbitration
  from public.information_agent_auto_publication_arbitrations arbitration
  where arbitration.fact_id = v_fact.id
  order by arbitration.recorded_at desc, arbitration.id desc
  limit 1;
  if not found or v_arbitration.prompt_version is distinct from p_arbiter_version then
    v_reasons := v_reasons || 'arbiter_pending'::text;
  elsif v_arbitration.status = 'skipped' then
    v_reasons := v_reasons || 'arbiter_skipped'::text;
  elsif v_arbitration.status <> 'completed' then
    v_reasons := v_reasons || 'arbiter_unavailable'::text;
  elsif not v_arbitration.publish then
    v_reasons := v_reasons || 'arbiter_declined'::text;
  elsif v_value is null or v_arbitration.value <> v_value then
    v_reasons := v_reasons || 'arbiter_value_mismatch'::text;
  end if;

  -- Champ vide sur la fiche (toute colonne que la fiche peut afficher) et vente à un seul lot.
  v_reasons := v_reasons || app_private.information_agent_auto_publication_sale_blocks(v_fact.sale_id, v_fact.fact_key);

  -- Plafonds : 10 publications par jour de Paris, 2 par dossier.
  if cardinality(v_reasons) = 0 then
    v_day_start := (
      pg_catalog.date_trunc('day', pg_catalog.statement_timestamp() at time zone 'Europe/Paris')
    ) at time zone 'Europe/Paris';
    if (
      select count(distinct decision.fact_id)
      from public.information_agent_auto_publication_decisions decision
      where decision.outcome = 'published' and decision.decided_at >= v_day_start
    ) >= 10 then
      v_reasons := v_reasons || 'daily_cap_reached'::text;
    end if;
    if (
      select count(distinct decision.fact_id)
      from public.information_agent_auto_publication_decisions decision
      where decision.outcome = 'published' and decision.case_id = v_fact.case_id
    ) >= 2 then
      v_reasons := v_reasons || 'case_cap_reached'::text;
    end if;
  end if;

  if cardinality(v_reasons) > 0 then
    perform app_private.write_information_agent_auto_publication_decision(
      v_fact.id, v_fact.case_id, v_fact.sale_id, v_fact.fact_key, 'auto', 'review', v_reasons,
      p_policy_version
    );
    return pg_catalog.jsonb_build_object('status', 'review', 'reasons', pg_catalog.to_jsonb(v_reasons));
  end if;

  -- d. Publication : fait accepté sans relecteur, noyau, observation, décision du registre, journal du moteur.
  update public.information_agent_fact_candidates fact
  set status = 'accepted', reviewed_by = null, reviewed_at = pg_catalog.statement_timestamp(),
      review_notes = null, updated_at = pg_catalog.statement_timestamp()
  where fact.id = v_fact.id;

  perform app_private.apply_information_agent_fact(v_fact.id, 'auto', null, p_policy_version);

  -- Le pont est différé à la fin de la transaction ; il est rendu immédiat ici pour que l'observation existe avant
  -- la décision du registre, puis remis en différé.
  set constraints public.information_agent_fact_claim_bridge immediate;
  set constraints public.information_agent_fact_claim_bridge deferred;

  -- L'observation du pont pour ce fait et cette vente (la plus récente, ordre déterministe).
  select claim.id into v_claim_id
  from public.auction_fact_claims claim
  where claim.evidence_locator ->> 'information_agent_fact_id' = v_fact.id::text
    and claim.auction_sale_id = v_fact.sale_id
  order by claim.created_at desc, claim.id desc
  limit 1;
  if v_claim_id is null then
    raise exception using errcode = '55000', message = 'The automatic publication has no fact claim.';
  end if;

  v_registry := app_private.accept_information_agent_claim_automatically(v_claim_id, p_policy_version);

  perform app_private.write_information_agent_auto_publication_decision(
    v_fact.id, v_fact.case_id, v_fact.sale_id, v_fact.fact_key, 'auto', 'published', '{}'::text[],
    p_policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'published',
    'fact_id', v_fact.id,
    'claim_id', v_claim_id,
    'decision_id', v_registry -> 'decision_id',
    'state', v_registry -> 'state'
  );
end;
$$;

comment on function public.publish_information_agent_fact_auto(uuid, text, text, text) is
  'Agent d''information, étape 6 : seul chemin de publication automatique (auteur auto). Mode relu sous verrou partagé (rien hors du mode auto), fait déjà publié rendu sans écriture, contrôles de sécurité redits en base (dont analyses du message finies, délai de 30 jours, autres messages du dossier, verdict de la version courante du prompt), plafonds exacts (10 par jour, 2 par dossier), puis fait accepté, noyau, observation, décision automatique du registre et décision « published », dans une seule transaction. Service_role seul ; appelée par src/lib/information-agent/auto-publication-store.ts.';

revoke all on function public.publish_information_agent_fact_auto(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_information_agent_fact_auto(uuid, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
