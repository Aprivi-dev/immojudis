-- 20261108100000 (n° 82) : alertes de supervision de l'observation d'inondation, du calcul des pépites et de l'import
-- ANIL, évaluées par app_private.evaluate_flood_pepite_reference_health et appelées par evaluate_operational_health.
--   * flood_risk.observation.degraded : entrée (A) résumé des 3 dernières passes réussies, entrée (B) échecs
--     « dégradée » ou source_degraded ; critique après 12 h ;
--   * flood_risk.write_blocked : writeBusy sur 3 passes, ou reliquat qui ne baisse pas sur 6 passes ;
--   * pepites.evaluation.stale : mode autre que « on » depuis plus d'une heure, ou dernière évaluation de plus de 6 h ;
--   * reference.anil_rents.stale : édition de décembre non chargée au 15 janvier, critique 60 jours plus tard.
-- Une base vide n'ouvre aucune de ces alertes.
begin;

select plan(38);

delete from public.operational_alerts;
delete from public.operational_job_runs;

create temporary table pgtap_761_context (p_now timestamptz not null) on commit drop;
insert into pgtap_761_context values ('2026-10-28T12:00:00Z');

create function pg_temp.run(
  p_status text, p_ago interval, p_summary jsonb default '{}', p_error text default null
) returns void language sql as $$
  insert into public.operational_job_runs (job_name, status, summary, error_message, started_at, finished_at)
  select 'sale-flood-risk', p_status, p_summary, p_error,
    p_now - p_ago, p_now - p_ago + interval '1 minute'
  from pgtap_761_context;
$$;

-- Sévérité de l'alerte si elle est ouverte, sinon « none ».
create function pg_temp.sev(p_key text) returns text language sql as $$
  select coalesce(
    (select alert.severity from public.operational_alerts alert
      where alert.alert_key = p_key and alert.status = 'open'),
    'none'
  );
$$;

create function pg_temp.reset() returns void language sql as $$
  delete from public.operational_alerts;
  delete from public.operational_job_runs;
  delete from public.anil_rents;
  update app_private.sale_pepite_settings
     set mode = 'on', updated_at = '2026-10-01T00:00:00Z'
   where singleton;
$$;

-- À l'instant du contexte, sauf indication.
create function pg_temp.evaluate(p_at timestamptz default null) returns void language sql as $$
  select app_private.evaluate_flood_pepite_reference_health(
    coalesce(p_at, (select p_now from pgtap_761_context))
  );
$$;

-- Structure et droits ------------------------------------------------------------------------------
select has_function(
  'app_private', 'evaluate_flood_pepite_reference_health', array['timestamp with time zone'],
  'the flood, pepite and reference alerts have their own function'
);
select ok(
  not has_function_privilege(
    'anon', 'app_private.evaluate_flood_pepite_reference_health(timestamptz)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'app_private.evaluate_flood_pepite_reference_health(timestamptz)', 'EXECUTE'
  ),
  'neither a visitor nor an account can evaluate the alerts'
);
select ok(
  position('evaluate_flood_pepite_reference_health' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'evaluate_operational_health calls the new evaluation'
);
-- La liste des tâches attendues de cron.stale et les autres alertes n'ont pas bougé.
select ok(
  position('(''sale-flood-risk'', interval ''3 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('(''sale-pepites'', interval ''3 hours'')' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('auction_scenarios.snapshot.stale' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'the expected-jobs list and the existing alerts are untouched'
);

-- Base vide : aucune des quatre alertes -------------------------------------------------------------
select pg_temp.reset();
select pg_temp.evaluate();
select is(
  (select count(*)::integer from public.operational_alerts
    where alert_key in (
      'flood_risk.observation.degraded', 'flood_risk.write_blocked',
      'pepites.evaluation.stale', 'reference.anil_rents.stale'
    ) and status = 'open'),
  0,
  'an empty database opens none of the four alerts'
);

-- flood_risk.observation.degraded : entrée (A) ----------------------------------------------------------
select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"callsFailed": 20, "callsObserved": 10}');
select pg_temp.run('success', interval '2 hours', '{"callsFailed": 15, "callsObserved": 10}');
select pg_temp.run('success', interval '3 hours', '{"callsFailed": 5, "callsObserved": 10}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'warning',
  'three passes with 40 failed calls out of 70 open the alert as a warning'
);
select ok(
  (select (details->>'failed_calls')::numeric = 40 and (details->>'observed_calls')::numeric = 30
     and details ? 'active_since'
   from public.operational_alerts where alert_key = 'flood_risk.observation.degraded'),
  'the details carry the counted calls and the start date, no sale and no coordinate'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"callsFailed": 10, "callsObserved": 1}');
select pg_temp.run('success', interval '2 hours', '{"callsFailed": 10, "callsObserved": 1}');
select pg_temp.run('success', interval '3 hours', '{"callsFailed": 9, "callsObserved": 1}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'none',
  'fewer than 30 failed calls open nothing'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"failed": 20, "observed": 2}');
select pg_temp.run('success', interval '2 hours', '{"failed": 20, "observed": 2}');
select pg_temp.run('success', interval '3 hours', '{"failed": 20, "observed": 2}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'warning',
  'passes recorded before the new fields (failed, observed) are read as well'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"callsFailed": 30, "callsObserved": 100}');
select pg_temp.run('success', interval '2 hours', '{"callsFailed": 0, "callsObserved": 100}');
select pg_temp.run('success', interval '3 hours', '{"callsFailed": 0, "callsObserved": 100}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'none',
  'a failure share under one half opens nothing'
);

-- Moins de trois passes : pas de conclusion.
select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"callsFailed": 40, "callsObserved": 0}');
select pg_temp.run('success', interval '2 hours', '{"callsFailed": 40, "callsObserved": 0}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'none',
  'two passes are not enough to conclude'
);

