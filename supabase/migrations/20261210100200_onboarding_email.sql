begin;

set local lock_timeout = '5s';

-- Email unique de prise en main, le lendemain de l'inscription (décision du propriétaire du 26/11/2026,
-- après avis juridique). Le message reste un message de service, et non de la prospection, à des
-- conditions que cette migration porte côté base :
--   * UN SEUL message par compte : le journal public.onboarding_email_notices a pour clé le compte, et la
--     réservation public.claim_onboarding_email est prise AVANT l'envoi (même règle que
--     public.claim_trial_end_notice, 20261110180200) ;
--   * jamais aux comptes qui ont l'accès Analyse (abonnement, essai en cours, premium, administrateur :
--     règle canonique app_private.has_active_analysis_access), ni à ceux qui ont déjà débloqué une vente
--     ou en ont acheté une ;
--   * seulement dans les 24 à 72 heures qui suivent la création du compte : passé ce délai, ce n'est plus
--     de la prise en main, le compte n'est plus jamais dans la file ;
--   * jamais aux comptes désinscrits (liste d'exclusion public.onboarding_email_optouts, lien du message).
--
-- La règle d'audience est écrite UNE fois (app_private.onboarding_email_eligible) : la file la lit pour
-- choisir les comptes, la réservation la relit au moment de l'envoi (un compte qui débloque une vente
-- entre la lecture de la file et l'envoi n'est pas écrit).
--
-- Rien n'est envoyé par cette migration : l'envoi est le cron /api/cron/onboarding-email, derrière
-- ONBOARDING_EMAIL_MODE (off par défaut). Aucune donnée existante n'est modifiée (tables neuves).

