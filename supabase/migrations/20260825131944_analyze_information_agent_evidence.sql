begin;

-- Version aligned with the migration recorded on the production project.

alter table public.information_agent_fact_candidates
  drop constraint if exists information_agent_fact_candidates_fact_key_check;
alter table public.information_agent_fact_candidates
  add constraint information_agent_fact_candidates_fact_key_check check (
    fact_key in (
      'surface_m2', 'land_surface_m2', 'rooms_count', 'occupancy_status',
      'visit_information', 'sale_date', 'starting_price_eur', 'energy_diagnostics',
      'property_type', 'address', 'document', 'photo'
    )
  );
alter table public.information_agent_fact_candidates
  add column evidence_asset_id uuid
    references public.information_agent_evidence_assets(id) on delete set null,
  add column source_page integer check (source_page is null or source_page between 1 and 1000),
  add column source_locator text check (
    source_locator is null or char_length(source_locator) between 1 and 300
  );

update public.information_agent_fact_candidates fact
set evidence_asset_id = asset.id
from public.information_agent_evidence_assets asset
where fact.fact_key in ('document', 'photo')
  and fact.evidence_asset_id is null
  and fact.proposed_value->>'value' = asset.id::text;

create index information_agent_fact_candidates_asset_idx
  on public.information_agent_fact_candidates (evidence_asset_id, status, created_at)
  where evidence_asset_id is not null;

create table public.information_agent_evidence_extractions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique
    references public.information_agent_evidence_assets(id) on delete cascade,
  case_id uuid not null references public.information_agent_cases(id) on delete cascade,
  message_id uuid not null references public.information_agent_messages(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'completed', 'needs_password', 'unsupported', 'failed')
  ),
  processor text not null default 'immojudis_document_worker',
  processor_version text not null default 'evidence_v1',
  detected_mime_type text,
  document_kind text,
  page_count integer check (page_count is null or page_count between 0 and 1000),
  is_encrypted boolean not null default false,
  summary text check (summary is null or char_length(summary) <= 4000),
  extracted_text text check (extracted_text is null or char_length(extracted_text) <= 250000),
  pages jsonb not null default '[]'::jsonb check (
    jsonb_typeof(pages) = 'array' and pg_column_size(pages) <= 262144
  ),
  extracted_facts jsonb not null default '[]'::jsonb check (
    jsonb_typeof(extracted_facts) = 'array' and pg_column_size(extracted_facts) <= 65536
  ),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  attempts integer not null default 0 check (attempts between 0 and 10),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 32768
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index information_agent_evidence_extractions_queue_idx
  on public.information_agent_evidence_extractions (status, available_at, created_at)
  where status in ('queued', 'processing', 'failed');
create index information_agent_evidence_extractions_case_idx
  on public.information_agent_evidence_extractions (case_id, created_at desc);

alter table public.information_agent_evidence_extractions enable row level security;
revoke all on table public.information_agent_evidence_extractions from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_evidence_extractions
to service_role;

create trigger information_agent_evidence_extractions_updated_at
before update on public.information_agent_evidence_extractions
for each row execute function app_private.set_user_profiles_updated_at();

create or replace function app_private.enqueue_information_agent_evidence_extraction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.information_agent_evidence_extractions (
    asset_id, case_id, message_id, sale_id
  ) values (
    new.id, new.case_id, new.message_id, new.sale_id
  )
  on conflict (asset_id) do nothing;
  return new;
end;
$$;

revoke all on function app_private.enqueue_information_agent_evidence_extraction()
from public, anon, authenticated;

create trigger information_agent_evidence_assets_enqueue_extraction
after insert on public.information_agent_evidence_assets
for each row execute function app_private.enqueue_information_agent_evidence_extraction();

insert into public.information_agent_evidence_extractions (
  asset_id, case_id, message_id, sale_id, created_at, updated_at
)
select asset.id, asset.case_id, asset.message_id, asset.sale_id, asset.created_at, asset.created_at
from public.information_agent_evidence_assets asset
on conflict (asset_id) do nothing;

