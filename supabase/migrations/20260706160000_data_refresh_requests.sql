begin;

create table if not exists public.data_refresh_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  request_kind text not null check (request_kind in ('cadastre', 'dpe', 'full')),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  priority integer not null default 50 check (priority >= 0 and priority <= 100),
  requested_payload jsonb not null default '{}'::jsonb,
  result_summary jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.data_refresh_requests is
  'User-triggered queue for on-demand DPE and cadastral enrichment refreshes on judicial sales.';

comment on column public.data_refresh_requests.request_kind is
  'Refresh scope requested by the app: cadastre, dpe, or full.';

comment on column public.data_refresh_requests.source_url is
  'Stable auction source URL used by the pipeline enrichment tables.';

create index if not exists data_refresh_requests_user_created_idx
  on public.data_refresh_requests (user_id, created_at desc);

create index if not exists data_refresh_requests_sale_created_idx
  on public.data_refresh_requests (sale_id, created_at desc);

create index if not exists data_refresh_requests_queue_idx
  on public.data_refresh_requests (status, priority desc, created_at asc)
  where status in ('queued', 'running');

create unique index if not exists data_refresh_requests_user_source_kind_active_idx
  on public.data_refresh_requests (user_id, source_url, request_kind)
  where status in ('queued', 'running');

alter table public.data_refresh_requests enable row level security;

revoke all on table public.data_refresh_requests from anon, authenticated;
grant select, insert on table public.data_refresh_requests to authenticated;
grant select, insert, update, delete on table public.data_refresh_requests to service_role;

drop trigger if exists immojudis_data_refresh_requests_updated_at
on public.data_refresh_requests;
create trigger immojudis_data_refresh_requests_updated_at
before update on public.data_refresh_requests
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists data_refresh_requests_select_authorized
on public.data_refresh_requests;
create policy data_refresh_requests_select_authorized
on public.data_refresh_requests
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists data_refresh_requests_insert_own
on public.data_refresh_requests;
create policy data_refresh_requests_insert_own
on public.data_refresh_requests
for insert
to authenticated
with check (user_id = (select auth.uid()));

alter table public.feature_usage_events
  drop constraint if exists feature_usage_events_event_key_check;

alter table public.feature_usage_events
  add constraint feature_usage_events_event_key_check check (
    event_key in (
      'property_report.created',
      'property_report.pdf_exported',
      'sales.csv_exported',
      'sales.api_feed_requested',
      'sale_history.viewed',
      'market.analytics_viewed',
      'dpe.explorer_viewed',
      'sales.favorite_added',
      'sales.favorite_removed',
      'sales.statistics_viewed',
      'bid_ceiling.calculated',
      'dvf.comparables_viewed',
      'workspace.audience_tracking_viewed',
      'sale_changes.monitored',
      'lawyer.referral_requested',
      'data_refresh.requested'
    )
  );

notify pgrst, 'reload schema';

commit;
