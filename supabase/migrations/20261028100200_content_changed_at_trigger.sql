begin;

set local lock_timeout = '5s';

-- 2/3 de « date de modification fiable des fiches » (contexte dans 20261028100100). Suppose la colonne
-- content_changed_at.
--
-- Déclencheur BEFORE UPDATE : quand une écriture change un champ VISIBLE de la fiche, la colonne prend
-- l'heure de la transaction. Les écritures qui ne changent aucun de ces champs (passage de la collecte
-- sans changement, journal, relecture IA, projections, last_seen_at, updated_at…) la laissent intacte.
--
-- Champs suivis (colonnes réelles de public.auction_sales) :
--   starting_price_eur                        mise à prix
--   sale_date                                 date de vente
--   status                                    statut
--   address, postal_code, city                adresse
--   app_surface_m2                            surface
--   rooms_count, bedrooms_count, bathrooms_count   pièces
--   catalogue_thumbnail_url                   photo principale (projection de raw_payload.raw_image_url)
-- Il n'existe pas de colonne « nombre de photos » : le nombre de photos d'une fiche se lit dans
-- raw_payload (jsonb de plusieurs centaines de Ko), que ce déclencheur ne relit volontairement pas. La
-- photo principale, qui est ce que la fiche montre en premier, est suivie par sa projection.
--
-- Une écriture qui renseigne elle-même content_changed_at l'emporte (rattrapage ou correction manuelle).
-- Le déclencheur porte le nom le plus tardif de la table (« zzzzzz_ », après « zzzzz_ » de la visibilité
-- et « zzzz_ » des projections) : sa clause WHEN est évaluée après les autres déclencheurs BEFORE, donc
-- sur la ligne définitive (la photo projetée, par exemple, est déjà recalculée).
--
-- À APPLIQUER HORS COLLECTE : CREATE TRIGGER prend un verrou SHARE ROW EXCLUSIVE (les lectures continuent,
-- les écritures attendent quelques millisecondes). lock_timeout (5 s) fait échouer la migration sans effet
-- si le verrou n'est pas obtenu. Aucun rattrapage : les lignes existantes restent à NULL.

create or replace function app_private.stamp_auction_sale_content_changed_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  -- Une valeur écrite à la main (ou par un rattrapage) n'est pas écrasée.
  if new.content_changed_at is distinct from old.content_changed_at then
    return new;
  end if;
  new.content_changed_at := pg_catalog.now();
  return new;
end;
$function$;

comment on function app_private.stamp_auction_sale_content_changed_at() is
  'Déclencheur BEFORE UPDATE de auction_sales : date le dernier changement d''un champ visible de la fiche (content_changed_at).';

revoke all on function app_private.stamp_auction_sale_content_changed_at()
  from public, anon, authenticated;
grant execute on function app_private.stamp_auction_sale_content_changed_at() to service_role;

drop trigger if exists zzzzzz_auction_sales_content_changed_at on public.auction_sales;
create trigger zzzzzz_auction_sales_content_changed_at
  before update on public.auction_sales
  for each row
  when (
    old.starting_price_eur is distinct from new.starting_price_eur
    or old.sale_date is distinct from new.sale_date
    or old.status is distinct from new.status
    or old.address is distinct from new.address
    or old.postal_code is distinct from new.postal_code
    or old.city is distinct from new.city
    or old.app_surface_m2 is distinct from new.app_surface_m2
    or old.rooms_count is distinct from new.rooms_count
    or old.bedrooms_count is distinct from new.bedrooms_count
    or old.bathrooms_count is distinct from new.bathrooms_count
    or old.catalogue_thumbnail_url is distinct from new.catalogue_thumbnail_url
  )
  execute function app_private.stamp_auction_sale_content_changed_at();

commit;
