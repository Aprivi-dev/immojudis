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
--      garde d'immuabilité, qui refusent déjà UPDATE et DELETE). Exception 55000.
--
-- Ni colonne ajoutée, ni garde d'immuabilité touchée : la garde compare to_jsonb(new) à to_jsonb(old), une
-- colonne de plus serait immuable et impossible à remplir pour les lignes existantes.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.auction_fact_claims (contrainte), puis SHARE ROW EXCLUSIVE
-- (déclencheur). À appliquer hors import : la collecte insère des observations.
--
-- Retour arrière (sans effet sur les données tant qu'aucune ligne n'utilise les nouvelles valeurs) :
--   begin; set local lock_timeout = '5s';
--   drop trigger if exists auction_fact_claims_no_truncate on public.auction_fact_claims;
--   drop function if exists app_private.refuse_auction_fact_claims_truncate();
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

drop trigger if exists auction_fact_claims_no_truncate on public.auction_fact_claims;
create trigger auction_fact_claims_no_truncate
  before truncate on public.auction_fact_claims
  for each statement execute function app_private.refuse_auction_fact_claims_truncate();

commit;
