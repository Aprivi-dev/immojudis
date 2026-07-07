begin;

create table if not exists public.auction_urban_planning_signals (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  signal_key text not null,
  signal_kind text not null check (
    signal_kind in ('zoning', 'permit', 'servitude', 'coownership', 'usage', 'public_record')
  ),
  label text not null,
  status text not null default 'to_verify' check (status in ('documented', 'to_verify')),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  source_name text,
  source_kind text not null default 'sale_text' check (
    source_kind in ('sale_text', 'source_payload', 'document', 'pdf', 'risk', 'score_factor', 'llm', 'manual')
  ),
  document_url text,
  document_label text,
  document_type text,
  page_number integer,
  excerpt text,
  action text,
  confidence numeric not null default 0.65 check (confidence >= 0 and confidence <= 1),
  detector text not null default 'urban_planning_regex',
  detector_version text not null default 'urban_planning_v1',
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.auction_urban_planning_signals is
  'Structured PLU, permit, servitude, co-ownership and public-record signals detected for judicial sales and reused in opportunity reports.';

create unique index if not exists auction_urban_planning_signals_source_key_uidx
  on public.auction_urban_planning_signals (source_url, signal_key);

create index if not exists auction_urban_planning_signals_source_url_idx
  on public.auction_urban_planning_signals (source_url);

create index if not exists auction_urban_planning_signals_kind_status_idx
  on public.auction_urban_planning_signals (signal_kind, status, priority);

create index if not exists auction_urban_planning_signals_document_url_idx
  on public.auction_urban_planning_signals (document_url)
  where document_url is not null;

drop trigger if exists immojudis_auction_urban_planning_signals_updated_at
on public.auction_urban_planning_signals;
create trigger immojudis_auction_urban_planning_signals_updated_at
before update on public.auction_urban_planning_signals
for each row
execute function app_private.set_user_profiles_updated_at();

alter table public.auction_urban_planning_signals enable row level security;

revoke all on table public.auction_urban_planning_signals from anon, authenticated;
grant select, insert, update, delete on table public.auction_urban_planning_signals to service_role;

notify pgrst, 'reload schema';

commit;
