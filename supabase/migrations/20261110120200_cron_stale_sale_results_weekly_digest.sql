begin;

set local lock_timeout = '5s';

-- Compte-rendu du 31/10/2026, n° 39 (fiabilite-sre n° 4) : sale-results (alerte de résultat ou de remise en
-- vente, Vercel 10:15) et weekly-digest (récapitulatif « Ma semaine », Vercel 11:30) entrent dans la liste
-- attendue de cron.stale (app_private.evaluate_operational_health). Jusqu'ici ils n'avaient que leur journal
-- d'exécution : une route qui échoue chaque jour, ou que Vercel ne lance plus, restait silencieuse.
--
--   * sale-results : une passe par jour, seuil de 27 h (24 h + jusqu'à 59 min de décalage du plan Hobby + marge,
--     comme les quatre autres tâches quotidiennes). Pas de passage de rattrapage : un jour manqué est vu 3 h
--     après l'heure attendue du lendemain ;
--   * weekly-digest : la route passe CHAQUE JOUR (11:30) et choisit les comptes dont c'est le jour ; elle
--     réussit même quand rien n'est dû. Le seuil de 8 jours est donc très large (une semaine + un jour), plus
--     tolérant que 27 h parce que l'envoi réel est hebdomadaire ; il voit tout de même une route arrêtée.
--   Tant que SALE_RESULTS_MODE et WEEKLY_DIGEST_MODE valent `off`, les deux passages réussissent sans rien
--   envoyer : la supervision est donc sans objet de volume, elle ne surveille que le déclenchement.
--
-- ORDRE DE MISE EN PRODUCTION (docs/operations/planification.md, « Ajouter une tâche supervisée ») : la
-- tâche n'a aucun succès enregistré avant son prochain passage ; l'alerte `cron.stale` s'ouvre aussitôt en
-- critique pour ces deux tâches si elles n'ont jamais réussi (ou pas dans leur fenêtre). Donc : (1) le code qui
-- porte les routes est déjà déployé, (2) appliquer cette migration, (3) appeler chaque route une fois avec
-- `Authorization: Bearer $CRON_SECRET` (/api/cron/sale-results et /api/cron/weekly-digest) : le succès
-- enregistré referme la détection au passage suivant d'operational-health, et l'alerte se ferme deux heures plus
-- tard (app_private.sync_operational_alert). Ne pas supprimer la ligne d'operational_alerts.
--
-- Même méthode que 20261104100100 et 20261106100300 : pg_get_functiondef, remplacement d'un fragment vérifié, refus
-- de deviner si la forme a changé. AUCUNE entrée existante n'est retirée : la migration refuse de s'appliquer si
-- une des onze tâches attendues manque dans la définition actuelle, et vérifie qu'elles y sont toutes après le
-- remplacement. Retour arrière : retirer les deux entrées par le remplacement inverse.
do $expected_jobs$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );
  updated text;
  job text;
  existing_jobs constant text[] := array[
    'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor', 'data-retention',
    'sale-retention', 'information-agent-inbound', 'listing-completeness', 'sale-reminders', 'sale-pepites',
    'sale-flood-risk'
  ];
  new_jobs constant text[] := array['sale-results', 'weekly-digest'];
  anchor constant text := '(''sale-reminders'', interval ''27 hours'')';
begin
  foreach job in array existing_jobs loop
    if position('(''' || job || ''', interval ''' in definition) = 0 then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Operational health expected-jobs list changed (%s missing); review before adding sale-results and weekly-digest.',
          job
        );
    end if;
  end loop;

  updated := definition;
  if position('(''sale-results''' in updated) = 0 and position('(''weekly-digest''' in updated) = 0 then
    if position(anchor in updated) = 0 then
      raise exception using
        errcode = '55000',
        message = 'Operational health expected-jobs list changed (sale-reminders anchor missing); review before adding sale-results and weekly-digest.';
    end if;
    updated := replace(
      updated,
      anchor,
      anchor || ', (''sale-results'', interval ''27 hours''), (''weekly-digest'', interval ''8 days'')'
    );
  elsif position('(''sale-results''' in updated) = 0 or position('(''weekly-digest''' in updated) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Operational health expected-jobs list holds only one of sale-results and weekly-digest; review it.';
  end if;

  foreach job in array existing_jobs || new_jobs loop
    if position('(''' || job || ''', interval ''' in updated) = 0 then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('Operational health expected-jobs list lost %s; migration refused.', job);
    end if;
  end loop;

  if updated <> definition then
    execute updated;
  end if;
end;
$expected_jobs$;

notify pgrst, 'reload schema';

commit;
