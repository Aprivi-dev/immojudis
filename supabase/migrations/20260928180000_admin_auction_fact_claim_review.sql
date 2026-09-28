begin;

-- A claim is an observation until an administrator resolves it.  This
-- function deliberately does not rewrite auction_sales: accepting a claim is
-- only allowed when it still agrees with the current canonical value.  A
-- later, separately reviewed projection can then use accepted claims without
-- allowing a stale source snapshot to overwrite the catalogue.
create or replace function public.review_auction_fact_claim(
  p_reviewer_id uuid,
  p_claim_id uuid,
  p_decision text,
  p_resolution_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claim public.auction_fact_claims%rowtype;
  v_sale public.auction_sales%rowtype;
  v_canonical_match boolean := false;
  v_scalar text;
  v_conflict_group text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_decision not in ('accepted', 'rejected', 'conflicted') then
    raise exception using
      errcode = '22023',
      message = 'Fact claim decisions must be accepted, rejected or conflicted.';
  end if;

  if not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = p_reviewer_id
      and profile.user_role = 'admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator can resolve a fact claim.';
  end if;

  select claim.*
  into v_claim
  from public.auction_fact_claims claim
  where claim.id = p_claim_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Fact claim not found.';
  end if;

  if v_claim.claim_status <> 'candidate' then
    raise exception using
      errcode = '55000',
      message = 'Only an unresolved candidate can be reviewed.';
  end if;

  if p_decision in ('rejected', 'conflicted')
    and nullif(pg_catalog.btrim(p_resolution_note), '') is null then
    raise exception using
      errcode = '22023',
      message = 'A rejection or conflict requires a resolution reason.';
  end if;

  if v_claim.auction_sale_id is null then
    raise exception using
      errcode = '55000',
      message = 'A claim without a current sale target cannot be reviewed.';
  end if;

  select sale.*
  into v_sale
  from public.auction_sales sale
  where sale.id = v_claim.auction_sale_id
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'The claim sale no longer exists.';
  end if;

  if p_decision = 'accepted' then
    v_scalar := v_claim.value_jsonb #>> '{}';
    v_canonical_match := case v_claim.field_key
      when 'sale.sale_date' then
        jsonb_typeof(v_claim.value_jsonb) = 'string'
        and v_sale.sale_date is not null
        and pg_catalog.pg_input_is_valid(v_scalar, 'timestamptz')
        and v_scalar::timestamptz = v_sale.sale_date
      when 'sale.starting_price_eur' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.starting_price_eur is not null
        and v_scalar::numeric = v_sale.starting_price_eur
      when 'property.surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.surface_m2 is not null
        and v_scalar::numeric = v_sale.surface_m2
      when 'property.habitable_surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.habitable_surface_m2 is not null
        and v_scalar::numeric = v_sale.habitable_surface_m2
      when 'property.carrez_surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.carrez_surface_m2 is not null
        and v_scalar::numeric = v_sale.carrez_surface_m2
      when 'property.land_surface_m2' then
        jsonb_typeof(v_claim.value_jsonb) = 'number'
        and v_sale.land_surface_m2 is not null
        and v_scalar::numeric = v_sale.land_surface_m2
      when 'property.occupancy_status' then
        jsonb_typeof(v_claim.value_jsonb) = 'string'
        and v_sale.occupancy_status is not null
        and lower(pg_catalog.btrim(v_scalar)) = lower(pg_catalog.btrim(v_sale.occupancy_status))
      else false
    end;

    if not v_canonical_match then
      raise exception using
        errcode = '55000',
        message = 'The candidate no longer matches the current canonical sale field.';
    end if;
  end if;

  v_conflict_group := case
    when p_decision = 'conflicted' then coalesce(
      v_claim.conflict_group,
      pg_catalog.left(
        pg_catalog.format('sale:%s:%s', v_claim.auction_sale_id, v_claim.field_key),
        200
      )
    )
    else null
  end;

  update public.auction_fact_claims claim
  set claim_status = p_decision,
      conflict_group = v_conflict_group,
      resolution_actor_type = 'human',
      resolution_actor_id = p_reviewer_id,
      resolution_note = nullif(pg_catalog.btrim(p_resolution_note), ''),
      resolved_at = v_now
  where claim.id = p_claim_id
    and claim.claim_status = 'candidate';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'The fact claim was resolved concurrently.';
  end if;

  return pg_catalog.jsonb_build_object(
    'claim_id', p_claim_id,
    'claim_status', p_decision,
    'canonical_match', v_canonical_match,
    'resolved_at', v_now
  );
end;
$function$;

revoke all on function public.review_auction_fact_claim(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.review_auction_fact_claim(uuid, uuid, text, text)
to service_role;

comment on function public.review_auction_fact_claim(uuid, uuid, text, text) is
  'Atomically resolves one source-backed fact candidate after an admin decision; accepted values must still match auction_sales.';

notify pgrst, 'reload schema';

commit;
