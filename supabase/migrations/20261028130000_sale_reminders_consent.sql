begin;

set local lock_timeout = '5s';

-- Consentement distinct pour les rappels d'audience et les avertissements graves sur les ventes
-- suivies (favoris, ventes débloquées).  Il est indépendant de l'email récapitulatif des alertes
-- (alert_email_*): cocher l'un n'active pas l'autre, et retirer l'un laisse l'autre intact.
-- Comme pour les alertes, la case n'est jamais pré-cochée (défaut false) et la date du
-- consentement est la preuve; la date du retrait est conservée.
alter table public.user_notification_preferences
  add column if not exists sale_reminders_enabled boolean not null default false,
  add column if not exists sale_reminders_consented_at timestamptz,
  add column if not exists sale_reminders_revoked_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_reminder_consent_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_reminder_consent_check
      check (sale_reminders_enabled = false or sale_reminders_consented_at is not null);
  end if;
end $$;

comment on column public.user_notification_preferences.sale_reminders_enabled is
  'Consentement distinct aux rappels d''audience (J-7, J-1) et aux avertissements graves (date modifiée, vente retirée, reportée ou adjugée) sur les favoris et les ventes débloquées. Jamais pré-coché.';
comment on column public.user_notification_preferences.sale_reminders_consented_at is
  'Horodatage prouvant quand la personne a explicitement activé les rappels d''audience.';
comment on column public.user_notification_preferences.sale_reminders_revoked_at is
  'Horodatage du retrait du consentement aux rappels d''audience (réglages ou lien de désinscription).';

-- Index partiel: le cron ne lit que les personnes qui ont consenti.
create index if not exists user_notification_preferences_reminders_enabled_idx
  on public.user_notification_preferences (user_id)
  where sale_reminders_enabled;

notify pgrst, 'reload schema';

commit;