-- Entrée (B) : la passe lève elle-même l'erreur, elle est enregistrée en échec ----------------------------
select pg_temp.reset();
select pg_temp.run('failed', interval '1 hour', '{}', 'Observation du risque d''inondation dégradée : 80 appel(s) en échec sur 120');
select pg_temp.run('failed', interval '2 hours', '{}', 'Source Géorisques dégradée (source_degraded) : point de contrôle');
select pg_temp.run('success', interval '3 hours', '{"callsFailed": 0, "callsObserved": 10}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'warning',
  'two degraded failures among the last three, the last one included, open the alert'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"callsFailed": 0, "callsObserved": 10}');
select pg_temp.run('failed', interval '2 hours', '{}', 'Observation du risque d''inondation dégradée : x');
select pg_temp.run('failed', interval '3 hours', '{}', 'Observation du risque d''inondation dégradée : x');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'none',
  'a success after two degraded failures means the source is back: no alert'
);

select pg_temp.reset();
select pg_temp.run('failed', interval '1 hour', '{}', 'Écriture des verdicts d''inondation impossible');
select pg_temp.run('failed', interval '2 hours', '{}', 'Écriture des verdicts d''inondation impossible');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'none',
  'failures of another kind are left to cron.stale'
);

-- Critique après 12 h, et fermeture au rétablissement.
select pg_temp.reset();
select pg_temp.run('failed', interval '1 hour', '{}', 'Observation du risque d''inondation dégradée : x');
select pg_temp.run('failed', interval '2 hours', '{}', 'Observation du risque d''inondation dégradée : x');
select pg_temp.evaluate('2026-10-27T23:00:00Z');
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'warning',
  'the alert opens as a warning'
);
select pg_temp.evaluate('2026-10-28T10:59:00Z');
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'warning',
  'still a warning 11 h 59 later'
);
select pg_temp.evaluate('2026-10-28T11:00:00Z');
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'critical',
  'critical once it has been active for 12 hours'
);
select pg_temp.run('success', interval '0 minutes', '{"callsFailed": 0, "callsObserved": 10}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'none',
  'a successful pass closes the alert'
);

-- Intégration : par evaluate_operational_health.
select pg_temp.reset();
select pg_temp.run('failed', interval '1 hour', '{}', 'Observation du risque d''inondation dégradée : x');
select pg_temp.run('failed', interval '2 hours', '{}', 'Observation du risque d''inondation dégradée : x');
select public.evaluate_operational_health((select p_now from pgtap_761_context));
select is(
  pg_temp.sev('flood_risk.observation.degraded'), 'warning',
  'evaluate_operational_health opens the alert'
);

-- flood_risk.write_blocked ------------------------------------------------------------------------------
select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"writeBusy": 25, "remaining": 0}');
select pg_temp.run('success', interval '2 hours', '{"writeBusy": 25, "remaining": 0}');
select pg_temp.run('success', interval '3 hours', '{"writeBusy": 25, "remaining": 0}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.write_blocked'), 'warning',
  'blocked writes on three passes in a row open the alert'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"writeBusy": 25}');
select pg_temp.run('success', interval '2 hours', '{"writeBusy": 0}');
select pg_temp.run('success', interval '3 hours', '{"writeBusy": 25}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.write_blocked'), 'none',
  'a pass without blocked writes in between: no alert'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"remaining": 80}');
select pg_temp.run('success', interval '2 hours', '{"remaining": 75}');
select pg_temp.run('success', interval '3 hours', '{"remaining": 70}');
select pg_temp.run('success', interval '4 hours', '{"remaining": 60}');
select pg_temp.run('success', interval '5 hours', '{"remaining": 50}');
select pg_temp.run('success', interval '6 hours', '{"remaining": 40}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.write_blocked'), 'warning',
  'a backlog that has not gone down over six passes opens the alert'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"remaining": 10}');
select pg_temp.run('success', interval '2 hours', '{"remaining": 20}');
select pg_temp.run('success', interval '3 hours', '{"remaining": 30}');
select pg_temp.run('success', interval '4 hours', '{"remaining": 40}');
select pg_temp.run('success', interval '5 hours', '{"remaining": 50}');
select pg_temp.run('success', interval '6 hours', '{"remaining": 60}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.write_blocked'), 'none',
  'a backlog going down is healthy'
);

