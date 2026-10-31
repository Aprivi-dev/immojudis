begin;

set local lock_timeout = '5s';

-- Lot 6, n° 87 : email unique de fin d'essai, à J+5 après la confirmation de l'adresse (l'essai dure 7
-- jours : le message part deux jours avant la fin).
--
-- Le préavis existe déjà dans la base (20261102140000) : journal public.launch_offer_end_notices (un
-- préavis par compte et par date de fin), liste de désinscription
-- public.launch_offer_end_notice_optouts, réservation public.claim_launch_offer_end_notice. Ces objets
-- servaient à un préavis GLOBAL (une date de fin de l'offre annoncée à tous) dont aucun outil d'envoi n'a
-- jamais existé. Ici le même journal sert à la fin d'essai PROPRE À CHAQUE COMPTE : « ends_on » est le
-- jour de Paris de la fin de l'essai du compte (app_private.signup_trial_ends_at). La clé (user_id,
-- ends_on, kind) garantit un seul email par compte et par type, même si le passage du cron est relancé
-- ou rattrapé.
--
-- Les deux messages peuvent tomber le même jour : une fin d'essai du compte le jour même de la date de fin
-- de l'offre annoncée à tous. Avec la seule clé (user_id, ends_on), le second message serait pris pour
-- le premier et ne partirait jamais. Le journal reçoit donc un TYPE (colonne « kind » : 'launch_offer_end'
-- pour le préavis global, 'trial_end' pour la fin d'essai) qui entre dans la clé. Les lignes existantes
-- prennent 'launch_offer_end' (valeur par défaut) ; la désinscription reste COMMUNE aux deux messages (un
-- compte qui se désinscrit de l'un n'est plus écrit pour l'autre : voulu, une seule liste).
--
-- Cette migration pose le type du journal, la réservation de la fin d'essai (public.claim_trial_end_notice)
-- et la FILE D'ENVOI, en lecture : public.get_trial_end_notice_queue. Elle redéfinit à l'identique, à la
-- clé près, les deux fonctions du préavis global qui dépendent de la clé (public.claim_launch_offer_end_notice
-- et public.get_launch_offer_end_queue). Aucun email n'est envoyé par elle ; l'envoi est le cron
-- /api/cron/trial-end-email, derrière TRIAL_END_EMAIL_MODE (off par défaut). Aucune ligne existante n'est
-- modifiée.
--
-- 1. Type du journal ---------------------------------------------------------------------------------------
-- Ajout d'une colonne à valeur par défaut constante (sans réécriture de la table), puis la clé devient
-- (user_id, ends_on, kind). Le journal est petit (un message par compte et par fin) : le verrou est bref.
alter table public.launch_offer_end_notices
  add column if not exists kind text not null default 'launch_offer_end'
  check (kind in ('launch_offer_end', 'trial_end'));

comment on column public.launch_offer_end_notices.kind is
  'Le message que dit la ligne : launch_offer_end (préavis global de fin de l''offre, ends_on = date annoncée) ou trial_end (fin d''essai propre au compte, ends_on = jour de Paris de cette fin). Le type entre dans la clé : les deux messages d''un même jour ne se bloquent pas.';

alter table public.launch_offer_end_notices drop constraint if exists launch_offer_end_notices_pkey;
alter table public.launch_offer_end_notices
  add constraint launch_offer_end_notices_pkey primary key (user_id, ends_on, kind);

-- 2. Préavis global : mêmes fonctions, à la clé près -----------------------------------------------------
-- Le préavis ne voit plus que ses lignes ('launch_offer_end') et réserve avec la nouvelle clé.
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
      on notice.user_id = a.user_id
      and notice.ends_on = p_ends_on
      and notice.kind = 'launch_offer_end'
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
      (user_id, ends_on, kind, status, attempts, created_at, updated_at)
    select p_user_id, p_ends_on, 'launch_offer_end', 'pending', 1, p_now, p_now
    where not exists (
      select 1 from public.launch_offer_end_notice_optouts optout where optout.user_id = p_user_id
    )
    on conflict (user_id, ends_on, kind) do update
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

-- 3. Réservation de la fin d'essai -------------------------------------------------------------------------
-- Même règle que celle du préavis global (première réservation, ou reprise d'un 'failed' / d'un 'pending'
-- abandonné depuis plus d'une heure, trois essais au plus, dans les 23 h du premier), sur les lignes
-- 'trial_end'. Faux quand ce message a déjà été réservé ou envoyé, ou quand le compte s'est désinscrit.
create or replace function public.claim_trial_end_notice(
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
      (user_id, ends_on, kind, status, attempts, created_at, updated_at)
    select p_user_id, p_ends_on, 'trial_end', 'pending', 1, p_now, p_now
    where not exists (
      select 1 from public.launch_offer_end_notice_optouts optout where optout.user_id = p_user_id
    )
    on conflict (user_id, ends_on, kind) do update
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

revoke all on function public.claim_trial_end_notice(uuid, date, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_trial_end_notice(uuid, date, timestamptz) to service_role;

comment on function public.claim_trial_end_notice(uuid, date, timestamptz) is
  'Réserve l''email de fin d''essai d''un compte pour un jour de fin (ligne kind = trial_end du journal du préavis) : vrai quand il faut envoyer, faux quand il l''a déjà été ou que le compte s''est désinscrit. Réservée à l''envoi (service_role).';

-- 4. File d'envoi ---------------------------------------------------------------------------------------------
-- Qui est dans la file : un compte dont l'essai se termine dans les 2 prochains jours (J+5 atteint) et
-- pas dans les 6 prochaines heures (un message qui arrive à la veille de la fin n'apprend plus rien),
-- avec profil et adresse confirmée, hors administrateurs, comptes premium et abonnés Analyse (ils ne
-- perdent rien), essai encore ouvert pour lui (interrupteur actif, ou adresse confirmée avant la coupure),
-- non désinscrit, pas encore prévenu pour cette fin d'essai.
--
-- Réponse (jsonb) : { audience, opted_out, notified, total, in_progress, needs_review, recipients } avec les
-- mêmes sens que public.get_launch_offer_end_queue ; « recipients » liste au plus p_limit (1 à 200)
-- objets { user_id, ends_at, ends_on }, les jamais essayés d'abord. Aucune adresse ne sort.
--
-- Reprise d'un envoi : un 'failed' (ou un 'pending' abandonné depuis plus d'une heure) est repris trois fois
-- au plus, dans les 23 h du premier essai, jamais au-delà : la clé d'idempotence de Resend ne protège d'un
-- doublon que pendant 24 h. Le cron passe deux fois le même jour (12:30, rattrapage 14:30 si le premier
-- passage a échoué) : la reprise tombe donc dans la fenêtre. Au-delà, la ligne est comptée dans
-- « needs_review » (un message a pu partir sans qu'on le sache) et n'est plus jamais rejouée.
create or replace function public.get_trial_end_notice_queue(
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
    select
      account.id as user_id,
      app_private.signup_trial_ends_at(account.id) as ends_at
    from auth.users account
    join public.user_profiles profile on profile.user_id = account.id
    where account.email_confirmed_at is not null
      -- Garde d'index : seuls les comptes confirmés il y a 5 à 7 jours peuvent être concernés.
      and account.email_confirmed_at > p_now - interval '8 days'
      and account.email_confirmed_at <= p_now
      and pg_catalog.btrim(coalesce(account.email, '')) <> ''
      and profile.user_role is distinct from 'admin'
      and profile.account_tier is distinct from 'premium'
      and (
        app_private.launch_offer_active()
        or app_private.launch_offer_confirmed_before_close(account.id)
      )
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
  ),
  due as (
    select
      a.user_id,
      a.ends_at,
      (a.ends_at at time zone 'Europe/Paris')::date as ends_on
    from audience a
    where a.ends_at > p_now + interval '6 hours'
      and a.ends_at <= p_now + interval '2 days'
  ),
  state as (
    select
      d.user_id,
      d.ends_at,
      d.ends_on,
      exists (
        select 1 from public.launch_offer_end_notice_optouts optout where optout.user_id = d.user_id
      ) as opted_out,
      notice.status,
      notice.attempts,
      notice.created_at,
      notice.updated_at
    from due d
    left join public.launch_offer_end_notices notice
      on notice.user_id = d.user_id and notice.ends_on = d.ends_on and notice.kind = 'trial_end'
  ),
  open_state as (
    select s.* from state s where not s.opted_out
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
  picked as (
    select
      s.user_id,
      s.ends_at,
      s.ends_on,
      pg_catalog.row_number() over (order by (s.status is not null), s.ends_at, s.user_id) as position
    from sendable s
    order by position
    limit least(greatest(coalesce(p_limit, 200), 1), 200)
  )
  select pg_catalog.jsonb_build_object(
    'audience', (select pg_catalog.count(*) from due),
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
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'user_id', picked.user_id,
            'ends_at', picked.ends_at,
            'ends_on', picked.ends_on
          )
          order by picked.position
        )
        from picked
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.get_trial_end_notice_queue(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_trial_end_notice_queue(integer, timestamptz) to service_role;

comment on function public.get_trial_end_notice_queue(integer, timestamptz) is
  'File d''envoi de l''email de fin d''essai (J+5) : comptes dont l''essai se termine dans les 2 jours, non désinscrits, pas encore prévenus pour cette fin. Nombres et identifiants seulement, aucune adresse. Lecture serveur seule (service_role). Le journal est public.launch_offer_end_notices (kind = trial_end, ends_on = jour de Paris de la fin d''essai du compte).';

notify pgrst, 'reload schema';

commit;
