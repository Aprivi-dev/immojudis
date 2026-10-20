-- 20261029170000 (W9, points 1 et 48) : nouvelles alertes de evaluate_operational_health :
-- retention.sale.overdue, catalogue.invalidation.backlog et alerts.delivery.late. Chaque alerte s'ouvre sur
-- son seuil, pas en deçà, et se referme d'elle-même (hystérésis de deux heures de sync_operational_alert).
begin;

select plan(27);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role', 'app_private.evaluate_operational_health(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'anon', 'app_private.evaluate_operational_health(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'authenticated', 'app_private.evaluate_operational_health(timestamptz)', 'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  ),
  'l''évaluation reste SECURITY DEFINER, fermée au navigateur, ouverte au service'
);

select ok(
  position('retention.sale.overdue' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('catalogue.invalidation.backlog' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('alerts.delivery.late' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('dvf.freshness' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'la nouvelle définition porte les trois alertes et garde les précédentes'
);

-- Données de départ : aucune alerte, aucune vente échue, boîte vide, aucune notification en file.
-- Les ventes de ce test sont créées avec une fin de vente explicite (source_sale_schedule), que le
-- déclencheur de date limite matérialise telle quelle dans catalogue_expiry_deadline.
delete from public.operational_alerts;
delete from app_private.catalogue_invalidations;
delete from public.operational_job_runs;
delete from public.user_alert_notifications;

-- Les notifications d'alerte pointent vers un compte, une alerte, une correspondance et une vente :
-- les contraintes de clé étrangère sont levées pour ce seul test (annulé par le rollback).
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.user_alert_notifications'::regclass
      and contype = 'f'
  loop
    execute format(
      'alter table public.user_alert_notifications drop constraint %I',
      constraint_row.conname
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- retention.sale.overdue
-- ---------------------------------------------------------------------------------------------
-- Instant de l'évaluation : fixe, pour que les âges soient ceux écrits ci-dessous.
create temporary table pgtap_595_context (p_now timestamptz not null) on commit drop;
insert into pgtap_595_context values ('2026-10-20T10:00:00Z');

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, raw_payload
) values (
  'f5950000-0000-4000-8000-000000000001',
  'pgtap-595',
  'https://example.test/pgtap/595/overdue-recent',
  'upcoming',
  '2026-10-20T08:30:00Z',
  jsonb_build_object(
    'source_sale_schedule',
    jsonb_build_object('opens_at', '2026-10-20T08:30:00Z', 'closes_at', '2026-10-20T09:00:00Z')
  )
);

select is(
  (
    select catalogue_expiry_deadline
    from public.auction_sales
    where id = 'f5950000-0000-4000-8000-000000000001'
  ),
  '2026-10-20T09:00:00Z'::timestamptz,
  'la vente de départ expire à la fin de vente fournie, soit une heure avant l''évaluation'
);

select lives_ok(
  $sql$select public.evaluate_operational_health((select p_now from pgtap_595_context))$sql$,
  'l''évaluation tourne avec une vente échue depuis une heure'
);

select is(
  (select count(*) from public.operational_alerts where alert_key = 'retention.sale.overdue'),
  0::bigint,
  'une vente échue depuis moins de 2 h n''ouvre pas retention.sale.overdue'
);

-- Une seconde vente, échue depuis trois heures : la purge a du retard.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, raw_payload
) values (
  'f5950000-0000-4000-8000-000000000002',
  'pgtap-595',
  'https://example.test/pgtap/595/overdue-old',
  'upcoming',
  '2026-10-20T06:30:00Z',
  jsonb_build_object(
    'source_sale_schedule',
    jsonb_build_object('opens_at', '2026-10-20T06:30:00Z', 'closes_at', '2026-10-20T07:00:00Z')
  )
);

select lives_ok(
  $sql$select public.evaluate_operational_health((select p_now from pgtap_595_context))$sql$,
  'l''évaluation tourne avec une vente échue depuis trois heures'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'retention.sale.overdue'
      and status = 'open'
      and severity = 'critical'
      and (details->>'overdue_count')::integer = 2
      and (details->>'oldest_overdue_age_minutes')::integer = 180
  ),
  1::bigint,
  'la vente échue la plus ancienne date de plus de 2 h : alerte critique, avec son âge'
);

-- La purge rattrape son retard : plus aucune vente échue (les deux ventes reçoivent une fin de vente
-- lointaine, ce que le déclencheur de date limite matérialise), l'alerte devient inactive puis se ferme.
update public.auction_sales
set sale_date = '2030-01-01T10:00:00Z',
    raw_payload = jsonb_build_object(
      'source_sale_schedule',
      jsonb_build_object('opens_at', '2030-01-01T10:00:00Z', 'closes_at', '2030-01-01T11:00:00Z')
    )
where source_name = 'pgtap-595';
update pgtap_595_context set p_now = p_now + interval '5 minutes';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'retention.sale.overdue'
  ),
  'sans vente échue, l''alerte devient inactive (elle reste ouverte pendant l''hystérésis)'
);

