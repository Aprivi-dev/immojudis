begin;

-- This migration adds guards to hot catalogue tables.  Never wait behind a
-- long-running production upsert; the release gate can retry after the lock
-- holder completes.
set local lock_timeout = '5s';

-- Private projection guard for the frozen, AI-only extraction review.
--
-- The review manifest has a public source URL but no durable auction_sales.id.
-- This table keeps the mapping decision explicit and fail-closed.  A row is
-- publishable only when one exact source_name/source_url match was observed,
-- the final AI label is resolved, and every citation for that field was found
-- in the frozen capture.  Unmapped, ambiguous, unresolved and unverified
-- rows remain service-role-readable quarantine records.  This migration does not
-- import the private manifest or mutate existing sales; the reviewed importer
-- must insert the projection rows before the publication guard can quarantine
-- a matching canonical sale.  The case-status table below also records the
-- 27 sample cases that were not captured; no synthetic capture digest or
-- evidence is created for those rows.
create table public.auction_ai_review_case_status (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null check (
    schema_version = 'immojudis.real-extraction-review.v2'
  ),
  sample_sha256 text not null check (sample_sha256 ~ '^[0-9a-f]{64}$'),
  case_id text not null check (char_length(nullif(btrim(case_id), '')) between 1 and 200),
  source_name text not null check (char_length(nullif(btrim(source_name), '')) between 2 and 64),
  source_url text not null check (
    char_length(source_url) between 1 and 4096
    and source_url ~ '^https://'
  ),
  access_state text not null check (
    access_state in ('captured', 'not_attempted', 'inaccessible', 'capture_failed')
  ),
  access_reason text,
  capture_sha256 text check (capture_sha256 is null or capture_sha256 ~ '^[0-9a-f]{64}$'),
  -- This is the canonical auction_sales content hash at import time.  It is
  -- deliberately distinct from the frozen capture SHA above.
  canonical_content_hash_at_import text check (
    canonical_content_hash_at_import is null
    or canonical_content_hash_at_import ~ '^[0-9a-f]{64}$'
  ),
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  mapping_status text not null check (mapping_status in ('exact', 'unmapped', 'ambiguous')),
  created_at timestamptz not null default now(),
  constraint auction_ai_review_case_status_unique_case
    unique (sample_sha256, case_id),
  constraint auction_ai_review_case_status_capture_state check (
    (access_state = 'captured' and capture_sha256 is not null)
    or (access_state <> 'captured' and capture_sha256 is null)
  ),
  constraint auction_ai_review_case_status_mapping_state check (
    mapping_status = 'exact' or auction_sale_id is null
  )
);

create index auction_ai_review_case_status_sale_idx
  on public.auction_ai_review_case_status(auction_sale_id, access_state)
  where auction_sale_id is not null;

create index auction_ai_review_case_status_blocked_idx
  on public.auction_ai_review_case_status(sample_sha256, access_state, mapping_status)
  where access_state <> 'captured' or mapping_status <> 'exact';

create or replace function app_private.validate_ai_review_case_mapping()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  sale_source_name text;
  sale_source_url text;
begin
  -- The FK may detach an exact historical mapping when its canonical sale is
  -- retained away.  Keep the audit row, but never allow a caller to create a
  -- new exact mapping without a live sale target.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
    and old.auction_sale_id is not null and new.auction_sale_id is null then
    return new;
  end if;
  if new.mapping_status = 'exact' then
    if new.auction_sale_id is null then
      raise exception using
        errcode = '23514',
        message = 'An exact AI review case mapping requires an auction sale target.';
    end if;
    select sale.source_name, sale.source_url
      into sale_source_name, sale_source_url
    from public.auction_sales sale
    where sale.id = new.auction_sale_id;
    if sale_source_name is null
      or sale_source_name is distinct from new.source_name
      or sale_source_url is distinct from new.source_url then
      raise exception using
        errcode = '55000',
        message = 'AI review case mapping must match one exact source name and URL.';
    end if;
  end if;
  return new;
end;
$function$;

