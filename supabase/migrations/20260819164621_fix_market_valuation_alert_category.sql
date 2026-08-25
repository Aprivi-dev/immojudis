begin;

alter table public.operational_alerts
  drop constraint if exists operational_alerts_category_check;

alter table public.operational_alerts
  add constraint operational_alerts_category_check check (
    category in ('cron', 'webhook', 'import', 'refresh_queue', 'dvf', 'valuation')
  );

notify pgrst, 'reload schema';

commit;