update pgtap_595_context set p_now = p_now + interval '2 hours 10 minutes';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select status from public.operational_alerts where alert_key = 'retention.sale.overdue'),
  'resolved',
  'l''alerte se referme d''elle-même deux heures après le retour à la normale'
);

-- Second critère : six passages de la purge qui laissent des ventes restantes.
delete from public.operational_alerts where alert_key = 'retention.sale.overdue';
delete from public.operational_job_runs where job_name = 'sale-retention';
update pgtap_595_context set p_now = '2026-10-20T12:00:00Z';

insert into public.operational_job_runs (job_name, status, summary, started_at, finished_at)
select
  'sale-retention',
  'success',
  jsonb_build_object('deleted', 300, 'remaining', 40 - pass_number, 'busy', false),
  '2026-10-20T11:00:00Z'::timestamptz + pass_number * interval '5 minutes',
  '2026-10-20T11:01:00Z'::timestamptz + pass_number * interval '5 minutes'
from generate_series(1, 5) as pass_number;

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select count(*) from public.operational_alerts where alert_key = 'retention.sale.overdue'),
  0::bigint,
  'cinq passages avec des ventes restantes ne suffisent pas'
);

insert into public.operational_job_runs (job_name, status, summary, started_at, finished_at)
values (
  'sale-retention',
  'success',
  jsonb_build_object('deleted', 300, 'remaining', 35, 'busy', false),
  '2026-10-20T11:35:00Z',
  '2026-10-20T11:36:00Z'
);

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'retention.sale.overdue'
      and status = 'open'
      and (details->>'passes_with_remaining')::integer = 6
      and (details->>'passes_checked')::integer = 6
  ),
  1::bigint,
  'six passages de suite avec des ventes restantes ouvrent retention.sale.overdue'
);

-- Un passage qui vide la file (remaining = 0) casse la série : plus d'alerte active.
insert into public.operational_job_runs (job_name, status, summary, started_at, finished_at)
values (
  'sale-retention',
  'success',
  jsonb_build_object('deleted', 35, 'remaining', 0, 'busy', false),
  '2026-10-20T11:40:00Z',
  '2026-10-20T11:41:00Z'
);

update pgtap_595_context set p_now = p_now + interval '1 minute';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'retention.sale.overdue'
  ),
  'un passage qui vide la file rend l''alerte inactive'
);

-- Un passage en échec dans la série ne compte pas comme « ventes restantes ».
delete from public.operational_alerts where alert_key = 'retention.sale.overdue';
delete from public.operational_job_runs where job_name = 'sale-retention';
insert into public.operational_job_runs (job_name, status, summary, started_at, finished_at)
select
  'sale-retention',
  case when pass_number = 3 then 'failed' else 'success' end,
  case
    when pass_number = 3 then '{}'::jsonb
    else jsonb_build_object('remaining', 10)
  end,
  '2026-10-20T11:00:00Z'::timestamptz + pass_number * interval '5 minutes',
  '2026-10-20T11:01:00Z'::timestamptz + pass_number * interval '5 minutes'
from generate_series(1, 6) as pass_number;

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select count(*) from public.operational_alerts where alert_key = 'retention.sale.overdue'),
  0::bigint,
  'un passage en échec dans la série ne compte pas comme des ventes restantes'
);

-- ---------------------------------------------------------------------------------------------
-- catalogue.invalidation.backlog
-- ---------------------------------------------------------------------------------------------
update pgtap_595_context set p_now = '2026-10-20T14:00:00Z';

-- Les modifications de ventes ci-dessus ont pu noter des lignes dans la boîte : on la repart vide.
delete from app_private.catalogue_invalidations;
insert into app_private.catalogue_invalidations (sale_id, at)
values (gen_random_uuid(), '2026-10-20T12:30:00Z');

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select count(*) from public.operational_alerts where alert_key = 'catalogue.invalidation.backlog'),
  0::bigint,
  'une ligne de la boîte d''invalidation de 90 minutes ne déclenche rien'
);

delete from app_private.catalogue_invalidations;
insert into app_private.catalogue_invalidations (sale_id, at)
values (gen_random_uuid(), '2026-10-20T11:30:00Z');

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'catalogue.invalidation.backlog'
      and status = 'open'
      and severity = 'warning'
      and (details->>'oldest_age_minutes')::integer = 150
      and (details->>'pending_count')::integer = 1
  ),
  1::bigint,
  'une ligne de plus de 2 h ouvre catalogue.invalidation.backlog (avertissement)'
);

-- Le pipeline vide la boîte : l'alerte devient inactive puis se ferme.
delete from app_private.catalogue_invalidations;
update pgtap_595_context set p_now = p_now + interval '10 minutes';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'catalogue.invalidation.backlog'
  ),
  'une fois la boîte vidée, l''alerte devient inactive'
);

