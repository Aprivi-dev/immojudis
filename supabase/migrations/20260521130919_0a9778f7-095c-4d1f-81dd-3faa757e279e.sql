create table if not exists public.auction_sales (
  id uuid primary key default gen_random_uuid(),
  title text,
  city text,
  department text,
  postal_code text,
  address text,
  tribunal text,
  tribunal_code text,
  property_type text,
  starting_price_eur numeric,
  sale_date timestamptz,
  latitude double precision,
  longitude double precision,
  occupancy_status text,
  habitable_surface_m2 numeric,
  carrez_surface_m2 numeric,
  land_surface_m2 numeric,
  app_surface_m2 numeric,
  app_surface_kind text,
  surface_scope text,
  surface_source text,
  surface_confidence numeric,
  surface_evidence text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  parking_count integer,
  has_garden boolean,
  has_terrace boolean,
  has_garage boolean,
  has_pool boolean,
  has_air_conditioning boolean,
  has_double_glazing boolean,
  investment_score numeric,
  investment_summary text,
  score_version text,
  risk_notes text,
  source_name text,
  source_url text,
  primary_source text,
  source_urls jsonb,
  dedupe_confidence text,
  quality_flags jsonb,
  documents jsonb,
  status text default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.auction_sales add column if not exists title text;
alter table public.auction_sales add column if not exists city text;
alter table public.auction_sales add column if not exists department text;
alter table public.auction_sales add column if not exists postal_code text;
alter table public.auction_sales add column if not exists address text;
alter table public.auction_sales add column if not exists tribunal text;
alter table public.auction_sales add column if not exists tribunal_code text;
alter table public.auction_sales add column if not exists property_type text;
alter table public.auction_sales add column if not exists starting_price_eur numeric;
alter table public.auction_sales add column if not exists sale_date timestamptz;
alter table public.auction_sales add column if not exists latitude double precision;
alter table public.auction_sales add column if not exists longitude double precision;
alter table public.auction_sales add column if not exists occupancy_status text;
alter table public.auction_sales add column if not exists habitable_surface_m2 numeric;
alter table public.auction_sales add column if not exists carrez_surface_m2 numeric;
alter table public.auction_sales add column if not exists land_surface_m2 numeric;
alter table public.auction_sales add column if not exists app_surface_m2 numeric;
alter table public.auction_sales add column if not exists app_surface_kind text;
alter table public.auction_sales add column if not exists surface_scope text;
alter table public.auction_sales add column if not exists surface_source text;
alter table public.auction_sales add column if not exists surface_confidence numeric;
alter table public.auction_sales add column if not exists surface_evidence text;
alter table public.auction_sales add column if not exists rooms_count integer;
alter table public.auction_sales add column if not exists bedrooms_count integer;
alter table public.auction_sales add column if not exists bathrooms_count integer;
alter table public.auction_sales add column if not exists parking_count integer;
alter table public.auction_sales add column if not exists has_garden boolean;
alter table public.auction_sales add column if not exists has_terrace boolean;
alter table public.auction_sales add column if not exists has_garage boolean;
alter table public.auction_sales add column if not exists has_pool boolean;
alter table public.auction_sales add column if not exists has_air_conditioning boolean;
alter table public.auction_sales add column if not exists has_double_glazing boolean;
alter table public.auction_sales add column if not exists investment_score numeric;
alter table public.auction_sales add column if not exists investment_summary text;
alter table public.auction_sales add column if not exists score_version text;
alter table public.auction_sales add column if not exists risk_notes text;
alter table public.auction_sales add column if not exists source_name text;
alter table public.auction_sales add column if not exists source_url text;
alter table public.auction_sales add column if not exists primary_source text;
alter table public.auction_sales add column if not exists source_urls jsonb;
alter table public.auction_sales add column if not exists dedupe_confidence text;
alter table public.auction_sales add column if not exists quality_flags jsonb;
alter table public.auction_sales add column if not exists documents jsonb;
alter table public.auction_sales add column if not exists status text default 'unknown';
alter table public.auction_sales add column if not exists created_at timestamptz not null default now();
alter table public.auction_sales add column if not exists updated_at timestamptz not null default now();

create table if not exists public.tribunals (
  code text primary key,
  canonical_name text,
  city text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auction_risks (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  risk_type text,
  risk_label text,
  severity numeric,
  evidence text,
  created_at timestamptz not null default now()
);

create table if not exists public.auction_documents (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  document_url text not null,
  label text,
  document_type text,
  extraction_status text,
  created_at timestamptz not null default now()
);

create table if not exists public.user_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, sale_id)
);

create table if not exists public.user_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  department text,
  city text,
  property_type text,
  max_price_eur numeric,
  min_surface_m2 numeric,
  occupancy_status text,
  min_investment_score numeric,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_auction_sales_status on public.auction_sales(status);