-- Canonical comparison is deliberately kept in PostgreSQL, next to the
-- publication gate.  The offline reviewer may propose a value, but only the
-- current canonical row can decide whether that proposal is usable.  These
-- normalizers are intentionally conservative: they remove presentation
-- differences (case, accents, repeated whitespace) without translating
-- business vocabularies such as "house" and "maison".
create or replace function app_private.ai_review_normalize_text(p_text text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select nullif(
    pg_catalog.regexp_replace(
      extensions.unaccent(pg_catalog.lower(pg_catalog.btrim(p_text))),
      '[[:space:]]+',
      ' ',
      'g'
    ),
    ''
  );
$function$;

create or replace function app_private.ai_review_normalize_occupancy(p_text text)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $function$
declare
  normalized text;
begin
  normalized := pg_catalog.replace(app_private.ai_review_normalize_text(p_text), '_', ' ');
  return case normalized
    when 'libre' then 'vacant'
    when 'libre de toute occupation' then 'vacant'
    when 'vacant' then 'vacant'
    when 'occupe' then 'occupied'
    when 'occupied' then 'occupied'
    when 'proprietaire occupant' then 'owner_occupied'
    when 'proprietaire occupe' then 'owner_occupied'
    when 'owner occupied' then 'owner_occupied'
    when 'locataire' then 'rented'
    when 'loue' then 'rented'
    when 'rented' then 'rented'
    when 'squat' then 'squatted'
    when 'squatte' then 'squatted'
    when 'squatted' then 'squatted'
    when 'unknown' then 'unknown'
    else null
  end;
end;
$function$;

-- Compare one AI field with the live canonical sale.  The function returns a
-- status even when no usable canonical value exists, so callers cannot turn a
-- null comparison into an implicit match.  Energy diagnostics are sourced
-- from both the listing and extracted PDF when available; an invalid value or
-- disagreement between those sources is explicitly unsupported.
create or replace function app_private.ai_review_compare_field(
  p_field_key text,
  p_value jsonb,
  p_sale_id uuid
)
returns table(
  comparison_status text,
  canonical_value_jsonb jsonb,
  normalized_ai_value text,
  normalized_canonical_value text,
  comparison_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  sale_row public.auction_sales%rowtype;
  value_kind text;
  canonical_text text;
  canonical_num numeric;
  canonical_date text;
  ai_text text;
  ai_num numeric;
  ai_date date;
  energy_values text[];
  energy_candidate_count bigint;
  energy_invalid_present boolean := false;
  energy_conflict boolean := false;
  canonical_occupancy text;
  canonical_raw_occupancy text;
  ai_occupancy text;
  canonical_unsupported boolean := false;
  ai_unsupported boolean := false;
begin
  comparison_status := 'not_publishable';
  canonical_value_jsonb := null;
  normalized_ai_value := null;
  normalized_canonical_value := null;
  comparison_reason := null;

  if p_sale_id is null then
    comparison_reason := 'canonical sale identity is missing';
    return next;
    return;
  end if;

  select sale.* into sale_row
  from public.auction_sales sale
  where sale.id = p_sale_id;
  if not found then
    comparison_reason := 'canonical sale row is missing';
    return next;
    return;
  end if;

  case p_field_key
    when 'property.property_type' then
      value_kind := 'text';
      canonical_text := nullif(pg_catalog.btrim(sale_row.property_type), '');
    when 'property.city' then
      value_kind := 'text';
      canonical_text := nullif(pg_catalog.btrim(sale_row.city), '');
    when 'sale.sale_date' then
      value_kind := 'date';
      if sale_row.sale_date is not null then
        canonical_date := (
          (sale_row.sale_date at time zone 'Europe/Paris')::date
        )::text;
      end if;
    when 'sale.starting_price_eur' then
      value_kind := 'numeric';
      canonical_num := sale_row.starting_price_eur;
    when 'property.habitable_surface_m2' then
      value_kind := 'numeric';
      canonical_num := sale_row.habitable_surface_m2;
    when 'property.carrez_surface_m2' then
      value_kind := 'numeric';
      canonical_num := sale_row.carrez_surface_m2;
    when 'property.land_surface_m2' then
      value_kind := 'numeric';
      canonical_num := sale_row.land_surface_m2;
    when 'property.occupancy_status' then
      value_kind := 'occupancy';
      canonical_raw_occupancy := nullif(pg_catalog.btrim(sale_row.occupancy_status), '');
      canonical_occupancy := app_private.ai_review_normalize_occupancy(canonical_raw_occupancy);
      if canonical_raw_occupancy is not null and canonical_occupancy is null then
        canonical_unsupported := true;
      elsif canonical_occupancy = 'unknown' then
        canonical_occupancy := null;
      end if;
    when 'property.rooms_count' then
      value_kind := 'numeric';
      canonical_num := sale_row.rooms_count;
    when 'property.parking_count' then
      value_kind := 'numeric';
      canonical_num := sale_row.parking_count;
    when 'property.source_energy_dpe_class', 'property.source_energy_ges_class' then
      value_kind := 'energy';
      -- The canonical catalogue exposes source blocks and extracted document
      -- blocks through raw_payload.  Walk the nested object/array tree so the
      -- comparison follows the same evidence that the fiche uses.  One class
      -- repeated by several sources is fine; an invalid value, an empty value,
      -- or two different classes is deliberately unsupported.
      with recursive json_nodes(value) as (
        select coalesce(sale_row.raw_payload, '{}'::jsonb)
        union all
        select child.value
        from json_nodes node
        cross join lateral (
          select object_child.value
          from jsonb_each(
            case when jsonb_typeof(node.value) = 'object'
              then node.value else '{}'::jsonb end
          ) object_child
          union all
          select array_child.value
          from jsonb_array_elements(
            case when jsonb_typeof(node.value) = 'array'
              then node.value else '[]'::jsonb end
          ) array_child
        ) child
      ), energy_entries as (
        select lower(entry.key) as key, entry.value
        from json_nodes node
        cross join lateral jsonb_each(
          case when jsonb_typeof(node.value) = 'object'
            then node.value else '{}'::jsonb end
        ) entry
        where lower(entry.key) = any (
          case when p_field_key = 'property.source_energy_dpe_class' then
            array[
              'dpe_classe', 'dpe_class', 'dpe', 'diagnostic_dpe',
              'classe_energie', 'energy_dpe_class', 'source_energy_dpe_class'
            ]::text[]
          else
            array[
              'ges_classe', 'ges_class', 'ges', 'diagnostic_ges',
              'classe_ges', 'energy_ges_class', 'source_energy_ges_class'
            ]::text[]
          end
        )
      )
      select
        coalesce(
          array_agg(nullif(pg_catalog.btrim(entry.value #>> '{}'), ''))
            filter (where jsonb_typeof(entry.value) in ('string', 'number')),
          '{}'::text[]
        ),
        count(*) filter (
          where jsonb_typeof(entry.value) in ('string', 'number')
            and nullif(pg_catalog.btrim(entry.value #>> '{}'), '') is not null
        ),
        coalesce(bool_or(
          jsonb_typeof(entry.value) not in ('string', 'number')
          or nullif(pg_catalog.btrim(entry.value #>> '{}'), '') is null
          or (entry.value #>> '{}') !~* '^[A-G]$'
        ), false),
        coalesce(count(distinct pg_catalog.upper(
          nullif(pg_catalog.btrim(entry.value #>> '{}'), '')
        )) filter (
          where jsonb_typeof(entry.value) in ('string', 'number')
            and nullif(pg_catalog.btrim(entry.value #>> '{}'), '') is not null
        ) > 1, false)
      into energy_values, energy_candidate_count,
        energy_invalid_present, energy_conflict
      from energy_entries;
      if energy_candidate_count = 0 then
        canonical_text := null;
      elsif energy_invalid_present or energy_conflict then
        canonical_unsupported := true;
      else
        canonical_text := pg_catalog.upper(energy_values[1]);
      end if;
    else
      comparison_reason := 'field is outside the fixed twelve-field contract';
      return next;
      return;
  end case;

  if value_kind in ('text', 'occupancy', 'energy') then
    if canonical_unsupported then
      comparison_status := 'unsupported';
      comparison_reason := 'canonical text value is invalid or ambiguous';
      return next;
      return;
    end if;
    if value_kind = 'occupancy' then
      if canonical_occupancy is null then
        comparison_status := 'missing';
        comparison_reason := 'canonical occupancy is missing or unknown';
        return next;
      end if;
      canonical_text := canonical_occupancy;
      normalized_canonical_value := canonical_occupancy;
    else
      if canonical_text is null then
        comparison_status := 'missing';
        comparison_reason := 'canonical value is missing';
        return next;
      end if;
      normalized_canonical_value := case
        when value_kind = 'energy' then pg_catalog.upper(canonical_text)
        else app_private.ai_review_normalize_text(canonical_text)
      end;
    end if;
    canonical_value_jsonb := pg_catalog.to_jsonb(canonical_text);
    if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string' then
      comparison_status := 'unsupported';
      comparison_reason := 'AI value is not text';
      return next;
      return;
    end if;
    ai_text := p_value #>> '{}';
    if value_kind = 'occupancy' then
      ai_occupancy := app_private.ai_review_normalize_occupancy(ai_text);
      if ai_occupancy is null or ai_occupancy = 'unknown' then
        ai_unsupported := true;
      else
        normalized_ai_value := ai_occupancy;
      end if;
    elsif value_kind = 'energy' then
      ai_text := pg_catalog.btrim(ai_text);
      if ai_text !~* '^[A-G]$' then
        ai_unsupported := true;
      else
        normalized_ai_value := pg_catalog.upper(ai_text);
      end if;
    else
      normalized_ai_value := app_private.ai_review_normalize_text(ai_text);
      if normalized_ai_value is null then
        ai_unsupported := true;
      end if;
    end if;
    if ai_unsupported then
      comparison_status := 'unsupported';
      comparison_reason := 'AI value cannot be normalized safely';
    elsif normalized_ai_value = normalized_canonical_value then
      comparison_status := 'match';
      comparison_reason := 'normalized AI and canonical values match';
    else
      comparison_status := 'conflict';
      comparison_reason := 'normalized AI and canonical values differ';
    end if;
    return next;
    return;
  end if;

  if value_kind = 'date' then
    if canonical_date is null then
      comparison_status := 'missing';
      comparison_reason := 'canonical sale date is missing';
      return next;
      return;
    end if;
    normalized_canonical_value := canonical_date;
    canonical_value_jsonb := pg_catalog.to_jsonb(canonical_date);
    if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string' then
      comparison_status := 'unsupported';
      comparison_reason := 'AI sale date is not text';
      return next;
      return;
    end if;
    ai_text := p_value #>> '{}';
    if ai_text is null or ai_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      ai_unsupported := true;
    else
      begin
        ai_date := ai_text::date;
        if pg_catalog.to_char(ai_date, 'YYYY-MM-DD') <> ai_text then
          ai_unsupported := true;
        end if;
      exception when others then
        ai_unsupported := true;
      end;
    end if;
    if ai_unsupported then
      comparison_status := 'unsupported';
      comparison_reason := 'AI sale date is not a valid Paris-local date';
    else
      normalized_ai_value := ai_text;
      if normalized_ai_value = normalized_canonical_value then
        comparison_status := 'match';
        comparison_reason := 'Paris-local AI and canonical dates match';
      else
        comparison_status := 'conflict';
        comparison_reason := 'Paris-local AI and canonical dates differ';
      end if;
    end if;
    return next;
    return;
  end if;

  -- Numeric fields compare as PostgreSQL numerics, avoiding float rounding and
  -- making a missing or NaN canonical value fail closed.
  if canonical_num is null then
    comparison_status := 'missing';
    comparison_reason := 'canonical numeric value is missing';
    return next;
    return;
  end if;
  if canonical_num::text = 'NaN' then
    comparison_status := 'unsupported';
    comparison_reason := 'canonical numeric value is not finite';
    return next;
    return;
  end if;
  normalized_canonical_value := canonical_num::text;
  canonical_value_jsonb := pg_catalog.to_jsonb(canonical_num);
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'number' then
    comparison_status := 'unsupported';
    comparison_reason := 'AI numeric value is not JSON numeric';
    return next;
    return;
  end if;
  begin
    ai_num := (p_value #>> '{}')::numeric;
    if ai_num is null or ai_num::text = 'NaN' then
      ai_unsupported := true;
    end if;
  exception when others then
    ai_unsupported := true;
  end;
  if ai_unsupported then
    comparison_status := 'unsupported';
    comparison_reason := 'AI numeric value cannot be compared safely';
  else
    normalized_ai_value := ai_num::text;
    if ai_num = canonical_num then
      comparison_status := 'match';
      comparison_reason := 'numeric AI and canonical values match';
    else
      comparison_status := 'conflict';
      comparison_reason := 'numeric AI and canonical values differ';
    end if;
  end if;
  return next;
end;
$function$;

create trigger auction_ai_review_case_mapping_guard
before insert or update on public.auction_ai_review_case_status
for each row execute function app_private.validate_ai_review_case_mapping();

create table public.auction_ai_review_projections (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null check (
    schema_version = 'immojudis.real-extraction-review.v2'
  ),
  sample_sha256 text not null check (sample_sha256 ~ '^[0-9a-f]{64}$'),
  case_id text not null check (char_length(nullif(btrim(case_id), '')) between 1 and 200),
  source_name text not null check (char_length(nullif(btrim(source_name), '')) between 2 and 64),
  source_url text not null check (
    char_length(source_url) between 1 and 4096
    and source_url ~ '^https://'
  ),
  capture_sha256 text not null check (capture_sha256 ~ '^[0-9a-f]{64}$'),
  -- This is the canonical auction_sales content hash at import time.  It is
  -- deliberately distinct from the frozen capture SHA above.
  canonical_content_hash_at_import text check (
    canonical_content_hash_at_import is null
    or canonical_content_hash_at_import ~ '^[0-9a-f]{64}$'
  ),
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  mapping_status text not null check (mapping_status in ('exact', 'unmapped', 'ambiguous')),
  field_key text not null check (
    char_length(field_key) between 2 and 128
    and field_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$'
  ),
  review_state text not null check (
    review_state in ('resolved', 'unknown', 'absent', 'unresolved', 'unverified')
  ),
  citation_status text not null check (
    citation_status in ('verified', 'unverified', 'not_required')
  ),
  value_jsonb jsonb check (value_jsonb is null or jsonb_typeof(value_jsonb) <> 'null'),
  evidence_locator jsonb not null default '{}'::jsonb check (
    jsonb_typeof(evidence_locator) = 'object'
  ),
  block_reason text,
  local_is_publishable boolean generated always as (
    mapping_status = 'exact'
    and auction_sale_id is not null
    and review_state = 'resolved'
    and citation_status = 'verified'
    and value_jsonb is not null
  ) stored,
  created_at timestamptz not null default now(),
  constraint auction_ai_review_projection_unique_field
    unique (sample_sha256, case_id, field_key),
  constraint auction_ai_review_projection_field_key_allowed check (
    field_key in (
      'property.property_type',
      'property.city',
      'sale.sale_date',
      'sale.starting_price_eur',
      'property.habitable_surface_m2',
      'property.carrez_surface_m2',
      'property.land_surface_m2',
      'property.occupancy_status',
      'property.rooms_count',
      'property.parking_count',
      'property.source_energy_dpe_class',
      'property.source_energy_ges_class'
    )
  ),
  constraint auction_ai_review_projection_value_state check (
    (review_state = 'resolved' and citation_status = 'verified' and value_jsonb is not null)
    or (review_state <> 'resolved' and value_jsonb is null)
  ),
  constraint auction_ai_review_projection_citation_state check (
    (citation_status = 'verified' and review_state = 'resolved')
    or citation_status <> 'verified'
  ),
  constraint auction_ai_review_projection_block_reason check (
    review_state in ('resolved', 'unknown', 'absent')
    or nullif(btrim(block_reason), '') is not null
  )
);

create index auction_ai_review_projection_sale_field_idx
  on public.auction_ai_review_projections(auction_sale_id, field_key)
  where local_is_publishable;

create index auction_ai_review_projection_blocked_idx
  on public.auction_ai_review_projections(sample_sha256, mapping_status, review_state)
  where not local_is_publishable;

create index auction_ai_review_projection_blocked_sale_idx
  on public.auction_ai_review_projections(auction_sale_id, review_state)
  where auction_sale_id is not null
    and review_state in ('unresolved', 'unverified');

-- Sale triggers must answer the common no-review case with one indexed
-- lookup, without evaluating the reconciliation view on every pipeline upsert.
create index auction_ai_review_projection_sale_idx
  on public.auction_ai_review_projections(auction_sale_id)
  where auction_sale_id is not null;

create index auction_ai_review_projection_case_identity_idx
  on public.auction_ai_review_projections(
    sample_sha256,
    case_id,
    capture_sha256,
    auction_sale_id
  );

create or replace function app_private.validate_ai_review_projection_mapping()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  sale_source_name text;
  sale_source_url text;
begin
  -- An FK retention detach may null the sale id after the original exact
  -- mapping was stored.  The generated publishability flag then becomes
  -- false; do not let a nested FK update destroy the audit row.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 and old.auction_sale_id is not null
    and new.auction_sale_id is null then
    return new;
  end if;

  if new.mapping_status = 'exact' then
    if new.auction_sale_id is null then
      raise exception using
        errcode = '23514',
        message = 'An exact AI review mapping requires an auction sale target.';
    end if;
    select sale.source_name, sale.source_url
      into sale_source_name, sale_source_url
    from public.auction_sales sale
    where sale.id = new.auction_sale_id;
    if sale_source_name is null
      or sale_source_name is distinct from new.source_name
      or sale_source_url is distinct from new.source_url then
      raise exception using
        errcode = '55000',
        message = 'AI review mapping must match one exact source name and URL.';
    end if;
  elsif new.auction_sale_id is not null then
    raise exception using
      errcode = '23514',
      message = 'Unmapped or ambiguous AI review rows cannot carry an auction sale target.';
  end if;

  return new;
end;
$function$;

create trigger auction_ai_review_projection_mapping_guard
before insert or update on public.auction_ai_review_projections
for each row execute function app_private.validate_ai_review_projection_mapping();

-- Keep the AI values bounded before they enter the private projection.  The
-- checks intentionally validate shape and safe domain ranges only; they do
-- not claim that an AI value is canonical until a later field-level review
-- contract compares it with the sale record.
create or replace function app_private.ai_review_value_is_bounded(
  p_field_key text,
  p_value jsonb
)
returns boolean
language plpgsql
stable
strict
security invoker
set search_path = ''
as $function$
declare
  value_text text;
  value_number numeric;
  parsed_date date;
begin
  value_text := p_value #>> '{}';
  case p_field_key
    when 'property.property_type' then
      return jsonb_typeof(p_value) = 'string'
        and char_length(btrim(value_text)) between 1 and 160;
    when 'property.city' then
      return jsonb_typeof(p_value) = 'string'
        and char_length(btrim(value_text)) between 1 and 160;
    when 'sale.sale_date' then
      if jsonb_typeof(p_value) <> 'string'
        or value_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        return false;
      end if;
      parsed_date := to_date(value_text, 'YYYY-MM-DD');
      return to_char(parsed_date, 'YYYY-MM-DD') = value_text;
    when 'sale.starting_price_eur' then
      if jsonb_typeof(p_value) <> 'number' then
        return false;
      end if;
      value_number := (p_value #>> '{}')::numeric;
      return value_number between 0 and 1000000000;
    when 'property.habitable_surface_m2',
         'property.carrez_surface_m2',
         'property.land_surface_m2' then
      if jsonb_typeof(p_value) <> 'number' then
        return false;
      end if;
      value_number := (p_value #>> '{}')::numeric;
      return value_number between 0 and 100000000;
    when 'property.occupancy_status' then
      return jsonb_typeof(p_value) = 'string'
        and lower(btrim(value_text)) in (
          'libre', 'libre de toute occupation', 'occupied', 'occupé',
          'owner_occupied', 'partially_occupied', 'rented', 'squatted',
          'vacant'
        );
    when 'property.rooms_count', 'property.parking_count' then
      if jsonb_typeof(p_value) <> 'number' then
        return false;
      end if;
      value_number := (p_value #>> '{}')::numeric;
      return value_number between 0 and 1000
        and value_number = trunc(value_number);
    when 'property.source_energy_dpe_class',
         'property.source_energy_ges_class' then
      return jsonb_typeof(p_value) = 'string'
        and upper(btrim(value_text)) ~ '^[A-G]$';
    else
      return false;
  end case;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$function$;

create or replace function app_private.validate_ai_review_projection_value()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.review_state = 'resolved'
    and not app_private.ai_review_value_is_bounded(new.field_key, new.value_jsonb) then
    raise exception using
      errcode = '23514',
      message = 'AI review projection value is outside the bounded field contract.';
  end if;
  return new;
end;
$function$;

create trigger auction_ai_review_projection_value_guard
before insert or update on public.auction_ai_review_projections
for each row execute function app_private.validate_ai_review_projection_value();

-- Import a sanitized offline payload through the privileged SQL connector.
-- The payload intentionally carries no auction_sale_id: this function resolves
-- the source identity against the live database and only preserves an AI value
-- when exactly one row matches.  Re-running an identical batch is a no-op;
-- any conflicting existing row aborts the transaction.
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
    or p_payload->>'format' <> 'immojudis.ai-review-import.v1' then
    raise exception using
      errcode = '22023',
      message = 'Invalid AI review import payload format.';
  end if;
  v_schema_version := p_payload->>'schema_version';
  v_manifest_sha256 := p_payload->>'manifest_sha256';
  v_sample_sha256 := p_payload->>'sample_sha256';
  if v_schema_version <> 'immojudis.real-extraction-review.v2'
    or v_manifest_sha256 <> 'c2a8d1d245e738efc7549be148a59716aa32a4958aed4db996ea860a0427f6f1'
    or v_sample_sha256 <> '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424'
    or jsonb_typeof(p_payload->'case_statuses') <> 'array'
    or jsonb_typeof(p_payload->'projections') <> 'array' then
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

-- Create the reconciliation relation before the sale trigger functions below
-- are parsed.  The full definition is replaced after those functions are
-- installed; keeping the same column contract also makes this migration safe
-- on PostgreSQL installations that validate SQL function dependencies at
-- CREATE FUNCTION time.
create view public.v_auction_ai_review_projection_reconciliation
with (security_invoker = true)
as
select
  projection.id as projection_id,
  projection.auction_sale_id,
  projection.field_key,
  projection.source_name,
  projection.source_url,
  projection.review_state,
  projection.citation_status,
  projection.local_is_publishable,
  null::jsonb as ai_value_jsonb,
  null::jsonb as canonical_value_jsonb,
  null::text as normalized_ai_value,
  null::text as normalized_canonical_value,
  'not_publishable'::text as comparison_status,
  'view definition is installed after trigger dependencies'::text as comparison_reason,
  projection.capture_sha256,
  projection.evidence_locator,
  projection.created_at
from public.auction_ai_review_projections projection
where false;

-- The application already filters rows whose raw payload carries the
-- publication_quarantine marker in both authenticated fiche and discovery
-- views.  Reuse that established gate for a blocked AI review, and reapply it
-- whenever the pipeline updates the canonical sale.  A blocked field therefore
-- cannot be made visible by a later catalogue upsert that replaces raw_payload.
-- The safe default quarantines the whole sale; a future field-level mask can
-- relax this only after every affected listing query has adopted the same
-- status contract.
-- A complete captured set may contain an explicit unknown or absent decision,
-- but those rows are still not field-level publication matches. The sale gate
-- therefore quarantines every exact sale with a non-match, including a
-- missing, conflicting, unsupported, stale, or otherwise uncheckable field.
create or replace function app_private.ai_review_sale_is_blocked(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with expected_fields(field_key) as (
    values
      ('property.property_type'::text),
      ('property.city'::text),
      ('sale.sale_date'::text),
      ('sale.starting_price_eur'::text),
      ('property.habitable_surface_m2'::text),
      ('property.carrez_surface_m2'::text),
      ('property.land_surface_m2'::text),
      ('property.occupancy_status'::text),
      ('property.rooms_count'::text),
      ('property.parking_count'::text),
      ('property.source_energy_dpe_class'::text),
      ('property.source_energy_ges_class'::text)
  )
  select exists (
    select 1
    from public.auction_ai_review_projections projection
    where projection.auction_sale_id = p_sale_id
      and projection.review_state in ('unresolved', 'unverified')
  ) or exists (
    select 1
    from public.v_auction_ai_review_projection_reconciliation reconciliation
    where reconciliation.auction_sale_id = p_sale_id
      and reconciliation.comparison_status <> 'match'
  ) or exists (
    select 1
    from public.auction_ai_review_case_status case_status
    where case_status.auction_sale_id = p_sale_id
      and case_status.access_state <> 'captured'
  ) or exists (
    -- A captured exact case without a canonical snapshot cannot prove that
    -- its AI values still describe the current sale.  Keep it quarantined
    -- until the importer records the canonical content hash on the case.
    select 1
    from public.auction_ai_review_case_status case_status
    where case_status.auction_sale_id = p_sale_id
      and case_status.access_state = 'captured'
      and case_status.mapping_status = 'exact'
      and case_status.canonical_content_hash_at_import is null
  ) or exists (
    select 1
    from public.auction_ai_review_projections projection
    where projection.auction_sale_id = p_sale_id
      and projection.mapping_status = 'exact'
      and projection.canonical_content_hash_at_import is null
  ) or exists (
    select 1
    from public.auction_ai_review_case_status case_status
    join public.auction_sales sale on sale.id = case_status.auction_sale_id
    where case_status.auction_sale_id = p_sale_id
      and case_status.canonical_content_hash_at_import is not null
      and sale.content_hash is distinct from case_status.canonical_content_hash_at_import
  ) or exists (
    select 1
    from public.auction_ai_review_projections projection
    join public.auction_sales sale on sale.id = projection.auction_sale_id
    where projection.auction_sale_id = p_sale_id
      and projection.canonical_content_hash_at_import is not null
      and sale.content_hash is distinct from projection.canonical_content_hash_at_import
  ) or exists (
    select 1
    from public.auction_ai_review_projections projection
    where projection.auction_sale_id = p_sale_id
      and not exists (
        select 1
        from public.auction_ai_review_case_status case_status
        where case_status.sample_sha256 = projection.sample_sha256
          and case_status.case_id = projection.case_id
          and case_status.access_state = 'captured'
          and case_status.mapping_status = 'exact'
          and case_status.auction_sale_id = projection.auction_sale_id
          and case_status.capture_sha256 = projection.capture_sha256
      )
  ) or exists (
    select 1
    from public.auction_ai_review_case_status case_status
    where case_status.auction_sale_id = p_sale_id
      and case_status.access_state = 'captured'
      and case_status.mapping_status = 'exact'
      and (
        (
          select count(*)
          from public.auction_ai_review_projections projection
          where projection.sample_sha256 = case_status.sample_sha256
            and projection.case_id = case_status.case_id
            and projection.capture_sha256 = case_status.capture_sha256
            and projection.auction_sale_id = case_status.auction_sale_id
        ) <> (select count(*) from expected_fields)
        or exists (
          select 1
          from expected_fields expected
          where not exists (
            select 1
            from public.auction_ai_review_projections projection
            where projection.sample_sha256 = case_status.sample_sha256
              and projection.case_id = case_status.case_id
              and projection.capture_sha256 = case_status.capture_sha256
              and projection.auction_sale_id = case_status.auction_sale_id
              and projection.field_key = expected.field_key
          )
        )
        or exists (
          select 1
          from public.auction_ai_review_projections projection
          where projection.sample_sha256 = case_status.sample_sha256
            and projection.case_id = case_status.case_id
            and (
              projection.capture_sha256 is distinct from case_status.capture_sha256
              or projection.auction_sale_id is distinct from case_status.auction_sale_id
            )
        )
      )
  );
$function$;

create or replace function app_private.enforce_ai_review_publication_quarantine()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from public.auction_ai_review_case_status case_status
    where case_status.auction_sale_id = new.id
  ) and not exists (
    select 1 from public.auction_ai_review_projections projection
    where projection.auction_sale_id = new.id
  ) then
    return new;
  end if;

  -- A stored exact mapping is tied to the captured source identity.  If a
  -- later pipeline upsert changes that identity, a generated publishability
  -- flag cannot revalidate it against auction_sales.  Reject the update so
  -- reviewed facts never follow a different listing under the same sale id.
  if tg_op = 'UPDATE'
    and (new.source_name, new.source_url)
      is distinct from (old.source_name, old.source_url)
    and (
      exists (
        select 1 from public.auction_ai_review_case_status case_status
        where case_status.auction_sale_id = old.id
      )
      or exists (
        select 1 from public.auction_ai_review_projections projection
        where projection.auction_sale_id = old.id
      )
    ) then
    raise exception using
      errcode = '55000',
      message = 'AI_REVIEW_SOURCE_IDENTITY_IMMUTABLE';
  end if;

  if app_private.ai_review_sale_is_blocked(new.id)
    and coalesce(new.raw_payload->>'publication_quarantine', '') = '' then
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb)
      || jsonb_build_object('publication_quarantine', 'ai_review_projection_blocked');
  elsif not app_private.ai_review_sale_is_blocked(new.id)
    and coalesce(new.raw_payload->>'publication_quarantine', '')
      = 'ai_review_projection_blocked' then
    -- This marker is owned by this guard.  Do not overwrite another
    -- publication quarantine value supplied by the pipeline or an operator.
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb)
      - 'publication_quarantine';
  end if;
  return new;
end;
$function$;

create or replace function app_private.refresh_ai_review_publication_quarantine()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  sale_id uuid;
begin
  -- The FK can detach the projection while the sale row is being deleted.
  -- Refreshing the old target is harmless when the canonical row is already
  -- gone, and also handles a future review correction or cleanup delete.
  if tg_op = 'DELETE' then
    sale_id := old.auction_sale_id;
    if sale_id is not null then
      update public.auction_sales sale
      set raw_payload = coalesce(sale.raw_payload, '{}'::jsonb)
        - 'publication_quarantine',
          updated_at = pg_catalog.now()
      where sale.id = sale_id
        and coalesce(sale.raw_payload->>'publication_quarantine', '')
          = 'ai_review_projection_blocked'
        and not app_private.ai_review_sale_is_blocked(sale.id);
    end if;
    return old;
  end if;

  sale_id := new.auction_sale_id;
  if sale_id is not null then
    update public.auction_sales sale
    set raw_payload = case
        when app_private.ai_review_sale_is_blocked(sale.id) then case
          when coalesce(sale.raw_payload->>'publication_quarantine', '') = ''
            then coalesce(sale.raw_payload, '{}'::jsonb)
              || jsonb_build_object('publication_quarantine', 'ai_review_projection_blocked')
          else sale.raw_payload
        end
        when coalesce(sale.raw_payload->>'publication_quarantine', '')
          = 'ai_review_projection_blocked' then coalesce(sale.raw_payload, '{}'::jsonb)
          - 'publication_quarantine'
        else sale.raw_payload
      end,
        updated_at = pg_catalog.now()
    where sale.id = sale_id
      and (
        (app_private.ai_review_sale_is_blocked(sale.id)
          and coalesce(sale.raw_payload->>'publication_quarantine', '') = '')
        or coalesce(sale.raw_payload->>'publication_quarantine', '')
          = 'ai_review_projection_blocked'
      );
  end if;

  -- A projection update can move a review from one canonical sale to another.
  -- Refresh the old target too; the before-sale trigger preserves any marker
  -- while another blocked row still points to it.
  if tg_op = 'UPDATE'
    and old.auction_sale_id is distinct from new.auction_sale_id
    and old.auction_sale_id is not null then
    update public.auction_sales sale
    set raw_payload = case
        when app_private.ai_review_sale_is_blocked(sale.id) then case
          when coalesce(sale.raw_payload->>'publication_quarantine', '') = ''
            then coalesce(sale.raw_payload, '{}'::jsonb)
              || jsonb_build_object('publication_quarantine', 'ai_review_projection_blocked')
          else sale.raw_payload
        end
        when coalesce(sale.raw_payload->>'publication_quarantine', '')
          = 'ai_review_projection_blocked' then coalesce(sale.raw_payload, '{}'::jsonb)
          - 'publication_quarantine'
        else sale.raw_payload
      end,
        updated_at = pg_catalog.now()
    where sale.id = old.auction_sale_id
      and (
        app_private.ai_review_sale_is_blocked(sale.id)
        or coalesce(sale.raw_payload->>'publication_quarantine', '')
          = 'ai_review_projection_blocked'
      );
  end if;
  return new;
end;
$function$;

drop trigger if exists auction_sales_ai_review_publication_guard on public.auction_sales;
create trigger auction_sales_ai_review_publication_guard
before insert or update on public.auction_sales
for each row execute function app_private.enforce_ai_review_publication_quarantine();

-- The before trigger above protects an update using the last stored sale row.
-- A pipeline upsert can, however, change a canonical field and its payload in
-- the same NEW row.  Re-evaluate after the row is stored so the marker is
-- based on that NEW value before the transaction becomes visible.  The nested
-- marker update is guarded by trigger depth and is idempotent.
create or replace function app_private.refresh_ai_review_sale_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if not exists (
    select 1 from public.auction_ai_review_case_status case_status
    where case_status.auction_sale_id = new.id
  ) and not exists (
    select 1 from public.auction_ai_review_projections projection
    where projection.auction_sale_id = new.id
  ) then
    return new;
  end if;
  if app_private.ai_review_sale_is_blocked(new.id)
    and coalesce(new.raw_payload->>'publication_quarantine', '') = '' then
    update public.auction_sales sale
    set raw_payload = coalesce(sale.raw_payload, '{}'::jsonb)
        || jsonb_build_object('publication_quarantine', 'ai_review_projection_blocked'),
        updated_at = pg_catalog.now()
    where sale.id = new.id;
  elsif not app_private.ai_review_sale_is_blocked(new.id)
    and coalesce(new.raw_payload->>'publication_quarantine', '')
      = 'ai_review_projection_blocked' then
    update public.auction_sales sale
    set raw_payload = coalesce(sale.raw_payload, '{}'::jsonb)
        - 'publication_quarantine',
        updated_at = pg_catalog.now()
    where sale.id = new.id;
  end if;
  return new;
end;
$function$;

drop trigger if exists auction_sales_ai_review_publication_after_guard on public.auction_sales;
create trigger auction_sales_ai_review_publication_after_guard
after update on public.auction_sales
for each row execute function app_private.refresh_ai_review_sale_after_update();

-- The source URL can remain stable while the canonical sale contents change.
-- Preserve a durable quarantine marker in that case.  The marker is only
-- added when no operator or pre-existing publication marker owns the field;
-- the dynamic sale gate above still blocks the row even if a different marker
-- is already present.
create or replace function app_private.enforce_ai_review_content_hash_quarantine()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
    and new.content_hash is distinct from old.content_hash
    and (
      exists (
        select 1
        from public.auction_ai_review_case_status case_status
        where case_status.auction_sale_id = new.id
          and case_status.canonical_content_hash_at_import is not null
      )
      or exists (
        select 1
        from public.auction_ai_review_projections projection
        where projection.auction_sale_id = new.id
          and projection.canonical_content_hash_at_import is not null
      )
    )
    and coalesce(new.raw_payload->>'publication_quarantine', '') = '' then
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb)
      || jsonb_build_object('publication_quarantine', 'ai_review_content_hash_changed');
  end if;
  return new;
end;
$function$;

drop trigger if exists auction_sales_ai_review_content_hash_guard on public.auction_sales;
create trigger auction_sales_ai_review_content_hash_guard
before insert or update of content_hash on public.auction_sales
for each row execute function app_private.enforce_ai_review_content_hash_quarantine();

drop trigger if exists auction_ai_review_projection_publication_quarantine
on public.auction_ai_review_projections;
create trigger auction_ai_review_projection_publication_quarantine
after insert or update or delete on public.auction_ai_review_projections
for each row execute function app_private.refresh_ai_review_publication_quarantine();

drop trigger if exists auction_ai_review_case_status_publication_quarantine
on public.auction_ai_review_case_status;
create trigger auction_ai_review_case_status_publication_quarantine
after insert or update or delete on public.auction_ai_review_case_status
for each row execute function app_private.refresh_ai_review_publication_quarantine();

-- Only a future trusted importer may read the projection.  The current fiche
-- and map views continue to read auction_sales, so they do not consume this
-- view directly.  Instead, the trigger below writes their existing
-- publication_quarantine marker for exact sales with unresolved, stale, or
-- canonically conflicting projection rows.  The reconciliation view is the
-- single field-level publication contract: no hash, orphaned identity,
-- missing case status, stale snapshot, or non-resolved AI row can become a
-- match by accident.
create or replace view public.v_auction_ai_review_projection_reconciliation
with (security_invoker = true)
as
select
  projection.id as projection_id,
  projection.auction_sale_id,
  projection.field_key,
  projection.source_name,
  projection.source_url,
  projection.review_state,
  projection.citation_status,
  projection.local_is_publishable,
  projection.value_jsonb as ai_value_jsonb,
  comparison.canonical_value_jsonb,
  comparison.normalized_ai_value,
  comparison.normalized_canonical_value,
  case
    when projection.mapping_status <> 'exact'
      or projection.auction_sale_id is null
      or sale.id is null
      or sale.source_name is distinct from projection.source_name
      or sale.source_url is distinct from projection.source_url
      or projection.canonical_content_hash_at_import is null
      or sale.content_hash is distinct from projection.canonical_content_hash_at_import
      or not exists (
        select 1
        from public.auction_ai_review_case_status case_status
        where case_status.sample_sha256 = projection.sample_sha256
          and case_status.case_id = projection.case_id
          and case_status.access_state = 'captured'
          and case_status.mapping_status = 'exact'
          and case_status.auction_sale_id = projection.auction_sale_id
          and case_status.capture_sha256 = projection.capture_sha256
          and case_status.canonical_content_hash_at_import = projection.canonical_content_hash_at_import
      )
      or projection.review_state <> 'resolved'
      or projection.citation_status <> 'verified'
      or projection.value_jsonb is null
      then 'not_publishable'
    else comparison.comparison_status
  end as comparison_status,
  case
    when projection.mapping_status <> 'exact'
      or projection.auction_sale_id is null
      or sale.id is null
      then 'exact canonical sale mapping is required'
    when projection.canonical_content_hash_at_import is null
      or sale.content_hash is distinct from projection.canonical_content_hash_at_import
      then 'canonical content hash is missing or stale'
    when not exists (
      select 1
      from public.auction_ai_review_case_status case_status
      where case_status.sample_sha256 = projection.sample_sha256
        and case_status.case_id = projection.case_id
        and case_status.access_state = 'captured'
        and case_status.mapping_status = 'exact'
        and case_status.auction_sale_id = projection.auction_sale_id
        and case_status.capture_sha256 = projection.capture_sha256
        and case_status.canonical_content_hash_at_import = projection.canonical_content_hash_at_import
    ) then 'captured exact case provenance is missing'
    when projection.review_state <> 'resolved'
      or projection.citation_status <> 'verified'
      or projection.value_jsonb is null
      then 'AI review is not a verified resolved value'
    else comparison.comparison_reason
  end as comparison_reason,
  projection.capture_sha256,
  projection.evidence_locator,
  projection.created_at
from public.auction_ai_review_projections projection
left join public.auction_sales sale
  on sale.id = projection.auction_sale_id
cross join lateral app_private.ai_review_compare_field(
  projection.field_key,
  projection.value_jsonb,
  projection.auction_sale_id
) comparison;

create or replace view public.v_auction_ai_review_projection_read_model
with (security_invoker = true)
as
select
  reconciliation.projection_id,
  reconciliation.auction_sale_id,
  reconciliation.field_key,
  reconciliation.review_state,
  reconciliation.citation_status,
  (
    reconciliation.local_is_publishable
    and reconciliation.comparison_status = 'match'
    and not app_private.ai_review_sale_is_blocked(reconciliation.auction_sale_id)
  )
    as is_publishable,
  reconciliation.source_name,
  reconciliation.source_url,
  reconciliation.comparison_status,
  reconciliation.comparison_reason
from public.v_auction_ai_review_projection_reconciliation reconciliation;

create or replace view public.v_auction_ai_review_publishable
with (security_invoker = true)
as
select
  reconciliation.projection_id,
  reconciliation.auction_sale_id,
  reconciliation.field_key,
  reconciliation.review_state,
  reconciliation.citation_status,
  true as is_publishable,
  reconciliation.ai_value_jsonb as value_jsonb,
  reconciliation.source_name,
  reconciliation.source_url,
  reconciliation.capture_sha256,
  reconciliation.evidence_locator,
  reconciliation.created_at
from public.v_auction_ai_review_projection_reconciliation reconciliation
where reconciliation.comparison_status = 'match'
  and reconciliation.local_is_publishable
  and not app_private.ai_review_sale_is_blocked(reconciliation.auction_sale_id);

-- The Data API service_role is a read-only consumer of these private
-- relations.  Imports and fixture/maintenance writes run as the table owner
-- (the postgres/maintenance connection), whose owner privileges are retained
-- without granting INSERT to the application role.
alter table public.auction_ai_review_case_status enable row level security;
revoke all on table public.auction_ai_review_case_status from public, anon, authenticated, service_role;
grant select on table public.auction_ai_review_case_status to service_role;
alter table public.auction_ai_review_projections enable row level security;
revoke all on table public.auction_ai_review_projections from public, anon, authenticated, service_role;
grant select on table public.auction_ai_review_projections to service_role;
revoke all on table public.v_auction_ai_review_projection_read_model from public, anon, authenticated, service_role;
grant select on table public.v_auction_ai_review_projection_read_model to service_role;
revoke all on table public.v_auction_ai_review_projection_reconciliation from public, anon, authenticated, service_role;
grant select on table public.v_auction_ai_review_projection_reconciliation to service_role;
revoke all on table public.v_auction_ai_review_publishable from public, anon, authenticated, service_role;
grant select on table public.v_auction_ai_review_publishable to service_role;

-- A fact claim can cite an AI projection only through its generated
-- publishability gate.  This makes an unresolved or unverified field
-- impossible to promote by passing its row id to the claim writer.
alter table public.auction_fact_claims
  add column if not exists ai_review_projection_id uuid
  references public.auction_ai_review_projections(id) on delete restrict;

create or replace function app_private.validate_ai_review_fact_claim_link()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  projection public.auction_ai_review_projections%rowtype;
  reconciliation public.v_auction_ai_review_projection_reconciliation%rowtype;
begin
  if new.ai_review_projection_id is null then
    return new;
  end if;

  select * into projection
  from public.auction_ai_review_projections candidate
  where candidate.id = new.ai_review_projection_id;

  select * into reconciliation
  from public.v_auction_ai_review_projection_reconciliation candidate
  where candidate.projection_id = new.ai_review_projection_id;

  if not found or reconciliation.comparison_status <> 'match'
    or not projection.local_is_publishable
    or app_private.ai_review_sale_is_blocked(projection.auction_sale_id)
    or projection.auction_sale_id is distinct from new.auction_sale_id
    or projection.field_key is distinct from new.field_key
    or projection.value_jsonb is distinct from new.value_jsonb then
    raise exception using
      errcode = '55000',
      message = 'An auction fact claim may link only to a publishable AI review projection for the same sale and field.';
  end if;
  return new;
end;
$function$;

revoke all on function app_private.validate_ai_review_projection_mapping()
from public, anon, authenticated;
revoke all on function app_private.validate_ai_review_case_mapping()
from public, anon, authenticated;
revoke all on function app_private.ai_review_sale_is_blocked(uuid)
from public, anon, authenticated;
grant execute on function app_private.ai_review_sale_is_blocked(uuid)
to service_role;
revoke all on function app_private.ai_review_value_is_bounded(text, jsonb)
from public, anon, authenticated;
revoke all on function app_private.ai_review_normalize_text(text)
from public, anon, authenticated;
revoke all on function app_private.ai_review_normalize_occupancy(text)
from public, anon, authenticated;
revoke all on function app_private.ai_review_compare_field(text, jsonb, uuid)
from public, anon, authenticated;
grant execute on function app_private.ai_review_compare_field(text, jsonb, uuid)
to service_role;
revoke all on function app_private.validate_ai_review_projection_value()
from public, anon, authenticated;
revoke all on function app_private.import_ai_review_payload(jsonb)
from public, anon, authenticated, service_role;
revoke all on function app_private.validate_ai_review_fact_claim_link()
from public, anon, authenticated;
revoke all on function app_private.enforce_ai_review_publication_quarantine()
from public, anon, authenticated;
revoke all on function app_private.refresh_ai_review_sale_after_update()
from public, anon, authenticated;
revoke all on function app_private.enforce_ai_review_content_hash_quarantine()
from public, anon, authenticated;
revoke all on function app_private.refresh_ai_review_publication_quarantine()
from public, anon, authenticated;

create trigger auction_fact_claims_ai_review_link_guard
before insert or update on public.auction_fact_claims
for each row execute function app_private.validate_ai_review_fact_claim_link();

-- Keep an accepted fact claim linked to an AI projection only while that
-- projection still reconciles with the current canonical sale.  The claim
-- remains visible for audit/review when it goes stale, but it must leave the
-- publishable contract immediately without waiting for a claim rewrite.
create or replace view public.v_auction_fact_claims_read_model
with (security_invoker = true)
as
select
  claim.id as claim_id,
  claim.auction_sale_id,
  claim.lot_id,
  claim.field_key,
  claim.value_jsonb,
  claim.claim_status as fact_status,
  (
    claim.claim_status = 'accepted'
    and (
      claim.ai_review_projection_id is null
      or exists (
        select 1
        from public.v_auction_ai_review_projection_reconciliation reconciliation
        where reconciliation.projection_id = claim.ai_review_projection_id
          and reconciliation.auction_sale_id is not distinct from claim.auction_sale_id
          and reconciliation.field_key = claim.field_key
          and reconciliation.ai_value_jsonb is not distinct from claim.value_jsonb
          and reconciliation.local_is_publishable
          and reconciliation.comparison_status = 'match'
          and not app_private.ai_review_sale_is_blocked(claim.auction_sale_id)
      )
    )
  ) as is_publishable,
  claim.conflict_group,
  claim.evidence_kind,
  claim.source_id,
  claim.raw_artifact_id,
  claim.source_record_id,
  claim.artifact_extraction_id,
  claim.source_url,
  claim.evidence_locator,
  claim.confidence_score,
  claim.captured_at,
  claim.resolved_at,
  claim.resolution_note,
  claim.created_at,
  claim.updated_at
from public.auction_fact_claims claim
where claim.claim_status in ('candidate', 'accepted', 'conflicted')
  and (claim.auction_sale_id is not null or claim.lot_id is not null);

revoke all on table public.v_auction_fact_claims_read_model
from public, anon, authenticated, service_role;
grant select on table public.v_auction_fact_claims_read_model to service_role;

comment on table public.auction_ai_review_projections is
  'Private, fail-closed projection of the AI extraction review; exact source URL mapping and verified citations are required before publication.';
comment on table public.auction_ai_review_case_status is
  'Private case-level AI review access outcomes; non-captured sample cases remain explicit blockers without synthetic evidence.';
comment on function app_private.import_ai_review_payload(jsonb) is
  'Postgres/maintenance-owner-only idempotent import for sanitized offline AI review batches; exact source identity is resolved inside production PostgreSQL.';
comment on function app_private.ai_review_value_is_bounded(text, jsonb) is
  'Private bounded shape and domain validation for the twelve AI review fields; canonical equality is checked separately.';
comment on function app_private.ai_review_compare_field(text, jsonb, uuid) is
  'Private field-level canonical reconciliation with accent/case/space, numeric, Paris-local date, occupancy, and fail-closed energy rules.';
comment on function app_private.refresh_ai_review_sale_after_update() is
  'Private after-update recheck that quarantines a canonical sale using the pipeline NEW row after field-level changes are stored.';
comment on function app_private.validate_ai_review_projection_value() is
  'Private trigger enforcing bounded AI value shapes for every resolved projection row.';
comment on view public.v_auction_ai_review_projection_read_model is
  'Service-role-only status and source identity contract for trusted fiche adapters; canonical comparison status is explicit and no values or private evidence are exposed.';
comment on view public.v_auction_ai_review_projection_reconciliation is
  'Service-role-only field reconciliation; match is the only status eligible for publication, and nohash/orphan/stale rows are not_publishable.';
comment on view public.v_auction_ai_review_publishable is
  'Service-role-only AI review rows that passed exact mapping, resolved label and citation verification.';
comment on column public.auction_fact_claims.ai_review_projection_id is
  'Optional pointer to a publishable AI review projection; sale, field, and value must match exactly.';

notify pgrst, 'reload schema';

commit;
