begin;

-- The materialized cutoff is the normal retention path.  Only postponed rows
-- (or rows whose source payload explicitly reports a postponement) need the
-- compatibility fallback below.  Keep that fallback predicate byte-for-byte
-- equivalent to the purge function so the index limits JSON detoasting to the
-- small set of rows which can actually take that path.
create index if not exists auction_sales_retention_fallback_candidate_idx
  on public.auction_sales (sale_date, id)
  where status = 'postponed'
     or lower(coalesce(raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)';

-- observe_autonomous_pipeline ranks every non-cancelled revision by this exact
-- key.  Matching the partition and order keys lets PostgreSQL feed the window
-- directly from the index instead of sorting and repeatedly reading the heap.
create index if not exists auction_enrichment_jobs_revision_detail_idx
  on public.auction_enrichment_jobs (
    source_url,
    job_type,
    detail_source_name,
    detail_source_url,
    created_at desc,
    (input_hash like 'pipeline_v2:%') desc,
    id desc
  )
  where status <> 'cancelled';

-- Split the normal materialized cutoff from the postponed compatibility path.
-- The old OR predicate forced a heap scan and evaluated the JSON/date helper
-- for every sale.  The two branches below are set-equivalent: the fallback
-- explicitly excludes rows already selected by the materialized branch, and
-- the UNION ALL branches are therefore disjoint.  Advisory/table locks,
-- one-row processing, bridge ordering, tombstones and cleanup remain intact.
do $patch$
declare
  v_definition text;
  v_old_selection constant text := $old_selection$
  for sale_row in
    select sale.*
    from public.auction_sales sale
    where (
        sale.catalogue_expiry_materialized
        and sale.catalogue_expiry_deadline <= p_now
      )
      or (
        (
          sale.status = 'postponed'
          or lower(coalesce(sale.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
        )
        and app_private.sale_catalogue_expiry(
          sale.sale_date,
          (case
            when jsonb_typeof(coalesce(sale.raw_payload, '{}'::jsonb)) = 'object'
              then coalesce(sale.raw_payload, '{}'::jsonb)
            else '{}'::jsonb
           end) || jsonb_build_object('sale_procedure', coalesce(sale.sale_procedure, '{}'::jsonb))
        ) <= p_now
      )
    order by sale.sale_date, sale.id
    limit least(p_limit, 1)
  loop
$old_selection$;
  v_new_selection constant text := $new_selection$
  for sale_row in
    with retention_candidates as (
      select sale.id
        from public.auction_sales sale
       where sale.catalogue_expiry_materialized
         and sale.catalogue_expiry_deadline <= p_now
      union all
      select sale.id
        from public.auction_sales sale
       where (
               sale.status = 'postponed'
               or lower(coalesce(sale.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
             )
         and (
               sale.catalogue_expiry_materialized
               and sale.catalogue_expiry_deadline <= p_now
             ) is not true
         and app_private.sale_catalogue_expiry(
               sale.sale_date,
               (case
                 when jsonb_typeof(coalesce(sale.raw_payload, '{}'::jsonb)) = 'object'
                   then coalesce(sale.raw_payload, '{}'::jsonb)
                 else '{}'::jsonb
                end) || jsonb_build_object('sale_procedure', coalesce(sale.sale_procedure, '{}'::jsonb))
             ) <= p_now
    )
    select sale.*
      from public.auction_sales sale
      join retention_candidates candidate on candidate.id = sale.id
     order by sale.sale_date, sale.id
     limit least(p_limit, 1)
  loop
$new_selection$;
  v_old_remaining constant text := $old_remaining$
  select count(*)
    into remaining_count
    from public.auction_sales sale
   where (
        sale.catalogue_expiry_materialized
        and sale.catalogue_expiry_deadline <= p_now
      )
      or (
        (
          sale.status = 'postponed'
          or lower(coalesce(sale.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
        )
        and app_private.sale_catalogue_expiry(
          sale.sale_date,
          (case
            when jsonb_typeof(coalesce(sale.raw_payload, '{}'::jsonb)) = 'object'
              then coalesce(sale.raw_payload, '{}'::jsonb)
            else '{}'::jsonb
           end) || jsonb_build_object('sale_procedure', coalesce(sale.sale_procedure, '{}'::jsonb))
        ) <= p_now
      );
$old_remaining$;
  v_new_remaining constant text := $new_remaining$
  select (
    (
      select count(*)
        from public.auction_sales sale
       where sale.catalogue_expiry_materialized
         and sale.catalogue_expiry_deadline <= p_now
    )
    +
    (
      select count(*)
        from public.auction_sales sale
       where (
               sale.status = 'postponed'
               or lower(coalesce(sale.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
             )
         and (
               sale.catalogue_expiry_materialized
               and sale.catalogue_expiry_deadline <= p_now
             ) is not true
         and app_private.sale_catalogue_expiry(
               sale.sale_date,
               (case
                 when jsonb_typeof(coalesce(sale.raw_payload, '{}'::jsonb)) = 'object' then coalesce(sale.raw_payload, '{}'::jsonb)
                 else '{}'::jsonb
                end) || jsonb_build_object('sale_procedure', coalesce(sale.sale_procedure, '{}'::jsonb))
             ) <= p_now
    )
  )::integer
    into remaining_count;
$new_remaining$;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(
    'public.purge_expired_auction_sales(timestamptz,integer)'
  )::oid;

  if v_definition is null then
    raise exception using
      errcode = '42883',
      message = 'Missing public.purge_expired_auction_sales(timestamptz,integer).';
  end if;

  if position('with retention_candidates as (' in v_definition) = 0 then
    if (length(v_definition) - length(replace(v_definition, v_old_selection, '')))
         / length(v_old_selection) <> 1
       or (length(v_definition) - length(replace(v_definition, v_old_remaining, '')))
         / length(v_old_remaining) <> 1 then
      raise exception using
        errcode = '55000',
        message = 'Unexpected retention function definition; refusing the indexed fallback patch.';
    end if;

    v_definition := replace(v_definition, v_old_selection, v_new_selection);
    v_definition := replace(v_definition, v_old_remaining, v_new_remaining);
    execute v_definition;
  end if;
end;
$patch$;

notify pgrst, 'reload schema';

commit;
