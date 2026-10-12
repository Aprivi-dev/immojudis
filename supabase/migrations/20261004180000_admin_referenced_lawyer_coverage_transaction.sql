begin;

-- Keep the admin lawyer profile and its replacement coverage rows in the same
-- database transaction. This function is called only by the trusted server
-- client after the application has authenticated an ImmoJudis administrator.
create or replace function public.save_referenced_lawyer_with_coverage(
  p_lawyer_id uuid,
  p_lawyer jsonb,
  p_coverage jsonb
)
returns setof public.referenced_lawyers
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.referenced_lawyers;
  coverage_item jsonb;
begin
  if p_lawyer is null or pg_catalog.jsonb_typeof(p_lawyer) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Invalid referenced lawyer payload.';
  end if;

  if p_coverage is null
    or pg_catalog.jsonb_typeof(p_coverage) <> 'array'
    or pg_catalog.jsonb_array_length(p_coverage) > 30 then
    raise exception using
      errcode = '22023',
      message = 'Invalid referenced lawyer coverage payload.';
  end if;

  if nullif(pg_catalog.btrim(p_lawyer->>'display_name'), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Referenced lawyer display name is required.';
  end if;

  if p_lawyer->'practice_tags' is null
    or pg_catalog.jsonb_typeof(p_lawyer->'practice_tags') <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'Referenced lawyer practice tags must be an array.';
  end if;

  -- Validate every coverage item before changing either table. The table
  -- constraint remains the final guard, including for future callers.
  for coverage_item in
    select value
    from pg_catalog.jsonb_array_elements(p_coverage)
  loop
    if pg_catalog.jsonb_typeof(coverage_item) <> 'object' then
      raise exception using
        errcode = '22023',
        message = 'Referenced lawyer coverage items must be objects.';
    end if;

    if nullif(pg_catalog.btrim(coverage_item->>'tribunal_code'), '') is null
      and nullif(pg_catalog.btrim(coverage_item->>'department'), '') is null
      and nullif(pg_catalog.btrim(coverage_item->>'city'), '') is null
      and nullif(pg_catalog.btrim(coverage_item->>'postal_code_prefix'), '') is null then
      raise exception using
        errcode = '22023',
        message = 'Each referenced lawyer coverage item needs a location.';
    end if;
  end loop;

  if p_lawyer_id is null then
    insert into public.referenced_lawyers (
      status,
      paid_placement_status,
      display_name,
      firm_name,
      email,
      phone,
      website_url,
      bar_association,
      bar_number,
      city,
      department,
      address,
      profile_summary,
      practice_tags,
      accepts_judicial_auctions,
      accepts_remote_contact,
      priority_weight,
      paid_placement_starts_at,
      paid_placement_ends_at,
      created_by
    )
    values (
      coalesce(nullif(pg_catalog.btrim(p_lawyer->>'status'), ''), 'draft'),
      coalesce(nullif(pg_catalog.btrim(p_lawyer->>'paid_placement_status'), ''), 'not_started'),
      pg_catalog.btrim(p_lawyer->>'display_name'),
      nullif(pg_catalog.btrim(p_lawyer->>'firm_name'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'email'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'phone'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'website_url'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'bar_association'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'bar_number'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'city'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'department'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'address'), ''),
      nullif(pg_catalog.btrim(p_lawyer->>'profile_summary'), ''),
      coalesce(
        (
          select pg_catalog.array_agg(pg_catalog.btrim(tag))
          from pg_catalog.jsonb_array_elements_text(p_lawyer->'practice_tags') as tags(tag)
        ),
        array['adjudication']::text[]
      ),
      coalesce(nullif(p_lawyer->>'accepts_judicial_auctions', '')::boolean, true),
      coalesce(nullif(p_lawyer->>'accepts_remote_contact', '')::boolean, true),
      coalesce(nullif(p_lawyer->>'priority_weight', '')::integer, 0),
      nullif(pg_catalog.btrim(p_lawyer->>'paid_placement_starts_at'), '')::timestamptz,
      nullif(pg_catalog.btrim(p_lawyer->>'paid_placement_ends_at'), '')::timestamptz,
      nullif(pg_catalog.btrim(p_lawyer->>'created_by'), '')::uuid
    )
    returning * into saved;
  else
    update public.referenced_lawyers
    set
      status = coalesce(nullif(pg_catalog.btrim(p_lawyer->>'status'), ''), 'draft'),
      paid_placement_status = coalesce(nullif(pg_catalog.btrim(p_lawyer->>'paid_placement_status'), ''), 'not_started'),
      display_name = pg_catalog.btrim(p_lawyer->>'display_name'),
      firm_name = nullif(pg_catalog.btrim(p_lawyer->>'firm_name'), ''),
      email = nullif(pg_catalog.btrim(p_lawyer->>'email'), ''),
      phone = nullif(pg_catalog.btrim(p_lawyer->>'phone'), ''),
      website_url = nullif(pg_catalog.btrim(p_lawyer->>'website_url'), ''),
      bar_association = nullif(pg_catalog.btrim(p_lawyer->>'bar_association'), ''),
      bar_number = nullif(pg_catalog.btrim(p_lawyer->>'bar_number'), ''),
      city = nullif(pg_catalog.btrim(p_lawyer->>'city'), ''),
      department = nullif(pg_catalog.btrim(p_lawyer->>'department'), ''),
      address = nullif(pg_catalog.btrim(p_lawyer->>'address'), ''),
      profile_summary = nullif(pg_catalog.btrim(p_lawyer->>'profile_summary'), ''),
      practice_tags = coalesce(
        (
          select pg_catalog.array_agg(pg_catalog.btrim(tag))
          from pg_catalog.jsonb_array_elements_text(p_lawyer->'practice_tags') as tags(tag)
        ),
        array['adjudication']::text[]
      ),
      accepts_judicial_auctions = coalesce(nullif(p_lawyer->>'accepts_judicial_auctions', '')::boolean, true),
      accepts_remote_contact = coalesce(nullif(p_lawyer->>'accepts_remote_contact', '')::boolean, true),
      priority_weight = coalesce(nullif(p_lawyer->>'priority_weight', '')::integer, 0),
      paid_placement_starts_at = nullif(pg_catalog.btrim(p_lawyer->>'paid_placement_starts_at'), '')::timestamptz,
      paid_placement_ends_at = nullif(pg_catalog.btrim(p_lawyer->>'paid_placement_ends_at'), '')::timestamptz
    where id = p_lawyer_id
    returning * into saved;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'Referenced lawyer not found.';
    end if;
  end if;

  delete from public.referenced_lawyer_coverage
  where lawyer_id = saved.id;

  insert into public.referenced_lawyer_coverage (
    lawyer_id,
    tribunal_code,
    tribunal_name,
    city,
    department,
    postal_code_prefix
  )
  select
    saved.id,
    nullif(pg_catalog.btrim(item->>'tribunal_code'), ''),
    nullif(pg_catalog.btrim(item->>'tribunal_name'), ''),
    nullif(pg_catalog.btrim(item->>'city'), ''),
    nullif(pg_catalog.btrim(item->>'department'), ''),
    nullif(pg_catalog.btrim(item->>'postal_code_prefix'), '')
  from pg_catalog.jsonb_array_elements(p_coverage) as entries(item);

  return next saved;
  return;
end;
$$;

revoke all on function public.save_referenced_lawyer_with_coverage(uuid, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.save_referenced_lawyer_with_coverage(uuid, jsonb, jsonb)
to service_role;

notify pgrst, 'reload schema';

commit;
