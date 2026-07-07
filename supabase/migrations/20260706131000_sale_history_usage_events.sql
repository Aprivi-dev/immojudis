begin;

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
      'lawyer.referral_requested'
    )
  );

notify pgrst, 'reload schema';

commit;
