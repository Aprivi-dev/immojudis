begin;

select plan(5);

-- Cadence de collecte : chaque source au plus toutes les 12 heures (décision du
-- 11/10/2026). Les lignes de test sont annulées en fin de fichier.

select ok(
  position(
    'next_inventory_at=now_at+interval ''12 hours''' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0
  and position(
    'next_inventory_at=now_at+interval ''6 hours''' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) = 0,
  'a dispatched source is held back for 12 hours, no longer 6'
);

select ok(
  not has_function_privilege('anon', 'public.claim_autonomous_pipeline_run()', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_autonomous_pipeline_run()', 'execute'),
  'the scheduler claim stays reserved to the service role'
);

set local role service_role;

update public.auction_runs
   set status = 'failed', finished_at = statement_timestamp()
 where status in ('queued', 'running');
update public.auction_source_state set enabled = false;
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = false,
       enrichment_drain_until = null,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;

insert into public.auction_source_state (source_name, enabled, next_inventory_at)
values ('pgtap-cadence-12h', true, statement_timestamp() - interval '10 minutes');

create temporary table pgtap_cadence_claim (payload jsonb) on commit drop;
insert into pgtap_cadence_claim values (public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'source' from pgtap_cadence_claim),
  'pgtap-cadence-12h',
  'the due source gets its collection turn'
);

select ok(
  (
    select next_inventory_at between statement_timestamp() + interval '11 hours 59 minutes'
                                 and statement_timestamp() + interval '12 hours 1 minute'
      from public.auction_source_state
     where source_name = 'pgtap-cadence-12h'
  ),
  'the claimed source is postponed for the 12-hour cadence'
);

select is(
  (select public.claim_autonomous_pipeline_run()),
  null::jsonb,
  'the same source is not dispatched again while its run is pending'
);

select * from finish();
rollback;
