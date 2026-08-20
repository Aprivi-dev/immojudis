begin;

-- Judilibre is an official open-data source distributed by the Cour de
-- cassation under Licence Ouverte 2.0. Activation remains bounded by the
-- runtime flag, private Storage, review-only matching and the physical purge
-- worker shipped with the same release.
update public.data_sources
set
  publisher = 'Cour de cassation',
  official = true,
  base_url = 'https://api.piste.gouv.fr/cassation/judilibre/v1.0',
  license = 'Licence Ouverte / Open Licence 2.0',
  terms_url = 'https://www.courdecassation.fr/conditions-generales-dutilisation-pour-la-reutilisation-des-donnees-judiciaires-ouvertes-open-data',
  terms_version = 'reviewed_2026-08-20',
  legal_review_status = 'approved',
  ingestion_policy = 'allowed_automated',
  rate_limit = jsonb_build_object(
    'history_refresh_max_hours', 72,
    'retry_after_respected', true,
    'search_page_size_max', 50,
    'transactional_history_page_size', 100
  ),
  personal_data_possible = true,
  active = true,
  updated_at = now()
where name = 'judilibre';

do $$
begin
  if not exists (
    select 1
    from public.data_sources
    where name = 'judilibre'
      and official
      and legal_review_status = 'approved'
      and ingestion_policy = 'allowed_automated'
      and active
      and terms_version = 'reviewed_2026-08-20'
  ) then
    raise exception 'Judilibre source policy activation failed';
  end if;
end;
$$;

-- The bucket remains private. DELETE is granted only to the trusted server
-- role so upstream corrections and occultations can be physically propagated.
grant delete on table storage.objects to service_role;

commit;
