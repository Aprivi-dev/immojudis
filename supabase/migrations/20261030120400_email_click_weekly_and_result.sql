-- Liens suivis des nouveaux emails (points 70 et 73 de la session du 20/10/2026) : deux types de plus
-- dans la liste fermée des détails d'un clic d'email.
--
-- email_clicked portait detail in ('alert', 'reminder'). Les liens du récapitulatif hebdomadaire « Ma
-- semaine » et de l'alerte de résultat passent par la même redirection signée (/api/email/click, point
-- 65) et sont mesurés à part :
--   * alert    : email d'alertes (inchangé) ;
--   * reminder : rappels d'audience et avertissements graves (inchangé) ;
--   * weekly   : récapitulatif hebdomadaire « Ma semaine » ;
--   * result   : alerte de résultat ou de remise en vente.
-- Les autres types d'événement et leurs détails ne changent pas (liste de 20261029120100).
--
-- Contrainte remplacée en deux temps (ajout NOT VALID, puis validation) pour ne tenir le verrou exclusif
-- que le temps du remplacement ; rejouer la migration est sans effet. public.admin_pilotage_summary
-- (20261029120200) compte toujours tous les clics (total) et détaille alert et reminder : la ventilation
-- weekly et result n'y figure pas tant que cette fonction n'est pas étendue (décision du propriétaire).
begin;

set local lock_timeout = '5s';

alter table public.account_product_events
  drop constraint if exists account_product_events_type_detail_check;

alter table public.account_product_events
  add constraint account_product_events_type_detail_check check (
    -- Chaque branche est vraie ou fausse, jamais nulle : un CHECK à résultat nul passerait.
    (
      event_type = 'quota_reached'
      and coalesce(
        detail in ('unlocks', 'favorites', 'daily', 'daily_account', 'daily_shared'),
        false
      )
    )
    or (
      event_type = 'email_clicked'
      and coalesce(detail in ('alert', 'reminder', 'weekly', 'result'), false)
    )
    or (event_type in ('sale_unlocked', 'bid_ceiling_calculated', 'calendar_exported') and detail is null)
  ) not valid;

alter table public.account_product_events
  validate constraint account_product_events_type_detail_check;

comment on column public.account_product_events.detail is
  'Précision fermée : quota atteint (unlocks, favorites, daily_account, daily_shared ; daily pour les lignes d''avant la distinction) ou email cliqué (alert, reminder, weekly, result) ; nulle pour les autres événements.';

notify pgrst, 'reload schema';

commit;
