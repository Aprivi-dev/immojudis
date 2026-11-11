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
--      quatre premiers champs tenables, pas les visites (verrouillées par contrainte, voir plus bas). Toujours
--      « keep_and_review » au départ (choix 1 du plan).
--   2. public.auction_fact_source_precedence : rang et droit de tenir par champ et par origine de pièce. Départ :
--      admin 10, lawyer_form 20, lawyer_email 30, document 50 (tous tenables, mais seulement après une décision
--      d'acceptation humaine), listing 60 (jamais : contrainte auction_fact_source_precedence_listing_never_holds).
--   3. public.auction_fact_claim_decisions : journal des décisions sur les observations de auction_fact_claims,
--      en AJOUT SEUL (ni modification, ni suppression, ni vidage). Le statut effectif d'une observation est sa
--      dernière décision, dans l'ordre de la colonne seq (identité) : la date decided_at est imposée par la base
--      (clock_timestamp()), jamais fournie par l'écrivain, et ne sert pas à ordonner. Publication automatique
--      impossible (contrainte auction_fact_claim_decisions_auto_locked) ; une acceptation vient toujours d'un
--      administrateur existant (contrainte auction_fact_claim_decisions_accepted_by_admin et déclencheur de
--      validation) : la réponse d'un avocat est une observation, acceptée ensuite par une personne de l'équipe.
--      Aucun texte libre : le motif est un code d'une liste fermée (reason_code). Si une note libre devient
--      nécessaire, elle ira dans une table à part, purgeable, jamais dans ce journal non effaçable.
--   4. public.auction_sale_field_hold_events : file de relecture des champs tenus, en ajout seul (l'annonce a
--      changé, une pièce a été posée, retirée ou n'a pas pu l'être, deux pièces se contredisent). Même ordre
--      par seq, même date imposée.
--
-- Aucune clé étrangère vers public.auction_sales : elle prendrait un verrou SHARE ROW EXCLUSIVE sur la table
-- chaude, et une suppression en cascade effacerait l'audit lors d'une fusion de doublons (les fusions se suivent
-- par app_private.auction_sale_merges). Les quatre tables sont fermées aux rôles de l'API : RLS sans politique,
-- tout retiré à public, anon, authenticated et service_role, puis SELECT seul pour service_role. Seules des
-- fonctions SECURITY DEFINER (lot R2) y écriront.
--
-- Les déclencheurs de ce fichier sont posés par « create or replace trigger » (une seconde application ne
-- supprime rien) puis passés en « enable always » : ils restent actifs en session_replication_role = replica.
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
--   drop function if exists app_private.stamp_fact_registry_event();
--   drop function if exists app_private.validate_auction_fact_claim_decision();
--   drop function if exists app_private.sale_field_claim_value(text, jsonb);
--   commit;
-- Les migrations suivantes du lot (20261116100500) dépendent de ces tables : les retirer d'abord.

-- Valeur d'une observation que le registre peut tenir, contrôlée strictement (type JSON, bornes du noyau de
-- publication). Nulle si la valeur n'est pas recevable : une telle observation ne peut pas être acceptée.
--   surface : nombre dans ]0 ; 1 000 000] ; terrain : nombre dans ]0 ; 100 000 000] ; pièces : entier de 1 à 100 ;
--   occupation : vacant (libre), occupied (occupé) ou rented (loué), et rien d'autre : le plan (section 6,
--   choix 5) interdit de dire qui occupe ni pourquoi (owner_occupied et squatted ne sont pas des pièces ;
--   « unknown » non plus) ;
--   visites : tableau non vide de dates AAAA-MM-JJ, rendu trié et sans doublon.
create or replace function app_private.sale_field_claim_value(p_field_key text, p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then null
    when p_field_key = 'property.surface_m2' then
      case when jsonb_typeof(p_value) = 'number'
        and (p_value #>> '{}')::numeric > 0 and (p_value #>> '{}')::numeric <= 1000000
        then p_value end
    when p_field_key = 'property.land_surface_m2' then
      case when jsonb_typeof(p_value) = 'number'
        and (p_value #>> '{}')::numeric > 0 and (p_value #>> '{}')::numeric <= 100000000
        then p_value end
    when p_field_key = 'property.rooms_count' then
      case when jsonb_typeof(p_value) = 'number'
        and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
        and (p_value #>> '{}')::numeric between 1 and 100
        then to_jsonb((p_value #>> '{}')::numeric::integer) end
    when p_field_key = 'property.occupancy_status' then
      case when jsonb_typeof(p_value) = 'string'
        and (p_value #>> '{}') in ('vacant', 'occupied', 'rented')
        then p_value end
    when p_field_key = 'sale.visit_dates' then
      case when jsonb_typeof(p_value) = 'array'
        and jsonb_array_length(p_value) between 1 and 50
        and not exists (
          select 1 from jsonb_array_elements(p_value) element
          where jsonb_typeof(element) <> 'string'
            or (element #>> '{}') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
        )
        then (
          select jsonb_agg(day order by day)
          from (select distinct element as day from jsonb_array_elements_text(p_value) element) days
        ) end
    else null
  end;
$$;

revoke all on function app_private.sale_field_claim_value(text, jsonb)
  from public, anon, authenticated, service_role;

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
  ),
  -- Les dates de visite ne sont pas tenables : la colonne visit_dates de l'annonce est un texte qui peut porter
  -- une heure, un nom ou un téléphone, et une pièce de visite n'en garderait que le jour (l'heure serait perdue,
  -- et la dernière valeur de l'annonce, recopiée dans held_fields, pourrait contenir une donnée personnelle).
  -- À lever par une migration seulement quand un fait de visite structuré (jour, heure, sans texte libre) et sa
  -- normalisation existent.
  constraint auction_fact_fields_visit_dates_locked check (
    field_key <> 'sale.visit_dates' or not hold_enabled
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
--
-- Motifs (reason_code), par type de décision :
--   accepted     : aucun ;
--   rejected     : already_known (déjà connu), other_lot (autre lot), doubtful_statement (doute dans la phrase),
--                  implausible_value (valeur invraisemblable), other (annexe 05, motifs de refus en un geste) ;
--   withdrawn    : entry_error (erreur de saisie ou de lecture), other_lot (valeur d'un autre lot),
--                  authorization_withdrawn (le professionnel retire son autorisation d'affichage, annexe 07),
--                  replaced_by_source (la source a corrigé sa réponse), other ;
--   opposed      : professional_opposition (opposition du professionnel, art. 21 du RGPD), other ;
--   contradicted : by_listing, by_document, by_professional (origine de la valeur contraire), other.
create table if not exists public.auction_fact_claim_decisions (
  id uuid primary key default gen_random_uuid(),
  -- Ordre des décisions : la dernière décision d'une observation est celle de seq le plus grand.
  seq bigint generated always as identity,
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
  reason_code text,
  information_agent_fact_id uuid,
  recipient_kind text check (
    recipient_kind is null
    or recipient_kind in ('source_lawyer', 'source_contact', 'manual_professional')
  ),
  received_at timestamptz,
  publication_mode text not null default 'manual' check (publication_mode in ('manual', 'auto')),
  supersedes_decision_id uuid references public.auction_fact_claim_decisions(id) on delete restrict,
  -- Imposée par le déclencheur de validation : l'écrivain ne choisit pas la date.
  decided_at timestamptz not null default clock_timestamp(),
  -- Liste fermée de motifs, par type de décision ; une acceptation n'en porte pas.
  constraint auction_fact_claim_decisions_reason_code_check check (
    case decision
      when 'accepted' then reason_code is null
      when 'rejected' then coalesce(
        reason_code in ('already_known', 'other_lot', 'doubtful_statement', 'implausible_value', 'other'),
        false
      )
      when 'withdrawn' then coalesce(
        reason_code in (
          'entry_error', 'other_lot', 'authorization_withdrawn', 'replaced_by_source', 'other'
        ),
        false
      )
      when 'opposed' then coalesce(reason_code in ('professional_opposition', 'other'), false)
      when 'contradicted' then coalesce(
        reason_code in ('by_listing', 'by_document', 'by_professional', 'other'), false
      )
      else false
    end
  ),
  -- Une pièce ne tient un champ que par l'acceptation d'un administrateur : ni le système, ni un avocat seul.
  -- Verrou lié à la publication automatique (lot R9) : l'invariant
  -- information-agent-no-automatic-publication-path échoue si une migration le retire.
  constraint auction_fact_claim_decisions_accepted_by_admin check (
    decision <> 'accepted' or (actor_kind = 'admin' and actor_id is not null)
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

create unique index if not exists auction_fact_claim_decisions_seq_key
  on public.auction_fact_claim_decisions (seq);
create index if not exists auction_fact_claim_decisions_sale_field_idx
  on public.auction_fact_claim_decisions (sale_id, field_key, seq desc);
create index if not exists auction_fact_claim_decisions_claim_idx
  on public.auction_fact_claim_decisions (claim_id, seq desc);
-- Idempotence des publications : un même fait relu n'est accepté qu'une fois (un double clic est refusé). Une
-- nouvelle acceptation du même fait, après un retrait fait par erreur ou pour corriger le rattachement au lot,
-- nomme la décision qu'elle remplace (supersedes_decision_id) : elle est alors permise, une fois.
create unique index if not exists auction_fact_claim_decisions_fact_accepted_key
  on public.auction_fact_claim_decisions (
    information_agent_fact_id,
    coalesce(supersedes_decision_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where decision = 'accepted' and information_agent_fact_id is not null;
create index if not exists auction_fact_claim_decisions_supersedes_idx
  on public.auction_fact_claim_decisions (supersedes_decision_id)
  where supersedes_decision_id is not null;

comment on table public.auction_fact_claim_decisions is
  'Registre des pièces : journal en ajout seul des décisions sur les observations de auction_fact_claims (acceptée, rejetée, retirée, opposition, contredite), avec le rattachement au lot. Le statut effectif d''une observation est sa dernière décision (ordre de seq). Ni extrait, ni email, ni nom, ni texte libre : le motif est un code.';

alter table public.auction_fact_claim_decisions enable row level security;
revoke all on table public.auction_fact_claim_decisions from public, anon, authenticated, service_role;
grant select on table public.auction_fact_claim_decisions to service_role;

-- Une décision porte sur l'observation qu'elle nomme : même champ, même vente (ou, pour une observation dont la
-- vente a été supprimée par une fusion, une vente déjà nommée par une décision antérieure de cette observation),
-- et elle ne remplace qu'une décision de la même observation. Sa date est celle de la base. Une acceptation
-- vient d'un administrateur qui existe au moment de la décision (même règle que la relecture de l'agent
-- d'information : user_profiles.user_role = 'admin' ; l'identifiant est fourni par la RPC du lot R2, sans
-- dépendre de auth.uid()), et sa valeur doit être recevable pour un champ du registre. SECURITY DEFINER : le
-- contrôle ne dépend pas des politiques de ligne du rôle qui insère.
create or replace function app_private.validate_auction_fact_claim_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim_sale_id uuid;
  v_claim_field_key text;
  v_claim_value jsonb;
begin
  new.decided_at := pg_catalog.clock_timestamp();

  select claim.auction_sale_id, claim.field_key, claim.value_jsonb
  into v_claim_sale_id, v_claim_field_key, v_claim_value
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
  if new.decision = 'accepted' then
    -- Un auteur qui n'est pas un administrateur est refusé par la contrainte …_accepted_by_admin.
    if new.actor_kind = 'admin' and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = new.actor_id and profile.user_role = 'admin'
    ) then
      raise exception using errcode = '42501',
        message = 'A fact claim is accepted by an existing administrator.';
    end if;
    if exists (
      select 1 from public.auction_fact_fields field where field.field_key = new.field_key
    ) and app_private.sale_field_claim_value(new.field_key, v_claim_value) is null then
      raise exception using errcode = '22023',
        message = 'An accepted fact claim must carry a value that the registry can hold.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.validate_auction_fact_claim_decision()
  from public, anon, authenticated, service_role;

create or replace trigger auction_fact_claim_decisions_validate
  before insert on public.auction_fact_claim_decisions
  for each row execute function app_private.validate_auction_fact_claim_decision();
alter table public.auction_fact_claim_decisions
  enable always trigger auction_fact_claim_decisions_validate;

-- 4. Évènements des champs tenus (ajout seul) ----------------------------------------------------------------
create table if not exists public.auction_sale_field_hold_events (
  id uuid primary key default gen_random_uuid(),
  -- Ordre des évènements : le dernier évènement d'un champ est celui de seq le plus grand.
  seq bigint generated always as identity,
  sale_id uuid not null,
  field_key text not null references public.auction_fact_fields(field_key) on delete restrict,
  event text not null check (
    event in (
      'listing_changed_kept', 'listing_changed_released', 'projection_held', 'projection_released',
      'projection_blocked', 'conflicted'
    )
  ),
  held_value jsonb,
  listing_value jsonb,
  incoming_value jsonb,
  decision_id uuid references public.auction_fact_claim_decisions(id) on delete restrict,
  -- Imposée par déclencheur : l'écrivain ne choisit pas la date.
  created_at timestamptz not null default clock_timestamp()
);

create unique index if not exists auction_sale_field_hold_events_seq_key
  on public.auction_sale_field_hold_events (seq);
create index if not exists auction_sale_field_hold_events_sale_field_idx
  on public.auction_sale_field_hold_events (sale_id, field_key, seq desc);
create index if not exists auction_sale_field_hold_events_decision_idx
  on public.auction_sale_field_hold_events (decision_id)
  where decision_id is not null;

comment on table public.auction_sale_field_hold_events is
  'Registre des pièces : file de relecture en ajout seul des champs tenus (l''annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction). Valeurs de champs seulement (occupation : vacant, occupied ou rented) : ni extrait, ni email, ni nom.';

alter table public.auction_sale_field_hold_events enable row level security;
revoke all on table public.auction_sale_field_hold_events from public, anon, authenticated, service_role;
grant select on table public.auction_sale_field_hold_events to service_role;

create or replace function app_private.stamp_fact_registry_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function app_private.stamp_fact_registry_event()
  from public, anon, authenticated, service_role;

create or replace trigger auction_sale_field_hold_events_stamp
  before insert on public.auction_sale_field_hold_events
  for each row execute function app_private.stamp_fact_registry_event();
alter table public.auction_sale_field_hold_events
  enable always trigger auction_sale_field_hold_events_stamp;

-- Ajout seul : ni modification, ni suppression, ni vidage, pour tout rôle et même en
-- session_replication_role = replica (déclencheurs « enable always »). Seule une instruction de structure
-- (suppression ou désactivation du déclencheur, que l'invariant fact-registry-append-only interdit aux
-- migrations) le contournerait. Une erreur ne se corrige que par une nouvelle décision.
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

create or replace trigger auction_fact_claim_decisions_append_only
  before update or delete on public.auction_fact_claim_decisions
  for each row execute function app_private.fact_registry_append_only();
alter table public.auction_fact_claim_decisions
  enable always trigger auction_fact_claim_decisions_append_only;

create or replace trigger auction_fact_claim_decisions_no_truncate
  before truncate on public.auction_fact_claim_decisions
  for each statement execute function app_private.fact_registry_append_only();
alter table public.auction_fact_claim_decisions
  enable always trigger auction_fact_claim_decisions_no_truncate;

create or replace trigger auction_sale_field_hold_events_append_only
  before update or delete on public.auction_sale_field_hold_events
  for each row execute function app_private.fact_registry_append_only();
alter table public.auction_sale_field_hold_events
  enable always trigger auction_sale_field_hold_events_append_only;

create or replace trigger auction_sale_field_hold_events_no_truncate
  before truncate on public.auction_sale_field_hold_events
  for each statement execute function app_private.fact_registry_append_only();
alter table public.auction_sale_field_hold_events
  enable always trigger auction_sale_field_hold_events_no_truncate;

notify pgrst, 'reload schema';

commit;
