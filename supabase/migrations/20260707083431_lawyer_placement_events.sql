begin;

create table if not exists public.lawyer_placement_events (
  id uuid primary key default gen_random_uuid(),
  lawyer_id uuid not null references public.referenced_lawyers(id) on delete cascade,
  sale_id uuid references public.auction_sales(id) on delete set null,
  event_type text not null check (event_type in ('impression', 'cta_click')),
  placement_slot text not null default 'sale_detail_sticky',
  matching_basis text check (
    matching_basis in ('tribunal_code', 'department', 'postal_code_prefix', 'city')
  ),
  sector_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.lawyer_placement_events is
  'Anonymous-safe analytics for paid ImmoJudis referenced-lawyer placements on sale detail cards. Does not store source-site lawyer contacts.';

create index if not exists lawyer_placement_events_lawyer_type_created_idx
  on public.lawyer_placement_events (lawyer_id, event_type, created_at desc);

create index if not exists lawyer_placement_events_sale_created_idx
  on public.lawyer_placement_events (sale_id, created_at desc)
  where sale_id is not null;

create index if not exists lawyer_placement_events_created_idx
  on public.lawyer_placement_events (created_at desc);

alter table public.lawyer_placement_events enable row level security;

revoke all on table public.lawyer_placement_events from anon, authenticated;
grant select on table public.lawyer_placement_events to authenticated;
grant select, insert, update, delete on table public.lawyer_placement_events to service_role;

drop policy if exists lawyer_placement_events_select_admin
on public.lawyer_placement_events;
create policy lawyer_placement_events_select_admin
on public.lawyer_placement_events
for select
to authenticated
using (public.is_admin());

notify pgrst, 'reload schema';

commit;
