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
-- ends_on) garantit un seul email par compte, même si le passage du cron est relancé ou rattrapé.
--
-- Cette migration ne pose que la FILE D'ENVOI, en lecture : public.get_trial_end_notice_queue. Aucun
-- email n'est envoyé par elle ; l'envoi est le cron /api/cron/trial-end-email, derrière
-- TRIAL_END_EMAIL_MODE (off par défaut). Aucune donnée existante n'est modifiée.
--
-- Qui est dans la file : un compte dont l'essai se termine dans les 2 prochains jours (J+5 atteint) et
-- pas dans les 6 prochaines heures (un message qui arrive à la veille de la fin n'apprend plus rien),
-- avec profil et adresse confirmée, hors administrateurs, comptes premium et abonnés Analyse (ils ne
-- perdent rien), essai encore ouvert pour lui (interrupteur actif, ou adresse confirmée avant la coupure),
-- non désinscrit, pas encore prévenu pour cette fin d'essai.
--
-- Réponse (jsonb) : { audience, opted_out, notified, total, in_progress, needs_review, recipients } avec les
-- mêmes sens que public.get_launch_offer_end_queue ; « recipients » liste au plus p_limit (1 à 200)
-- objets { user_id, ends_at, ends_on }, les jamais essayés d'abord. Aucune adresse ne sort.
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
      on notice.user_id = d.user_id and notice.ends_on = d.ends_on
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
  'File d''envoi de l''email de fin d''essai (J+5) : comptes dont l''essai se termine dans les 2 jours, non désinscrits, pas encore prévenus pour cette fin. Nombres et identifiants seulement, aucune adresse. Lecture serveur seule (service_role). Le journal est public.launch_offer_end_notices (ends_on = jour de Paris de la fin d''essai du compte).';

notify pgrst, 'reload schema';

commit;
