-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai. Procedure complete : supabase/repairs/README.md.
--
-- Point 27 (2026-10-20) : adresse canonique des comptes existants (offre de lancement).
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus),
-- APRES la migration 20261029110000_launch_offer_canonical_email.sql :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261029110000_backfill_account_email_identity.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est annulee (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261029110000_backfill_account_email_identity.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Idempotente : une seconde execution ne trouve plus aucune ligne a ajouter ou a corriger.
--
-- Constat : app_private.account_email_identity est tenue a jour par un declencheur sur auth.users, mais
-- seulement pour les comptes crees ou modifies (email, email_confirmed_at) apres la migration. Les
-- comptes existants n'y sont pas : tant qu'ils y manquent, ils ne comptent pas comme « plus ancien
-- compte confirme de leur adresse canonique », et deux comptes existants a+1@x.fr et a+2@x.fr
-- gardent l'offre de lancement l'un et l'autre. Cette reparation les y inscrit.
--
-- Ecrit uniquement dans app_private.account_email_identity (table derivee) : rien dans auth.users,
-- user_profiles ni user_subscriptions. Aucun compte n'est modifie, aucune sauvegarde n'est necessaire :
-- retour arriere = vider la table (voir la fin du fichier), le declencheur la remplit a nouveau.
--
-- A verifier apres (lecture seule) : combien de comptes confirmes partagent une adresse canonique et
-- perdent donc l'offre de lancement :
--   select canonical_email, count(*) from app_private.account_email_identity
--    where email_confirmed_at is not null group by 1 having count(*) > 1 order by 2 desc;
--
-- Retour arriere : truncate app_private.account_email_identity;

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : app_private.account_email_identity sera remplie ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

create temporary table account_email_identity_plan on commit drop as
select
  account.id as user_id,
  app_private.canonical_email(account.email) as canonical_email,
  account.email_confirmed_at
from auth.users account
left join app_private.account_email_identity current_row on current_row.user_id = account.id
where account.email is not null
  and btrim(account.email) <> ''
  and (
    current_row.user_id is null
    or current_row.canonical_email is distinct from app_private.canonical_email(account.email)
    or current_row.email_confirmed_at is distinct from account.email_confirmed_at
  );

select count(*) as comptes_a_inscrire_ou_corriger from account_email_identity_plan;

select count(*) as comptes_qui_perdraient_l_offre
from account_email_identity_plan plan
where plan.email_confirmed_at is not null
  and exists (
    select 1
    from (
      select user_id, canonical_email, email_confirmed_at from account_email_identity_plan
      union all
      select user_id, canonical_email, email_confirmed_at from app_private.account_email_identity
    ) other
    where other.canonical_email = plan.canonical_email
      and other.user_id <> plan.user_id
      and other.email_confirmed_at is not null
      and (other.email_confirmed_at, other.user_id) < (plan.email_confirmed_at, plan.user_id)
  );

\if :apply
  insert into app_private.account_email_identity (user_id, canonical_email, email_confirmed_at)
  select user_id, canonical_email, email_confirmed_at
  from account_email_identity_plan
  on conflict (user_id) do update
    set canonical_email = excluded.canonical_email,
        email_confirmed_at = excluded.email_confirmed_at,
        updated_at = now();

  select count(*) as comptes_inscrits from app_private.account_email_identity;
  commit;
\else
  rollback;
\endif
