begin;

-- Extend the reviewed AI import allowlist with the v4.2 artifact, whose three
-- added cases retain separate blind executions, prompts and outputs. The 73
-- inherited cases keep their existing, explicitly limited traceability.
-- The original v4 manifest remains accepted for compatibility;
-- v4.1 and every other digest remain rejected.  The import body is repeated
-- here because PostgreSQL has no supported way to patch one PL/pgSQL predicate
-- in place. Required metadata also explicitly rejects missing/NULL inputs;
-- all other guards and transaction logic are unchanged from
-- 20260929103000_ai_review_projection_guard.sql.  The metadata checks also
-- use NULL-safe comparisons so an absent key cannot pass the guard through
-- PL/pgSQL's three-valued IF semantics.
set local lock_timeout = '5s';

create or replace function app_private.import_ai_review_payload(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_schema_version text;
  v_manifest_sha256 text;
  v_sample_sha256 text;
  v_source_name text;
  v_source_url text;
  v_case_id text;
  v_access_state text;
  v_access_reason text;
  v_capture_sha256 text;
  v_field_key text;
  v_review_state text;
  v_citation_status text;
  v_block_reason text;
  v_mapping_status text;
  v_matches bigint;
  v_sale_id uuid;
  v_content_hash text;
  v_value jsonb;
  v_locator jsonb;
  v_inserted bigint;
  v_case_inserted integer := 0;
  v_case_unchanged integer := 0;
  v_projection_inserted integer := 0;
  v_projection_unchanged integer := 0;
  v_case_item jsonb;
  v_projection_item jsonb;
  v_existing_case public.auction_ai_review_case_status%rowtype;
  v_review_case public.auction_ai_review_case_status%rowtype;
  v_existing_projection public.auction_ai_review_projections%rowtype;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'format' is distinct from 'immojudis.ai-review-import.v1' then
    raise exception using
      errcode = '22023',
      message = 'Invalid AI review import payload format.';
  end if;
  v_schema_version := p_payload->>'schema_version';
  v_manifest_sha256 := p_payload->>'manifest_sha256';
  v_sample_sha256 := p_payload->>'sample_sha256';
  if v_schema_version is distinct from 'immojudis.real-extraction-review.v2'
    or v_manifest_sha256 is null
    or v_manifest_sha256 not in (
      'c2a8d1d245e738efc7549be148a59716aa32a4958aed4db996ea860a0427f6f1',
      '1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae'
    )
    or v_sample_sha256 is distinct from '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424'
    or jsonb_typeof(p_payload->'case_statuses') is distinct from 'array'
    or jsonb_typeof(p_payload->'projections') is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'Invalid AI review import payload metadata.';
  end if;

  for v_case_item in select value from jsonb_array_elements(p_payload->'case_statuses') loop
    v_source_name := v_case_item->>'source_name';
    v_source_url := v_case_item->>'source_url';
    v_case_id := v_case_item->>'case_id';
    v_access_state := v_case_item->>'access_state';
    v_access_reason := nullif(btrim(v_case_item->>'access_reason'), '');
    v_capture_sha256 := nullif(v_case_item->>'capture_sha256', '');
    if v_case_item->>'schema_version' is distinct from v_schema_version
      or v_case_item->>'sample_sha256' is distinct from v_sample_sha256
      or coalesce(v_case_item->>'mapping_status', '') <> 'server_exact_required'
      or v_source_name is null or char_length(v_source_name) < 2 or char_length(v_source_name) > 64
      or v_source_url is null or v_source_url !~ '^https://' or char_length(v_source_url) > 4096
      or v_case_id is null or char_length(v_case_id) < 1 or char_length(v_case_id) > 200
      or v_access_state not in ('captured', 'not_attempted', 'inaccessible', 'capture_failed')
      or (v_capture_sha256 is not null and v_capture_sha256 !~ '^[0-9a-f]{64}$')
      or coalesce(v_access_reason, '') ~* '(/private/|/tmp/|private_ref|capture_path)' then
      raise exception using
        errcode = '22023',
        message = 'Invalid or unsafe AI review case status payload.';
    end if;

    select count(*), min(sale.id::text)::uuid, min(sale.content_hash)
      into v_matches, v_sale_id, v_content_hash
    from public.auction_sales sale
    where sale.source_name = v_source_name
      and sale.source_url = v_source_url;
    v_mapping_status := case
      when v_matches = 1 then 'exact'
      when v_matches > 1 then 'ambiguous'
      else 'unmapped'
    end;

    if v_mapping_status <> 'exact' then
      v_sale_id := null;
      v_content_hash := null;
    end if;

    insert into public.auction_ai_review_case_status(
      schema_version, sample_sha256, case_id, source_name, source_url,
      access_state, access_reason, capture_sha256,
      canonical_content_hash_at_import, auction_sale_id, mapping_status
    ) values (
      v_schema_version, v_sample_sha256, v_case_id, v_source_name, v_source_url,
      v_access_state, v_access_reason, v_capture_sha256,
      v_content_hash, v_sale_id, v_mapping_status
    ) on conflict (sample_sha256, case_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_case_inserted := v_case_inserted + 1;
    else
      select * into v_existing_case
      from public.auction_ai_review_case_status existing
      where existing.sample_sha256 = v_sample_sha256
        and existing.case_id = v_case_id;
      if not found
        or v_existing_case.schema_version is distinct from v_schema_version
        or v_existing_case.source_name is distinct from v_source_name
        or v_existing_case.source_url is distinct from v_source_url
        or v_existing_case.access_state is distinct from v_access_state
        or v_existing_case.access_reason is distinct from v_access_reason
        or v_existing_case.capture_sha256 is distinct from v_capture_sha256
        or v_existing_case.canonical_content_hash_at_import is distinct from v_content_hash
        or v_existing_case.auction_sale_id is distinct from v_sale_id
        or v_existing_case.mapping_status is distinct from v_mapping_status then
        raise exception using
          errcode = '55000',
          message = 'Existing AI review case status conflicts with the offline payload.';
      end if;
      v_case_unchanged := v_case_unchanged + 1;
    end if;
  end loop;

  for v_projection_item in select value from jsonb_array_elements(p_payload->'projections') loop
    v_source_name := v_projection_item->>'source_name';
    v_source_url := v_projection_item->>'source_url';
    v_case_id := v_projection_item->>'case_id';
    v_capture_sha256 := v_projection_item->>'capture_sha256';
    v_field_key := v_projection_item->>'field_key';
    v_review_state := v_projection_item->>'review_state';
    v_citation_status := v_projection_item->>'citation_status';
    v_block_reason := nullif(btrim(v_projection_item->>'block_reason'), '');
    v_value := case
      when v_projection_item->'value_jsonb' is null
        or v_projection_item->'value_jsonb' = 'null'::jsonb then null
      else v_projection_item->'value_jsonb'
    end;
    v_locator := coalesce(v_projection_item->'evidence_locator', '{}'::jsonb);
    if v_projection_item->>'schema_version' is distinct from v_schema_version
      or v_projection_item->>'sample_sha256' is distinct from v_sample_sha256
      or coalesce(v_projection_item->>'mapping_status', '') <> 'server_exact_required'
      or v_source_name is null or char_length(v_source_name) < 2 or char_length(v_source_name) > 64
      or v_source_url is null or v_source_url !~ '^https://' or char_length(v_source_url) > 4096
      or v_case_id is null or char_length(v_case_id) < 1 or char_length(v_case_id) > 200
      or v_capture_sha256 !~ '^[0-9a-f]{64}$'
      or v_field_key is null
      or v_field_key not in (
        'property.property_type', 'property.city', 'sale.sale_date',
        'sale.starting_price_eur', 'property.habitable_surface_m2',
        'property.carrez_surface_m2', 'property.land_surface_m2',
        'property.occupancy_status', 'property.rooms_count',
        'property.parking_count', 'property.source_energy_dpe_class',
        'property.source_energy_ges_class'
      )
      or v_review_state not in ('resolved', 'unknown', 'absent', 'unresolved', 'unverified')
      or v_citation_status not in ('verified', 'unverified', 'not_required')
      or jsonb_typeof(v_locator) <> 'object'
      or v_locator::text ~* '(/private/|/tmp/|private_ref|capture_path|excerpt)' then
      raise exception using
        errcode = '22023',
        message = 'Invalid or unsafe AI review projection payload.';
    end if;
    if (v_review_state = 'resolved' and (v_citation_status <> 'verified' or v_value is null))
      or (v_review_state <> 'resolved' and v_value is not null) then
      raise exception using
        errcode = '23514',
        message = 'AI review projection value does not match its review state.';
    end if;
    if v_review_state in ('unresolved', 'unverified') and v_block_reason is null then
      raise exception using
        errcode = '23514',
        message = 'Blocked AI review projection rows require a reason.';
    end if;

    select count(*), min(sale.id::text)::uuid, min(sale.content_hash)
      into v_matches, v_sale_id, v_content_hash
    from public.auction_sales sale
    where sale.source_name = v_source_name
      and sale.source_url = v_source_url;
    v_mapping_status := case
      when v_matches = 1 then 'exact'
      when v_matches > 1 then 'ambiguous'
      else 'unmapped'
    end;

    if v_mapping_status <> 'exact' then
      v_sale_id := null;
      v_content_hash := null;
    end if;

    select * into v_review_case
    from public.auction_ai_review_case_status case_status
    where case_status.sample_sha256 = v_sample_sha256
      and case_status.case_id = v_case_id;
    if not found
      or v_review_case.access_state is distinct from 'captured'
      or v_review_case.schema_version is distinct from v_schema_version
      or v_review_case.source_name is distinct from v_source_name
      or v_review_case.source_url is distinct from v_source_url
      or v_review_case.capture_sha256 is distinct from v_capture_sha256
      or v_review_case.mapping_status is distinct from v_mapping_status
      or v_review_case.auction_sale_id is distinct from v_sale_id
      or v_review_case.canonical_content_hash_at_import is distinct from v_content_hash then
      raise exception using
        errcode = '55000',
        message = 'AI review projection must match one captured exact case status and live sale mapping.';
    end if;

    if v_mapping_status <> 'exact' then
      v_sale_id := null;
      if v_review_state = 'resolved' then
        v_review_state := 'unresolved';
        v_citation_status := 'not_required';
        v_value := null;
        v_block_reason := concat_ws('; ', v_block_reason, 'exact database source identity match required');
      end if;
    end if;

    if v_review_state = 'resolved'
      and not app_private.ai_review_value_is_bounded(v_field_key, v_value) then
      raise exception using
        errcode = '23514',
        message = 'AI review projection value is outside the bounded field contract.';
    end if;

    insert into public.auction_ai_review_projections(
      schema_version, sample_sha256, case_id, source_name, source_url,
      capture_sha256, canonical_content_hash_at_import, auction_sale_id,
      mapping_status, field_key, review_state,
      citation_status, value_jsonb, evidence_locator, block_reason
    ) values (
      v_schema_version, v_sample_sha256, v_case_id, v_source_name, v_source_url,
      v_capture_sha256, v_content_hash, v_sale_id, v_mapping_status, v_field_key,
      v_review_state,
      v_citation_status, v_value, v_locator, v_block_reason
    ) on conflict (sample_sha256, case_id, field_key) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_projection_inserted := v_projection_inserted + 1;
    else
      select * into v_existing_projection
      from public.auction_ai_review_projections existing
      where existing.sample_sha256 = v_sample_sha256
        and existing.case_id = v_case_id
        and existing.field_key = v_field_key;
      if not found
        or v_existing_projection.schema_version is distinct from v_schema_version
        or v_existing_projection.source_name is distinct from v_source_name
        or v_existing_projection.source_url is distinct from v_source_url
        or v_existing_projection.capture_sha256 is distinct from v_capture_sha256
        or v_existing_projection.canonical_content_hash_at_import is distinct from v_content_hash
        or v_existing_projection.auction_sale_id is distinct from v_sale_id
        or v_existing_projection.mapping_status is distinct from v_mapping_status
        or v_existing_projection.review_state is distinct from v_review_state
        or v_existing_projection.citation_status is distinct from v_citation_status
        or v_existing_projection.value_jsonb is distinct from v_value
        or v_existing_projection.evidence_locator is distinct from v_locator
        or v_existing_projection.block_reason is distinct from v_block_reason then
        raise exception using
          errcode = '55000',
          message = 'Existing AI review projection conflicts with the offline payload.';
      end if;
      v_projection_unchanged := v_projection_unchanged + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'sample_sha256', v_sample_sha256,
    'case_status_inserted', v_case_inserted,
    'case_status_unchanged', v_case_unchanged,
    'projection_inserted', v_projection_inserted,
    'projection_unchanged', v_projection_unchanged
  );
end;
$function$;

commit;
