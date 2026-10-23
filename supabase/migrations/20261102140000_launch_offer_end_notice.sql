begin;

set local lock_timeout = '5s';

-- Coupure de l'offre de lancement : l'événement de fin et le préavis aux comptes (n° 74 de la session
-- du 23/10/2026, seconde vague, chantier Y5).
--
-- Les textes publics promettent « Nous vous prévenons par email avant leur fin » (src/lib/launch-offer.ts,
-- CGV art. 13), mais aucun outil n'existait et l'événement de fin n'était pas défini. Cette migration pose :
--
--   1. la DATE DE FIN ANNONCÉE, dans la configuration de l'offre (app_private.launch_offer.ends_on, un jour
--      du calendrier de Paris). C'est la date que dit le préavis. Elle ne coupe RIEN toute seule : l'offre
--      reste active jusqu'à ce que l'administrateur la coupe (bouton de /admin/clients), comme avant ;
--      public.get_launch_offer_status() et les fonctions d'accès Analyse ne la lisent pas ;
--   2. la lecture de cette configuration et son écriture (service_role seul, l'administrateur est
--      contrôlé par le serveur d'application comme pour l'envoi à la liste d'attente) ;
--   3. le journal du préavis (public.launch_offer_end_notices) : une ligne = un préavis pour un compte et
--      une date de fin annoncée. La clé (user_id, ends_on) garantit qu'un compte n'est jamais prévenu deux
--      fois pour la même date, même si l'administrateur relance l'envoi (public.claim_launch_offer_end_notice
--      réserve la ligne AVANT l'envoi, même règle que public.claim_weekly_digest) ;
--   4. la liste des désinscrits (public.launch_offer_end_notice_optouts) : un compte qui se désinscrit par le
--      lien du message ne reçoit plus ce préavis, pour aucune date ;
--   5. la file d'envoi (public.get_launch_offer_end_queue) : les comptes qui n'ont l'accès Analyse que grâce
--      à l'offre (règle canonique app_private.launch_offer_account_eligible, hors administrateurs, comptes
--      premium et abonnés Analyse, comme le chiffre « launch_offer_accounts » du pilotage), non désinscrits,
--      pas encore prévenus pour cette date ;
--   6. la purge du journal (public.purge_launch_offer_end_notices), appelée par la tâche de rétention.
--
-- Rien n'est envoyé par cette migration ni par aucune tâche planifiée : l'envoi n'a lieu que sur l'action
-- explicite d'un administrateur (/admin/clients). Aucune donnée existante n'est modifiée (colonne ajoutée
-- sans valeur, tables neuves).

-- 1. La date de fin annoncée ----------------------------------------------------------------------------
alter table app_private.launch_offer
  add column if not exists ends_on date;

comment on column app_private.launch_offer.ends_on is
  'Date de fin ANNONCÉE de l''offre de lancement (jour du calendrier de Paris), celle que dit le préavis par email. Ne coupe rien : l''offre reste active jusqu''à set_launch_offer(false).';

-- 2. Lecture et écriture de la configuration ---------------------------------------------------------------
create or replace function public.get_launch_offer_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'active', app_private.launch_offer_active(),
    'ends_on', (select offer.ends_on from app_private.launch_offer offer where offer.singleton),
    'updated_at', (select offer.updated_at from app_private.launch_offer offer where offer.singleton)
  );
$function$;

revoke all on function public.get_launch_offer_config() from public, anon, authenticated;
grant execute on function public.get_launch_offer_config() to service_role;

comment on function public.get_launch_offer_config() is
  'État de l''offre de lancement et date de fin annoncée ({ active, ends_on, updated_at }). Lecture serveur seule (service_role).';

