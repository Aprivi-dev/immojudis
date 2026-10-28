begin;

set local lock_timeout = '5s';

-- Cache des annonces refusées à l'écriture par la règle de minimum (services/data-pipeline/src/listing_minimum.py,
-- migration 20261108202000). Une annonce refusée n'est pas en base : sans mémoire, le collecteur relirait sa fiche de
-- détail à chaque passage (400 à 600 fiches pour Vench et Petites Affiches, à 1,5 s la requête, avec des passages que
-- le chien de garde coupe déjà). Le pipeline écrit ici l'annonce qu'il refuse et ne relit pas sa fiche pendant 7 jours
-- (src/rejected_listings.py) ; passé ce délai elle est relue, la fiche a pu s'enrichir (un email publié, une pièce).
--
-- CE QUE LA TABLE N'EST PAS : ni une source de vérité ni une décision de catalogue. Elle ne change ni l'inventaire de
-- la source (l'annonce sautée reste découverte et reçoit la décision « excluded » dans auction_collection_items, comme
-- une annonce refusée après lecture), ni la santé des sources, ni l'alerte de baisse d'inventaire. Vide ou absente, le
-- pipeline relit les fiches comme avant : aucun risque de perte.
--
-- MINIMISATION : l'URL publique de l'annonce, la source, la date du refus et une empreinte des champs de la vignette
-- (date, prix, statut) qui fait relire la fiche si l'un d'eux change. Aucune donnée de la fiche, aucune donnée
-- personnelle.
--
-- CONSERVATION : 30 jours. app_private.purge_rejected_listings supprime les lignes plus anciennes ; le pipeline
-- l'appelle quand il charge le cache. Elle n'est pas (encore) branchée dans public.run_data_retention : cette
-- fonction est redéfinie par plusieurs migrations en cours, un correctif à part l'y ajoutera sans conflit
-- (règle 7 de supabase/README.md).
--
-- DROITS : sur le modèle de app_private.auction_sale_source_presence : RLS activée, aucun droit pour anon ni
-- authenticated, lecture et écriture par le rôle de service.

create table if not exists app_private.rejected_listings (
  source_url text primary key check (length(btrim(source_url)) > 0),
  source_name text not null check (length(btrim(source_name)) > 0),
  rejected_at timestamptz not null default now(),
  fingerprint text,
  reason text not null default 'insufficient_listing' check (reason in ('insufficient_listing'))
);

comment on table app_private.rejected_listings is
  'Annonces refusées à l''écriture par la règle de minimum : leur fiche de détail n''est pas relue pendant 7 jours. Cache jetable (30 jours), jamais une décision de catalogue.';
comment on column app_private.rejected_listings.source_url is
  'URL publique de l''annonce, normalisée (sans fragment).';
comment on column app_private.rejected_listings.fingerprint is
  'Empreinte de la vignette au moment du refus (date, prix, statut) : si elle change, la fiche est relue avant 7 jours.';

create index if not exists rejected_listings_rejected_at_idx
  on app_private.rejected_listings (rejected_at);

alter table app_private.rejected_listings enable row level security;
revoke all on table app_private.rejected_listings from public, anon, authenticated, service_role;
grant select, insert, update, delete on table app_private.rejected_listings to service_role;
drop policy if exists rejected_listings_service_role on app_private.rejected_listings;
create policy rejected_listings_service_role
  on app_private.rejected_listings
  for all to service_role
  using (true)
  with check (true);

create or replace function app_private.purge_rejected_listings(
  p_now timestamptz default statement_timestamp(),
  p_keep interval default interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted integer;
begin
  if p_now is null or p_keep is null or p_keep < interval '1 day' then
    raise exception using errcode = '22023', message = 'The rejected listings purge needs a date and a delay of at least one day.';
  end if;
  delete from app_private.rejected_listings where rejected_at < p_now - p_keep;
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('rejected_listings', v_deleted);
end;
$function$;

revoke all on function app_private.purge_rejected_listings(timestamptz, interval) from public, anon, authenticated;
grant execute on function app_private.purge_rejected_listings(timestamptz, interval) to service_role;

comment on function app_private.purge_rejected_listings(timestamptz, interval) is
  'Supprime les refus de plus de 30 jours (cache des annonces refusées). Appelée par le pipeline au chargement du cache.';

notify pgrst, 'reload schema';

commit;
