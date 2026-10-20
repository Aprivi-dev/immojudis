begin;

set local lock_timeout = '5s';

-- Chantier R1, point 5 (relecture de code du 20/10/2026) : l'envoi à la liste d'attente
-- (src/lib/admin-offer-opening-notifier.ts).
--
-- Constats :
--   1. les demandes dont l'adresse n'est pas confirmée étaient sélectionnées EN TÊTE à chaque lot (les
--      plus anciennes d'abord), marquées, puis rendues : un lot de 200 pouvait n'être fait que de comptes
--      non confirmés et n'envoyer rien, à chaque passage ;
--   2. une demande dont l'envoi avait échoué était reprise sans limite ni ordre ;
--   3. la clé d'idempotence de Resend ne vaut que 24 h : une demande « perdue » (marque posée, réponse du
--      fournisseur inconnue) relancée plus tard pouvait recevoir deux emails.
--
-- Cette migration ajoute le suivi des essais à la demande et une fonction de lecture de la file :
--   * notify_attempts : nombre d'essais d'envoi (un par marque `notified_at` posée avant l'envoi) ;
--   * notify_attempted_at : instant du PREMIER essai de la série (la clé d'idempotence de Resend, stable
--     par compte, court à partir de là) ;
--   * public.get_offer_opening_queue(p_limit) : la file, en un document jsonb { total, needs_review,
--     recipients: [{ user_id, attempts, attempted_at }] }. Une demande y figure seulement si
--       - elle est active (notify_enabled), jamais prévenue (notified_at null), offre « analyse » ;
--       - son compte a une adresse CONFIRMÉE (auth.users.email_confirmed_at) : les comptes non confirmés
--         sont écartés en amont, ils ne prennent plus de place dans un lot ;
--       - elle n'a jamais été essayée, OU elle l'a été moins de 3 fois ET le premier essai date de moins de
--         23 h (marge sous les 24 h de Resend : un nouvel essai porte la même clé d'idempotence et ne peut
--         pas doubler un email déjà parti).
--     L'ordre : les demandes jamais essayées d'abord (plus anciennes en tête), puis les essais en cours.
--     `total` est le nombre de demandes envoyables, `needs_review` celui des demandes confirmées dont les
--     essais sont épuisés ou plus anciens que 23 h : un email a pu partir sans qu'on le sache, elles ne
--     sont plus relancées toutes seules. Avant de les reprendre, vérifier le journal d'envoi de Resend
--     (destinataire et clé « immojudis-offer-opening-<user_id> »), puis, si rien n'est parti :
--       update public.offer_opening_notifications
--          set notify_attempts = 0, notify_attempted_at = null
--        where user_id = '<user_id>';
--     (ou poser notified_at à la main si l'email est bien parti).
--
-- Colonnes ajoutées sans valeur à recalculer (default 0, metadata seulement) ; aucune donnée existante
-- n'est modifiée. La fonction n'est exécutable que par service_role (adresses lues dans auth.users, sans
-- qu'aucune adresse ne sorte). L'application tolère l'absence de la fonction (ancienne sélection).

alter table public.offer_opening_notifications
  add column if not exists notify_attempted_at timestamptz,
  add column if not exists notify_attempts integer not null default 0;

alter table public.offer_opening_notifications
  drop constraint if exists offer_opening_notifications_attempts_check,
  add constraint offer_opening_notifications_attempts_check
    check (notify_attempts between 0 and 100);

comment on column public.offer_opening_notifications.notify_attempts is
  'Nombre d''essais d''envoi de l''email d''ouverture (une marque notified_at posée avant l''envoi = un essai). Écrit par la route serveur seule.';
comment on column public.offer_opening_notifications.notify_attempted_at is
  'Instant du premier essai d''envoi de la série en cours : la clé d''idempotence de Resend (24 h) court à partir de là. Au-delà de 23 h, la demande n''est plus relancée sans vérification du journal d''envoi.';

create or replace function public.get_offer_opening_queue(
  p_limit integer default 200,
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with confirmed as (
    select
      request.user_id,
      request.consented_at,
      request.notify_attempts,
      request.notify_attempted_at
    from public.offer_opening_notifications request
    join auth.users account on account.id = request.user_id
    where request.offer_code = 'analyse'
      and request.notify_enabled
      and request.notified_at is null
      and account.email_confirmed_at is not null
      and pg_catalog.btrim(coalesce(account.email, '')) <> ''
  ),
  sendable as (
    select c.*
    from confirmed c
    where c.notify_attempts = 0
       or (
         c.notify_attempts < 3
         and c.notify_attempted_at > p_now - interval '23 hours'
       )
  ),
  picked as (
    select s.*
    from sendable s
    order by (s.notify_attempts > 0), s.consented_at, s.user_id
    limit least(greatest(coalesce(p_limit, 200), 1), 200)
  )
  select pg_catalog.jsonb_build_object(
    'total', (select pg_catalog.count(*) from sendable),
    'needs_review',
      (select pg_catalog.count(*) from confirmed) - (select pg_catalog.count(*) from sendable),
    'recipients', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'user_id', p.user_id,
            'attempts', p.notify_attempts,
            'attempted_at', p.notify_attempted_at
          )
          order by (p.notify_attempts > 0), p.consented_at, p.user_id
        )
        from picked p
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.get_offer_opening_queue(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_offer_opening_queue(integer, timestamptz) to service_role;

comment on function public.get_offer_opening_queue(integer, timestamptz) is
  'File d''envoi de l''email d''ouverture : demandes actives, jamais prévenues, à adresse confirmée, jamais essayées ou essayées moins de 3 fois dans les 23 dernières heures (clé d''idempotence de Resend). Lecture serveur seule (service_role) ; aucune adresse ne sort.';

notify pgrst, 'reload schema';

commit;