create or replace function public.claim_information_agent_evidence_extractions(
  p_limit integer default 5
)
returns setof public.information_agent_evidence_extractions
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception using errcode = '22023', message = 'Evidence extraction limit must be between 1 and 10.';
  end if;

  return query
  with candidates as (
    select extraction.id
    from public.information_agent_evidence_extractions extraction
    where extraction.attempts < 3
      and extraction.available_at <= statement_timestamp()
      and (
        extraction.status in ('queued', 'failed')
        or (
          extraction.status = 'processing'
          and extraction.locked_at < statement_timestamp() - interval '45 minutes'
        )
      )
    order by extraction.created_at asc
    for update skip locked
    limit p_limit
  )
  update public.information_agent_evidence_extractions extraction
  set status = 'processing',
      attempts = extraction.attempts + 1,
      locked_at = statement_timestamp(),
      started_at = coalesce(extraction.started_at, statement_timestamp()),
      error_code = null,
      error_message = null,
      updated_at = statement_timestamp()
  from candidates
  where extraction.id = candidates.id
  returning extraction.*;
end;
$$;

revoke all on function public.claim_information_agent_evidence_extractions(integer)
from public, anon, authenticated;
grant execute on function public.claim_information_agent_evidence_extractions(integer)
to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'information-agent-approved',
  'information-agent-approved',
  true,
  20971520,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'image/heic', 'image/heif', 'text/plain'
  ]
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.stage_information_agent_evidence_publication(
  p_fact_id uuid,
  p_public_url text,
  p_public_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.information_agent_fact_candidates%rowtype;
  v_asset public.information_agent_evidence_assets%rowtype;
begin
  select * into v_fact
  from public.information_agent_fact_candidates fact
  where fact.id = p_fact_id
  for update;

  if v_fact.id is null or v_fact.fact_key not in ('document', 'photo') then
    raise exception using errcode = '22023', message = 'Publishable information-agent fact required.';
  end if;
  if v_fact.status not in ('pending', 'conflict') or v_fact.evidence_asset_id is null then
    raise exception using errcode = '55000', message = 'Evidence publication is not available.';
  end if;

  select * into v_asset
  from public.information_agent_evidence_assets asset
  where asset.id = v_fact.evidence_asset_id
  for update;

  if v_asset.id is null or v_asset.rights_status <> 'authorized' then
    raise exception using errcode = '55000', message = 'Attachment rights are not authorized.';
  end if;
  if p_public_url !~ '^https://[a-z0-9]+[.]supabase[.]co/storage/v1/object/public/information-agent-approved/' then
    raise exception using errcode = '22023', message = 'Invalid approved evidence URL.';
  end if;
  if p_public_path not like v_fact.sale_id::text || '/' || v_asset.id::text || '/%' then
    raise exception using errcode = '22023', message = 'Invalid approved evidence path.';
  end if;

  update public.information_agent_fact_candidates fact
  set proposed_value = fact.proposed_value || jsonb_build_object(
        'public_url', p_public_url,
        'public_path', p_public_path
      ),
      updated_at = statement_timestamp()
  where fact.id = v_fact.id;

  update public.information_agent_evidence_assets asset
  set metadata = asset.metadata || jsonb_build_object(
        'approved_public_url', p_public_url,
        'approved_public_path', p_public_path,
        'publication_staged_at', statement_timestamp()
      )
  where asset.id = v_asset.id;

  return jsonb_build_object(
    'fact_id', v_fact.id,
    'asset_id', v_asset.id,
    'public_url', p_public_url,
    'staged', true
  );
end;
$$;

revoke all on function public.stage_information_agent_evidence_publication(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.stage_information_agent_evidence_publication(uuid, text, text)
to service_role;

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
      md5('information-agent:' || v_fact.id::text || ':' || v_now::text)
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

comment on table public.information_agent_evidence_extractions is
  'Private, traceable PDF/image extraction queue. Results remain untrusted until fact review.';
comment on column public.information_agent_evidence_extractions.is_encrypted is
  'True when a PDF requires a password. The worker never attempts password guessing.';

notify pgrst, 'reload schema';

commit;
