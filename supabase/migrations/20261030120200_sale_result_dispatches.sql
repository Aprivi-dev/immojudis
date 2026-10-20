begin;

set local lock_timeout = '5s';

-- Journal d'envoi de l'alerte de résultat ou de remise en vente d'une vente suivie (point 73 de la
-- session du 20/10/2026).
--
-- Une ligne = un email pour un compte, une vente et un type. La contrainte d'unicité (user_id, sale_id,
-- result_kind) garantit qu'un compte n'est jamais prévenu deux fois du même résultat pour la même vente,
-- même si le cron passe plusieurs fois (« un email par compte, vente et type ») :
--   * result_known   : la vente a eu lieu et est connue comme adjugée (instantané après l'audience, ou
--                      statut « adjugée » détecté par le suivi des changements) ;
--   * result_unknown : la vente a eu lieu mais Immojudis n'en connaît pas le résultat (instantané) ;
--   * withdrawn      : vente retirée ou annulée (suivi des changements) ;
--   * relisted       : vente remise en vente, c'est-à-dire de nouveau « à venir » après avoir été passée,
--                      adjugée, retirée ou annulée (suivi des changements).
-- Aucun type « non adjugée » : aucune source ne distingue une vente non adjugée d'un résultat inconnu, donc
-- Immojudis ne l'affirme pas.
--
-- Pas de clé étrangère vers auction_sales, comme user_followed_sale_snapshots : la vente est supprimée par
-- la rétention du catalogue après l'audience, et une cascade effacerait la ligne « déjà envoyé » alors que
-- l'instantané qui a déclenché l'email existe encore (l'email repartirait le lendemain). Les lignes
-- disparaissent avec le compte (on delete cascade) et au bout de 180 jours (purge ci-dessous).
--
-- Le cron réserve la ligne AVANT d'envoyer (public.claim_sale_result), avec la même reprise que
-- public.claim_sale_reminder : ligne 'failed' ou 'pending' orpheline de plus d'une heure, trois essais.
--
-- Minimisation : aucun contenu d'email ni aucun prix n'est gardé. Le payload ne porte que l'origine de la
-- détection (instantané ou changement de statut) et le statut lu, jamais un montant.
create table if not exists public.sale_result_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null,
  result_kind text not null check (
    result_kind in ('result_known', 'result_unknown', 'withdrawn', 'relisted')
  ),
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
  constraint sale_result_dispatches_once_key unique (user_id, sale_id, result_kind)
);

comment on table public.sale_result_dispatches is
  'Journal des alertes de résultat ou de remise en vente : un email (compte, vente, type) n''est envoyé qu''une fois. Jamais de prix. Écrit par le cron sale-results (service_role) uniquement.';
comment on column public.sale_result_dispatches.sale_id is
  'Identifiant de la vente suivie. Sans clé étrangère : la vente est supprimée par la rétention du catalogue après l''audience.';
comment on column public.sale_result_dispatches.payload is
  'Origine de la détection (snapshot ou status_event) et statut lu : jamais un prix ni le contenu de l''email.';
comment on column public.sale_result_dispatches.error is
  'Code court de l''échec, d''une liste fermée : email_unavailable, email_lookup_failed, message_build_failed, send_failed, journal_failed. Jamais de texte libre.';

create index if not exists sale_result_dispatches_created_idx
  on public.sale_result_dispatches (created_at);
create index if not exists sale_result_dispatches_sent_idx
  on public.sale_result_dispatches (user_id, sent_at desc)
  where status = 'sent';

alter table public.sale_result_dispatches enable row level security;

-- Aucun accès depuis le navigateur : ni lecture, ni écriture, aucune politique.
revoke all on table public.sale_result_dispatches from public, anon, authenticated;
grant select, insert, update, delete on table public.sale_result_dispatches to service_role;

create or replace function public.claim_sale_result(
  p_user_id uuid,
  p_sale_id uuid,
  p_kind text,
  p_mode text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language sql
security invoker
set search_path = ''
as $function$
  insert into public.sale_result_dispatches as dispatch (
    user_id, sale_id, result_kind, mode, payload
  )
  values (p_user_id, p_sale_id, p_kind, p_mode, coalesce(p_payload, '{}'::jsonb))
  on conflict (user_id, sale_id, result_kind) do update
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

revoke all on function public.claim_sale_result(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_sale_result(uuid, uuid, text, text, jsonb) to service_role;

comment on function public.claim_sale_result(uuid, uuid, text, text, jsonb) is
  'Réserve l''alerte de résultat d''un compte pour une vente et un type : renvoie l''id quand il faut envoyer, rien quand elle l''a déjà été. Réservée au cron (service_role).';

-- Purge du journal : 180 jours (30 au minimum), appelée par public.run_data_retention (20261030120300).
create or replace function public.purge_sale_result_dispatches(
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
    raise exception 'La durée de conservation du journal des alertes de résultat ne peut pas descendre sous 30 jours.';
  end if;
  with removed as (
    delete from public.sale_result_dispatches
    where created_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into deleted_count from removed;
  return deleted_count;
end;
$function$;

revoke all on function public.purge_sale_result_dispatches(interval)
  from public, anon, authenticated;
grant execute on function public.purge_sale_result_dispatches(interval) to service_role;

comment on function public.purge_sale_result_dispatches(interval) is
  'Supprime les lignes du journal des alertes de résultat plus anciennes que 180 jours (30 jours au minimum). Réservée à run_data_retention et au service_role.';

notify pgrst, 'reload schema';

commit;
