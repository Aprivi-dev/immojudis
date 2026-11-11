begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M1 (plan du 11/11/2026, docs/equipe/2026-11-11-registre-des-pieces.md ;
-- spécification : annexe 03-base-de-donnees-arbitrage.md). Fondations INERTES : aucune fiche ne change, aucun
-- code ne lit ni n'écrit ces tables à ce lot.
--
--   1. public.auction_fact_fields : une ligne par champ que le registre sait tenir (surface, terrain, nombre de
--      pièces, occupation, dates de visite), avec les colonnes de la fiche tenues ensemble, le type de valeur,
--      les tolérances, le réglage « l'annonce change » et l'interrupteur hold_enabled. Données de départ : les
--      quatre premiers champs tenables, pas les visites. Toujours « keep_and_review » au départ (choix 1 du plan).
--   2. public.auction_fact_source_precedence : rang et droit de tenir par champ et par origine de pièce. Départ :
--      admin 10, lawyer_form 20, lawyer_email 30, document 50 (tous tenables, mais seulement après une décision
--      d'acceptation humaine), listing 60 (jamais : contrainte auction_fact_source_precedence_listing_never_holds).
--   3. public.auction_fact_claim_decisions : journal des décisions sur les observations de auction_fact_claims,
--      en AJOUT SEUL (ni modification, ni suppression, ni vidage). Le statut effectif d'une observation est sa
--      dernière décision. Publication automatique impossible (contrainte
--      auction_fact_claim_decisions_auto_locked) ; une acceptation vient toujours d'une personne (administrateur
--      ou avocat), jamais du système.
--   4. public.auction_sale_field_hold_events : file de relecture des champs tenus, en ajout seul (l'annonce a
--      changé, une pièce a été posée ou retirée, deux pièces se contredisent).
--
-- Aucune clé étrangère vers public.auction_sales : elle prendrait un verrou SHARE ROW EXCLUSIVE sur la table
-- chaude, et une suppression en cascade effacerait l'audit lors d'une fusion de doublons (les fusions se suivent
-- par app_private.auction_sale_merges). Les quatre tables sont fermées aux rôles de l'API : RLS sans politique,
-- tout retiré à public, anon, authenticated et service_role, puis SELECT seul pour service_role. Seules des
-- fonctions SECURITY DEFINER (lot R2) y écriront.
--
-- Verrous : la clé étrangère claim_id prend un SHARE ROW EXCLUSIVE bref sur public.auction_fact_claims (les
-- insertions d'observations de la collecte attendent quelques millisecondes). Aucun verrou sur auction_sales.
-- À appliquer hors import (lock_timeout 5 s : la migration échoue sans effet si le verrou n'est pas obtenu).
--
-- Retour arrière (sans perte tant que le lot R2 n'a rien écrit ; ensuite, garder les journaux, qui sont l'audit) :
--   begin; set local lock_timeout = '5s';
--   drop table if exists public.auction_sale_field_hold_events, public.auction_fact_claim_decisions,
--     public.auction_fact_source_precedence, public.auction_fact_fields;
--   drop function if exists app_private.fact_registry_append_only();
--   drop function if exists app_private.validate_auction_fact_claim_decision();
--   commit;
-- Les migrations suivantes du lot (20261116100500) dépendent de ces tables : les retirer d'abord.

-- 1. Champs tenables ------------------------------------------------------------------------------------------
create table if not exists public.auction_fact_fields (
  field_key text primary key,
  held_columns text[] not null,
  value_type text not null check (value_type in ('numeric', 'integer', 'enum', 'date_list')),
  abs_tolerance numeric check (abs_tolerance is null or abs_tolerance >= 0),
  rel_tolerance numeric check (rel_tolerance is null or rel_tolerance between 0 and 0.2),
  on_listing_change text not null default 'keep_and_review' check (
    on_listing_change in ('keep_and_review', 'listing_wins_and_review')
  ),
  hold_enabled boolean not null default false,
  -- Le déclencheur de retenue (20261116100500) connaît ces cinq champs et leurs colonnes en dur, et se déclenche
  -- sur ces seules colonnes : la forme de chaque ligne est donc fixée ici, pour que les données ne puissent pas
  -- annoncer une colonne que la base ne protège pas.
  constraint auction_fact_fields_shape check (
    case field_key
      when 'property.surface_m2' then value_type = 'numeric' and held_columns = array[
        'surface_m2', 'app_surface_m2', 'app_surface_kind', 'surface_source', 'surface_confidence'
      ]::text[]
      when 'property.land_surface_m2' then value_type = 'numeric'
        and held_columns = array['land_surface_m2']::text[]
      when 'property.rooms_count' then value_type = 'integer'
        and held_columns = array['rooms_count']::text[]
      when 'property.occupancy_status' then value_type = 'enum'
        and held_columns = array['occupancy_status']::text[]
      when 'sale.visit_dates' then value_type = 'date_list'
        and held_columns = array['visit_dates']::text[]
      else false
    end
  ),
  -- Une tolérance n'a de sens que pour un nombre décimal.
  constraint auction_fact_fields_tolerance_numeric check (
    value_type = 'numeric' or (abs_tolerance is null and rel_tolerance is null)
  )
);

comment on table public.auction_fact_fields is
  'Registre des pièces : champs de la fiche qu''une pièce acceptée peut tenir, colonnes tenues ensemble, type, tolérances, réglage quand l''annonce change (keep_and_review par défaut) et interrupteur hold_enabled. Données versionnées par migration.';

insert into public.auction_fact_fields (
  field_key, held_columns, value_type, abs_tolerance, rel_tolerance, on_listing_change, hold_enabled
) values
  (
    'property.surface_m2',
    array['surface_m2', 'app_surface_m2', 'app_surface_kind', 'surface_source', 'surface_confidence']::text[],
    'numeric', 1, 0.02, 'keep_and_review', true
  ),
  ('property.land_surface_m2', array['land_surface_m2']::text[], 'numeric', 1, 0.02, 'keep_and_review', true),
  ('property.rooms_count', array['rooms_count']::text[], 'integer', null, null, 'keep_and_review', true),
  ('property.occupancy_status', array['occupancy_status']::text[], 'enum', null, null, 'keep_and_review', true),
  -- Pas de fait de visite structuré tant que le noyau ne publie pas de visites : non tenable au départ.
  ('sale.visit_dates', array['visit_dates']::text[], 'date_list', null, null, 'keep_and_review', false)
on conflict (field_key) do nothing;

alter table public.auction_fact_fields enable row level security;
revoke all on table public.auction_fact_fields from public, anon, authenticated, service_role;
grant select on table public.auction_fact_fields to service_role;

-- 2. Préséance des origines ----------------------------------------------------------------------------------
create table if not exists public.auction_fact_source_precedence (
  field_key text not null references public.auction_fact_fields(field_key) on delete restrict,
  source_kind text not null check (
    source_kind in ('admin', 'lawyer_form', 'lawyer_email', 'document', 'listing')
  ),
  -- 1 = le plus fort.
  rank smallint not null check (rank between 1 and 100),
  can_hold boolean not null default false,
  primary key (field_key, source_kind),
  -- L'annonce reste la valeur par défaut des colonnes : elle ne tient jamais un champ.
  constraint auction_fact_source_precedence_listing_never_holds check (
    not can_hold or source_kind <> 'listing'
  )
);

comment on table public.auction_fact_source_precedence is
  'Registre des pièces : rang (1 = le plus fort) et droit de tenir un champ par origine de pièce. Une pièce ne tient un champ qu''après une décision d''acceptation humaine ; l''annonce ne tient jamais (contrainte auction_fact_source_precedence_listing_never_holds).';

insert into public.auction_fact_source_precedence (field_key, source_kind, rank, can_hold)
select fields.field_key, origins.source_kind, origins.rank, origins.can_hold
from public.auction_fact_fields fields
cross join (
  values
    ('admin', 10::smallint, true),
    ('lawyer_form', 20::smallint, true),
    ('lawyer_email', 30::smallint, true),
    ('document', 50::smallint, true),
    ('listing', 60::smallint, false)
) as origins (source_kind, rank, can_hold)
on conflict do nothing;

alter table public.auction_fact_source_precedence enable row level security;
revoke all on table public.auction_fact_source_precedence from public, anon, authenticated, service_role;
grant select on table public.auction_fact_source_precedence to service_role;

-- 3. Journal des décisions (ajout seul) --------------------------------------------------------------------
-- sale_id sans clé étrangère : le journal survit à la fusion et à la purge de la vente. actor_id sans clé
-- étrangère : un « on delete set null » serait une modification, refusée par l'ajout seul.
-- information_agent_fact_id sans clé étrangère : la purge des messages supprime les faits candidats.
create table if not exists public.auction_fact_claim_decisions (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.auction_fact_claims(id) on delete restrict,
  sale_id uuid not null,
  field_key text not null check (
    char_length(field_key) between 2 and 128
    and field_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$'
  ),
  decision text not null check (
    decision in ('accepted', 'rejected', 'withdrawn', 'opposed', 'contradicted')
  ),
  -- Jugement porté sur le rattachement au lot au moment de la décision ; seuls single_lot et matched tiennent.
  lot_attachment text not null check (
    lot_attachment in ('single_lot', 'matched', 'unmatched', 'unknown')
  ),
  -- Ce que dit la pièce (« lot 2 »).
  lot_ref text check (lot_ref is null or char_length(btrim(lot_ref)) between 1 and 40),
  actor_kind text not null check (actor_kind in ('admin', 'lawyer', 'system')),
  actor_id uuid,
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  information_agent_fact_id uuid,
  recipient_kind text check (
    recipient_kind is null
    or recipient_kind in ('source_lawyer', 'source_contact', 'manual_professional')
  ),
  received_at timestamptz,
  publication_mode text not null default 'manual' check (publication_mode in ('manual', 'auto')),
  supersedes_decision_id uuid references public.auction_fact_claim_decisions(id) on delete restrict,
  decided_at timestamptz not null default statement_timestamp(),
  -- Toute décision autre qu'une acceptation dit pourquoi.
  constraint auction_fact_claim_decisions_reason_check check (
    decision = 'accepted' or reason is not null
  ),
  -- Une pièce ne tient un champ que par une décision d'acceptation humaine : le système n'accepte jamais.
  constraint auction_fact_claim_decisions_accepted_by_person check (
    decision <> 'accepted' or actor_kind in ('admin', 'lawyer')
  ),
  constraint auction_fact_claim_decisions_admin_actor check (
    actor_kind <> 'admin' or actor_id is not null
  ),
  constraint auction_fact_claim_decisions_no_self_supersession check (
    supersedes_decision_id is null or supersedes_decision_id <> id
  ),
  -- Verrou de la publication automatique (plan du 11/11/2026 : repoussée au lot R9). Seule une migration de ce
  -- lot pourra la retirer ; l'invariant information-agent-no-automatic-publication-path échoue sinon.
  constraint auction_fact_claim_decisions_auto_locked check (publication_mode <> 'auto')
);

create index if not exists auction_fact_claim_decisions_sale_field_idx
  on public.auction_fact_claim_decisions (sale_id, field_key, decided_at desc, id desc);
create index if not exists auction_fact_claim_decisions_claim_idx
  on public.auction_fact_claim_decisions (claim_id, decided_at desc);
create unique index if not exists auction_fact_claim_decisions_fact_accepted_key
  on public.auction_fact_claim_decisions (information_agent_fact_id)
  where decision = 'accepted' and information_agent_fact_id is not null;
create index if not exists auction_fact_claim_decisions_supersedes_idx
  on public.auction_fact_claim_decisions (supersedes_decision_id)
  where supersedes_decision_id is not null;

comment on table public.auction_fact_claim_decisions is
  'Registre des pièces : journal en ajout seul des décisions sur les observations de auction_fact_claims (acceptée, rejetée, retirée, opposition, contredite), avec le rattachement au lot. Le statut effectif d''une observation est sa dernière décision. Ni extrait, ni email, ni nom.';

alter table public.auction_fact_claim_decisions enable row level security;
revoke all on table public.auction_fact_claim_decisions from public, anon, authenticated, service_role;
grant select on table public.auction_fact_claim_decisions to service_role;

-- Une décision porte sur l'observation qu'elle nomme : même champ, même vente (ou, pour une observation dont la
-- vente a été supprimée par une fusion, une vente déjà nommée par une décision antérieure de cette observation),
-- et elle ne remplace qu'une décision de la même observation.
create or replace function app_private.validate_auction_fact_claim_decision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim_sale_id uuid;
  v_claim_field_key text;
begin
  select claim.auction_sale_id, claim.field_key
  into v_claim_sale_id, v_claim_field_key
  from public.auction_fact_claims claim
  where claim.id = new.claim_id;
  if v_claim_field_key is null then
    raise exception using errcode = '23503',
      message = 'A fact claim decision must name an existing fact claim.';
  end if;
  if new.field_key is distinct from v_claim_field_key then
    raise exception using errcode = '23514',
      message = 'A fact claim decision must carry the field of its fact claim.';
  end if;
  if v_claim_sale_id is not null and new.sale_id is distinct from v_claim_sale_id then
    raise exception using errcode = '23514',
      message = 'A fact claim decision must carry the sale of its fact claim.';
  end if;
  if v_claim_sale_id is null and not exists (
    select 1 from public.auction_fact_claim_decisions earlier
    where earlier.claim_id = new.claim_id and earlier.sale_id = new.sale_id
  ) then
    raise exception using errcode = '23514',
      message = 'A detached fact claim can only be decided for a sale named by one of its earlier decisions.';
  end if;
  if new.supersedes_decision_id is not null and not exists (
    select 1 from public.auction_fact_claim_decisions earlier
    where earlier.id = new.supersedes_decision_id and earlier.claim_id = new.claim_id
  ) then
    raise exception using errcode = '23514',
      message = 'A fact claim decision can only supersede a decision of the same fact claim.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.validate_auction_fact_claim_decision()
  from public, anon, authenticated, service_role;

drop trigger if exists auction_fact_claim_decisions_validate on public.auction_fact_claim_decisions;
create trigger auction_fact_claim_decisions_validate
  before insert on public.auction_fact_claim_decisions
  for each row execute function app_private.validate_auction_fact_claim_decision();

-- 4. Évènements des champs tenus (ajout seul) ----------------------------------------------------------------
create table if not exists public.auction_sale_field_hold_events (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null,
  field_key text not null references public.auction_fact_fields(field_key) on delete restrict,
  event text not null check (
    event in (
      'listing_changed_kept', 'listing_changed_released', 'projection_held', 'projection_released',
      'conflicted'
    )
  ),
  held_value jsonb,
  listing_value jsonb,
  incoming_value jsonb,
  decision_id uuid references public.auction_fact_claim_decisions(id) on delete restrict,
  created_at timestamptz not null default statement_timestamp()
);

create index if not exists auction_sale_field_hold_events_sale_field_idx
  on public.auction_sale_field_hold_events (sale_id, field_key, created_at desc);
create index if not exists auction_sale_field_hold_events_created_idx
  on public.auction_sale_field_hold_events (created_at desc);
create index if not exists auction_sale_field_hold_events_decision_idx
  on public.auction_sale_field_hold_events (decision_id)
  where decision_id is not null;

comment on table public.auction_sale_field_hold_events is
  'Registre des pièces : file de relecture en ajout seul des champs tenus (l''annonce a changé sur un champ tenu, pièce posée ou retirée, contradiction). Valeurs seulement : ni extrait, ni email, ni nom.';

alter table public.auction_sale_field_hold_events enable row level security;
revoke all on table public.auction_sale_field_hold_events from public, anon, authenticated, service_role;
grant select on table public.auction_sale_field_hold_events to service_role;

-- Ajout seul : ni modification, ni suppression, ni vidage (même par le propriétaire des tables). Une erreur ne
-- se corrige que par une nouvelle décision.
create or replace function app_private.fact_registry_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = format(
      'public.%s est en ajout seul : ni modification, ni suppression, ni vidage.', tg_table_name
    );
end;
$$;

revoke all on function app_private.fact_registry_append_only()
  from public, anon, authenticated, service_role;

drop trigger if exists auction_fact_claim_decisions_append_only on public.auction_fact_claim_decisions;
create trigger auction_fact_claim_decisions_append_only
  before update or delete on public.auction_fact_claim_decisions
  for each row execute function app_private.fact_registry_append_only();

drop trigger if exists auction_fact_claim_decisions_no_truncate on public.auction_fact_claim_decisions;
create trigger auction_fact_claim_decisions_no_truncate
  before truncate on public.auction_fact_claim_decisions
  for each statement execute function app_private.fact_registry_append_only();

drop trigger if exists auction_sale_field_hold_events_append_only on public.auction_sale_field_hold_events;
create trigger auction_sale_field_hold_events_append_only
  before update or delete on public.auction_sale_field_hold_events
  for each row execute function app_private.fact_registry_append_only();

drop trigger if exists auction_sale_field_hold_events_no_truncate on public.auction_sale_field_hold_events;
create trigger auction_sale_field_hold_events_no_truncate
  before truncate on public.auction_sale_field_hold_events
  for each statement execute function app_private.fact_registry_append_only();

notify pgrst, 'reload schema';

commit;
