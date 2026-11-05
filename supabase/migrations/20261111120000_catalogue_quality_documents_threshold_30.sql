-- Sentinelle qualité du catalogue : le seuil des ventes aux pièces non lues passe de 80 à 30 (05/11/2026).
--
-- Décision du propriétaire : garder 80 pendant le rattrapage de la relecture des pièces, puis descendre à 30.
-- Le rattrapage est fait : 14 ventes avec une pièce « incomplete » depuis plus de 3 jours au cliché du 05/11/2026,
-- et 230 des 296 ventes visibles avec pièces relues sous les règles actuelles. À 30, l'alerte signale de nouveau
-- un retard réel au lieu d'attendre qu'il double.
--
-- Seule la valeur documents_incomplete_max_sales change ; les autres seuils sont repris à l'identique.
begin;

set local lock_timeout = '5s';

create or replace function app_private.catalogue_quality_thresholds()
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'price_per_m2_max_eur', 30000,
    'price_per_m2_acknowledged_sale_ids',
      pg_catalog.jsonb_build_array('b13dcf59-fa8a-42d5-8c5b-a0de982994cf'),
    'missing_postal_code_ratio_max', 0.08,
    'ratio_minimum_live_sales', 100,
    'documents_incomplete_minimum_age_days', 3,
    'documents_incomplete_max_sales', 30,
    'example_limit', 5
  );
$$;

revoke all on function app_private.catalogue_quality_thresholds() from public, anon, authenticated;
grant execute on function app_private.catalogue_quality_thresholds() to service_role;

comment on function app_private.catalogue_quality_thresholds() is
  'Seuils des alertes catalogue.quality.* : 30 000 €/m² (hors ventes reconnues), 8 % de ventes sans code postal à partir de 100 ventes en ligne, 30 ventes avec une pièce incomplete depuis plus de 3 jours (80 jusqu''au 05/11/2026). Les invariants (chambres >= pièces, terrain avec pièces, lot Licitor) alertent dès 1 vente.';

commit;
