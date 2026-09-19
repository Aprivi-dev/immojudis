begin;

-- A reservation is inserted by reserve_llm_request immediately before each
-- provider POST.  Keeping that row when the POST has an ambiguous transport
-- outcome prevents a later worker from sending the same paid request blindly.
alter table public.llm_usage_events
  add column if not exists request_status text not null default 'completed',
  add column if not exists sale_id text,
  add column if not exists job_id text,
  add column if not exists source_url text,
  add column if not exists stage text,
  add column if not exists reason text,
  add column if not exists request_key text,
  add column if not exists input_tokens_estimate integer,
  add column if not exists output_tokens_estimate integer;

alter table public.llm_usage_events
  add constraint llm_usage_events_request_status_check
  check (request_status in ('completed', 'reserved', 'succeeded', 'failed', 'rate_limited', 'ambiguous', 'released'));

alter table public.llm_usage_events
  add constraint llm_usage_events_token_estimates_check
  check (
    (input_tokens_estimate is null or input_tokens_estimate >= 0)
    and (output_tokens_estimate is null or output_tokens_estimate >= 0)
  );

comment on column public.llm_usage_events.request_status is
  'Lifecycle of the external request reservation; released rows did not result in a provider POST.';
comment on column public.llm_usage_events.sale_id is
  'Bounded sale identifier attached by the enrichment caller; no prompt or source document is stored.';
comment on column public.llm_usage_events.job_id is
  'Bounded enrichment job identifier attached by the queue caller.';

grant update on table public.llm_usage_events to service_role;

create index if not exists llm_usage_events_budget_created_at_idx
  on public.llm_usage_events(provider, created_at desc)
  where request_status <> 'released';

create index if not exists llm_usage_events_request_key_idx
  on public.llm_usage_events(request_key, created_at desc)
  where request_key is not null and request_status in ('reserved', 'ambiguous');

create or replace function public.reserve_llm_request(
  p_provider text,
  p_model text,
  p_request_kind text,
  p_attempt_number integer default 1,
  p_max_calls_per_hour integer default 0,
  p_request_key text default null,
  p_sale_id text default null,
  p_job_id text default null,
  p_source_url text default null,
  p_stage text default null,
  p_reason text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  request_id uuid;
  request_count integer;
begin
  if nullif(btrim(p_provider), '') is null then
    raise exception 'LLM request provider is required';
  end if;
  if nullif(btrim(p_model), '') is null then
    raise exception 'LLM request model is required';
  end if;
  if nullif(btrim(p_request_kind), '') is null then
    raise exception 'LLM request kind is required';
  end if;
  if coalesce(p_max_calls_per_hour, 0) < 0 then
    raise exception 'LLM request hourly budget cannot be negative';
  end if;

  -- The lock makes the rolling-window count and insert one atomic operation
  -- across manual, queued and autonomous execution modes.
  perform pg_advisory_xact_lock(
    hashtextextended('immojudis:llm-request-budget:v1:' || p_provider, 0)
  );

  if nullif(btrim(p_request_key), '') is not null
     and exists (
       select 1
         from public.llm_usage_events
        where request_key = btrim(p_request_key)
          and request_status in ('reserved', 'ambiguous')
          and created_at >= now() - interval '30 minutes'
     ) then
    raise exception 'Unresolved LLM request key requires provider reconciliation before retry'
      using errcode = 'P0001';
  end if;

  if coalesce(p_max_calls_per_hour, 0) > 0 then
    select count(*)
      into request_count
      from public.llm_usage_events
     where provider = p_provider
       and created_at >= now() - interval '1 hour'
       and request_status <> 'released';

    if request_count >= p_max_calls_per_hour then
      raise exception 'Hourly LLM request budget exhausted'
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.llm_usage_events (
    provider,
    model,
    request_kind,
    attempt_number,
    request_key,
    request_status,
    succeeded,
    sale_id,
    job_id,
    source_url,
    stage,
    reason
  ) values (
    p_provider,
    p_model,
    p_request_kind,
    greatest(1, coalesce(p_attempt_number, 1)),
    nullif(btrim(p_request_key), ''),
    'reserved',
    false,
    nullif(btrim(p_sale_id), ''),
    nullif(btrim(p_job_id), ''),
    nullif(btrim(p_source_url), ''),
    nullif(btrim(p_stage), ''),
    nullif(btrim(p_reason), '')
  )
  returning id into request_id;

  return request_id;
end;
$$;

create or replace function public.finalize_llm_request(
  p_request_id uuid,
  p_request_status text,
  p_prediction_id text default null,
  p_succeeded boolean default false,
  p_prompt_chars integer default null,
  p_system_prompt_chars integer default null,
  p_output_chars integer default null,
  p_input_tokens_estimate integer default null,
  p_output_tokens_estimate integer default null,
  p_error_message text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.llm_usage_events
     set request_status = p_request_status,
         prediction_id = coalesce(nullif(btrim(p_prediction_id), ''), prediction_id),
         succeeded = coalesce(p_succeeded, false),
         prompt_chars = coalesce(p_prompt_chars, prompt_chars),
         system_prompt_chars = coalesce(p_system_prompt_chars, system_prompt_chars),
         output_chars = coalesce(p_output_chars, output_chars),
         input_tokens_estimate = coalesce(p_input_tokens_estimate, input_tokens_estimate),
         output_tokens_estimate = coalesce(p_output_tokens_estimate, output_tokens_estimate),
         error_message = coalesce(nullif(left(p_error_message, 1000), ''), error_message)
   where id = p_request_id;

  if not found then
    raise exception 'LLM request reservation % was not found', p_request_id;
  end if;
end;
$$;

revoke all on function public.reserve_llm_request(text, text, text, integer, integer, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_llm_request(text, text, text, integer, integer, text, text, text, text, text, text)
  to service_role;

revoke all on function public.finalize_llm_request(uuid, text, text, boolean, integer, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.finalize_llm_request(uuid, text, text, boolean, integer, integer, integer, integer, integer, text)
  to service_role;

commit;
