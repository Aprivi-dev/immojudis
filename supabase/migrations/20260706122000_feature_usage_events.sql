begin;

create table if not exists public.feature_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null check (
    event_key in (
      'property_report.created',
      'property_report.pdf_exported',
      'sales.csv_exported',
      'sales.api_feed_requested',
      'lawyer.referral_requested'
    )
  ),
  quantity integer not null default 1 check (quantity > 0),
  subject_type text,
  subject_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.feature_usage_events is
  'User-owned usage log for metered ImmoJudis offer features, quotas and billing analytics.';

create index if not exists feature_usage_events_user_key_created_idx
  on public.feature_usage_events (user_id, event_key, created_at desc);

create index if not exists feature_usage_events_key_created_idx
  on public.feature_usage_events (event_key, created_at desc);

create index if not exists feature_usage_events_subject_idx
  on public.feature_usage_events (subject_type, subject_id);

alter table public.feature_usage_events enable row level security;

revoke all on table public.feature_usage_events from anon, authenticated;
grant select on table public.feature_usage_events to authenticated;
grant select, insert, update, delete on table public.feature_usage_events to service_role;

drop policy if exists feature_usage_events_select_authorized
on public.feature_usage_events;
create policy feature_usage_events_select_authorized
on public.feature_usage_events
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
