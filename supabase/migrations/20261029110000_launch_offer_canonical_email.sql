-- Offre de lancement : une seule offre par adresse email canonique.
--
-- 20261028170000 exige une adresse confirmée, mais rien n'empêche une personne de confirmer
-- a+1@x.fr, a+2@x.fr, a+3@x.fr (sous-adresses, « +tag » : la même boîte), ou j.ohn@gmail.com et
-- john@gmail.com (Gmail ignore les points), ou des adresses jetables : chaque compte confirmé aurait
-- les avantages Analyse. Cette migration réserve l'offre au PLUS ANCIEN compte confirmé de chaque
-- adresse canonique, et refuse les domaines jetables d'une courte liste.
--
-- - app_private.canonical_email(text) : minuscules, sans « +tag » ; pour gmail.com et googlemail.com,
--   sans points et domaine ramené à gmail.com. Les points d'un autre domaine comptent (ils
--   distinguent des boîtes chez la plupart des hébergeurs).
-- - app_private.is_disposable_email_domain(text) : liste courte de domaines d'adresses jetables, à
--   compléter ici quand un abus en révèle un autre.
-- - app_private.account_email_identity : adresse canonique et date de confirmation de chaque compte,
--   tenues à jour par un déclencheur sur auth.users. auth.users ne peut pas être indexée par nous :
--   sans cette table, vérifier « le plus ancien de son adresse canonique » parcourrait tous les
--   comptes à chaque lecture des droits. Le déclencheur ne bloque JAMAIS une inscription ou une
--   confirmation (toute erreur devient un avertissement). La table est dérivée : les comptes
--   existants y entrent par supabase/repairs/20261029110000_backfill_account_email_identity.sql
--   (non lancé par cette migration) ; en attendant, un compte absent de la table est traité comme
--   le premier de son adresse (jamais plus sévère qu'avant).
-- - app_private.launch_offer_account_eligible(uuid) : mêmes garde-fous qu'en 20261028170000 (profil,
--   email confirmé), plus domaine non jetable et « plus ancien compte confirmé de son adresse
--   canonique » (ordre : date de confirmation, puis identifiant). Les deux fonctions d'accès Analyse
--   (20261028170000) l'appellent déjà : elles ne sont pas redéfinies ici. Un abonné, un compte
--   premium ou un administrateur n'est pas concerné (leurs droits ne passent pas par cette
--   fonction). Aucune écriture dans les comptes ni les abonnements.
begin;

set local lock_timeout = '5s';

-- 1. Adresse canonique et domaines jetables ---------------------------------------------------------
create or replace function app_private.canonical_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select
    case
      when p_email is null then null
      when parts.domain is null then lower(btrim(p_email))
      when parts.domain in ('gmail.com', 'googlemail.com')
        then replace(parts.local_part, '.', '') || '@gmail.com'
      else parts.local_part || '@' || parts.domain
    end
  from (
    select
      substring(lower(btrim(p_email)) from '@([^@]*)$') as domain,
      coalesce(
        nullif(split_part(substring(lower(btrim(p_email)) from '^(.*)@[^@]*$'), '+', 1), ''),
        substring(lower(btrim(p_email)) from '^(.*)@[^@]*$')
      ) as local_part
  ) parts;
$function$;

revoke all on function app_private.canonical_email(text) from public, anon, authenticated;
grant execute on function app_private.canonical_email(text) to service_role;

comment on function app_private.canonical_email(text) is
  'Adresse email canonique : minuscules, sans +tag ; gmail.com / googlemail.com sans points. Sert à n''accorder l''offre de lancement qu''une fois par boîte.';

create or replace function app_private.is_disposable_email_domain(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    substring(lower(btrim(p_email)) from '@([^@]*)$') = any (array[
      '10minutemail.com',
      'dispostable.com',
      'emailondeck.com',
      'fakeinbox.com',
      'getnada.com',
      'guerrillamail.com',
      'guerrillamail.net',
      'maildrop.cc',
      'mailinator.com',
      'mailnesia.com',
      'mohmal.com',
      'sharklasers.com',
      'temp-mail.org',
      'tempail.com',
      'tempmail.com',
      'throwawaymail.com',
      'trashmail.com',
      'yopmail.com',
      'yopmail.fr'
    ]),
    false
  );
$function$;

revoke all on function app_private.is_disposable_email_domain(text) from public, anon, authenticated;
grant execute on function app_private.is_disposable_email_domain(text) to service_role;

comment on function app_private.is_disposable_email_domain(text) is
  'Vrai si le domaine de l''adresse figure dans une courte liste de services d''adresses jetables : ces comptes n''ont pas l''offre de lancement.';

