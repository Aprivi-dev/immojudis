begin;

-- A busy scheduler cannot dispatch another writer. Resolve its existing run
-- lease/retry first, without repeating the expensive optional detail admission
-- scan or waiting on the source-detail administration lock. A new dispatch still
-- admits due details before deciding between source collection and enrichment.
do $$
declare
  definition text := pg_get_functiondef(
    'public.claim_autonomous_pipeline_run()'::regprocedure
  );
  enqueue_statement constant text :=
    '  perform public.enqueue_due_source_details(now_at,500);';
  admission_marker constant text :=
    '  update public.auction_source_state s set next_inventory_at=least(s.next_inventory_at,now_at)';
begin
  if (length(definition) - length(replace(definition, enqueue_statement, '')))
       / length(enqueue_statement) <> 1
     or (length(definition) - length(replace(definition, admission_marker, '')))
       / length(admission_marker) <> 1
     or position(enqueue_statement in definition)
       >= position('  if active_id is not null then' in definition)
     or position(admission_marker in definition)
       <= position('  if active_id is not null then' in definition) then
    raise exception 'Unexpected scheduler definition; refusing to move detail admission.';
  end if;

  definition := replace(definition, enqueue_statement || chr(10), '');
  definition := replace(
    definition,
    admission_marker,
    enqueue_statement || chr(10) || chr(10) || admission_marker
  );
  execute definition;
end;
$$;

revoke all on function public.claim_autonomous_pipeline_run()
  from public, anon, authenticated;
grant execute on function public.claim_autonomous_pipeline_run()
  to service_role;

notify pgrst, 'reload schema';

commit;
