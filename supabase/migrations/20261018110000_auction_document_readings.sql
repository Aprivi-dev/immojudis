begin;

set local lock_timeout = '5s';

-- « Lecture des pièces » (offre Analyse): the points a buyer must know, read by
-- the pipeline (services/data-pipeline/src/document_reading.py) in the persisted
-- page texts of the case documents. Every point carries a quote that was found
-- word for word in the cited page. Service role only: the web app checks the
-- plan before serving a reading, and a free account only learns how many points
-- were found.

create table if not exists public.auction_document_readings (
  sale_id uuid primary key references public.auction_sales (id) on delete cascade,
  source_url text not null,
  input_fingerprint text not null,
  prompt_version text not null,
  model text,
  status text not null check (status in ('completed', 'no_text', 'failed')),
  points jsonb not null default '[]'::jsonb check (jsonb_typeof(points) = 'array'),
  documents jsonb not null default '[]'::jsonb check (jsonb_typeof(documents) = 'array'),
  input_truncated boolean not null default false,
  error_code text,
  generated_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

alter table public.auction_document_readings enable row level security;
revoke all on table public.auction_document_readings from public, anon, authenticated;
grant select, insert, update, delete on table public.auction_document_readings to service_role;

notify pgrst, 'reload schema';

commit;
