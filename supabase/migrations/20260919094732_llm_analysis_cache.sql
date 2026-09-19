begin;

create table public.llm_analysis_cache (
  cache_key text not null
    check (cache_key ~ '^[0-9a-f]{64}$'),
  stage text not null
    check (length(stage) between 1 and 128),
  result jsonb not null
    check (jsonb_typeof(result) = 'object'),
  model text not null,
  created_at timestamptz not null default now(),
  primary key (cache_key, stage)
);

comment on table public.llm_analysis_cache is
  'Validated LLM extraction results keyed by source-content hash and analysis stage; prompts are never stored.';

alter table public.llm_analysis_cache enable row level security;
revoke all on table public.llm_analysis_cache from public, anon, authenticated;
grant select, insert, update on table public.llm_analysis_cache to service_role;

create index llm_analysis_cache_created_at_idx
  on public.llm_analysis_cache(created_at desc);

commit;