create index if not exists idx_auction_sales_department on public.auction_sales(department);
create index if not exists idx_auction_sales_city on public.auction_sales(city);
create index if not exists idx_auction_sales_property_type on public.auction_sales(property_type);
create index if not exists idx_auction_sales_sale_date on public.auction_sales(sale_date);
create index if not exists idx_auction_sales_starting_price on public.auction_sales(starting_price_eur);
create index if not exists idx_auction_sales_score on public.auction_sales(investment_score);
create index if not exists idx_auction_sales_latlng on public.auction_sales(latitude, longitude);
create index if not exists auction_sales_lat_lng_idx on public.auction_sales(latitude, longitude) where latitude is not null and longitude is not null;
create index if not exists auction_sales_department_sale_date_idx on public.auction_sales(department, sale_date);
create index if not exists auction_sales_investment_score_idx on public.auction_sales(investment_score desc nulls last);
create index if not exists idx_auction_documents_source_url on public.auction_documents(source_url);
create index if not exists idx_auction_risks_source_url on public.auction_risks(source_url);
create index if not exists idx_user_favorites_user on public.user_favorites(user_id);
create index if not exists idx_user_favorites_sale on public.user_favorites(sale_id);
create index if not exists idx_user_alerts_user on public.user_alerts(user_id);
create index if not exists idx_user_alerts_active on public.user_alerts(is_active);

drop view if exists public.v_auction_sales_app;
create view public.v_auction_sales_app as
select
  s.id,
  s.title,
  s.city,
  s.department,
  s.postal_code,
  s.address,
  s.tribunal,
  s.tribunal_code,
  t.canonical_name as tribunal_name,
  t.city as tribunal_city,
  s.property_type,
  s.starting_price_eur,
  s.sale_date,
  s.latitude,
  s.longitude,
  s.occupancy_status,
  s.habitable_surface_m2,
  s.carrez_surface_m2,
  s.land_surface_m2,
  s.app_surface_m2,
  s.app_surface_kind,
  s.surface_scope,
  s.surface_source,
  s.surface_confidence,
  s.surface_evidence,
  s.rooms_count,
  s.bedrooms_count,
  s.bathrooms_count,
  s.parking_count,
  s.has_garden,
  s.has_terrace,
  s.has_garage,
  s.has_pool,
  s.has_air_conditioning,
  s.has_double_glazing,
  s.investment_score,
  s.investment_summary,
  s.score_version,
  s.risk_notes,
  s.source_name,
  s.source_url,
  s.primary_source,
  s.source_urls,
  s.dedupe_confidence,
  s.quality_flags,
  s.documents,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'risk_type', r.risk_type,
          'risk_label', r.risk_label,
          'severity', r.severity,
          'evidence', r.evidence
        )
        order by r.severity desc nulls last
      )
      from public.auction_risks r
      where r.source_url = s.source_url
    ),
    '[]'::jsonb
  ) as risks,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'url', d.document_url,
          'label', d.label,
          'type', d.document_type,
          'extraction_status', d.extraction_status
        )
        order by d.label nulls last
      )
      from public.auction_documents d
      where d.source_url = s.source_url
    ),
    '[]'::jsonb
  ) as documents_rich,
  s.status,
  s.created_at,
  s.updated_at
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
where s.status in ('upcoming', 'unknown')
  and s.latitude is not null
  and s.longitude is not null;

grant select on public.v_auction_sales_app to anon, authenticated;

alter table public.auction_sales enable row level security;
alter table public.tribunals enable row level security;
alter table public.auction_risks enable row level security;
alter table public.auction_documents enable row level security;
alter table public.user_favorites enable row level security;
alter table public.user_alerts enable row level security;

drop policy if exists auction_sales_public_read on public.auction_sales;
create policy auction_sales_public_read on public.auction_sales for select to anon, authenticated using (true);

drop policy if exists tribunals_public_read on public.tribunals;
create policy tribunals_public_read on public.tribunals for select to anon, authenticated using (true);

drop policy if exists auction_risks_public_read on public.auction_risks;
create policy auction_risks_public_read on public.auction_risks for select to anon, authenticated using (true);

drop policy if exists auction_documents_public_read on public.auction_documents;
create policy auction_documents_public_read on public.auction_documents for select to anon, authenticated using (true);

drop policy if exists favorites_select_own on public.user_favorites;
drop policy if exists favorites_insert_own on public.user_favorites;
drop policy if exists favorites_delete_own on public.user_favorites;
create policy favorites_select_own on public.user_favorites for select to authenticated using (user_id = auth.uid());
create policy favorites_insert_own on public.user_favorites for insert to authenticated with check (user_id = auth.uid());
create policy favorites_delete_own on public.user_favorites for delete to authenticated using (user_id = auth.uid());

drop policy if exists alerts_select_own on public.user_alerts;
drop policy if exists alerts_insert_own on public.user_alerts;
drop policy if exists alerts_update_own on public.user_alerts;
drop policy if exists alerts_delete_own on public.user_alerts;
create policy alerts_select_own on public.user_alerts for select to authenticated using (user_id = auth.uid());
create policy alerts_insert_own on public.user_alerts for insert to authenticated with check (user_id = auth.uid());
create policy alerts_update_own on public.user_alerts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy alerts_delete_own on public.user_alerts for delete to authenticated using (user_id = auth.uid());