-- 2. Adresse canonique de chaque compte -------------------------------------------------------------
create table if not exists app_private.account_email_identity (
  user_id uuid primary key references auth.users (id) on delete cascade,
  canonical_email text not null,
  email_confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists account_email_identity_canonical_idx
  on app_private.account_email_identity (canonical_email, email_confirmed_at, user_id)
  where email_confirmed_at is not null;

alter table app_private.account_email_identity enable row level security;
revoke all on table app_private.account_email_identity from public, anon, authenticated;

comment on table app_private.account_email_identity is
  'Adresse email canonique et date de confirmation de chaque compte, dérivées d''auth.users par le déclencheur immojudis_sync_account_email_identity. Lue par launch_offer_account_eligible(). Supprimée avec le compte (donnée personnelle).';

create or replace function app_private.sync_account_email_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Cette table est dérivée : une erreur ici ne doit jamais empêcher une inscription, une
  -- confirmation ou un changement d'adresse.
  begin
    if new.email is null or btrim(new.email) = '' then
      delete from app_private.account_email_identity where user_id = new.id;
    else
      insert into app_private.account_email_identity (
        user_id, canonical_email, email_confirmed_at, updated_at
      )
      values (new.id, app_private.canonical_email(new.email), new.email_confirmed_at, now())
      on conflict (user_id) do update
        set canonical_email = excluded.canonical_email,
            email_confirmed_at = excluded.email_confirmed_at,
            updated_at = excluded.updated_at;
    end if;
  exception when others then
    raise warning 'sync_account_email_identity: %', sqlerrm;
  end;
  return new;
end;
$function$;

revoke all on function app_private.sync_account_email_identity() from public, anon, authenticated;

do $do$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'auth.users'::regclass
      and trigger_row.tgname = 'immojudis_sync_account_email_identity'
      and not trigger_row.tgisinternal
  ) then
    create trigger immojudis_sync_account_email_identity
      after insert or update of email, email_confirmed_at on auth.users
      for each row execute function app_private.sync_account_email_identity();
  end if;
end
$do$;

-- 3. Éligibilité à l'offre de lancement -------------------------------------------------------------
create or replace function app_private.launch_offer_account_eligible(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Fermée par défaut : sans utilisateur, sans profil, sans email confirmé, avec une adresse jetable,
  -- ou si un compte plus ancien a déjà confirmé la même adresse canonique, faux. Ne dit rien de
  -- l'interrupteur de l'offre : les fonctions d'accès le consultent elles-mêmes.
  select
    p_user_id is not null
    and exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = p_user_id
    )
    and exists (
      select 1
      from auth.users account
      where account.id = p_user_id
        and account.email_confirmed_at is not null
        and not app_private.is_disposable_email_domain(account.email)
        and not exists (
          select 1
          from app_private.account_email_identity older
          where older.canonical_email = app_private.canonical_email(account.email)
            and older.user_id <> account.id
            and older.email_confirmed_at is not null
            and (older.email_confirmed_at, older.user_id) < (account.email_confirmed_at, account.id)
        )
    );
$function$;

revoke all on function app_private.launch_offer_account_eligible(uuid) from public, anon, authenticated;
grant execute on function app_private.launch_offer_account_eligible(uuid) to service_role;

comment on function app_private.launch_offer_account_eligible(uuid) is
  'Vrai si le compte a un profil, une adresse email confirmée, non jetable, et s''il est le plus ancien compte confirmé de son adresse canonique (sans +tag, sans points Gmail). Condition de l''offre de lancement, lue par les fonctions d''accès Analyse avec launch_offer_active() ; jamais ouverte à anon.';

-- 4. Lecture par l'application ----------------------------------------------------------------------
-- L'application (src/lib/launch-offer.server.ts, hasConfirmedEmail) lit la même règle que les
-- fonctions d'accès : une seule source de vérité, plutôt qu'une seconde copie en TypeScript. Le
-- schéma app_private n'est pas exposé par l'API : cette fonction publique n'est exécutable que par
-- le rôle service_role.
create or replace function public.get_launch_offer_account_eligibility(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select app_private.launch_offer_account_eligible(p_user_id);
$function$;

revoke all on function public.get_launch_offer_account_eligibility(uuid)
  from public, anon, authenticated;
grant execute on function public.get_launch_offer_account_eligibility(uuid) to service_role;

comment on function public.get_launch_offer_account_eligibility(uuid) is
  'Lecture serveur seule (service_role) de app_private.launch_offer_account_eligible : le compte a-t-il droit à l''offre de lancement (email confirmé, non jetable, plus ancien de son adresse canonique) ?';

notify pgrst, 'reload schema';

commit;
