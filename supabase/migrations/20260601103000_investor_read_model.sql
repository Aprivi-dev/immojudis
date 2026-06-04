begin;

-- Read model populated by the pipeline for fast app/admin reads.
-- It avoids rebuilding the full investor payload from several normalized tables
-- on every public request.
create table if not exists public.auction_sales_app_read (
  source_url text primary key references public.auction_sales(source_url) on delete cascade,
  id uuid,
  title text,
  city text,
  department text,
  postal_code text,
  property_type text,
  starting_price_eur numeric,
  sale_date timestamptz,
  latitude double precision,
  longitude double precision,
  occupancy_status text,
  app_surface_m2 numeric,
  investment_score numeric,
  score_confidence numeric,
  score_version text,
  deal_memo jsonb not null default '{}'::jsonb,
  quality_summary jsonb not null default '{}'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  score_factors jsonb not null default '[]'::jsonb,
  documents_rich jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.auction_sales_app_read enable row level security;

create index if not exists idx_auction_sales_app_read_sale_date
  on public.auction_sales_app_read(sale_date);
create index if not exists idx_auction_sales_app_read_department
  on public.auction_sales_app_read(department);
create index if not exists idx_auction_sales_app_read_score
  on public.auction_sales_app_read(investment_score desc nulls last);
create index if not exists idx_auction_sales_app_read_location
  on public.auction_sales_app_read(latitude, longitude)
  where latitude is not null and longitude is not null;
create index if not exists idx_auction_sales_app_read_quality_gin
  on public.auction_sales_app_read using gin(quality_summary);
create index if not exists idx_auction_sales_app_read_risks_gin
  on public.auction_sales_app_read using gin(risks);

revoke all on table public.auction_sales_app_read from anon, authenticated;
grant select (
  source_url, id, title, city, department, postal_code, property_type,
  starting_price_eur, sale_date, latitude, longitude, occupancy_status,
  app_surface_m2, investment_score, score_confidence, score_version,
  deal_memo, quality_summary, risks, score_factors, documents_rich,
  created_at, updated_at
) on table public.auction_sales_app_read to anon, authenticated;

grant select, insert, update, delete on table public.auction_sales_app_read to service_role;

drop policy if exists auction_sales_app_read_public_read on public.auction_sales_app_read;
create policy auction_sales_app_read_public_read
on public.auction_sales_app_read for select
to anon, authenticated
using (true);

notify pgrst, 'reload schema';

commit;
