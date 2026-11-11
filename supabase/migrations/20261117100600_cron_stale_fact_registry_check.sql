begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a (annexe 08, point 12) : la tâche quotidienne fact-registry-check (Vercel Cron,
-- 05:28 UTC, route /api/cron/fact-registry-check) entre dans la liste attendue de cron.stale
-- (app_private.evaluate_operational_health), avec le seuil des tâches quotidiennes : 27 heures (24 h, jusqu'à
-- 59 min de décalage du plan Hobby, et une marge). Sans cela, un contrôle qui ne tourne plus resterait silencieux,
-- et « aucune alerte fact_registry.* » ne voudrait plus rien dire.
--
-- ORDRE DE MISE EN PRODUCTION (docs/operations/planification.md, « Ajouter une tâche supervisée ») : la tâche
-- n'a aucun succès enregistré avant son premier passage ; l'alerte cron.stale s'ouvre alors en CRITIQUE au
-- passage suivant d'operational-health. Donc : (1) le code qui porte la route est déjà déployé (avant la
-- migration 20261117100500, la tâche réussit sans rien contrôler : résultat « skipped: migration_pending ») ;
-- (2) attendre un passage planifié de la tâche et vérifier son succès dans operational_job_runs ; (3) appliquer
-- les migrations du lot : le succès de l'étape 2 a moins de 27 heures, aucune alerte ne s'ouvre, et le passage du
-- lendemain tombe avant l'échéance. PERSONNE N'APPELLE LA ROUTE À LA MAIN et personne ne lit le secret de la
-- tâche (docs/runbooks/registre-des-pieces-r2a.md, « Ordre de déploiement »). Si les migrations ont été appliquées
-- sans attendre ce passage et que l'alerte s'ouvre, attendre le passage planifié suivant : elle se ferme deux
-- heures après le premier succès. Ne pas supprimer la ligne d'operational_alerts.
--
-- Même méthode que 20261110120200 : pg_get_functiondef, remplacement d'un fragment vérifié, refus de deviner si la
-- forme a changé. AUCUNE entrée existante n'est retirée : la migration refuse de s'appliquer si une des treize
-- tâches attendues manque dans la définition actuelle, et vérifie qu'elles y sont toutes après le remplacement.
-- Seconde application : l'entrée est déjà là, rien n'est réécrit.
--
-- Verrous : remplacement d'une fonction. Possible pendant un import.
--
-- Retour arrière : retirer l'entrée par le remplacement inverse (même bloc, fragments échangés).
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
    'sale-flood-risk', 'sale-results', 'weekly-digest'
  ];
  new_job constant text := 'fact-registry-check';
  new_entry constant text := '(''fact-registry-check'', interval ''27 hours'')';
  anchor constant text := '(''weekly-digest'', interval ''8 days'')';
begin
  foreach job in array existing_jobs loop
    if position('(''' || job || ''', interval ''' in definition) = 0 then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Operational health expected-jobs list changed (%s missing); review before adding fact-registry-check.',
          job
        );
    end if;
  end loop;

  updated := definition;
  if position('(''' || new_job || '''' in updated) = 0 then
    if position(anchor in updated) = 0 then
      raise exception using
        errcode = '55000',
        message = 'Operational health expected-jobs list changed (weekly-digest anchor missing); review before adding fact-registry-check.';
    end if;
    updated := replace(updated, anchor, anchor || ', ' || new_entry);
  end if;

  foreach job in array existing_jobs || new_job loop
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
