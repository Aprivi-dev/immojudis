begin;

set local lock_timeout = '5s';

-- The sources registry (outcome graph foundation) had no place for the update frequency
-- and the credit that a licence imposes. Both are nullable and informative.
alter table public.data_sources
  add column if not exists update_frequency text,
  add column if not exists attribution_notice text;

comment on column public.data_sources.update_frequency is
  'How often the publisher refreshes the source, in plain words.';
comment on column public.data_sources.attribution_notice is
  'Credit the licence requires wherever data from this source is shown.';

-- Registered as manual, not active and pending legal review: the reference tables are
-- loaded by the "Reference data import" workflow, outside the outcome ingestion. A
-- pending source is never picked by the outcome tooling (it requires approved + active).
insert into public.data_sources (
  name,
  publisher,
  official,
  base_url,
  license,
  terms_url,
  terms_version,
  legal_review_status,
  ingestion_policy,
  rate_limit,
  personal_data_possible,
  active,
  update_frequency,
  attribution_notice
) values
  (
    'anil_rent_map',
    'ANIL (Agence nationale pour l''information sur le logement)',
    true,
    'https://www.data.gouv.fr/api/1/datasets/693aa2feed1bf4da603faa49/',
    'Licence Ouverte / Open Licence 2.0',
    'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
    'Licence Ouverte 2.0; carte des loyers 2025, mise à jour du 11 décembre 2025',
    'pending',
    'allowed_manual',
    '{}'::jsonb,
    false,
    false,
    'Annuelle (publication en décembre)',
    'Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin'
  ),
  (
    'tlv_zoning',
    'Ministère de la Transition écologique',
    true,
    'https://www.data.gouv.fr/api/1/datasets/liste-des-communes-selon-le-zonage-tlv-1/',
    'Licence Ouverte / Open Licence 2.0',
    'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
    'Licence Ouverte 2.0; décret n° 2025-1267 du 22 décembre 2025, mise à jour du 30 décembre 2025',
    'pending',
    'allowed_manual',
    '{}'::jsonb,
    false,
    false,
    'À chaque décret modifiant le zonage (dernier : 22 décembre 2025)',
    'Source : ministère de la Transition écologique, liste des communes selon le zonage TLV (article 232 du code général des impôts), mise à jour du 30 décembre 2025 ; Licence Ouverte 2.0'
  )
on conflict (name) do nothing;

notify pgrst, 'reload schema';

commit;
