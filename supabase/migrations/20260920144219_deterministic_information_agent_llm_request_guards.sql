begin;

create index if not exists llm_usage_events_failed_request_key_idx
  on public.llm_usage_events(request_key, created_at desc)
  where request_key is not null and request_status = 'failed';

-- Keep the enrichment job identity tied to the accepted evidence state.  The
-- review timestamp remains useful audit data, but it must not make a retry
-- look like a new paid display-description request.
create or replace function public.review_information_agent_fact_candidate(
  p_reviewer_id uuid,
  p_fact_id uuid,
  p_decision text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
  v_source_url text;
  v_value_text text;
  v_value_numeric numeric;
  v_value_integer integer;
  v_value_date date;
  v_public_url text;
  v_source_images jsonb;
  v_document_kind text;
  v_now timestamptz := statement_timestamp();
  v_valuation_queued boolean := false;
begin
  if p_decision not in ('accepted', 'rejected') then
    raise exception using errcode = '22023', message = 'Invalid fact review decision.';
  end if;
  if not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = p_reviewer_id and profile.user_role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Administrator review is required.';
  end if;

  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;

  if v_fact.id is null then
    raise exception using errcode = 'P0002', message = 'Information agent fact not found.';
  end if;
  if v_fact.status not in ('pending', 'conflict') then
    raise exception using errcode = '55000', message = 'Information agent fact was already reviewed.';
  end if;
  if p_decision = 'accepted'
    and v_fact.fact_key in ('document', 'photo')
    and not exists (
      select 1 from public.information_agent_evidence_assets asset
      where asset.id = v_fact.evidence_asset_id and asset.rights_status = 'authorized'
    )
  then
    raise exception using errcode = '55000',
      message = 'Attachment rights must be authorized before publication acceptance.';
  end if;
  if p_decision = 'accepted' and v_fact.fact_key in ('document', 'photo') then
    v_public_url := nullif(btrim(v_fact.proposed_value->>'public_url'), '');
    if v_public_url is null
      or v_public_url !~ '^https://[a-z0-9]+[.]supabase[.]co/storage/v1/object/public/information-agent-approved/'
    then
      raise exception using errcode = '55000',
        message = 'Attachment publication must be staged before acceptance.';
    end if;
  end if;

  update public.information_agent_fact_candidates fact
  set status = p_decision, reviewed_by = p_reviewer_id, reviewed_at = v_now,
      review_notes = nullif(btrim(p_notes), ''), updated_at = v_now
  where fact.id = p_fact_id;

  if v_fact.evidence_asset_id is not null and v_fact.fact_key in ('document', 'photo') then
    update public.information_agent_evidence_assets asset
    set review_status = case when p_decision = 'accepted' then 'accepted' else 'rejected' end
    where asset.id = v_fact.evidence_asset_id;
  end if;

  if p_decision = 'rejected' then
    return jsonb_build_object('fact_id', p_fact_id, 'status', 'rejected');
  end if;

  select sale.source_url into v_source_url
  from public.auction_sales sale where sale.id = v_fact.sale_id
  for update;
  v_value_text := nullif(btrim(v_fact.proposed_value->>'value'), '');

  if v_fact.fact_key = 'surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted surface.';
    end if;
    update public.auction_sales sale set
      surface_m2 = v_value_numeric,
      app_surface_m2 = v_value_numeric,
      app_surface_kind = 'information_agent_verified',
      surface_source = 'information_agent_verified',
      surface_confidence = greatest(v_fact.confidence, 0.85),
      surface_evidence = left(coalesce(v_fact.evidence_excerpt, v_fact.display_value), 2000),
      updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'land_surface_m2' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 100000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted land surface.';
    end if;
    update public.auction_sales sale set land_surface_m2 = v_value_numeric, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'rooms_count' then
    v_value_integer := v_value_text::integer;
    if v_value_integer < 1 or v_value_integer > 100 then
      raise exception using errcode = '22023', message = 'Invalid accepted room count.';
    end if;
    update public.auction_sales sale set rooms_count = v_value_integer, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'occupancy_status' then
    if v_value_text not in ('vacant', 'occupied', 'rented', 'owner_occupied', 'squatted', 'unknown') then
      raise exception using errcode = '22023', message = 'Invalid accepted occupancy status.';
    end if;
    update public.auction_sales sale set occupancy_status = v_value_text, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'starting_price_eur' then
    v_value_numeric := v_value_text::numeric;
    if v_value_numeric <= 0 or v_value_numeric > 1000000000 then
      raise exception using errcode = '22023', message = 'Invalid accepted starting price.';
    end if;
    update public.auction_sales sale set starting_price_eur = v_value_numeric, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'sale_date' then
    v_value_date := v_value_text::date;
    update public.auction_sales sale set sale_date = v_value_date, updated_at = v_now
    where sale.id = v_fact.sale_id;
  elsif v_fact.fact_key = 'property_type' then
    if v_value_text not in ('house', 'apartment', 'building', 'commercial', 'mixed', 'land', 'parking', 'other') then
      raise exception using errcode = '22023', message = 'Invalid accepted property type.';
    end if;
    update public.auction_sales sale set property_type = v_value_text, updated_at = v_now
    where sale.id = v_fact.sale_id;
    v_valuation_queued := true;
  elsif v_fact.fact_key = 'photo' then
    select case
      when jsonb_typeof(sale.raw_payload->'source_images') = 'array'
        then sale.raw_payload->'source_images'
      else '[]'::jsonb
    end into v_source_images
    from public.auction_sales sale
    where sale.id = v_fact.sale_id;
    if not v_source_images @> jsonb_build_array(v_public_url) then
      v_source_images := v_source_images || jsonb_build_array(v_public_url);
    end if;
    update public.auction_sales sale
    set raw_payload = jsonb_set(
          coalesce(sale.raw_payload, '{}'::jsonb),
          '{source_images}',
          v_source_images,
          true
        ),
        updated_at = v_now
    where sale.id = v_fact.sale_id;
  elsif v_fact.fact_key = 'document' then
    select extraction.document_kind into v_document_kind
    from public.information_agent_evidence_extractions extraction
    where extraction.asset_id = v_fact.evidence_asset_id;
    insert into public.auction_documents (
      source_url, document_url, label, document_type, file_path, sha256,
      download_status, extraction_status, raw_payload, updated_at
    )
    select
      sale.source_url,
      v_public_url,
      asset.original_filename,
      coalesce(v_document_kind, 'information_agent_document'),
      v_fact.proposed_value->>'public_path',
      asset.sha256,
      'stored',
      'completed',
      jsonb_build_object(
        'source', 'information_agent',
        'fact_id', v_fact.id,
        'evidence_asset_id', asset.id,
        'reviewed_at', v_now
      ),
      v_now
    from public.auction_sales sale
    join public.information_agent_evidence_assets asset on asset.id = v_fact.evidence_asset_id
    where sale.id = v_fact.sale_id
    on conflict (document_url) do update set
      label = excluded.label,
      document_type = excluded.document_type,
      file_path = excluded.file_path,
      sha256 = excluded.sha256,
      download_status = excluded.download_status,
      extraction_status = excluded.extraction_status,
      raw_payload = excluded.raw_payload,
      updated_at = excluded.updated_at;
  end if;

  update public.auction_sales sale
  set raw_payload = (
        (coalesce(sale.raw_payload, '{}'::jsonb)
          - 'llm_display_description'
          - 'llm_display_description_word_count'
          - 'llm_prompt_version')
        || jsonb_build_object(
          'information_agent_verified_facts',
          coalesce(sale.raw_payload->'information_agent_verified_facts', '{}'::jsonb)
            || jsonb_build_object(
              v_fact.fact_key,
              jsonb_build_object(
                'value', v_fact.proposed_value,
                'display_value', v_fact.display_value,
                'fact_id', v_fact.id,
                'evidence_asset_id', v_fact.evidence_asset_id,
                'source_page', v_fact.source_page,
                'reviewed_at', v_now,
                'source', 'professional_email'
              )
            )
        )
      ),
      updated_at = v_now
  where sale.id = v_fact.sale_id;

  if v_source_url is not null then
    insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
    values (
      v_source_url, 'display_description', 90,
      md5(
        jsonb_build_object(
          'fingerprint_version', 1,
          'source', 'information-agent',
          'fact_id', v_fact.id,
          'case_id', v_fact.case_id,
          'message_id', v_fact.message_id,
          'sale_id', v_fact.sale_id,
          'fact_key', v_fact.fact_key,
          'proposed_value', v_fact.proposed_value,
          'display_value', v_fact.display_value,
          'evidence_excerpt', v_fact.evidence_excerpt,
          'evidence_asset_id', v_fact.evidence_asset_id,
          'source_page', v_fact.source_page,
          'source_locator', v_fact.source_locator,
          'confidence', v_fact.confidence,
          'extraction_method', v_fact.extraction_method,
          'metadata', v_fact.metadata
        )::text
      )
    )
    on conflict (source_url, job_type, input_hash) do nothing;
  end if;

  if v_valuation_queued then
    perform public.enqueue_auction_sale_market_estimate(
      p_auction_sale_id => v_fact.sale_id,
      p_priority => 90,
      p_reason => 'information_agent_verified_fact',
      p_now => v_now
    );
  end if;

  return jsonb_build_object(
    'fact_id', p_fact_id,
    'status', 'accepted',
    'sale_id', v_fact.sale_id,
    'valuation_queued', v_valuation_queued,
    'description_queued', v_source_url is not null
  );
end;
$$;

revoke all on function public.review_information_agent_fact_candidate(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.review_information_agent_fact_candidate(uuid, uuid, text, text)
to service_role;

-- A terminal model-format failure is safe to suppress for a bounded period:
-- the local parser/repair path has already run, and the exact request key
-- proves that evidence, prompt and model are unchanged.  Provider failures,
-- rate limits and ambiguous transport outcomes remain retryable/reconcilable.
create or replace function public.reserve_llm_request(
  p_provider text,
  p_model text,
  p_request_kind text,
  p_attempt_number integer default 1,
  p_max_calls_per_hour integer default 0,
  p_request_key text default null,
  p_sale_id text default null,
  p_job_id text default null,
  p_source_url text default null,
  p_stage text default null,
  p_reason text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_id uuid;
  request_count integer;
begin
  if nullif(btrim(p_provider), '') is null then
    raise exception 'LLM request provider is required';
  end if;
  if nullif(btrim(p_model), '') is null then
    raise exception 'LLM request model is required';
  end if;
  if nullif(btrim(p_request_kind), '') is null then
    raise exception 'LLM request kind is required';
  end if;
  if coalesce(p_max_calls_per_hour, 0) < 0 then
    raise exception 'LLM request hourly budget cannot be negative';
  end if;

  -- The lock makes the rolling-window count and insert one atomic operation
  -- across manual, queued and autonomous execution modes.
  perform pg_advisory_xact_lock(
    hashtextextended('immojudis:llm-request-budget:v1:' || p_provider, 0)
  );

  if nullif(btrim(p_request_key), '') is not null
     and exists (
       select 1
         from public.llm_usage_events
        where request_key = btrim(p_request_key)
          and request_status in ('reserved', 'ambiguous')
          and created_at >= now() - interval '30 minutes'
     ) then
    raise exception 'Unresolved LLM request key requires provider reconciliation before retry'
      using errcode = 'P0001';
  end if;

  if nullif(btrim(p_request_key), '') is not null
     and exists (
       select 1
         from public.llm_usage_events
        where request_key = btrim(p_request_key)
          and request_status = 'failed'
          and succeeded = false
          and created_at >= now() - interval '24 hours'
          and error_message is not null
          and error_message ~* '(replicate[[:space:]_-]+returned[[:space:]_-]+invalid[[:space:]_-]*json|invalid[[:space:]_-]*json[[:space:]]+from[[:space:]]+llm|validation[[:space:]]+errors?[[:space:]]+for[[:space:]]+llmextraction|structured[[:space:]_-]+validation)'
     ) then
    raise exception
      'Unresolved deterministic LLM request key is blocked for 24 hours after invalid JSON or structured validation failure; change evidence, prompt, or model before retry'
      using errcode = 'P0001';
  end if;

  if coalesce(p_max_calls_per_hour, 0) > 0 then
    select count(*)
      into request_count
      from public.llm_usage_events
     where provider = p_provider
       and created_at >= now() - interval '1 hour'
       and request_status <> 'released';

    if request_count >= p_max_calls_per_hour then
      raise exception 'Hourly LLM request budget exhausted'
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.llm_usage_events (
    provider,
    model,
    request_kind,
    attempt_number,
    request_key,
    request_status,
    succeeded,
    sale_id,
    job_id,
    source_url,
    stage,
    reason
  ) values (
    p_provider,
    p_model,
    p_request_kind,
    greatest(1, coalesce(p_attempt_number, 1)),
    nullif(btrim(p_request_key), ''),
    'reserved',
    false,
    nullif(btrim(p_sale_id), ''),
    nullif(btrim(p_job_id), ''),
    nullif(btrim(p_source_url), ''),
    nullif(btrim(p_stage), ''),
    nullif(btrim(p_reason), '')
  )
  returning id into request_id;

  return request_id;
end;
$$;

revoke all on function public.reserve_llm_request(text, text, text, integer, integer, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_llm_request(text, text, text, integer, integer, text, text, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