create or replace function public.set_launch_offer_end(p_ends_on date, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Une date passée ne se pose pas : elle ne pourrait que fausser un préavis. null efface la date.
  if p_ends_on is not null
    and p_ends_on < (statement_timestamp() at time zone 'Europe/Paris')::date then
    raise exception using errcode = '22023',
      message = 'The end date of the launch offer cannot be in the past.';
  end if;

  update app_private.launch_offer offer
  set ends_on = p_ends_on,
      updated_by = p_actor,
      updated_at = statement_timestamp()
  where offer.singleton;
  -- Pas de ligne : l'offre n'existe pas. On ne la crée pas ici (ce serait l'allumer).
  if not found then
    raise exception using errcode = 'P0002',
      message = 'The launch offer configuration row is missing.';
  end if;

  return public.get_launch_offer_config();
end;
$function$;

revoke all on function public.set_launch_offer_end(date, uuid) from public, anon, authenticated;
grant execute on function public.set_launch_offer_end(date, uuid) to service_role;

comment on function public.set_launch_offer_end(date, uuid) is
  'Enregistre (ou efface avec null) la date de fin annoncée de l''offre de lancement. Réservée au service_role : le serveur d''application contrôle le rôle administrateur et passe son identifiant.';

-- 3. Journal du préavis --------------------------------------------------------------------------------
create table if not exists public.launch_offer_end_notices (
  user_id uuid not null references auth.users (id) on delete cascade,
  ends_on date not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  message_id text,
  error text check (error is null or error in ('email_unavailable', 'send_failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint launch_offer_end_notices_pkey primary key (user_id, ends_on)
);

comment on table public.launch_offer_end_notices is
  'Journal du préavis de fin de l''offre de lancement : un préavis (compte, date de fin annoncée) n''est envoyé qu''une fois. Aucun contenu d''email, seulement l''état. Écrit par l''envoi administrateur (service_role) uniquement ; purgé par public.purge_launch_offer_end_notices.';
comment on column public.launch_offer_end_notices.ends_on is
  'La date de fin annoncée que disait le préavis (app_private.launch_offer.ends_on au moment de l''envoi).';
comment on column public.launch_offer_end_notices.error is
  'Code court de l''échec, d''une liste fermée : email_unavailable, send_failed. Jamais de texte libre.';

create index if not exists launch_offer_end_notices_created_idx
  on public.launch_offer_end_notices (created_at);

alter table public.launch_offer_end_notices enable row level security;

-- Aucun accès depuis le navigateur : ni lecture, ni écriture, aucune politique.
revoke all on table public.launch_offer_end_notices from public, anon, authenticated;
grant select, insert, update, delete on table public.launch_offer_end_notices to service_role;

-- 4. Désinscrits ----------------------------------------------------------------------------------------
create table if not exists public.launch_offer_end_notice_optouts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  unsubscribed_at timestamptz not null default now()
);

comment on table public.launch_offer_end_notice_optouts is
  'Comptes désinscrits du préavis de fin de l''offre de lancement (lien du message, un clic). Liste d''exclusion : conservée tant que le compte existe, supprimée avec lui.';

alter table public.launch_offer_end_notice_optouts enable row level security;
revoke all on table public.launch_offer_end_notice_optouts from public, anon, authenticated;
grant select, insert, update, delete on table public.launch_offer_end_notice_optouts to service_role;

-- 5. La file d'envoi -----------------------------------------------------------------------------------
-- Un document jsonb { audience, opted_out, notified, total, needs_review, in_progress, recipients }.
--   * audience : comptes qui n'ont l'accès Analyse que grâce à l'offre ;
--   * opted_out : parmi eux, les désinscrits ; notified : prévenus pour cette date ;
--   * total : envoyables maintenant (jamais essayés, ou 'failed' / 'pending' abandonné depuis plus d'une
--     heure, moins de 3 essais, premier essai de moins de 23 h : la clé d'idempotence de Resend vaut 24 h) ;
--   * in_progress : réservés depuis moins d'une heure (un envoi est peut-être en cours) ;
--   * needs_review : essais épuisés ou premier essai de plus de 23 h : un email a pu partir sans qu'on le
--     sache, ils ne sont plus relancés tout seuls (vérifier le journal d'envoi de Resend, clé
--     « immojudis-launch-offer-end-<user_id>-<date> ») ;
--   * recipients : au plus p_limit (1 à 200) identifiants, les jamais essayés d'abord. Aucune adresse ne sort.
create or replace function public.get_launch_offer_end_queue(
  p_ends_on date,
  p_limit integer default 200,
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with audience as (
    select account.id as user_id
    from auth.users account
    join public.user_profiles profile on profile.user_id = account.id
    where app_private.launch_offer_account_eligible(account.id)
      and profile.user_role is distinct from 'admin'
      and profile.account_tier is distinct from 'premium'
      and not exists (
        select 1
        from public.user_subscriptions subscription
        where subscription.user_id = account.id
          and subscription.plan_code = 'analyse'
          and app_private.subscription_grants_access(
            subscription.status,
            subscription.current_period_end
          )
      )
      and pg_catalog.btrim(coalesce(account.email, '')) <> ''
  ),
  state as (
    select
      a.user_id,
      exists (
        select 1 from public.launch_offer_end_notice_optouts optout where optout.user_id = a.user_id
      ) as opted_out,
      notice.status,
      notice.attempts,
      notice.created_at,
      notice.updated_at
    from audience a
    left join public.launch_offer_end_notices notice
      on notice.user_id = a.user_id and notice.ends_on = p_ends_on
  ),
  open_state as (
    select s.*
    from state s
    where not s.opted_out
  ),
  sendable as (
    select o.*
    from open_state o
    where o.status is null
       or (
         o.attempts < 3
         and o.created_at > p_now - interval '23 hours'
         and (
           o.status = 'failed'
           or (o.status = 'pending' and o.updated_at < p_now - interval '1 hour')
         )
       )
  ),
  -- Les comptes jamais essayés d'abord, puis par identifiant : un ordre stable d'un passage à l'autre.
  picked as (
    select
      s.user_id,
      pg_catalog.row_number() over (order by (s.status is not null), s.user_id) as position
    from sendable s
    order by position
    limit least(greatest(coalesce(p_limit, 200), 1), 200)
  )
  select pg_catalog.jsonb_build_object(
    'audience', (select pg_catalog.count(*) from audience),
    'opted_out', (select pg_catalog.count(*) from state where opted_out),
    'notified', (select pg_catalog.count(*) from open_state where status = 'sent'),
    'total', (select pg_catalog.count(*) from sendable),
    'in_progress', (
      select pg_catalog.count(*) from open_state
      where status = 'pending' and updated_at >= p_now - interval '1 hour'
        and user_id not in (select user_id from sendable)
    ),
    'needs_review', (
      select pg_catalog.count(*) from open_state
      where status in ('pending', 'failed')
        and user_id not in (select user_id from sendable)
        and not (status = 'pending' and updated_at >= p_now - interval '1 hour')
    ),
    'recipients', coalesce(
      (select pg_catalog.jsonb_agg(picked.user_id order by picked.position) from picked),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.get_launch_offer_end_queue(date, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_launch_offer_end_queue(date, integer, timestamptz)
  to service_role;

comment on function public.get_launch_offer_end_queue(date, integer, timestamptz) is
  'File d''envoi du préavis de fin de l''offre de lancement pour une date annoncée : comptes qui n''ont l''accès Analyse que grâce à l''offre, non désinscrits, pas encore prévenus. Nombres et identifiants seulement, aucune adresse. Lecture serveur seule (service_role).';

-- 6. Réservation d'un préavis ---------------------------------------------------------------------------
-- Renvoie vrai quand l'appelant peut envoyer : première réservation, ou reprise d'une ligne 'failed' (ou
-- 'pending' abandonnée depuis plus d'une heure), trois essais au plus, dans les 23 h du premier. Faux quand
-- le préavis de cette date a déjà été réservé ou envoyé, ou quand le compte s'est désinscrit. Atomique.
create or replace function public.claim_launch_offer_end_notice(
  p_user_id uuid,
  p_ends_on date,
  p_now timestamptz default statement_timestamp()
)
returns boolean
language sql
security invoker
set search_path = ''
as $function$
  with claimed as (
    insert into public.launch_offer_end_notices as notice
      (user_id, ends_on, status, attempts, created_at, updated_at)
    select p_user_id, p_ends_on, 'pending', 1, p_now, p_now
    where not exists (
      select 1 from public.launch_offer_end_notice_optouts optout where optout.user_id = p_user_id
    )
    on conflict (user_id, ends_on) do update
      set status = 'pending',
          attempts = notice.attempts + 1,
          error = null,
          updated_at = excluded.updated_at
      where notice.attempts < 3
        and notice.created_at > p_now - interval '23 hours'
        and (
          notice.status = 'failed'
          or (notice.status = 'pending' and notice.updated_at < p_now - interval '1 hour')
        )
    returning 1
  )
  select exists (select 1 from claimed);
$function$;

revoke all on function public.claim_launch_offer_end_notice(uuid, date, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_launch_offer_end_notice(uuid, date, timestamptz)
  to service_role;

comment on function public.claim_launch_offer_end_notice(uuid, date, timestamptz) is
  'Réserve le préavis de fin de l''offre de lancement d''un compte pour une date : vrai quand il faut envoyer, faux quand il l''a déjà été ou que le compte s''est désinscrit. Réservée à l''envoi administrateur (service_role).';

-- 7. Purge ------------------------------------------------------------------------------------------------
-- Le journal sert de preuve du préavis : 24 mois (12 au minimum). Appelée par la tâche de rétention
-- (src/lib/cron-jobs.ts), qui tourne aussi quand aucun envoi n'a lieu.
create or replace function public.purge_launch_offer_end_notices(
  p_older_than interval default interval '24 months'
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  deleted_count integer;
begin
  if p_older_than < interval '12 months' then
    raise exception 'La durée de conservation du journal du préavis ne peut pas descendre sous 12 mois.';
  end if;
  with removed as (
    delete from public.launch_offer_end_notices
    where created_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into deleted_count from removed;
  return deleted_count;
end;
$function$;

revoke all on function public.purge_launch_offer_end_notices(interval)
  from public, anon, authenticated;
grant execute on function public.purge_launch_offer_end_notices(interval) to service_role;

comment on function public.purge_launch_offer_end_notices(interval) is
  'Supprime les lignes du journal du préavis de fin de l''offre de lancement plus anciennes que 24 mois (12 au minimum). Réservée à la tâche de rétention et au service_role.';

notify pgrst, 'reload schema';

commit;
