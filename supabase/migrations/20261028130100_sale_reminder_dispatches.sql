begin;

set local lock_timeout = '5s';

-- Journal des rappels d'audience et des avertissements graves envoyés (ou en cours d'envoi).
--
-- Une ligne = un rappel pour une personne, une vente et un motif.  La contrainte d'unicité
-- (user_id, sale_id, reminder_kind, dedupe_key) garantit qu'un même rappel n'est JAMAIS envoyé deux
-- fois, même si le cron passe plusieurs fois, se chevauche avec son passage de rattrapage ou est
-- relancé à la main:
--   * audience_j7 / audience_j1: dedupe_key = le jour d'audience (calendrier de Paris, AAAA-MM-JJ).
--     Une date qui change donne une nouvelle clé, donc de nouveaux rappels pour la nouvelle date;
--   * date_changed / status_changed: dedupe_key = l'empreinte de l'événement de changement
--     (user_sale_change_events.fingerprint).
-- Le cron réserve la ligne AVANT d'envoyer (public.claim_sale_reminder).  Une ligne 'pending' dont
-- l'envoi a été interrompu n'est pas renvoyée (on préfère un rappel manquant à un doublon); une
-- ligne 'failed' peut être réessayée, trois essais au plus.
--
-- La colonne payload garde ce qui a été annoncé (date, libellé): c'est ce qui permet de mesurer les
-- fausses alertes pendant le mode d'essai (SALE_REMINDERS_MODE=internal) avant l'ouverture.
create table if not exists public.sale_reminder_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  reminder_kind text not null check (
    reminder_kind in ('audience_j7', 'audience_j1', 'date_changed', 'status_changed')
  ),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  mode text not null check (mode in ('internal', 'on')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  payload jsonb not null default '{}'::jsonb,
  message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_reminder_dispatches_once_key
    unique (user_id, sale_id, reminder_kind, dedupe_key)
);

comment on table public.sale_reminder_dispatches is
  'Journal des rappels d''audience et avertissements graves: un rappel (personne, vente, motif, clé) n''est envoyé qu''une fois. Écrit par le cron sale-reminders (service_role) uniquement.';
comment on column public.sale_reminder_dispatches.dedupe_key is
  'Jour d''audience (Paris, AAAA-MM-JJ) pour audience_j7 et audience_j1; empreinte de l''événement de changement pour date_changed et status_changed.';
comment on column public.sale_reminder_dispatches.payload is
  'Ce qui a été annoncé dans l''email (libellé, dates): sert à mesurer les fausses alertes en mode interne.';

create index if not exists sale_reminder_dispatches_created_idx
  on public.sale_reminder_dispatches (created_at);
create index if not exists sale_reminder_dispatches_kind_idx
  on public.sale_reminder_dispatches (reminder_kind, created_at desc);
create index if not exists sale_reminder_dispatches_sale_idx
  on public.sale_reminder_dispatches (sale_id);

alter table public.sale_reminder_dispatches enable row level security;

-- Aucun accès depuis le navigateur: ni lecture, ni écriture, aucune politique.  Seul le cron
-- (service_role, qui contourne la sécurité par ligne) lit et écrit le journal.
revoke all on table public.sale_reminder_dispatches from public, anon, authenticated;
grant select, insert, update, delete on table public.sale_reminder_dispatches to service_role;

-- Réserve un rappel.  Renvoie l'identifiant de la ligne quand l'appelant peut envoyer (première
-- réservation, ou nouvel essai d'une ligne 'failed' qui n'a pas épuisé ses trois essais), et
-- aucune ligne quand le rappel a déjà été réservé ou envoyé.  Atomique: deux cron simultanés ne
-- peuvent pas réserver le même rappel.
create or replace function public.claim_sale_reminder(
  p_user_id uuid,
  p_sale_id uuid,
  p_kind text,
  p_key text,
  p_mode text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language sql
security invoker
set search_path = ''
as $function$
  insert into public.sale_reminder_dispatches as dispatch (
    user_id, sale_id, reminder_kind, dedupe_key, mode, payload
  )
  values (p_user_id, p_sale_id, p_kind, p_key, p_mode, coalesce(p_payload, '{}'::jsonb))
  on conflict (user_id, sale_id, reminder_kind, dedupe_key) do update
    set status = 'pending',
        attempts = dispatch.attempts + 1,
        mode = excluded.mode,
        payload = excluded.payload,
        error = null,
        updated_at = now()
    where dispatch.status = 'failed' and dispatch.attempts < 3
  returning dispatch.id;
$function$;

revoke all on function public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb)
  to service_role;

comment on function public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb) is
  'Réserve un rappel d''audience: renvoie l''id quand il faut envoyer, rien quand il l''a déjà été. Réservée au cron (service_role).';

-- Purge du journal: les audiences sont passées depuis longtemps après 180 jours, et aucun
-- événement de changement aussi ancien n'est relu.  Appelée en fin de chaque passage du cron.
create or replace function public.purge_sale_reminder_dispatches(
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
    raise exception 'La durée de conservation du journal des rappels ne peut pas descendre sous 30 jours.';
  end if;
  with removed as (
    delete from public.sale_reminder_dispatches
    where created_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into deleted_count from removed;
  return deleted_count;
end;
$function$;

revoke all on function public.purge_sale_reminder_dispatches(interval)
  from public, anon, authenticated;
grant execute on function public.purge_sale_reminder_dispatches(interval) to service_role;

comment on function public.purge_sale_reminder_dispatches(interval) is
  'Supprime les lignes du journal des rappels plus anciennes que 180 jours (30 jours au minimum). Réservée au cron (service_role).';

notify pgrst, 'reload schema';

commit;
