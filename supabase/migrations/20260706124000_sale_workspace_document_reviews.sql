begin;

alter table public.sale_workspaces
  add column if not exists document_reviews jsonb not null default '{}'::jsonb;

comment on column public.sale_workspaces.document_reviews is
  'Per-document review status, notes, questions and read markers stored in the user-owned investor workspace.';

notify pgrst, 'reload schema';

commit;
