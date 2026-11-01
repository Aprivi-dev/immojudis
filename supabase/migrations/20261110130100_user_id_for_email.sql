begin;

set local lock_timeout = '5s';

-- Retrouver le compte d'une adresse email (webhook Resend des rebonds et plaintes des emails de compte,
-- /api/webhooks/resend/account-emails) : Resend ne donne que l'adresse du destinataire. Une adresse inconnue
-- rend null ; seuls les comptes dont l'adresse est confirmée sont rendus, comme pour l'envoi
-- (src/lib/email-alerts.ts, readUserEmail).
-- Réservée au rôle de service : la fonction lit auth.users, jamais ouverte au navigateur.
--
-- RETOUR ARRIÈRE : drop function public.user_id_for_email(text) ; le webhook répond alors 500 et Resend
-- rejoue l'évènement.

create or replace function public.user_id_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select account.id
  from auth.users account
  where pg_catalog.lower(account.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
    and account.email_confirmed_at is not null
  order by account.created_at
  limit 1;
$$;

revoke all on function public.user_id_for_email(text) from public, anon, authenticated;
grant execute on function public.user_id_for_email(text) to service_role;

comment on function public.user_id_for_email(text) is
  'Identifiant du compte (adresse confirmée) qui porte cette adresse email, ou null. Rôle de service uniquement ; sert au webhook Resend des rebonds et plaintes.';

notify pgrst, 'reload schema';

commit;
