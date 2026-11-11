begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R1, étape M2 (annexe 03, section 2 f). Rien ne change pour les fiches.
--
--   1. evidence_kind de public.auction_fact_claims accepte trois origines de plus : professional_email (réponse
--      d'un professionnel par email), professional_form (formulaire à champs fermés, lot R7) et admin_entry
--      (saisie d'un administrateur). Aujourd'hui le pont étiquette « manual_review » un fait lu dans le corps d'un
--      email d'avocat, ce qui le classerait comme une saisie d'administrateur. Aucun écrivain n'utilise encore
--      ces valeurs (lot R2). La contrainte est recréée NOT VALID ici (ACCESS EXCLUSIVE bref, sans parcours de la
--      table), puis validée par 20261116100200 (SHARE UPDATE EXCLUSIVE, les écritures continuent). Son nom réel,
--      lu dans le catalogue rejoué, est celui attribué d'office à la contrainte de colonne de 20260928140000 :
--      auction_fact_claims_evidence_kind_check. Recréée seulement si elle n'a pas déjà la liste élargie : une
--      seconde application ne la remet pas en NOT VALID.
--   2. public.auction_fact_claims ne peut plus être vidée (TRUNCATE contourne les déclencheurs par ligne de la
--      garde d'immuabilité, qui refusent déjà UPDATE et DELETE). Exception 55000, y compris en
--      session_replication_role = replica (déclencheur « enable always »).
--   3. Les trois nouvelles origines disent « un professionnel » ou « un administrateur » : aucun rôle de l'API
--      (anon, authenticated, service_role) ne peut insérer une observation qui les porte (42501). Seule une
--      fonction SECURITY DEFINER (lot R2) le pourra. Déclencheur NOUVEAU et séparé, avec une clause WHEN sur la
--      nature : les insertions actuelles de la collecte (source_listing, source_document…) ne l'appellent pas.
--
-- Ni colonne ajoutée, ni garde d'immuabilité touchée : la garde compare to_jsonb(new) à to_jsonb(old), une
-- colonne de plus serait immuable et impossible à remplir pour les lignes existantes.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.auction_fact_claims (contrainte, première application seulement),
-- puis SHARE ROW EXCLUSIVE (déclencheurs, posés par « create or replace trigger » : une seconde application ne
-- supprime rien). À appliquer hors import : la collecte insère des observations.
--
-- Retour arrière (sans effet sur les données tant qu'aucune ligne n'utilise les nouvelles valeurs) :
--   begin; set local lock_timeout = '5s';
--   drop trigger if exists auction_fact_claims_no_truncate on public.auction_fact_claims;
--   drop trigger if exists auction_fact_claims_registry_origin_guard on public.auction_fact_claims;
--   drop function if exists app_private.refuse_auction_fact_claims_truncate();
--   drop function if exists app_private.refuse_api_role_registry_origin();
--   alter table public.auction_fact_claims drop constraint auction_fact_claims_evidence_kind_check;
--   alter table public.auction_fact_claims add constraint auction_fact_claims_evidence_kind_check check (
--     evidence_kind in ('source_listing', 'source_document', 'source_record', 'email_attachment',
--       'portal_upload', 'manual_review', 'agent_research', 'other')) not valid;
--   alter table public.auction_fact_claims validate constraint auction_fact_claims_evidence_kind_check;
--   commit;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_fact_claims'::regclass
      and constraint_row.conname = 'auction_fact_claims_evidence_kind_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%professional_email%'
  ) then
    alter table public.auction_fact_claims
      drop constraint if exists auction_fact_claims_evidence_kind_check;
    alter table public.auction_fact_claims
      add constraint auction_fact_claims_evidence_kind_check check (
        evidence_kind in (
          'source_listing', 'source_document', 'source_record', 'email_attachment',
          'portal_upload', 'manual_review', 'agent_research', 'other',
          'professional_email', 'professional_form', 'admin_entry'
        )
      ) not valid;
  end if;
end;
$$;

create or replace function app_private.refuse_auction_fact_claims_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = 'Fact claims cannot be truncated; supersede or withdraw them.';
end;
$$;

revoke all on function app_private.refuse_auction_fact_claims_truncate()
  from public, anon, authenticated, service_role;

create or replace trigger auction_fact_claims_no_truncate
  before truncate on public.auction_fact_claims
  for each statement execute function app_private.refuse_auction_fact_claims_truncate();
alter table public.auction_fact_claims enable always trigger auction_fact_claims_no_truncate;

-- Origine réservée : SECURITY INVOKER, pour lire le rôle qui insère (dans une fonction SECURITY DEFINER,
-- current_user est son propriétaire, pas un rôle de l'API).
create or replace function app_private.refuse_api_role_registry_origin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
    raise exception using errcode = '42501',
      message = 'A professional or administrator fact claim cannot be inserted by an API role.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.refuse_api_role_registry_origin()
  from public, anon, authenticated, service_role;

create or replace trigger auction_fact_claims_registry_origin_guard
  before insert on public.auction_fact_claims
  for each row
  when (new.evidence_kind in ('professional_email', 'professional_form', 'admin_entry'))
  execute function app_private.refuse_api_role_registry_origin();
alter table public.auction_fact_claims enable always trigger auction_fact_claims_registry_origin_guard;

commit;
