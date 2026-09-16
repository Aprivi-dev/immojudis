begin;

create table if not exists public.llm_usage_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  provider text not null default 'replicate',
  model text not null,
  prediction_id text,
  request_kind text not null,
  attempt_number integer not null default 1,
  prompt_chars integer not null default 0,
  system_prompt_chars integer not null default 0,
  output_chars integer not null default 0,
  succeeded boolean not null default false,
  error_message text
);

comment on table public.llm_usage_events is
  'Operational telemetry for external LLM calls; contains sizes and outcomes, not prompts or source documents.';

alter table public.llm_usage_events enable row level security;
revoke all on table public.llm_usage_events from public, anon, authenticated;
grant select, insert on table public.llm_usage_events to service_role;

create index if not exists llm_usage_events_created_at_idx
  on public.llm_usage_events(created_at desc);
create index if not exists llm_usage_events_kind_created_at_idx
  on public.llm_usage_events(request_kind, created_at desc);

commit;
