begin;

set local lock_timeout = '5s';

-- Compte-rendu du 31/10/2026, n° 36 (expert-postgres n° 1, fiabilite-sre n° 2). Deux corrections à la migration
-- 20261110100713 (les tâches pg_cron n'appellent plus Vercel pour rien).
--
-- 1. Un passage ÉCHOUÉ ne compte plus comme « passage fait ».
--    app_private.cron_job_started_since lisait tout passage commencé, réussi ou non. Après un échec de
--    operational-health, sale-retention, information-agent-inbound ou sale-flood-risk, la fonction de
--    déclenchement croyait la tâche déjà passée et attendait la fin de sa fenêtre (25 min, 14 min, 6 min,
--    110 min) avant de la relancer ; pour sale-flood-risk, 2 h de silence après un échec, au-delà du seuil de
--    cron.stale. Désormais un passage `failed` est ignoré : la tâche est relancée au prochain tick de pg_cron.
--    Un passage `running` compte toujours (il évite d'en lancer un second pendant qu'un premier travaille).
--    Délai minimal : la route n'est pas rappelée dans les 5 minutes qui suivent la fin d'un passage `failed`
--    (app_private.cron_job_failed_since, appelée en tête de cron_dispatch_due). Sans lui, une tâche dont le travail
--    est dû (message en attente de information-agent-inbound, reste de sale-retention) échouerait en boucle à
--    chaque tick de 2 ou 5 minutes, et une panne de la route ou de sa source serait martelée. Avec lui, le rappel
--    a lieu au premier tick qui suit les 5 minutes (information-agent-inbound : 6 minutes au plus après l'échec ;
--    sale-flood-risk, tick horaire : à l'heure suivante, donc toujours bien avant le seuil de 5 h).
--
-- 2. Les seuils de cron.stale suivent les cadences réelles. Règle : seuil >= 2 x cadence + durée d'un passage
--    (un passage manqué ne doit pas suffire, deux oui). Cadences obtenues avec les gardes de 20261110100713 (le
--    tick de pg_cron tombe quelques secondes avant le début enregistré du passage précédent, donc un tick
--    « pile à la fenêtre » est parfois sauté et la cadence réelle est le tick suivant) :
--      tâche                       tick pg_cron    garde      cadence réelle   durée max   ancien seuil   nouveau seuil
--      operational-health          15 min          25 min     30 min           5 min       45 min         65 min
--      sale-retention              5 min           14 min     15 min           5 min       20 min         35 min
--      information-agent-inbound   2 min           6 min      8 min            5 min       10 min         25 min
--      sale-flood-risk             60 min          110 min    120 min          10 min      3 h            5 h
--    (sale-retention rejoue de suite tant que le dernier passage annonce un reste ; information-agent-inbound
--    appelle de suite quand un message est dû : ces cas ne rallongent jamais la cadence.) Les tâches horaires
--    (listing-completeness, sale-pepites) gardent 3 h, les quotidiennes 27 h, data-retention 8 jours.
--    src/lib/health-status.ts porte le seuil de operational-health (HEALTH_OPERATIONAL_MAX_AGE_MINUTES) : il
--    passe à 65 minutes dans le même changement.
--
-- Même méthode que 20261104100100 et 20261106100300 : pg_get_functiondef, remplacement de fragments vérifiés,
-- refus de deviner si la forme a changé. Aucune entrée de la liste n'est ajoutée ni retirée ici.
-- Retour arrière : remettre les anciennes valeurs par le même remplacement inverse ; pour cron_job_started_since,
-- recréer la fonction sans la ligne `run.status <> 'failed'` ; pour le délai, retirer de cron_dispatch_due le début
-- `not app_private.cron_job_failed_since(...) and` (puis supprimer cron_job_failed_since).

create or replace function app_private.cron_job_started_since(p_job text, p_since timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.operational_job_runs run
    where run.job_name = p_job
      and run.status <> 'failed'
      and run.started_at >= p_since
  );
$function$;

revoke all on function app_private.cron_job_started_since(text, timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.cron_job_started_since(text, timestamptz) is
  'Vrai si la tâche a commencé un passage (en cours ou réussi, jamais échoué) depuis p_since (20261110120100).';

-- Un passage échoué vient de se terminer : ne pas rappeler la route avant p_since (p_now - 5 minutes à l'appel).
create or replace function app_private.cron_job_failed_since(p_job text, p_since timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.operational_job_runs run
    where run.job_name = p_job
      and run.status = 'failed'
      and coalesce(run.finished_at, run.started_at) >= p_since
  );
$function$;

revoke all on function app_private.cron_job_failed_since(text, timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.cron_job_failed_since(text, timestamptz) is
  'Vrai si un passage de la tâche s''est terminé en échec depuis p_since (20261110120100) : délai minimal de 5 minutes avant de rappeler la route.';

do $dispatch_delay$
declare
  definition text := pg_catalog.pg_get_functiondef('app_private.cron_dispatch_due(text, timestamptz)'::regprocedure);
  head constant text := E'select case p_job';
  guard constant text := E'select not app_private.cron_job_failed_since(p_job, p_now - interval ''5 minutes'')\n    and case p_job';
begin
  if position('cron_job_failed_since' in definition) > 0 then
    return;
  end if;
  if (length(definition) - length(replace(definition, head, ''))) <> length(head) then
    raise exception using
      errcode = '55000',
      message = 'cron_dispatch_due changed shape (expected exactly one "select case p_job"); review the failed-run delay.';
  end if;
  execute replace(definition, head, guard);
end;
$dispatch_delay$;

do $thresholds$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );
  updated text;
  replacement text[];
  replacements constant text[] := array[
    '(''operational-health'', interval ''45 minutes'')',
    '(''operational-health'', interval ''65 minutes'')',
    '(''sale-retention'', interval ''20 minutes'')',
    '(''sale-retention'', interval ''35 minutes'')',
    '(''information-agent-inbound'', interval ''10 minutes'')',
    '(''information-agent-inbound'', interval ''25 minutes'')',
    '(''sale-flood-risk'', interval ''3 hours'')',
    '(''sale-flood-risk'', interval ''5 hours'')'
  ];
  i integer;
begin
  updated := definition;
  for i in 1 .. cardinality(replacements) by 2 loop
    replacement := array[replacements[i], replacements[i + 1]];
    if position(replacement[2] in updated) > 0 then
      continue;
    end if;
    if position(replacement[1] in updated) = 0 then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format(
          'Operational health expected-jobs list changed (%s not found); review the cron.stale thresholds.',
          replacement[1]
        );
    end if;
    updated := replace(updated, replacement[1], replacement[2]);
  end loop;

  if updated <> definition then
    execute updated;
  end if;
end;
$thresholds$;

notify pgrst, 'reload schema';

commit;
