begin;

-- Preserve the metadata owned by the canonical DVF importer even though a
-- replacement load temporarily drops and rebuilds the unique index.
comment on index public.dvf_transactions_source_mutation_uidx is
  'One canonical DVF transaction per source mutation; local and parcel source rows are aggregated by the importer.';

-- Restore the canonical auction read indexes and view when an environment is
-- missing objects already defined by the migration history.
create index if not exists auction_sales_lat_lng_idx
  on public.auction_sales (latitude, longitude)
  where latitude is not null and longitude is not null;

create index if not exists auction_sales_department_sale_date_idx
  on public.auction_sales (department, sale_date);

create index if not exists auction_sales_investment_score_idx
  on public.auction_sales (investment_score desc nulls last);

create or replace view public.v_auction_map_pins
with (security_invoker = true)
as
select
  id,
  title,
  city,
  department,
  property_type,
  starting_price_eur,
  sale_date,
  latitude,
  longitude,
  occupancy_status,
  app_surface_m2,
  investment_score,
  score_confidence,
  status,
  created_at
from public.auction_sales
where latitude is not null
  and longitude is not null
  and coalesce(status, 'unknown') in ('upcoming', 'unknown');

revoke all on table public.v_auction_map_pins from anon;
grant select on table public.v_auction_map_pins to authenticated;

-- These legacy pipeline objects are present and useful in production. Adopt
-- them into the migration history so a clean rebuild and production describe
-- the same application schema without dropping working indexes or history.
alter table public.auction_sales
  add column if not exists location public.geography(Point,4326)
  generated always as (
    case
      when latitude is not null and longitude is not null then
        public.st_setsrid(
          public.st_makepoint(longitude::double precision, latitude::double precision),
          4326
        )::public.geography
      else null::public.geography
    end
  ) stored;

create or replace function public.log_auction_sale_change()
returns trigger
language plpgsql
as $function$
begin
  if (to_jsonb(old) - 'updated_at' - 'last_seen_at') is distinct from (to_jsonb(new) - 'updated_at' - 'last_seen_at') then
    insert into public.auction_sale_history (source_url, old_row, new_row)
    values (new.source_url, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$function$;

do $block$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.auction_sales'::regclass
      and tgname = 'trg_log_auction_sale_change'
      and not tgisinternal
  ) then
    create trigger trg_log_auction_sale_change
      after update on public.auction_sales
      for each row
      execute function public.log_auction_sale_change();
  end if;
end
$block$;

create index if not exists idx_auction_documents_type
  on public.auction_documents (document_type);
create index if not exists idx_auction_extractions_source_url
  on public.auction_extractions (source_url);
create index if not exists idx_auction_extractions_provider
  on public.auction_extractions (provider);
create index if not exists idx_auction_features_investment_score
  on public.auction_features (investment_score);
create index if not exists idx_auction_observations_content_hash
  on public.auction_observations (content_hash);
create index if not exists idx_auction_risks_label
  on public.auction_risks (risk_label);
create index if not exists idx_auction_runs_started_at
  on public.auction_runs (started_at);
create index if not exists idx_auction_sale_history_source_url
  on public.auction_sale_history (source_url);
create index if not exists idx_auction_sales_investment_score
  on public.auction_sales (investment_score);
create index if not exists idx_auction_sales_latlng
  on public.auction_sales (latitude, longitude);
create index if not exists idx_auction_sales_location
  on public.auction_sales using gist (location);
create index if not exists idx_auction_sales_primary_source
  on public.auction_sales (primary_source);
create index if not exists idx_auction_sales_property_type
  on public.auction_sales (property_type);
create index if not exists idx_auction_sales_starting_price
  on public.auction_sales (starting_price_eur);
create index if not exists idx_auction_sales_tribunal_code
  on public.auction_sales (tribunal_code);
create index if not exists idx_user_alerts_active
  on public.user_alerts (is_active);
create index if not exists idx_user_favorites_sale
  on public.user_favorites (sale_id);

create or replace view public.auction_sales_investment_candidates
with (security_invoker = true)
as
select *
from public.public_auction_sales
where status = 'upcoming'
  and investment_score is not null
order by investment_score desc nulls last, sale_date asc;

grant all on function public.log_auction_sale_change() to anon, authenticated, service_role;
grant select, insert, update, delete on table
  public.auction_sales_quality_issues,
  public.auction_source_coverage,
  public.public_auction_sales,
  public.v_auction_sales_app
to service_role;

notify pgrst, 'reload schema';

commit;
