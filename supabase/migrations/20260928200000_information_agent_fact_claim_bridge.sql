begin;

-- An accepted information-agent fact already updates auction_sales in the
-- administrator review RPC. Keep the two records coupled without copying that
-- large RPC again: the deferred constraint trigger runs after the RPC has
-- finished its canonical sale update, but before the surrounding transaction
-- can commit.
--
-- This is deliberately an accepted-claim bridge, not a publication shortcut.
-- Facts remain pending/conflict until the existing administrator review RPC
-- changes their status to accepted. If the canonical value is absent or no
-- longer equal to the reviewed response, the trigger aborts the transaction;
-- no accepted claim or partial sale update can be committed.

create or replace function app_private.bridge_accepted_information_agent_fact_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sale public.auction_sales%rowtype;
  v_field_key text;
  v_value_text text;
  v_value_numeric numeric;
  v_value_integer integer;
  v_value_date date;
  v_value_jsonb jsonb;
  v_existing_claim_id uuid;
begin
  if new.status <> 'accepted' or old.status = 'accepted' then
    return new;
  end if;

  -- Binary evidence and free-form visit/address suggestions are accepted by
  -- the existing workflow but do not have a comparable canonical scalar in
  -- auction_sales. They remain represented by the reviewed candidate and its
  -- evidence trail; they must not be mislabelled as a fiche fact claim.
  v_field_key := case new.fact_key
    when 'surface_m2' then 'property.surface_m2'
    when 'land_surface_m2' then 'property.land_surface_m2'
    when 'rooms_count' then 'property.rooms_count'
    when 'occupancy_status' then 'property.occupancy_status'
    when 'starting_price_eur' then 'sale.starting_price_eur'
    when 'sale_date' then 'sale.sale_date'
    when 'property_type' then 'property.property_type'
    else null
  end;
  if v_field_key is null then
    return new;
  end if;

  select sale.* into v_sale
  from public.auction_sales sale
  where sale.id = new.sale_id
  for update;

  if v_sale.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Cannot bridge an information-agent fact without its sale.';
  end if;

  if new.reviewed_by is null then
    raise exception using
      errcode = '42501',
      message = 'Accepted information-agent facts require a reviewer identity.';
  end if;

  if not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = new.reviewed_by
      and profile.user_role = 'admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'Accepted information-agent facts require an administrator reviewer.';
  end if;

  v_value_text := nullif(btrim(new.proposed_value->>'value'), '');
  if v_value_text is null then
    raise exception using
      errcode = '23514',
      message = 'Accepted information-agent facts require a scalar value.';
  end if;

  -- Recheck the post-review canonical value. The checks intentionally use
  -- IS DISTINCT FROM so that NULL never counts as an accepted match.
  if new.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000
      or v_sale.surface_m2 is distinct from v_value_numeric
      or v_sale.app_surface_m2 is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000
      or v_sale.land_surface_m2 is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent land surface does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100
      or v_sale.rooms_count is distinct from v_value_integer then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent room count does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_integer);
  elsif new.fact_key = 'occupancy_status' then
    if v_sale.occupancy_status is distinct from v_value_text then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent occupancy does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_text);
  elsif new.fact_key = 'starting_price_eur' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000000
      or v_sale.starting_price_eur is distinct from v_value_numeric then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent price does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_numeric);
  elsif new.fact_key = 'sale_date' then
    v_value_date := v_value_text::date;
    if v_sale.sale_date is null
      or v_sale.sale_date::date is distinct from v_value_date then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent sale date does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_sale.sale_date);
  elsif new.fact_key = 'property_type' then
    if v_sale.property_type is distinct from v_value_text then
      raise exception using
        errcode = '55000',
        message = 'Accepted information-agent property type does not match the canonical sale.';
    end if;
    v_value_jsonb := to_jsonb(v_value_text);
  end if;

  -- A retry or a duplicate status write must never create a second accepted
  -- observation for the same reviewed response.
  select claim.id into v_existing_claim_id
  from public.auction_fact_claims claim
  where claim.evidence_locator->>'information_agent_fact_id' = new.id::text
  limit 1;
  if v_existing_claim_id is not null then
    return new;
  end if;

  insert into public.auction_fact_claims (
    auction_sale_id,
    field_key,
    value_jsonb,
    claim_status,
    evidence_kind,
    evidence_locator,
    confidence_score,
    extractor_name,
    extractor_version,
    captured_at,
    created_by,
    resolution_actor_type,
    resolution_actor_id,
    resolution_note,
    resolved_at
  ) values (
    new.sale_id,
    v_field_key,
    v_value_jsonb,
    'accepted',
    case
      when new.evidence_asset_id is null then 'manual_review'
      when exists (
        select 1
        from public.information_agent_evidence_assets asset
        where asset.id = new.evidence_asset_id
          and asset.provider_attachment_id like 'portal:%'
      ) then 'portal_upload'
      else 'email_attachment'
    end,
    jsonb_build_object(
      'information_agent_fact_id', new.id,
      'case_id', new.case_id,
      'message_id', new.message_id,
      'evidence_asset_id', new.evidence_asset_id,
      'fact_key', new.fact_key,
      'source_page', new.source_page,
      'source_locator', left(new.source_locator, 300)
    ),
    greatest(least(new.confidence, 1), 0),
    'information_agent',
    coalesce(nullif(btrim(new.extraction_method), ''), 'reviewed_v1'),
    coalesce(new.created_at, statement_timestamp()),
    new.reviewed_by,
    'human',
    new.reviewed_by,
    coalesce(
      nullif(btrim(new.review_notes), ''),
      'Réponse reçue et validée par un administrateur.'
    ),
    coalesce(new.reviewed_at, statement_timestamp())
  );

  return new;
end;
$function$;

revoke all on function app_private.bridge_accepted_information_agent_fact_claim()
from public, anon, authenticated;

drop trigger if exists information_agent_fact_claim_bridge on public.information_agent_fact_candidates;

-- Deferral is what allows the existing review RPC to set the fact status first
-- and the canonical sale value immediately afterwards in the same transaction.
create constraint trigger information_agent_fact_claim_bridge
after update of status on public.information_agent_fact_candidates
deferrable initially deferred
for each row
execute function app_private.bridge_accepted_information_agent_fact_claim();

comment on function app_private.bridge_accepted_information_agent_fact_claim() is
  'Transactional bridge from reviewed information-agent facts to accepted, source-backed auction fact claims.';

notify pgrst, 'reload schema';

commit;
