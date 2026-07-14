begin;

create table public.dvf_market_statistics (
  geography_level text not null check (
    geography_level in ('department', 'epci', 'commune')
  ),
  geography_code text not null,
  geography_label text not null,
  parent_code text,
  segment text not null check (
    segment in ('apartment', 'house', 'residential', 'commercial')
  ),
  sales_count integer not null check (sales_count >= 0),
  mean_price_per_m2 numeric check (mean_price_per_m2 is null or mean_price_per_m2 > 0),
  median_price_per_m2 numeric check (median_price_per_m2 is null or median_price_per_m2 > 0),
  source_url text not null,
  source_updated_at date,
  imported_at timestamptz not null default now(),
  primary key (geography_level, geography_code, segment)
);

comment on table public.dvf_market_statistics is
  'Private hierarchical DVF price statistics from data.gouv.fr. Used only as an indicative backend fallback when detailed comparable sales are insufficient.';

create index dvf_market_statistics_parent_segment_idx
  on public.dvf_market_statistics (parent_code, segment)
  where parent_code is not null;

alter table public.dvf_market_statistics enable row level security;

revoke all on table public.dvf_market_statistics from public, anon, authenticated;
grant select, insert, update, delete on table public.dvf_market_statistics to service_role;

notify pgrst, 'reload schema';

commit;
