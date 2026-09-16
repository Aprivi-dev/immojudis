begin;

alter table public.llm_usage_events
  add column if not exists input_tokens_estimate integer not null default 0,
  add column if not exists output_tokens_estimate integer not null default 0;

commit;
