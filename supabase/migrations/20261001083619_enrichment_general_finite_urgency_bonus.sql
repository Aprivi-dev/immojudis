begin;

set local lock_timeout = '5s';

-- Keep the all-family/source-detail lane order and every admission fence
-- intact.  Only the general enrichment branch changes: urgency is a finite
-- 168-hour bonus, so age can eventually outrank a stream of near sales.
do $patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  );
  old_order constant text := $old_order$
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              coalesce((s.sale_date between now() and now() + interval '7 days'), false) desc,
              j.priority + extract(epoch from (now() - j.created_at)) / 3600 desc,
              j.created_at,
              j.id$old_order$;
  new_order constant text := $new_order$
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              j.priority
                + extract(epoch from (now() - j.created_at)) / 3600
                + case
                    when coalesce((s.sale_date between now() and now() + interval '7 days'), false)
                      then 168
                    else 0
                  end desc,
              j.created_at,
              j.id$new_order$;
begin
  if (length(definition) - length(replace(definition, old_order, '')))
       / length(old_order) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'Unexpected general enrichment order; refusing finite urgency patch.';
  end if;

  definition := replace(definition, old_order, new_order);
  if position(old_order in definition) > 0
     or position('then 168' in definition) = 0
     or position('r.is_near desc' in definition) = 0
     or position('pg_advisory_xact_lock' in definition) = 0
     or position('revision_rank > 1' in definition) = 0
     or position('s.retention_deadline_materialized' in definition) = 0
     or position('active.status = ''running''' in definition) = 0
     or position('for update of j, s skip locked' in definition) = 0
     or position('v_family = ''all'' and j.job_type = ''source_detail''' in definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'Finite urgency patch did not preserve the claim guards or source-detail lane.';
  end if;

  execute definition;
end;
$patch$;

revoke all on function public.claim_auction_enrichment_jobs_family(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs_family(text, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
