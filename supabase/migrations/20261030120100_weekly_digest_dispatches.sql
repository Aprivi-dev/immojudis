begin;

set local lock_timeout = '5s';

-- Journal d'envoi du récapitulatif hebdomadaire « Ma semaine » (point 70 de la session du 20/10/2026).
--
-- Une ligne = un récapitulatif pour un compte et une semaine ISO. La contrainte d'unicité (user_id,
-- week_key) garantit qu'un compte n'en reçoit JAMAIS deux pour la même semaine, même si le cron passe
-- plusieurs fois ou est relancé à la main. week_key est la semaine ISO (AAAA-Www, calendrier de Paris) du
-- jour d'envoi dû : le jour choisi par le compte, ou la veille quand l'envoi a été reporté d'un jour parce
-- qu'un autre email du compte était déjà parti ce jour-là (règle « au plus un email par compte et par
-- jour », voir src/lib/weekly-digest.ts).
--
-- Le cron réserve la ligne AVANT d'envoyer (public.claim_weekly_digest). Une ligne 'failed' ou une ligne
-- 'pending' orpheline de plus d'une heure peut être reprise, trois essais au plus (même règle que
-- public.claim_sale_reminder).
--
-- Minimisation : aucun contenu d'email n'est gardé, seulement des compteurs (payload : nombre d'audiences,
-- de changements et de nouvelles ventes annoncés). L'erreur est un code d'une liste fermée, jamais un
-- texte libre (comme sale_reminder_dispatches, 20261029130100).
create table if not exists public.weekly_digest_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_key text not null check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  mode text not null check (mode in ('internal', 'on')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  payload jsonb not null default '{}'::jsonb,
  message_id text,
  error text check (
    error is null
    or error in (
      'email_unavailable',
      'email_lookup_failed',
      'message_build_failed',
      'send_failed',
      'journal_failed'
    )
  ),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_digest_dispatches_once_key unique (user_id, week_key)
);

comment on table public.weekly_digest_dispatches is
  'Journal du récapitulatif hebdomadaire « Ma semaine » : un récapitulatif (compte, semaine ISO) n''est envoyé qu''une fois. Compteurs seulement, aucun contenu. Écrit par le cron weekly-digest (service_role) uniquement.';
comment on column public.weekly_digest_dispatches.week_key is
  'Semaine ISO (AAAA-Www, calendrier de Paris) du jour d''envoi dû.';
comment on column public.weekly_digest_dispatches.payload is
  'Compteurs de ce qui a été annoncé (audiences, changements, nouvelles ventes) : jamais le contenu de l''email.';
comment on column public.weekly_digest_dispatches.error is
  'Code court de l''échec, d''une liste fermée : email_unavailable, email_lookup_failed, message_build_failed, send_failed, journal_failed. Jamais de texte libre.';

create index if not exists weekly_digest_dispatches_created_idx
  on public.weekly_digest_dispatches (created_at);
create index if not exists weekly_digest_dispatches_sent_idx
  on public.weekly_digest_dispatches (user_id, sent_at desc)
  where status = 'sent';

alter table public.weekly_digest_dispatches enable row level security;

-- Aucun accès depuis le navigateur : ni lecture, ni écriture, aucune politique. Seul le cron
-- (service_role, qui contourne la sécurité par ligne) lit et écrit le journal.
revoke all on table public.weekly_digest_dispatches from public, anon, authenticated;
grant select, insert, update, delete on table public.weekly_digest_dispatches to service_role;

-- Réserve un récapitulatif. Renvoie l'identifiant de la ligne quand l'appelant peut envoyer (première
-- réservation, ligne 'failed' ou 'pending' orpheline de plus d'une heure, trois essais au plus) et aucune
-- ligne quand le récapitulatif de la semaine a déjà été réservé ou envoyé. Atomique.
create or replace function public.claim_weekly_digest(
  p_user_id uuid,
  p_week_key text,
  p_mode text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language sql
security invoker
set search_path = ''
as $function$
  insert into public.weekly_digest_dispatches as dispatch (user_id, week_key, mode, payload)
  values (p_user_id, p_week_key, p_mode, coalesce(p_payload, '{}'::jsonb))
  on conflict (user_id, week_key) do update
    set status = 'pending',
        attempts = dispatch.attempts + 1,
        mode = excluded.mode,
        payload = excluded.payload,
        error = null,
        updated_at = now()
    where dispatch.attempts < 3
      and (
        dispatch.status = 'failed'
        or (dispatch.status = 'pending' and dispatch.updated_at < now() - interval '1 hour')
      )
  returning dispatch.id;
$function$;

revoke all on function public.claim_weekly_digest(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_weekly_digest(uuid, text, text, jsonb) to service_role;

comment on function public.claim_weekly_digest(uuid, text, text, jsonb) is
  'Réserve le récapitulatif hebdomadaire d''un compte pour une semaine : renvoie l''id quand il faut envoyer, rien quand il l''a déjà été. Réservée au cron (service_role).';

-- Purge du journal : 180 jours (30 au minimum). Appelée par public.run_data_retention
-- (20261030120300), jamais seulement par le cron : elle doit tourner même quand l'envoi est fermé.
create or replace function public.purge_weekly_digest_dispatches(
  p_older_than interval default interval '180 days'
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  deleted_count integer;
begin
  if p_older_than < interval '30 days' then
    raise exception 'La durée de conservation du journal du récapitulatif hebdomadaire ne peut pas descendre sous 30 jours.';
  end if;
  with removed as (
    delete from public.weekly_digest_dispatches
    where created_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into deleted_count from removed;
  return deleted_count;
end;
$function$;

revoke all on function public.purge_weekly_digest_dispatches(interval)
  from public, anon, authenticated;
grant execute on function public.purge_weekly_digest_dispatches(interval) to service_role;

comment on function public.purge_weekly_digest_dispatches(interval) is
  'Supprime les lignes du journal du récapitulatif hebdomadaire plus anciennes que 180 jours (30 jours au minimum). Réservée à run_data_retention et au service_role.';

notify pgrst, 'reload schema';

commit;
