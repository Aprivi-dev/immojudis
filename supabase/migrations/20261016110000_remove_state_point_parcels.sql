begin;

set local lock_timeout = '5s';

-- Owner decision (11/10/2026): the old cadastre parcels of the State sales
-- (cessions de l'État) found under the sale point are removed. They date from
-- the 12/09/2026 enrichment, when most State sales were placed at the commune
-- centroid, so the parcel under that point is usually wrong. Parcels are now
-- resolved from the references the State publishes (match_kind
-- reference_lookup); a later point lookup uses the corrected coordinates.
-- A copy of the rows is kept in app_private (created on 11/10/2026 when present).
create table if not exists app_private.cessions_point_parcels_backup_20261011
  (like public.auction_cadastre_parcels);
revoke all on app_private.cessions_point_parcels_backup_20261011
  from public, anon, authenticated;

insert into app_private.cessions_point_parcels_backup_20261011
select p.*
  from public.auction_cadastre_parcels p
 where p.match_kind = 'point_intersection'
   and p.source_url in (select s.source_url from public.auction_sales s where s.source_name = 'cessions_etat')
   and not exists (
     select 1 from app_private.cessions_point_parcels_backup_20261011 b where b.id = p.id
   );

delete from public.auction_cadastre_parcels p
 where p.match_kind = 'point_intersection'
   and p.source_url in (select s.source_url from public.auction_sales s where s.source_name = 'cessions_etat');

commit;