-- 1. Journal ---------------------------------------------------------------------------------------------
create table if not exists public.onboarding_email_notices (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  message_id text,
  error text check (error is null or error in ('email_unavailable', 'send_failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.onboarding_email_notices is
  'Journal de l''email unique de prise en main : une ligne par compte (la clé), donc un seul message par compte. Aucun contenu d''email, seulement l''état. Écrit par l''envoi (service_role) uniquement ; purgé par public.purge_onboarding_email_notices.';
comment on column public.onboarding_email_notices.error is
  'Code court de l''échec, d''une liste fermée : email_unavailable, send_failed. Jamais de texte libre.';

create index if not exists onboarding_email_notices_created_idx
  on public.onboarding_email_notices (created_at);

alter table public.onboarding_email_notices enable row level security;

-- Aucun accès depuis le navigateur : ni lecture, ni écriture, aucune politique.
revoke all on table public.onboarding_email_notices from public, anon, authenticated;
grant select, insert, update, delete on table public.onboarding_email_notices to service_role;

-- 2. Désinscrits ---------------------------------------------------------------------------------------------
create table if not exists public.onboarding_email_optouts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  unsubscribed_at timestamptz not null default now()
);

comment on table public.onboarding_email_optouts is
  'Comptes qui se sont opposés à l''email de prise en main (lien du message, un clic). Liste d''exclusion : conservée tant que le compte existe, supprimée avec lui.';

alter table public.onboarding_email_optouts enable row level security;
revoke all on table public.onboarding_email_optouts from public, anon, authenticated;
grant select, insert, update, delete on table public.onboarding_email_optouts to service_role;

-- 3. Audience ----------------------------------------------------------------------------------------------
-- Vrai quand le compte peut recevoir le message à p_now : adresse confirmée et non vide, compte créé il y
-- a 24 à 72 heures, profil non administrateur, aucun accès Analyse (abonnement, essai en cours, premium,
-- administrateur), aucun déblocage (de toute source, même rendu) ni achat d'une vente (de tout état). Ne
-- dit rien de la désinscription ni du journal : la file et la réservation les lisent elles-mêmes.
create or replace function app_private.onboarding_email_eligible(
  p_user_id uuid,
  p_now timestamptz default statement_timestamp()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select account.email_confirmed_at is not null
        and pg_catalog.btrim(coalesce(account.email, '')) <> ''
        and account.created_at <= p_now - interval '24 hours'
        and account.created_at > p_now - interval '72 hours'
        and profile.user_role is distinct from 'admin'
        and not app_private.has_active_analysis_access(account.id)
        and not exists (
          select 1 from public.user_sale_unlocks unlock_row where unlock_row.user_id = account.id
        )
        and not exists (
          select 1 from public.sale_unlock_purchases purchase where purchase.user_id = account.id
        )
      from auth.users account
      join public.user_profiles profile on profile.user_id = account.id
      where account.id = p_user_id
    ),
    false
  );
$function$;

revoke all on function app_private.onboarding_email_eligible(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.onboarding_email_eligible(uuid, timestamptz) to service_role;

comment on function app_private.onboarding_email_eligible(uuid, timestamptz) is
  'Règle d''audience de l''email de prise en main, écrite une fois : adresse confirmée, compte créé il y a 24 à 72 heures, ni administrateur ni accès Analyse (has_active_analysis_access), aucun déblocage ni achat de vente. Lue par la file et par la réservation. Jamais ouverte au navigateur.';

-- 4. Réservation ---------------------------------------------------------------------------------------------
-- Même règle que public.claim_trial_end_notice : première réservation, ou reprise d'un 'failed' (ou d'un
-- 'pending' abandonné depuis plus d'une heure), trois essais au plus, dans les 23 h du premier. Faux quand
-- le message a déjà été réservé ou envoyé, quand le compte s'est désinscrit, ou quand il n'est plus dans
-- l'audience (déblocage, accès Analyse, délai de 72 heures passé). Atomique.
create or replace function public.claim_onboarding_email(
  p_user_id uuid,
  p_now timestamptz default statement_timestamp()
)
returns boolean
language sql
security invoker
set search_path = ''
as $function$
  with claimed as (
    insert into public.onboarding_email_notices as notice
      (user_id, status, attempts, created_at, updated_at)
    select p_user_id, 'pending', 1, p_now, p_now
    where app_private.onboarding_email_eligible(p_user_id, p_now)
      and not exists (
        select 1 from public.onboarding_email_optouts optout where optout.user_id = p_user_id
      )
    on conflict (user_id) do update
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

revoke all on function public.claim_onboarding_email(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_onboarding_email(uuid, timestamptz) to service_role;

comment on function public.claim_onboarding_email(uuid, timestamptz) is
  'Réserve l''email unique de prise en main d''un compte : vrai quand il faut envoyer, faux quand il l''a déjà été, que le compte s''est désinscrit ou qu''il n''est plus dans l''audience (app_private.onboarding_email_eligible). Réservée à l''envoi (service_role).';

-- 5. File d'envoi --------------------------------------------------------------------------------------------
-- Réponse (jsonb) : { audience, opted_out, notified, total, in_progress, needs_review, recipients }, mêmes
-- sens que public.get_trial_end_notice_queue ; « recipients » liste au plus p_limit (1 à 200) objets
-- { user_id, department }, les jamais essayés d'abord. « department » est le département de la plus
-- ancienne alerte active du compte (null sans alerte active, ou quand cette alerte n'a pas de
-- département) : le seul lien du message ouvre le catalogue filtré sur lui. Aucune adresse ne sort.
--
-- Reprise d'un envoi : trois essais au plus, dans les 23 h du premier, jamais au-delà (la clé
-- d'idempotence de Resend ne protège d'un doublon que 24 h). Le cron passe à 13:30 et, si ce passage a
-- échoué, à 15:30 le même jour. Au-delà, la ligne est comptée dans « needs_review » et n'est plus rejouée.
create or replace function public.get_onboarding_email_queue(
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
    select account.id as user_id, account.created_at
    from auth.users account
    -- Garde : seuls les comptes créés il y a 24 à 72 heures peuvent être concernés (la règle complète
    -- est app_private.onboarding_email_eligible).
    where account.created_at <= p_now - interval '24 hours'
      and account.created_at > p_now - interval '72 hours'
      and app_private.onboarding_email_eligible(account.id, p_now)
  ),
  state as (
    select
      a.user_id,
      a.created_at as account_created_at,
      exists (
        select 1 from public.onboarding_email_optouts optout where optout.user_id = a.user_id
      ) as opted_out,
      notice.status,
      notice.attempts,
      notice.created_at,
      notice.updated_at
    from audience a
    left join public.onboarding_email_notices notice on notice.user_id = a.user_id
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
  -- Les comptes jamais essayés d'abord, puis les plus anciens : un ordre stable d'un passage à l'autre.
  picked as (
    select
      s.user_id,
      pg_catalog.row_number() over (
        order by (s.status is not null), s.account_created_at, s.user_id
      ) as position
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
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'user_id', picked.user_id,
            'department', (
              select alert.department
              from public.user_alerts alert
              where alert.user_id = picked.user_id
                and alert.is_active
              order by alert.created_at, alert.id
              limit 1
            )
          )
          order by picked.position
        )
        from picked
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.get_onboarding_email_queue(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_onboarding_email_queue(integer, timestamptz) to service_role;

comment on function public.get_onboarding_email_queue(integer, timestamptz) is
  'File d''envoi de l''email unique de prise en main : comptes de l''audience (app_private.onboarding_email_eligible), non désinscrits, jamais prévenus, avec le département de leur plus ancienne alerte active. Nombres, identifiants et départements seulement, aucune adresse. Lecture serveur seule (service_role).';

-- 6. Purge ---------------------------------------------------------------------------------------------------
-- Même durée que le journal du préavis de fin d'offre (20261102140000) : 24 mois, 12 au minimum. Un compte
-- purgé du journal ne peut pas être réécrit : il a plus de 72 heures. Appelée par la tâche de rétention
-- (src/lib/data-retention-job.ts), qui tourne aussi quand aucun envoi n'a lieu.
create or replace function public.purge_onboarding_email_notices(
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
    raise exception 'La durée de conservation du journal de l''email de prise en main ne peut pas descendre sous 12 mois.';
  end if;
  with removed as (
    delete from public.onboarding_email_notices
    where created_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer into deleted_count from removed;
  return deleted_count;
end;
$function$;

revoke all on function public.purge_onboarding_email_notices(interval)
  from public, anon, authenticated;
grant execute on function public.purge_onboarding_email_notices(interval) to service_role;

comment on function public.purge_onboarding_email_notices(interval) is
  'Supprime les lignes du journal de l''email de prise en main plus anciennes que 24 mois (12 au minimum). Réservée à la tâche de rétention et au service_role.';

notify pgrst, 'reload schema';

commit;
