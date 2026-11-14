-- 20261119101020 (14/11/2026, D13) : app_private.mark_unseen_undated_sales passe en « unknown » les ventes à venir
-- sans date d'audience non revues depuis 14 jours ; source active juste après un inventaire complet, source
-- désactivée sans condition d'inventaire (décision du propriétaire du 14/11/2026) ; rien n'est supprimé.
begin;

select plan(12);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.mark_unseen_undated_sales(text,boolean,timestamptz)'::regprocedure
  ),
  'the sweep is SECURITY DEFINER and closed to the API roles, like the withdrawal'
);

-- Rollback-only fixture.
insert into public.auction_source_state (source_name, enabled, next_inventory_at)
values ('pgtap-899-active', true, statement_timestamp() + interval '1 day'),
       ('pgtap-899-disabled', false, statement_timestamp() + interval '1 day');
update public.auction_source_state
   set last_inventory_complete_at = statement_timestamp() - interval '10 minutes'
 where source_name = 'pgtap-899-active';

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
select source_name, 'https://example.test/pgtap/899/' || source_name || '/' || sale_number, 'upcoming',
       case when sale_number = 1 then null else statement_timestamp() + interval '30 days' end, '{}'::jsonb
  from (values ('pgtap-899-active'), ('pgtap-899-disabled')) sources(source_name)
  cross join generate_series(1, 8) as sale_number;
-- The first sale of each source has no hearing date and has not been seen for 20 days.
update public.auction_sales
   set last_seen_at = statement_timestamp() - interval '20 days'
 where source_url like 'https://example.test/pgtap/899/%/1';

select is(
  app_private.mark_unseen_undated_sales('pgtap-899-active', true)->>'marked',
  '1',
  'an active source just after a complete inventory: its undated sale unseen for 20 days becomes unknown'
);

select ok(
  (
    select status = 'unknown'
       and raw_payload->'unseen_undated'->>'status_before' = 'upcoming'
       and (raw_payload->'unseen_undated'->>'unseen_days')::integer = 14
      from public.auction_sales
     where source_url = 'https://example.test/pgtap/899/pgtap-899-active/1'
  ),
  'the previous status is kept in raw_payload.unseen_undated'
);

select is(
  (
    select count(*)
      from public.auction_sales
     where source_name = 'pgtap-899-active' and status = 'upcoming'
  ),
  7::bigint,
  'dated sales stay upcoming and nothing is deleted'
);

select is(
  app_private.mark_unseen_undated_sales('pgtap-899-disabled', true)->>'marked',
  '1',
  'a disabled source is swept without any inventory (owner decision of 14/11/2026)'
);

update public.auction_source_state
   set last_inventory_complete_at = statement_timestamp() - interval '3 hours'
 where source_name = 'pgtap-899-active';
update public.auction_sales
   set status = 'upcoming'
 where source_url = 'https://example.test/pgtap/899/pgtap-899-active/1';

select is(
  app_private.mark_unseen_undated_sales('pgtap-899-active', true)->>'reason',
  'no_recent_complete_inventory',
  'an active source without a complete inventory of less than 2 hours is left alone'
);

-- More than 15 % of the visible sales at once (at least one) looks like a broken collection: nothing, and an alert.
update public.auction_source_state
   set last_inventory_complete_at = statement_timestamp() - interval '10 minutes'
 where source_name = 'pgtap-899-active';
update public.auction_sales
   set sale_date = null,
       last_seen_at = statement_timestamp() - interval '20 days'
 where source_name = 'pgtap-899-active';

select is(
  app_private.mark_unseen_undated_sales('pgtap-899-active', true)->>'action',
  'blocked',
  'past the cap of the withdrawal (15 % of the visible sales, at least one), nothing is done'
);

-- A separate statement: the alert written by the call is not visible to the statement that made it.
select ok(
  (
    select status = 'open'
      from public.operational_alerts
     where alert_key = 'catalogue.unseen_undated.pgtap-899-active'
  )
  and not exists (
    select 1 from public.auction_sales where source_name = 'pgtap-899-active' and status = 'unknown'
  ),
  'catalogue.unseen_undated.<source> opens and no sale of the source became unknown'
);

-- Second review (14/11/2026): the alert closes once a sweep is under the cap again. The collection sees the dated
-- sales again: only the first one is left unseen.
update public.auction_sales
   set last_seen_at = statement_timestamp()
 where source_name = 'pgtap-899-active'
   and source_url <> 'https://example.test/pgtap/899/pgtap-899-active/1';

select is(
  app_private.mark_unseen_undated_sales('pgtap-899-active', true)->>'marked',
  '1',
  'back under the cap, the sweep marks the sale left unseen'
);

select ok(
  (
    select inactive_since is not null
      from public.operational_alerts
     where alert_key = 'catalogue.unseen_undated.pgtap-899-active'
  ),
  'catalogue.unseen_undated.<source> is no longer active once a sweep is under the cap'
);

-- A sale whose last sighting is unknown (last_seen_at null) is never taken as unseen for 14 days.
update public.auction_sales
   set sale_date = null,
       last_seen_at = null
 where source_url = 'https://example.test/pgtap/899/pgtap-899-disabled/2';

select is(
  app_private.mark_unseen_undated_sales('pgtap-899-disabled', true)->>'candidates',
  '0',
  'an undated sale without last_seen_at is no candidate'
);

select is(
  (
    select status
      from public.auction_sales
     where source_url = 'https://example.test/pgtap/899/pgtap-899-disabled/2'
  ),
  'upcoming',
  'it stays upcoming'
);

select * from finish();

rollback;
