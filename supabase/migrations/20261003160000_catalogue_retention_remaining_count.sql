-- Keep the purge response honest after the catalogue-retention migration.
--
-- The first migration correctly changed the destructive eligibility predicate,
-- but its final `remaining` count still used the historical
-- retention_deadline column.  That made a one-row purge report zero remaining
-- rows whenever the old +24-hour deadline had not elapsed yet.  Patch the
-- already-installed function by replacing only that final count predicate.
do $migration$
declare
  v_definition text;
  v_remaining_tail text;
  v_old constant text := $old$
  select count(*)
    into remaining_count
    from public.auction_sales sale
   where sale.retention_deadline_materialized
     and sale.retention_deadline <= p_now;$old$;
  v_new constant text := $new$
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
      );$new$;
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

  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  else
    v_remaining_tail := substring(
      v_definition
      from nullif(position('into remaining_count' in v_definition), 0)
    );
    if position('catalogue_expiry_materialized' in coalesce(v_remaining_tail, '')) > 0
       and position('retention_deadline_materialized' in coalesce(v_remaining_tail, '')) = 0 then
      return;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'Unexpected retention function definition; remaining count was not corrected.';
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
