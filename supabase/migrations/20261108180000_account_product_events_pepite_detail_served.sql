-- Mesure du parcours par compte : un sixième événement, `pepite_detail_served`.
--
-- Le détail de la pépite (plafond de référence, prix probable) est servi par
-- /api/sales/[id]/pepite?view=detail, après vérification du droit au plafond. L'événement est
-- enregistré à ce moment, pour le compte et la vente : il permet de compter les comptes (essai ou
-- Découverte) qui ouvrent réellement un détail, ce que la navigation seule ne montre pas.
--
-- Même forme que sale_unlocked, bid_ceiling_calculated et calendar_exported : une vente, aucun
-- détail. Les autres types et leurs détails ne changent pas (liste de 20261030120400). Un événement
-- identique reste gardé une fois par jour UTC, compte et vente (index existant).
--
-- Contrainte remplacée en deux temps (ajout NOT VALID, puis validation) pour ne tenir le verrou
-- exclusif que le temps du remplacement ; rejouer la migration est sans effet.
--
-- Ordre de déploiement : tant que cette migration n'est pas appliquée, la base refuse la ligne
-- (SQLSTATE 23514) ; l'application journalise l'échec sans contenu et l'avale
-- (account-product-events.server.ts) : la mesure est perdue, rien d'autre.
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
    or (
      event_type in (
        'sale_unlocked',
        'bid_ceiling_calculated',
        'calendar_exported',
        'pepite_detail_served'
      )
      and detail is null
    )
  ) not valid;

alter table public.account_product_events
  validate constraint account_product_events_type_detail_check;

comment on table public.account_product_events is
  'Événements produit par compte (déblocage, quota atteint, plafond calculé, détail de pépite servi, export agenda, clic d''email). Pas de donnée libre. Conservés 90 jours (run_data_retention). Aucun accès pour anon ni authenticated ; lus seulement en agrégats par admin_pilotage_summary.';

notify pgrst, 'reload schema';

commit;
