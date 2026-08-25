begin;

create table public.auction_sale_court_document_assignments (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  source_url_snapshot text not null,
  document_url text not null check (document_url ~ '^https://'),
  document_label text,
  document_sha256 text not null check (
    document_sha256 ~ '^[0-9a-f]{64}$'
  ),
  document_page integer not null check (document_page > 0),
  observed_court_label text not null check (
    nullif(btrim(observed_court_label), '') is not null
  ),
  normalized_observed_court_label text not null,
  court_id uuid not null references public.outcome_courts(id) on delete restrict,
  court_code text not null check (nullif(btrim(court_code), '') is not null),
  court_name text not null check (nullif(btrim(court_name), '') is not null),
  matched_reference_label text not null check (
    nullif(btrim(matched_reference_label), '') is not null
  ),
  resolution_method text not null check (
    resolution_method in (
      'source_auction_notice_label_exact',
      'source_auction_notice_label_unique_prefix'
    )
  ),
  review_method text not null check (
    review_method = 'rendered_pdf_visual_review'
  ),
  candidate_count smallint not null default 1 check (candidate_count = 1),
  reviewed_at timestamptz not null default now(),
  unique (source_key, document_sha256, document_page, court_code),
  constraint auction_sale_court_document_source_key_check check (
    source_key = app_private.auction_sale_catalogue_source_key(
      source_url_snapshot
    )
  ),
  constraint auction_sale_court_document_normalized_label_check check (
    normalized_observed_court_label =
      app_private.normalize_court_label(observed_court_label)
  )
);

create index auction_sale_court_document_assignments_sale_idx
  on public.auction_sale_court_document_assignments(
    auction_sale_id,
    reviewed_at desc
  )
  where auction_sale_id is not null;

create index auction_sale_court_document_assignments_court_idx
  on public.auction_sale_court_document_assignments(
    court_id,
    reviewed_at desc
  );

create trigger guard_auction_sale_court_document_assignment_before_mutation
before update or delete on public.auction_sale_court_document_assignments
for each row execute function app_private.guard_court_enrichment_audit_mutation();

create or replace function public.apply_reviewed_auction_notice_court_assignment(
  p_auction_sale_id uuid,
  p_document_url text,
  p_document_sha256 text,
  p_document_page integer,
  p_observed_court_label text
)
returns table (
  assigned boolean,
  court_code text,
  court_name text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  sale_row public.auction_sales%rowtype;
  resolution record;
  source_document_label text;
  was_unassigned boolean;
  document_resolution_method text;
begin
  if p_auction_sale_id is null
    or nullif(btrim(p_document_url), '') is null
    or p_document_url !~ '^https://'
    or p_document_sha256 !~ '^[0-9a-f]{64}$'
    or p_document_page is null
    or p_document_page < 1
    or nullif(btrim(p_observed_court_label), '') is null then
    raise exception using
      errcode = '22023',
      message = 'A valid sale, HTTPS PDF, SHA-256, page and observed court label are required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'immojudis:reviewed-auction-notice-court:' || p_auction_sale_id::text,
      0
    )
  );

  select sale.*
  into strict sale_row
  from public.auction_sales sale
  where sale.id = p_auction_sale_id
  for update;

  if sale_row.sale_venue_type <> 'tribunal'
    or sale_row.sale_verification_status not in ('verified', 'cross_checked') then
    raise exception using
      errcode = '23514',
      message = 'Only verified or cross-checked tribunal sales can use auction-notice court evidence.';
  end if;

  select nullif(btrim(document.value->>'label'), '')
  into source_document_label
  from jsonb_array_elements(
    case
      when jsonb_typeof(sale_row.documents) = 'array'
        then sale_row.documents
      else '[]'::jsonb
    end
  ) document(value)
  where document.value->>'url' = p_document_url
    and document.value->>'type' = 'pdf'
  limit 1;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'The reviewed PDF must be listed on the sale source record.';
  end if;

  select resolved.*
  into resolution
  from app_private.resolve_unique_active_court_label(
    p_observed_court_label
  ) resolved;

  if resolution.court_id is null then
    raise exception using
      errcode = '23514',
      message = 'The observed PDF label does not resolve to one unique active court.';
  end if;

  if sale_row.tribunal_code is not null
    and sale_row.tribunal_code is distinct from resolution.court_code then
    raise exception using
      errcode = '23514',
      message = 'The reviewed PDF conflicts with the sale court already assigned.';
  end if;

  document_resolution_method := case resolution.mapping_method
    when 'source_tribunal_label_exact'
      then 'source_auction_notice_label_exact'
    else 'source_auction_notice_label_unique_prefix'
  end;
  was_unassigned := sale_row.tribunal_code is null;

  insert into public.auction_sale_court_document_assignments (
    source_key,
    auction_sale_id,
    source_url_snapshot,
    document_url,
    document_label,
    document_sha256,
    document_page,
    observed_court_label,
    normalized_observed_court_label,
    court_id,
    court_code,
    court_name,
    matched_reference_label,
    resolution_method,
    review_method,
    candidate_count
  ) values (
    app_private.auction_sale_catalogue_source_key(sale_row.source_url),
    sale_row.id,
    sale_row.source_url,
    p_document_url,
    source_document_label,
    p_document_sha256,
    p_document_page,
    p_observed_court_label,
    resolution.normalized_source_label,
    resolution.court_id,
    resolution.court_code,
    resolution.court_name,
    resolution.matched_label,
    document_resolution_method,
    'rendered_pdf_visual_review',
    1
  )
  on conflict (
    source_key,
    document_sha256,
    document_page,
    court_code
  ) do nothing;

  update public.auction_sales sale
  set tribunal_code = resolution.court_code,
      tribunal = coalesce(
        nullif(btrim(sale.tribunal), ''),
        resolution.court_name
      ),
      updated_at = now()
  where sale.id = sale_row.id
    and (
      sale.tribunal_code is null
      or sale.tribunal_code = resolution.court_code
    );

  return query select
    was_unassigned,
    resolution.court_code::text,
    resolution.court_name::text;
exception
  when no_data_found then
    raise exception using
      errcode = 'P0002',
      message = 'The requested auction sale does not exist.';
end;
$function$;

alter table public.auction_sale_court_document_assignments
  enable row level security;

revoke all on table public.auction_sale_court_document_assignments
  from anon, authenticated, service_role;
grant select, insert on table public.auction_sale_court_document_assignments
  to service_role;

revoke all on function public.apply_reviewed_auction_notice_court_assignment(
  uuid,
  text,
  text,
  integer,
  text
) from public, anon, authenticated;
grant execute on function public.apply_reviewed_auction_notice_court_assignment(
  uuid,
  text,
  text,
  integer,
  text
) to service_role;

comment on table public.auction_sale_court_document_assignments is
  'Append-only proof of a unique active court label visually reviewed in a sale-listed public auction-notice PDF.';
comment on function public.apply_reviewed_auction_notice_court_assignment(
  uuid,
  text,
  text,
  integer,
  text
) is
  'Applies reviewed sale-document court evidence without promoting it to territorial-competence evidence in Outcome.';

notify pgrst, 'reload schema';

commit;
