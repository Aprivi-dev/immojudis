begin;

set local lock_timeout = '5s';

-- A reading that failed (provider, budget, invalid output) was picked up again by
-- every pipeline run once 12 hours had passed, with no limit. Count the
-- consecutive failed attempts on the same input so that the pipeline
-- (services/data-pipeline/src/document_reading.py) can back off (12 h, then 24 h,
-- then 72 h) and give up at the fourth failure, with a readable error_code.
-- A reading that completes, or whose input changes, starts again from zero.
alter table public.auction_document_readings
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0);

comment on column public.auction_document_readings.attempt_count is
  'Consecutive failed reading attempts on the current input; 0 once the reading is completed.';

-- Readings already marked failed before this column existed have failed at least once.
update public.auction_document_readings
   set attempt_count = 1
 where status = 'failed'
   and attempt_count = 0;

notify pgrst, 'reload schema';

commit;