select pg_temp.reset();
select pg_temp.run('success', interval '1 hour', '{"remaining": 0}');
select pg_temp.run('success', interval '2 hours', '{"remaining": 5}');
select pg_temp.run('success', interval '3 hours', '{"remaining": 5}');
select pg_temp.run('success', interval '4 hours', '{"remaining": 5}');
select pg_temp.run('success', interval '5 hours', '{"remaining": 5}');
select pg_temp.run('success', interval '6 hours', '{"remaining": 5}');
select pg_temp.evaluate();
select is(
  pg_temp.sev('flood_risk.write_blocked'), 'none',
  'an empty backlog on the last pass is healthy'
);

-- pepites.evaluation.stale ------------------------------------------------------------------------------
select pg_temp.reset();
update app_private.sale_pepite_settings set mode = 'shadow', updated_at = '2026-10-28T11:30:00Z' where singleton;
select pg_temp.evaluate();
select is(pg_temp.sev('pepites.evaluation.stale'), 'none', 'shadow mode for 30 minutes: no alert yet');

update app_private.sale_pepite_settings set updated_at = '2026-10-28T10:30:00Z' where singleton;
select pg_temp.evaluate();
select is(
  pg_temp.sev('pepites.evaluation.stale'), 'warning',
  'a mode other than on for more than an hour opens a warning'
);

update app_private.sale_pepite_settings set updated_at = '2026-10-26T10:30:00Z' where singleton;
select pg_temp.evaluate();
select is(
  pg_temp.sev('pepites.evaluation.stale'), 'critical',
  'a mode other than on for more than a day is critical'
);

update app_private.sale_pepite_settings set mode = 'on', updated_at = '2026-10-01T00:00:00Z' where singleton;
select pg_temp.evaluate();
select is(pg_temp.sev('pepites.evaluation.stale'), 'none', 'back to on: the alert closes');

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type
) values (
  'c7610000-1000-4000-8000-000000000001', 'alerts-test', 'https://example.test/alerts/1',
  'Alert sale', 'upcoming', '2099-01-01T12:00:00Z', 100000, 'tribunal'
);
insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, status, is_pepite, reason_codes, details, evaluated_at
) values (
  'c7610000-1000-4000-8000-000000000001', 'pepite-v1', 'pgtap', 'not_pepite', false,
  array['fail:test_c_cost'], '{}', '2026-10-28T07:00:00Z'
);
select pg_temp.evaluate();
select is(
  pg_temp.sev('pepites.evaluation.stale'), 'none',
  'a last evaluation 5 hours old is normal'
);

update public.auction_sale_pepites set evaluated_at = '2026-10-28T05:00:00Z';
select pg_temp.evaluate();
select is(
  pg_temp.sev('pepites.evaluation.stale'), 'warning',
  'a last evaluation more than 6 hours old opens a warning'
);

update public.auction_sale_pepites set evaluated_at = '2026-10-27T05:00:00Z';
select pg_temp.evaluate();
select is(
  pg_temp.sev('pepites.evaluation.stale'), 'critical',
  'a last evaluation more than 24 hours old is critical'
);

update public.auction_sale_pepites set evaluated_at = '2026-10-28T11:00:00Z';
select pg_temp.evaluate();
select is(
  pg_temp.sev('pepites.evaluation.stale'), 'none',
  'a fresh evaluation closes the alert'
);

-- reference.anil_rents.stale ----------------------------------------------------------------------------
select pg_temp.reset();
select pg_temp.evaluate();
select is(pg_temp.sev('reference.anil_rents.stale'), 'none', 'an ANIL table never loaded opens nothing');

insert into public.anil_rents (
  commune_code, segment, commune_name, department_code, rent_per_m2, prediction_type, vintage, source_url
) values ('37261', 'apt_all', 'Tours', '37', 10, 'commune', 2025, 'https://example.test/anil');

select pg_temp.evaluate();
select is(
  pg_temp.sev('reference.anil_rents.stale'), 'none',
  'the December 2025 edition (vintage 2025) is current in October 2026'
);
select pg_temp.evaluate('2027-01-10T12:00:00Z');
select is(
  pg_temp.sev('reference.anil_rents.stale'), 'none',
  'before 15 January the edition of December is not yet due'
);
select pg_temp.evaluate('2027-01-16T12:00:00Z');
select is(
  pg_temp.sev('reference.anil_rents.stale'), 'warning',
  'after 15 January 2027 with the 2025 edition still loaded: warning'
);
select pg_temp.evaluate('2027-03-17T12:00:00Z');
select is(
  pg_temp.sev('reference.anil_rents.stale'), 'critical',
  'sixty days later: critical'
);
update public.anil_rents set vintage = 2026;
select pg_temp.evaluate('2027-03-17T12:00:00Z');
select is(
  pg_temp.sev('reference.anil_rents.stale'), 'none',
  'the December 2026 edition (vintage 2026) closes the alert'
);

select * from finish();
rollback;
