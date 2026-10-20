begin;

set local lock_timeout = '5s';

-- Journal des rappels : un code court à la place du texte d'erreur.
--
-- sale_reminder_dispatches.error recevait jusqu'à 500 caractères de la réponse du prestataire d'envoi
-- (Resend) ou du message d'une exception : texte libre, parfois personnel, jamais exploité. Le cron
-- (src/lib/sale-reminders.ts) n'y écrit plus qu'un code d'une liste fermée, reprise ici : une
-- régression qui y remettrait du texte libre échouerait à l'écriture au lieu de polluer le journal.
--
-- La contrainte est créée NOT VALID : elle s'applique aux lignes écrites ou modifiées à partir de
-- maintenant, sans parcourir ni réécrire les lignes déjà là (le journal est vide tant que
-- SALE_REMINDERS_MODE vaut off ; les éventuelles anciennes lignes sont purgées après 180 jours).
-- claim_sale_reminder remet error à null à chaque nouvelle réservation, donc une ancienne ligne
-- reprise n'est pas bloquée.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sale_reminder_dispatches'::regclass
      and conname = 'sale_reminder_dispatches_error_code_check'
  ) then
    alter table public.sale_reminder_dispatches
      add constraint sale_reminder_dispatches_error_code_check
      check (
        error is null
        or error in (
          'email_unavailable',
          'email_lookup_failed',
          'message_build_failed',
          'send_failed',
          'journal_failed'
        )
      ) not valid;
  end if;
end $$;

comment on column public.sale_reminder_dispatches.error is
  'Code court de l''échec, d''une liste fermée : email_unavailable (adresse absente ou non confirmée), email_lookup_failed, message_build_failed, send_failed, journal_failed. Jamais de texte libre.';

notify pgrst, 'reload schema';

commit;