update pgtap_595_context set p_now = p_now + interval '2 hours 10 minutes';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select status from public.operational_alerts where alert_key = 'catalogue.invalidation.backlog'),
  'resolved',
  'catalogue.invalidation.backlog se referme d''elle-même'
);

-- Plus de 1 000 lignes, même récentes.
delete from public.operational_alerts where alert_key = 'catalogue.invalidation.backlog';
update pgtap_595_context set p_now = '2026-10-20T20:00:00Z';
insert into app_private.catalogue_invalidations (sale_id, at)
select gen_random_uuid(), '2026-10-20T19:50:00Z'::timestamptz
from generate_series(1, 1000);

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select count(*) from public.operational_alerts where alert_key = 'catalogue.invalidation.backlog'),
  0::bigint,
  '1 000 lignes récentes ne suffisent pas (le seuil est au-delà de 1 000)'
);

insert into app_private.catalogue_invalidations (sale_id, at)
values (gen_random_uuid(), '2026-10-20T19:55:00Z');

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'catalogue.invalidation.backlog'
      and status = 'open'
      and (details->>'pending_count')::integer = 1001
  ),
  1::bigint,
  'plus de 1 000 lignes ouvrent l''alerte même si la plus ancienne est récente'
);

-- ---------------------------------------------------------------------------------------------
-- alerts.delivery.late
-- ---------------------------------------------------------------------------------------------
update pgtap_595_context set p_now = '2026-10-21T09:00:00Z';
-- La boîte d'invalidation est vidée : sa seule présence rouvrirait l'alerte précédente.
delete from app_private.catalogue_invalidations;

-- En file depuis 25 h, en file mais prévue demain, et envoyée depuis 40 h : aucune n'est « en retard ».
insert into public.user_alert_notifications (
  user_id, alert_id, match_id, sale_id, delivery_channel, delivery_status, scheduled_for
) values
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'email', 'queued',
   '2026-10-20T08:00:00Z'),
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'in_app', 'queued',
   '2026-10-22T07:00:00Z'),
  (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'email', 'sent',
   '2026-10-19T17:00:00Z');

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select count(*) from public.operational_alerts where alert_key = 'alerts.delivery.late'),
  0::bigint,
  'une notification en file depuis 25 h, une prévue demain et une envoyée n''ouvrent rien'
);

insert into public.user_alert_notifications (
  user_id, alert_id, match_id, sale_id, delivery_channel, delivery_status, scheduled_for
) values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'email', 'queued',
  '2026-10-20T06:30:00Z'
);

select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'alerts.delivery.late'
      and status = 'open'
      and severity = 'warning'
      and (details->>'late_count')::integer = 1
  ),
  1::bigint,
  'un envoi en file dont la date prévue a plus de 26 h ouvre alerts.delivery.late'
);

-- L'envoi part (statut sent) : l'alerte devient inactive puis se ferme.
update public.user_alert_notifications set delivery_status = 'sent' where delivery_status = 'queued';
update pgtap_595_context set p_now = p_now + interval '10 minutes';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'alerts.delivery.late'
  ),
  'une fois l''envoi parti, l''alerte devient inactive'
);

update pgtap_595_context set p_now = p_now + interval '2 hours 10 minutes';
select public.evaluate_operational_health((select p_now from pgtap_595_context));

select is(
  (select status from public.operational_alerts where alert_key = 'alerts.delivery.late'),
  'resolved',
  'alerts.delivery.late se referme d''elle-même'
);

-- ---------------------------------------------------------------------------------------------
-- Le résultat de l'évaluation expose les compteurs, sans casser les anciens.
-- ---------------------------------------------------------------------------------------------
select ok(
  (
    select result ? 'retention_overdue'
      and result ? 'catalogue_invalidations'
      and result ? 'late_alert_deliveries'
      and result ? 'open_alerts'
      and result ? 'stale_cron_jobs'
      and result ? 'dvf_stuck'
    from (
      select public.evaluate_operational_health((select p_now from pgtap_595_context)) as result
    ) evaluation
  ),
  'le résultat porte les trois nouveaux compteurs et les clés historiques'
);

select ok(
  not exists (
    select 1
    from public.operational_alerts
    where alert_key in (
      'retention.sale.overdue', 'catalogue.invalidation.backlog', 'alerts.delivery.late'
    )
      and status = 'open'
  ),
  'à la fin du scénario, plus aucune des trois alertes n''est ouverte'
);

-- Les seuils de la définition sont ceux annoncés (relus dans le texte de la fonction).
select ok(
  position('26 hours' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0
  and position('limit 1001' in pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  )) > 0,
  'la fenêtre de 26 h et la lecture bornée à 1 001 lignes sont dans la définition'
);

select ok(
  not has_function_privilege(
    'anon', 'public.evaluate_operational_health(timestamptz)', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'public.evaluate_operational_health(timestamptz)', 'execute'
  ),
  'l''enveloppe publique reste fermée au navigateur'
);

select * from finish();

rollback;
