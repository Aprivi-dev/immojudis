begin;

alter table public.user_subscriptions
  drop constraint if exists user_subscriptions_plan_code_check;

alter table public.user_subscriptions
  add constraint user_subscriptions_plan_code_check
  check (plan_code in ('decouverte', 'analyse', 'investisseur'));

comment on table public.user_subscriptions is
  'ImmoJudis subscription entitlements. Source of truth for Decouverte/Analyse/Investisseur feature access; not source-site contact data.';

notify pgrst, 'reload schema';

commit;
