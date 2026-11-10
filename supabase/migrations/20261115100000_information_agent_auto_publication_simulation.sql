begin;

set local lock_timeout = '5s';

-- Agent d'information, étape 3 du plan d'enrichissement (propositions 6 et 7, validées le 10/11/2026) :
-- moteur de décision « publier ou relire » en SIMULATION seulement, réglage à trois modes, journal, verrous.
--
-- AUCUN CHEMIN NE PUBLIE. Cette migration ne touche ni à app_private.apply_information_agent_fact, ni au pont
-- vers auction_fact_claims (qui refuse toujours actor_kind = 'auto'), ni à public.auction_sales. Le moteur est
-- en TypeScript (src/lib/information-agent/auto-publication-policy.ts) ; la base garde le réglage, le
-- journal des décisions et la trace des changements de mode.
--
--   1. public.information_agent_auto_publication_settings : ligne unique, mode 'off' (défaut), 'simulation'
--      ou 'auto'. Le mode 'auto' est VERROUILLÉ par la contrainte
--      information_agent_auto_publication_settings_auto_locked : seule une migration de l'étape 6 (textes
--      juridiques publiés, AIPD signée, avocat, jeu d'évaluation, simulation concluante) pourra la retirer.
--   2. public.information_agent_auto_publication_mode_changes : trace en ajout seul de chaque changement de
--      mode (qui, quand, ancien et nouveau mode, arrêt d'urgence ou non). Aucun texte libre.
--   3. public.information_agent_auto_publication_decisions : journal en ajout seul des décisions du moteur
--      (fait, dossier, vente, clé, issue, codes de motifs, version de la règle). Ni adresse, ni extrait, ni
--      texte issu du message : les motifs sont des codes en snake_case (contrainte), aucune autre colonne
--      texte n'est libre. Une décision « would_publish » n'est possible que pour un champ de la liste fermée
--      (contrainte comparée à AUTO_PUBLICATION_ELIGIBLE_FIELDS par un test). Les lignes suivent la vente :
--      supprimées seulement quand la vente l'est (déclencheur), jamais par l'API.
--   4. RPC d'administration (is_admin, jeton de l'administrateur) : set_information_agent_auto_publication_mode
--      (refuse 'auto') et stop_information_agent_auto_publication (arrêt d'urgence, toujours permis).
--      RPC de service : record_information_agent_auto_publication_decision, qui n'écrit qu'en mode
--      'simulation' (le mode est relu sous verrou partagé : après un arrêt, plus rien n'est écrit).
--
-- Aucune ligne existante n'est modifiée.
--
-- Retour arrière (aucune donnée à reprendre ; le journal n'est qu'une trace de simulation) : dans une
-- transaction, supprimer les fonctions public.record_information_agent_auto_publication_decision(uuid, text,
-- text, text[], text), public.set_information_agent_auto_publication_mode(text),
-- public.stop_information_agent_auto_publication(), puis les trois tables, puis
-- app_private.information_agent_auto_publication_append_only(). Déployer d'abord le code de l'application qui ne les lit plus (sans la table des
-- réglages, la simulation s'arrête : le code lit alors le mode comme une erreur et ne décide rien).

-- 1. Réglage ---------------------------------------------------------------------------------------------------
create table if not exists public.information_agent_auto_publication_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'off' check (mode in ('off', 'simulation', 'auto')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  -- Verrou de l'étape 3 : le mode automatique ne peut pas être enregistré.
  constraint information_agent_auto_publication_settings_auto_locked check (mode <> 'auto')
);

comment on table public.information_agent_auto_publication_settings is
  'Mode de la publication automatique des informations de l''agent (ligne unique) : off (défaut), simulation, auto (verrouillé par contrainte). Modifié seulement par set_/stop_information_agent_auto_publication (is_admin), chaque changement tracé dans information_agent_auto_publication_mode_changes.';

insert into public.information_agent_auto_publication_settings (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.information_agent_auto_publication_settings enable row level security;
revoke all on table public.information_agent_auto_publication_settings
  from public, anon, authenticated, service_role;
-- Lecture serveur seulement ; seules les RPC (security definer) écrivent.
grant select on table public.information_agent_auto_publication_settings to service_role;

-- 2. Trace des changements de mode -------------------------------------------------------------------------------
create table if not exists public.information_agent_auto_publication_mode_changes (
  id uuid primary key default gen_random_uuid(),
  changed_at timestamptz not null default statement_timestamp(),
  -- Administrateur auteur du changement (sans clé étrangère : la trace ne dépend pas du compte).
  actor_id uuid not null,
  previous_mode text not null check (previous_mode in ('off', 'simulation', 'auto')),
  new_mode text not null check (new_mode in ('off', 'simulation', 'auto')),
  emergency_stop boolean not null default false,
  constraint information_agent_auto_publication_mode_changes_stop_check check (
    not emergency_stop or new_mode = 'off'
  )
);

create index if not exists information_agent_auto_publication_mode_changes_at_idx
  on public.information_agent_auto_publication_mode_changes (changed_at desc);

comment on table public.information_agent_auto_publication_mode_changes is
  'Trace en ajout seul des changements de mode de la publication automatique : qui, quand, ancien et nouveau mode, arrêt d''urgence. Aucun texte libre.';

alter table public.information_agent_auto_publication_mode_changes enable row level security;
revoke all on table public.information_agent_auto_publication_mode_changes
  from public, anon, authenticated, service_role;
grant select on table public.information_agent_auto_publication_mode_changes to service_role;

-- 3. Journal des décisions -----------------------------------------------------------------------------------------
-- fact_id et case_id sans clé étrangère : le journal survit à la purge des messages et des dossiers (les
-- identifiants seuls ne contiennent aucune donnée). sale_id suit la vente (on delete cascade) : le déclencheur
-- d'ajout seul laisse partir une ligne quand sa vente n'existe plus, et rien d'autre.
create table if not exists public.information_agent_auto_publication_decisions (
  id uuid primary key default gen_random_uuid(),
  decided_at timestamptz not null default statement_timestamp(),
  -- Seul le mode simulation écrit à cette étape.
  mode text not null check (mode = 'simulation'),
  policy_version text not null check (policy_version ~ '^auto_publication_v[0-9]{1,4}$'),
  fact_id uuid not null,
  case_id uuid not null,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  fact_key text not null check (fact_key ~ '^[a-z0-9_]{1,64}$'),
  outcome text not null check (outcome in ('would_publish', 'review')),
  -- Codes de motifs seulement (snake_case) : aucun texte libre, aucune adresse.
  reasons text[] not null default '{}'::text[],
  constraint information_agent_auto_publication_decisions_reasons_check check (
    cardinality(reasons) <= 32
    and array_to_string(reasons, ',') ~ '^([a-z0-9_]{1,64}(,[a-z0-9_]{1,64})*)?$'
    and array_position(reasons, null) is null
  ),
  constraint information_agent_auto_publication_decisions_outcome_check check (
    (outcome = 'would_publish') = (cardinality(reasons) = 0)
  ),
  -- Liste fermée des champs éligibles : même liste que AUTO_PUBLICATION_ELIGIBLE_FIELDS (test de concordance).
  constraint information_agent_auto_publication_decisions_eligible_check check (
    outcome <> 'would_publish' or fact_key in ('surface_m2', 'land_surface_m2', 'rooms_count')
  )
);

create index if not exists information_agent_auto_publication_decisions_fact_idx
  on public.information_agent_auto_publication_decisions (fact_id, decided_at desc);
create index if not exists information_agent_auto_publication_decisions_publish_idx
  on public.information_agent_auto_publication_decisions (decided_at desc)
  where outcome = 'would_publish';
create index if not exists information_agent_auto_publication_decisions_case_idx
  on public.information_agent_auto_publication_decisions (case_id)
  where outcome = 'would_publish';
create index if not exists information_agent_auto_publication_decisions_sale_idx
  on public.information_agent_auto_publication_decisions (sale_id);

comment on table public.information_agent_auto_publication_decisions is
  'Journal en ajout seul des décisions du moteur « publier ou relire » (simulation) : fait, dossier, vente, clé, issue, codes de motifs, version de la règle. Ni adresse, ni extrait, ni texte issu du message. Suit la vente.';

alter table public.information_agent_auto_publication_decisions enable row level security;
revoke all on table public.information_agent_auto_publication_decisions
  from public, anon, authenticated, service_role;
-- Lecture serveur seulement ; l'écriture passe par la RPC de service, qui contrôle le mode.
grant select on table public.information_agent_auto_publication_decisions to service_role;

-- Ajout seul (journal et trace) : ni modification, ni suppression, ni vidage. Exception unique : une décision
-- dont la vente a été supprimée (purge des ventes) peut partir.
create or replace function app_private.information_agent_auto_publication_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and tg_table_name = 'information_agent_auto_publication_decisions'
    and not exists (select 1 from public.auction_sales sale where sale.id = old.sale_id)
  then
    return old;
  end if;
  raise exception using errcode = '55000',
    message = 'Le journal de la publication automatique est en ajout seul.';
end;
$$;

revoke all on function app_private.information_agent_auto_publication_append_only()
  from public, anon, authenticated, service_role;

drop trigger if exists information_agent_auto_publication_decisions_append_only
  on public.information_agent_auto_publication_decisions;
create trigger information_agent_auto_publication_decisions_append_only
  before update or delete on public.information_agent_auto_publication_decisions
  for each row execute function app_private.information_agent_auto_publication_append_only();

drop trigger if exists information_agent_auto_publication_decisions_no_truncate
  on public.information_agent_auto_publication_decisions;
create trigger information_agent_auto_publication_decisions_no_truncate
  before truncate on public.information_agent_auto_publication_decisions
  for each statement execute function app_private.information_agent_auto_publication_append_only();

drop trigger if exists information_agent_auto_publication_mode_changes_append_only
  on public.information_agent_auto_publication_mode_changes;
create trigger information_agent_auto_publication_mode_changes_append_only
  before update or delete on public.information_agent_auto_publication_mode_changes
  for each row execute function app_private.information_agent_auto_publication_append_only();

drop trigger if exists information_agent_auto_publication_mode_changes_no_truncate
  on public.information_agent_auto_publication_mode_changes;
create trigger information_agent_auto_publication_mode_changes_no_truncate
  before truncate on public.information_agent_auto_publication_mode_changes
  for each statement execute function app_private.information_agent_auto_publication_append_only();

-- 4. RPC d'administration ---------------------------------------------------------------------------------------
-- Ouvertes à authenticated (jeton de l'administrateur, contrôle is_admin()) : liste blanche du test 441.
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
  if p_mode = 'auto' then
    raise exception using errcode = '55000',
      message = 'Mode automatique verrouillé : textes juridiques, AIPD, validation par un avocat, jeu d''évaluation et simulation concluante requis.';
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

-- Arrêt d'urgence : toujours permis à un administrateur, sans condition ni motif, effet immédiat.
create or replace function public.stop_information_agent_auto_publication()
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
  select * into v_before
  from public.information_agent_auto_publication_settings settings
  where settings.singleton
  for update;
  if v_before.singleton is null then
    raise exception using errcode = 'P0002', message = 'Réglage de publication automatique absent.';
  end if;
  if v_before.mode = 'off' then
    return v_before;
  end if;

  update public.information_agent_auto_publication_settings settings
  set mode = 'off', updated_by = v_actor, updated_at = pg_catalog.statement_timestamp()
  where settings.singleton
  returning * into v_after;

  insert into public.information_agent_auto_publication_mode_changes (
    actor_id, previous_mode, new_mode, emergency_stop
  ) values (v_actor, v_before.mode, 'off', true);
  return v_after;
end;
$$;

revoke all on function public.stop_information_agent_auto_publication()
  from public, anon, authenticated;
grant execute on function public.stop_information_agent_auto_publication()
  to authenticated, service_role;

-- 5. Écriture d'une décision (serveur) ----------------------------------------------------------------------------
-- N'écrit qu'en mode 'simulation' (renvoie faux sinon) ; le mode est lu sous verrou partagé, donc un arrêt
-- d'urgence attend la fin de l'écriture en cours puis bloque toutes les suivantes. Dossier et vente sont lus
-- sur le fait (jamais fournis par l'appelant). Une décision identique à la dernière du fait (issue, motifs,
-- version) n'est pas réécrite.
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
  v_reasons text[] := coalesce(p_reasons, '{}'::text[]);
  v_last public.information_agent_auto_publication_decisions%rowtype;
begin
  select settings.mode into v_mode
  from public.information_agent_auto_publication_settings settings
  where settings.singleton
  for share;
  if v_mode is distinct from 'simulation' then
    return false;
  end if;

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id;
  if v_fact.id is null then
    raise exception using errcode = 'P0002', message = 'Information agent fact not found.';
  end if;
  if v_fact.fact_key is distinct from p_fact_key then
    raise exception using errcode = '22023', message = 'The decision does not match the fact key.';
  end if;

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

  insert into public.information_agent_auto_publication_decisions (
    mode, policy_version, fact_id, case_id, sale_id, fact_key, outcome, reasons
  ) values (
    'simulation', p_policy_version, v_fact.id, v_fact.case_id, v_fact.sale_id, v_fact.fact_key,
    p_outcome, v_reasons
  );
  return true;
end;
$$;

revoke all on function public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)
  to service_role;

notify pgrst, 'reload schema';

commit;
