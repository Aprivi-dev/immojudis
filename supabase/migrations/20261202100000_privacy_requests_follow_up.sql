begin;

set local lock_timeout = '5s';

-- Suivi des demandes de droits (conformité, 16/11/2026) : une demande d'effacement attendait depuis le
-- 15/11 sans que rien ne prévienne l'opérateur ni le demandeur.
--
--   1. data_subject_requests.acknowledged_at n'a plus de défaut ni de NOT NULL : la colonne dit quand
--      l'accusé de réception est réellement parti (posée par src/lib/privacy-request-notifications.ts).
--      Les lignes existantes gardent leur valeur ; une nouvelle ligne la reçoit à l'envoi de l'accusé.
--   2. due_at d'une rétractation (contract_withdrawal) : 14 jours après le dépôt (délai de remboursement de
--      l'art. L. 221-24 du code de la consommation), par un déclencheur BEFORE INSERT. Les autres types
--      gardent le défaut d'un mois (art. 12.3 RGPD). AUCUNE ligne existante n'est réécrite (la seule demande
--      ouverte en production est une demande d'effacement).
--   3. public.evaluate_privacy_request_health(p_now) : trois alertes d'exploitation, par la mécanique commune
--      (app_private.sync_operational_alert) :
--        compliance.privacy_requests.due_soon                avertissement : demande ouverte à 7 jours ou
--                                                             moins de son échéance (même seuil que
--                                                             PRIVACY_DEADLINE_WARNING_DAYS, vérifié par un
--                                                             test Vitest)
--        compliance.privacy_requests.overdue                 critique : échéance dépassée
--        compliance.privacy_requests.unacknowledged_operator avertissement : demande restée « reçue » plus
--                                                             de 3 jours (personne ne l'a prise en main)
--      Catégorie `cron` : operational_alerts_category_check n'est pas touchée. Aucune donnée personnelle dans
--      les détails : des nombres et des dates. Appelée par evaluateOperationalHealth
--      (src/lib/operational-health-job.ts), à chaque passage de operational-health.
--   4. public.account_sale_unlock_credits(p_user_id) : nombre de crédits d'achat à l'unité non utilisés d'un
--      compte, lu par la garde avant effacement (src/lib/privacy-requests.ts). La règle reste
--      app_private.sale_unlock_credit_purchases : cette fonction ne fait que l'exposer au rôle de service.
--
-- Droits : toutes les fonctions sont réservées à service_role ; la table garde sa RLS et ses droits
-- (aucun pour anon ni authenticated). Le site est déployé AVANT cette migration : le code tolère l'absence
-- des deux fonctions (évaluation sautée, crédits « inconnus » qui exigent la confirmation renforcée).
--
-- Retour arrière : drop des deux fonctions, du déclencheur et de sa fonction ; `alter column acknowledged_at
-- set default statement_timestamp()` puis `set not null` après avoir rempli les lignes nulles.

-- 1. Accusé de réception réel -----------------------------------------------------------------------------
alter table public.data_subject_requests
  alter column acknowledged_at drop default,
  alter column acknowledged_at drop not null;

comment on column public.data_subject_requests.acknowledged_at is
  'Envoi réel de l''accusé de réception au demandeur (nul tant qu''il n''est pas parti). Les lignes antérieures au 02/12/2026 portent la date de dépôt.';

-- 2. Échéance par type -------------------------------------------------------------------------------------
create or replace function app_private.set_data_subject_request_due_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Rétractation : le remboursement est dû au plus tard 14 jours après la notification (L. 221-24).
  if new.request_type = 'contract_withdrawal' then
    new.due_at := new.submitted_at + interval '14 days';
  end if;
  return new;
end;
$$;

revoke all on function app_private.set_data_subject_request_due_at()
  from public, anon, authenticated;

drop trigger if exists data_subject_requests_due_at on public.data_subject_requests;
create trigger data_subject_requests_due_at
before insert on public.data_subject_requests
for each row execute function app_private.set_data_subject_request_due_at();

comment on table public.data_subject_requests is
  'Authenticated privacy and distance-contract requests: one-month response deadline (GDPR art. 12.3), 14 days for a contract withdrawal (L. 221-24). acknowledged_at is the real acknowledgement email.';

-- 3. Alertes de suivi --------------------------------------------------------------------------------------
create or replace function public.evaluate_privacy_request_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  open_statuses constant text[] := array['received', 'identity_verification', 'in_review'];
  warning_days constant integer := 7;
  unacknowledged_days constant integer := 3;
  due_soon_count integer;
  next_due timestamptz;
  overdue_count integer;
  oldest_overdue timestamptz;
  unacknowledged_count integer;
  oldest_unacknowledged timestamptz;
begin
  select count(*)::integer, min(request.due_at)
  into due_soon_count, next_due
  from public.data_subject_requests request
  where request.status = any(open_statuses)
    and request.due_at >= p_now
    and request.due_at <= p_now + pg_catalog.make_interval(days => warning_days);

  select count(*)::integer, min(request.due_at)
  into overdue_count, oldest_overdue
  from public.data_subject_requests request
  where request.status = any(open_statuses)
    and request.due_at < p_now;

  select count(*)::integer, min(request.submitted_at)
  into unacknowledged_count, oldest_unacknowledged
  from public.data_subject_requests request
  where request.status = 'received'
    and request.submitted_at < p_now - pg_catalog.make_interval(days => unacknowledged_days);

  perform app_private.sync_operational_alert(
    'compliance.privacy_requests.due_soon',
    'cron',
    'warning',
    jsonb_build_object(
      'count', due_soon_count,
      'next_due_at', next_due,
      'warning_days', warning_days
    ),
    due_soon_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'compliance.privacy_requests.overdue',
    'cron',
    'critical',
    jsonb_build_object('count', overdue_count, 'oldest_due_at', oldest_overdue),
    overdue_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'compliance.privacy_requests.unacknowledged_operator',
    'cron',
    'warning',
    jsonb_build_object(
      'count', unacknowledged_count,
      'oldest_submitted_at', oldest_unacknowledged,
      'maximum_age_days', unacknowledged_days
    ),
    unacknowledged_count > 0,
    p_now
  );

  return jsonb_build_object(
    'due_soon', due_soon_count,
    'overdue', overdue_count,
    'unacknowledged_operator', unacknowledged_count
  );
end;
$$;

revoke all on function public.evaluate_privacy_request_health(timestamptz)
  from public, anon, authenticated;
grant execute on function public.evaluate_privacy_request_health(timestamptz) to service_role;

comment on function public.evaluate_privacy_request_health(timestamptz) is
  'Alertes de suivi des demandes de droits (échéance à 7 jours, échéance dépassée, demande reçue non prise en main depuis 3 jours). Nombres et dates seulement. Réservée à service_role.';

-- 4. Crédits non utilisés, pour la garde avant effacement ---------------------------------------------------
create or replace function public.account_sale_unlock_credits(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.sale_unlock_credits_available(p_user_id);
$$;

revoke all on function public.account_sale_unlock_credits(uuid)
  from public, anon, authenticated;
grant execute on function public.account_sale_unlock_credits(uuid) to service_role;

comment on function public.account_sale_unlock_credits(uuid) is
  'Crédits d''achat à l''unité non utilisés d''un compte (règle : app_private.sale_unlock_credit_purchases). Lu par la garde avant effacement. Réservée à service_role.';

notify pgrst, 'reload schema';

commit;
