begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A1 (plan du 11/11/2026, section 10 ; spécification : annexe
-- 08-bascule-base-de-donnees.md, point 7). INERTE : les deux journaux sont vides, rien n'y écrit avant la bascule.
--
-- Une séquence commune, app_private.fact_registry_seq, numérote désormais les décisions
-- (public.auction_fact_claim_decisions.seq) ET les évènements (public.auction_sale_field_hold_events.seq). Au lot
-- R1 chaque journal avait sa propre identité : l'ordre entre une décision et un évènement (« l'annonce a délogé
-- cette pièce, la décision est-elle antérieure ? ») reposait donc sur l'horloge (created_at comparé à decided_at),
-- qu'une restauration de données ou un saut d'horloge fausse. Avec une séquence commune, la projection
-- (20261117100200) compare deux numéros.
--
-- Pourquoi l'ordre est exact pour une vente : une séquence suit l'ordre d'attribution, pas l'ordre de validation,
-- mais toute écriture du registre pour une vente se fait sous le verrou de ligne de cette vente (la retenue est un
-- déclencheur de ligne de auction_sales, la projection verrouille la vente avant d'écrire, et les fonctions de
-- décision des lots R2b et R2c verrouillent la vente avant d'insérer la décision).
--
-- Même garantie que « generated always » : l'écrivain ne choisit pas seq. Les deux déclencheurs BEFORE INSERT
-- (validation des décisions, datation des évènements), en mode « always », l'imposent ; une valeur fournie est
-- remplacée. La colonne reste NOT NULL et unique (index …_seq_key de 20261116100000) : sans le déclencheur, une
-- insertion échoue au lieu de passer sans numéro.
--
-- Conditions, vérifiées ici : les deux tables sont VIDES (sinon les numéros déjà attribués par les deux identités
-- ne se comparent pas entre eux : la migration échoue sans effet, erreur 55000). Aucun verrou sur auction_sales ni
-- sur auction_fact_claims.
--
-- Verrous : ACCESS EXCLUSIVE sur les deux journaux, le temps de retirer l'identité (catalogue seulement, tables
-- vides). Seconde application : les colonnes n'ont plus d'identité, le bloc ne fait rien, AUCUN verrou ACCESS
-- EXCLUSIVE n'est repris et le contrôle « tables vides » n'est pas rejoué (les journaux peuvent alors être
-- remplis). Possible pendant un import (rien n'écrit ces tables), déconseillé.
--
-- Restauration de données seules : la séquence doit repartir au-dessus du plus grand seq des deux tables
-- (docs/runbooks/registre-des-pieces-r2a.md). Aucune migration ne fait setval ni alter sequence dessus.
--
-- Retour arrière (tables encore vides) :
--   begin; set local lock_timeout = '5s';
--   lock table public.auction_fact_claim_decisions, public.auction_sale_field_hold_events in access exclusive mode;
--   -- rétablir les deux fonctions de 20261116100000 (validate_auction_fact_claim_decision et
--   -- stamp_fact_registry_event, sans la ligne « new.seq := … »), puis :
--   alter table public.auction_fact_claim_decisions alter column seq add generated always as identity;
--   alter table public.auction_sale_field_hold_events alter column seq add generated always as identity;
--   drop sequence if exists app_private.fact_registry_seq;
--   commit;

create sequence if not exists app_private.fact_registry_seq as bigint;

comment on sequence app_private.fact_registry_seq is
  'Registre des pièces : numérotation commune des décisions et des évènements des champs tenus. L''ordre entre les deux journaux se lit dans seq, jamais dans une date.';

revoke all on sequence app_private.fact_registry_seq from public, anon, authenticated, service_role;

-- Validation d'une décision (définition de 20261116100000, plus le numéro d'ordre imposé).
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
  -- L'écrivain ne choisit ni l'ordre ni la date.
  new.seq := pg_catalog.nextval('app_private.fact_registry_seq'::regclass);
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

-- Datation d'un évènement (définition de 20261116100000, plus le numéro d'ordre imposé). SECURITY DEFINER
-- désormais : la séquence n'est utilisable par aucun rôle de l'API, et le numéro ne doit pas dépendre du rôle qui
-- insère (les seuls écrivains sont la retenue et la projection, elles-mêmes SECURITY DEFINER).
create or replace function app_private.stamp_fact_registry_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.seq := pg_catalog.nextval('app_private.fact_registry_seq'::regclass);
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function app_private.stamp_fact_registry_event()
  from public, anon, authenticated, service_role;

-- Retrait des deux identités, seulement si elles existent encore (première application).
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_attribute attribute
    where attribute.attrelid in (
        'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass)
      and attribute.attname = 'seq' and not attribute.attisdropped and attribute.attidentity <> ''
  ) then
    lock table public.auction_fact_claim_decisions, public.auction_sale_field_hold_events
      in access exclusive mode;
    if exists (select 1 from public.auction_fact_claim_decisions)
      or exists (select 1 from public.auction_sale_field_hold_events)
    then
      raise exception using errcode = '55000',
        message = 'fact registry journals are not empty: the common sequence cannot replace their identities';
    end if;
    alter table public.auction_fact_claim_decisions alter column seq drop identity if exists;
    alter table public.auction_sale_field_hold_events alter column seq drop identity if exists;
  end if;
end;
$$;

comment on column public.auction_fact_claim_decisions.seq is
  'Ordre des décisions, pris dans app_private.fact_registry_seq (commune avec les évènements) et imposé par le déclencheur de validation : l''écrivain ne le choisit pas.';
comment on column public.auction_sale_field_hold_events.seq is
  'Ordre des évènements, pris dans app_private.fact_registry_seq (commune avec les décisions) et imposé par le déclencheur de datation : l''écrivain ne le choisit pas.';

notify pgrst, 'reload schema';

commit;
