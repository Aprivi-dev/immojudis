-- Mesure du parcours par compte : distinguer le plafond quotidien d'un compte de celui d'une adresse
-- ou du site entier.
--
-- Le détail « daily » d'un quota_reached disait seulement qu'un plafond quotidien était atteint. Or
-- enforceDailyOperationLimits (src/lib/rate-limit.ts) en arrête trois, dans l'ordre : le plafond du
-- compte, celui de son adresse, puis le disjoncteur global. Un compte arrêté par SON plafond a épuisé
-- son quota ; un compte arrêté par l'adresse ou le disjoncteur n'a rien consommé de lui-même (un
-- bureau, un VPN, un abus d'un autre). Les deux ne se lisent pas pareil sur la page Pilotage.
--
-- Liste fermée des détails d'un quota atteint, après cette migration :
--   * unlocks, favorites : inchangés ;
--   * daily_account      : le plafond journalier du compte (par compte) ;
--   * daily_shared       : le plafond journalier de l'adresse ou du site entier (par adresse, global) ;
--   * daily              : conservé, pour les lignes écrites avant cette migration (plafond quotidien
--                          non distingué). Le code n'en écrit plus.
-- Les autres types d'événement et leur absence de détail ne changent pas.
--
-- Contrainte remplacée en deux temps (ajout NOT VALID, puis validation) pour ne tenir le verrou
-- exclusif que le temps du remplacement ; rejouer la migration est sans effet.
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
    or (event_type = 'email_clicked' and coalesce(detail in ('alert', 'reminder'), false))
    or (event_type in ('sale_unlocked', 'bid_ceiling_calculated', 'calendar_exported') and detail is null)
  ) not valid;

alter table public.account_product_events
  validate constraint account_product_events_type_detail_check;

comment on column public.account_product_events.detail is
  'Précision fermée : quota atteint (unlocks, favorites, daily_account, daily_shared ; daily pour les lignes d''avant la distinction) ou email cliqué (alert, reminder) ; nulle pour les autres événements.';

notify pgrst, 'reload schema';

commit;
