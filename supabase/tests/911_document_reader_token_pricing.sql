-- 20261207100000 (21/11/2026) : Claude Haiku 5.5 et Claude Sonnet 5.5, lecteurs des pièces, entrent dans la grille
-- des réservations aux prix de TOKEN_PRICES (services/data-pipeline/src/pipeline_usage.py) ; Haiku n'est réservé
-- que sous 100 000 jetons d'entrée (au-delà, son prix quintuple) ; les modèles existants gardent leurs prix et le
-- plafond de sortie (qui borne aussi la réflexion) reste de 32 768 jetons.
begin;

select plan(8);

set local role service_role;

delete from public.auction_runs where status in ('queued', 'running');
update public.auction_pipeline_control
   set max_ai_predictions_per_run = 40,
       daily_ai_budget_usd = 1000
 where id;
insert into public.auction_runs (id, status, source, scheduler_owned, started_at, summary, errors)
values ('91100000-0000-4000-8000-000000000001', 'running', 'enrichment-queue', true,
        statement_timestamp(), '{"running_lease_seconds": 7200}'::jsonb, '{}'::jsonb);

select is(
  (select reserved_usd from public.auction_pipeline_usage where id = public.reserve_pipeline_prediction(
    '91100000-0000-4000-8000-000000000001', 'claude-haiku-5-5', 100000, 16000)),
  0.018::numeric,
  'Claude Haiku 5.5 reserves 0.10 USD per million input tokens and 0.50 per million output tokens'
);

select is(
  (select reserved_usd from public.auction_pipeline_usage where id = public.reserve_pipeline_prediction(
    '91100000-0000-4000-8000-000000000001', 'claude-sonnet-5-5', 25000, 16000)),
  0.21::numeric,
  'Claude Sonnet 5.5 reserves 2 USD per million input tokens and 10 per million output tokens'
);

select is(
  (select reserved_usd from public.auction_pipeline_usage where id = public.reserve_pipeline_prediction(
    '91100000-0000-4000-8000-000000000001', 'qwen/qwen3-7-plus', 1000, 500)),
  0.0008265::numeric,
  'Qwen3.7 Plus keeps its price'
);

select is(
  (select rate_source from public.auction_pipeline_usage
    where run_id = '91100000-0000-4000-8000-000000000001' and model = 'claude-sonnet-5-5'),
  'https://platform.claude.com/docs/en/about-claude/pricing; checked 2026-11-21',
  'the reservation keeps its price source'
);

select throws_ok(
  $$select public.reserve_pipeline_prediction('91100000-0000-4000-8000-000000000001', 'claude-haiku-5-5', 100001, 1)$$,
  '22023',
  'Input token ceiling must be between 1 and 100000 for Claude Haiku 5.5',
  'a Haiku prompt over 100,000 tokens, priced five times higher, is never reserved'
);

select throws_ok(
  $$select public.reserve_pipeline_prediction('91100000-0000-4000-8000-000000000001', 'claude-sonnet-5-5', 1, 32769)$$,
  '22023',
  'Output token ceiling must be between 1 and 32768',
  'the output ceiling, thinking included, stays bounded'
);

select throws_ok(
  $$select public.reserve_pipeline_prediction('91100000-0000-4000-8000-000000000001', 'claude-opus-5-5', 1, 1)$$,
  'P0001',
  'Automatic AI model has no configured cost reservation',
  'an unpriced model is still refused'
);

select ok(
  (select (public.pipeline_usage_summary() ->> 'rate_source') like '%claude-haiku-5-5 input 0.10 USD/M%'
      and (public.pipeline_usage_summary() ->> 'rate_source') like '%claude-sonnet-5-5 input 2 USD/M%'
      and (public.pipeline_usage_summary() ->> 'rate_source') like '%qwen/qwen3-7-plus; input 0.276 USD/M%'),
  'the usage summary lists the new price sources next to the existing ones'
);

select * from finish();

rollback;
