begin;

set local lock_timeout = '5s';

-- Relecture R3/R4 : le rattrapage du cron sale-reminders (09:15) doit pouvoir reprendre un rappel
-- dont l'envoi a été interrompu.  20261028130100 ne rendait la main que pour une ligne 'failed'
-- (moins de trois essais) ; une ligne 'pending' restée là (fonction coupée entre la réservation et
-- l'envoi) n'était jamais reprise et le rappel J-7 ou J-1 était perdu.
--
-- Nouvelle règle : une ligne 'pending' dont la dernière mise à jour date de plus d'une heure est
-- orpheline et se réserve de nouveau, dans la même limite de trois essais que les lignes 'failed'.
-- Le délai d'une heure laisse un passage encore en cours (60 s au plus) terminer sans collision.
-- Le risque de doublon (envoi réussi mais ligne jamais passée à 'sent') est borné par la clé
-- d'idempotence de l'envoi (Resend, 24 h) quand le groupe d'éléments est le même.
--
-- Même signature, mêmes droits qu'avant : create or replace conserve les privilèges, rappelés ici.
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
    where dispatch.attempts < 3
      and (
        dispatch.status = 'failed'
        or (dispatch.status = 'pending' and dispatch.updated_at < now() - interval '1 hour')
      )
  returning dispatch.id;
$function$;

revoke all on function public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb)
  to service_role;

comment on function public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb) is
  'Réserve un rappel d''audience: renvoie l''id quand il faut envoyer (première réservation, ligne failed ou pending orpheline de plus d''une heure, trois essais au plus), rien quand il l''a déjà été. Réservée au cron (service_role).';

notify pgrst, 'reload schema';

commit;
