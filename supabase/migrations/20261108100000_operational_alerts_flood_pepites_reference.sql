begin;

set local lock_timeout = '5s';

-- Supervision des traitements ajoutés les 26 et 27/10/2026 (compte-rendu du 27/10/2026, n° 82 ; rapport
-- fiabilite-sre, propositions 1, 3, 4, 6 et 7 ; post-mortem, action 8). L'alerte cron.stale ne voit que « aucun
-- succès depuis 3 h » : elle est aveugle à la panne partielle (une passe d'inondation qui observe quelques ventes
-- réussit alors que la moitié des appels échouent), au calcul des pépites qui « réussit » sans rien écrire, au verrou
-- de publication qui retarde les écritures, et à l'import ANIL qui n'a aucun suivi de fraîcheur.
--
-- Quatre alertes, évaluées par une fonction SÉPARÉE (app_private.evaluate_flood_pepite_reference_health) que
-- app_private.evaluate_operational_health appelle juste avant de compter les alertes ouvertes : la grande fonction
-- n'est modifiée qu'en ce seul point (même méthode que 20261104100100 et 20261106100300 : pg_get_functiondef,
-- remplacement d'un fragment vérifié, refus de deviner si la forme a changé). Toutes sont de catégorie `cron`,
-- pour ne pas toucher la contrainte operational_alerts_category_check.
--
--   flood_risk.observation.degraded   avertissement, puis critique après 12 h. Deux entrées :
--       (A) les 3 dernières passes RÉUSSIES de `sale-flood-risk` : somme des appels en échec (`callsFailed`, à défaut
--           `failed`) d'au moins 30 et au moins la moitié des appels (échecs + `callsObserved`, à défaut `observed`) ;
--       (B) la passe d'inondation lève désormais elle-même une erreur quand la moitié des appels échouent (au moins
--           20 appels) ou quand le point de contrôle de la source est refusé (`source_degraded`) : une telle passe
--           est ENREGISTRÉE EN ÉCHEC, sans résumé. L'alerte s'ouvre donc aussi quand la dernière passe est un échec
--           « dégradée » ou `source_degraded` et qu'au moins 2 des 3 dernières le sont (une heure avant cron.stale,
--           qui attend 3 h sans succès).
--   flood_risk.write_blocked          avertissement : `writeBusy` > 0 sur les 3 dernières passes réussies (le verrou de
--       publication du pipeline retarde les écritures), ou `remaining` > 0 sans baisser sur les 6 dernières.
--   pepites.evaluation.stale          avertissement : mode des pépites autre que « on » depuis plus d'une heure, ou
--       dernière évaluation (auction_sale_pepites.evaluated_at) de plus de 6 h ; critique à 24 h. Sans aucune
--       évaluation, seul le mode compte.
--   reference.anil_rents.stale        avertissement à partir du 15 janvier si l'édition ANIL chargée (anil_rents.vintage)
--       n'est pas celle publiée en décembre de l'année précédente (millésime de l'année précédente) ; critique 60
--       jours plus tard. Table vide : aucune alerte (jeu jamais chargé). Le millésime d'une édition est celui de son
--       année de publication en décembre : l'édition de décembre 2025 porte le millésime 2025 et doit être chargée au
--       15 janvier 2026 ; celle de décembre 2026 (millésime 2026) au 15 janvier 2027.
--
-- Aucune donnée personnelle dans les détails : des nombres et des dates.
--
-- DÉPLOIEMENT : la fonction lit les champs `callsFailed`, `callsObserved` et `writeBusy` du résumé des passes, écrits
-- par le code qui accompagne cette migration ; avant lui elle se rabat sur `failed` et `observed`, et `writeBusy` est
-- absent (l'alerte d'écriture bloquée ne s'ouvre pas). Déployer le code d'abord est donc préférable, mais l'ordre
-- inverse ne casse rien.
-- RETOUR ARRIÈRE : retirer l'appel de app_private.evaluate_operational_health (même méthode, replace inverse), puis
-- drop function app_private.evaluate_flood_pepite_reference_health(timestamptz). Les alertes ouvertes se referment
-- à la main (update public.operational_alerts set status = 'resolved' ...).
create or replace function app_private.evaluate_flood_pepite_reference_health(
  p_now timestamptz default statement_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Inondation : entrée (A), les trois dernières passes réussies.
  flood_passes integer;
  flood_failed numeric;
  flood_observed numeric;
  -- Inondation : entrée (B), les trois dernières passes (réussies ou en échec).
  flood_last_degraded boolean;
  flood_degraded_runs integer;
  flood_active boolean;
  flood_previous_since timestamptz;
  flood_since timestamptz;
  -- Écritures bloquées.
  busy_passes integer;
  busy_blocked_passes integer;
  remaining_passes integer;
  remaining_positive_passes integer;
  remaining_newest numeric;
  remaining_oldest numeric;
  write_blocked boolean;
  -- Pépites.
  pepite_mode text;
  pepite_mode_since timestamptz;
  pepite_last_evaluated timestamptz;
  pepite_mode_late boolean;
  pepite_evaluation_late boolean;
  -- ANIL.
  anil_vintage integer;
  anil_year integer;
  anil_expected integer;
  anil_deadline timestamptz;
begin
  -- Inondation, entrée (A) : le résumé des trois dernières passes réussies.
  select
    count(*)::integer,
    coalesce(sum(
      case
        when pg_catalog.jsonb_typeof(passes.summary->'callsFailed') = 'number'
          then (passes.summary->>'callsFailed')::numeric
        when pg_catalog.jsonb_typeof(passes.summary->'failed') = 'number'
          then (passes.summary->>'failed')::numeric
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when pg_catalog.jsonb_typeof(passes.summary->'callsObserved') = 'number'
          then (passes.summary->>'callsObserved')::numeric
        when pg_catalog.jsonb_typeof(passes.summary->'observed') = 'number'
          then (passes.summary->>'observed')::numeric
        else 0
      end
    ), 0)
  into flood_passes, flood_failed, flood_observed
  from (
    select run.summary
    from public.operational_job_runs run
    where run.job_name = 'sale-flood-risk'
      and run.status = 'success'
    order by run.started_at desc
    limit 3
  ) passes;

  -- Inondation, entrée (B) : les trois dernières passes terminées, dont la dernière doit être un échec « dégradée ».
  select
    coalesce(bool_or(recent.is_degraded) filter (where recent.rank = 1), false),
    count(*) filter (where recent.is_degraded)::integer
  into flood_last_degraded, flood_degraded_runs
  from (
    select
      row_number() over (order by run.started_at desc) as rank,
      run.status = 'failed'
        and (
          run.error_message ilike '%dégradée%'
          or run.error_message ilike '%source_degraded%'
        ) as is_degraded
    from public.operational_job_runs run
    where run.job_name = 'sale-flood-risk'
      and run.status in ('success', 'failed')
    order by run.started_at desc
    limit 3
  ) recent;

  flood_active :=
    (
      flood_passes = 3
      and flood_failed >= 30
      and flood_failed >= (flood_failed + flood_observed) * 0.5
    )
    or (flood_last_degraded and flood_degraded_runs >= 2);

  -- Depuis quand l'alerte est active : la date est reportée dans les détails d'un passage à l'autre (elle repart
  -- de l'instant courant quand l'alerte était fermée), ce qui permet de la passer en critique après 12 h.
  select nullif(alert.details->>'active_since', '')::timestamptz
  into flood_previous_since
  from public.operational_alerts alert
  where alert.alert_key = 'flood_risk.observation.degraded'
    and alert.status = 'open';
  flood_since := coalesce(flood_previous_since, p_now);

  perform app_private.sync_operational_alert(
    'flood_risk.observation.degraded',
    'cron',
    case when flood_since <= p_now - interval '12 hours' then 'critical' else 'warning' end,
    jsonb_build_object(
      'recent_passes', flood_passes,
      'failed_calls', flood_failed,
      'observed_calls', flood_observed,
      'degraded_runs_of_last_3', flood_degraded_runs,
      'failed_share_threshold', 0.5,
      'failed_calls_threshold', 30,
      'active_since', flood_since,
      'critical_after_hours', 12
    ),
    flood_active,
    p_now
  );

  -- Écritures bloquées par le verrou de publication.
  select
    count(*)::integer,
    count(*) filter (
      where pg_catalog.jsonb_typeof(passes.summary->'writeBusy') = 'number'
        and (passes.summary->>'writeBusy')::numeric > 0
    )::integer
  into busy_passes, busy_blocked_passes
  from (
    select run.summary
    from public.operational_job_runs run
    where run.job_name = 'sale-flood-risk'
      and run.status = 'success'
    order by run.started_at desc
    limit 3
  ) passes;

  select
    count(*)::integer,
    count(*) filter (where passes.remaining > 0)::integer,
    (array_agg(passes.remaining order by passes.started_at desc))[1],
    (array_agg(passes.remaining order by passes.started_at asc))[1]
  into remaining_passes, remaining_positive_passes, remaining_newest, remaining_oldest
  from (
    select
      run.started_at,
      case
        when pg_catalog.jsonb_typeof(run.summary->'remaining') = 'number'
          then (run.summary->>'remaining')::numeric
      end as remaining
    from public.operational_job_runs run
    where run.job_name = 'sale-flood-risk'
      and run.status = 'success'
    order by run.started_at desc
    limit 6
  ) passes;

  write_blocked :=
    (busy_passes = 3 and busy_blocked_passes = 3)
    or (
      remaining_passes = 6
      and remaining_positive_passes = 6
      and remaining_newest >= remaining_oldest
    );

  perform app_private.sync_operational_alert(
    'flood_risk.write_blocked',
    'cron',
    'warning',
    jsonb_build_object(
      'recent_passes', busy_passes,
      'passes_with_blocked_writes', busy_blocked_passes,
      'passes_with_remaining', remaining_positive_passes,
      'remaining_newest', remaining_newest,
      'remaining_oldest', remaining_oldest,
      'blocked_passes_threshold', 3,
      'remaining_passes_threshold', 6
    ),
    write_blocked,
    p_now
  );

  -- Pépites : mode et dernière écriture.
  pepite_mode := app_private.sale_pepite_mode();
  select settings.updated_at into pepite_mode_since
  from app_private.sale_pepite_settings settings
  where settings.singleton;
  select max(pepite.evaluated_at) into pepite_last_evaluated
  from public.auction_sale_pepites pepite;

  pepite_mode_late := pepite_mode is distinct from 'on'
    and (pepite_mode_since is null or pepite_mode_since < p_now - interval '1 hour');
  pepite_evaluation_late := pepite_last_evaluated is not null
    and pepite_last_evaluated < p_now - interval '6 hours';

  perform app_private.sync_operational_alert(
    'pepites.evaluation.stale',
    'cron',
    case
      when (pepite_last_evaluated is not null and pepite_last_evaluated < p_now - interval '24 hours')
        or (pepite_mode_late and pepite_mode_since is not null
          and pepite_mode_since < p_now - interval '24 hours') then 'critical'
      else 'warning'
    end,
    jsonb_build_object(
      'mode', pepite_mode,
      'mode_since', pepite_mode_since,
      'last_evaluated_at', pepite_last_evaluated,
      'evaluation_age_hours',
        case
          when pepite_last_evaluated is null then null
          else (extract(epoch from (p_now - pepite_last_evaluated)) / 3600)::integer
        end,
      'warning_after_hours', 6,
      'critical_after_hours', 24
    ),
    pepite_mode_late or pepite_evaluation_late,
    p_now
  );

  -- Import ANIL : l'édition de décembre de l'année précédente doit être chargée au 15 janvier.
  select max(rent.vintage)::integer into anil_vintage
  from public.anil_rents rent;
  anil_year := extract(year from (p_now at time zone 'UTC'))::integer;
  anil_deadline := make_timestamptz(anil_year, 1, 15, 0, 0, 0, 'UTC');
  anil_expected := case when p_now >= anil_deadline then anil_year - 1 else anil_year - 2 end;

  perform app_private.sync_operational_alert(
    'reference.anil_rents.stale',
    'cron',
    case when p_now >= anil_deadline + interval '60 days' then 'critical' else 'warning' end,
    jsonb_build_object(
      'loaded_vintage', anil_vintage,
      'expected_vintage', anil_expected,
      'deadline_day', '01-15',
      'critical_after_days', 60
    ),
    anil_vintage is not null and anil_vintage < anil_expected,
    p_now
  );
end;
$$;

revoke all on function app_private.evaluate_flood_pepite_reference_health(timestamptz)
from public, anon, authenticated;
grant execute on function app_private.evaluate_flood_pepite_reference_health(timestamptz) to service_role;

comment on function app_private.evaluate_flood_pepite_reference_health(timestamptz) is
  'Alertes flood_risk.observation.degraded, flood_risk.write_blocked, pepites.evaluation.stale et reference.anil_rents.stale. Appelée par evaluate_operational_health ; ne renvoie rien.';

-- Appel depuis app_private.evaluate_operational_health, juste avant le décompte des alertes ouvertes. Méthode des
-- migrations précédentes : refuser de deviner si le fragment attendu n'y est plus.
do $$
declare
  definition text;
  anchor constant text := 'select count(*)::integer into open_alert_count';
begin
  definition := pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure);
  if position('evaluate_flood_pepite_reference_health' in definition) = 0 then
    if position(anchor in definition) = 0 then
      raise exception using
        errcode = '55000',
        message = 'Operational health definition changed; review before adding the flood, pepite and reference alerts (n° 82).';
    end if;
    execute replace(
      definition,
      anchor,
      'perform app_private.evaluate_flood_pepite_reference_health(p_now);' || E'\n\n  ' || anchor
    );
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
