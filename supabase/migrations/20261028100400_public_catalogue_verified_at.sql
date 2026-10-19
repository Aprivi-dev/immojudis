begin;

set local lock_timeout = '5s';

-- Date de la dernière collecte réussie, pour la ligne de l'accueil (point 57 du compte-rendu du
-- 18/10/2026). « N ventes à venir · mises à jour le … » annonçait la plus récente `updated_at` d'une fiche
-- (date technique, relue sur ~1 900 ventes par le sitemap) ; l'accueil dit désormais « données vérifiées
-- le … » et cette date est celle de la dernière collecte réussie d'une source :
--   auction_source_state.last_publication_complete_at = inventaire complet de la source ET publication
--   sans reste (posée par src/autonomous_runner.py), la plus récente de toutes les sources.
--
-- Lecture minimale : UNE ligne agrégée sur dix, sans toucher à auction_sales. Seule la date sort de la
-- base (aucun nom de source, aucun compteur). Une date dans le futur (horloge ou donnée fausse) est
-- ramenée à l'heure courante ; aucune collecte réussie donne NULL, et l'accueil n'affiche alors pas de date.

create or replace function app_private.get_public_catalogue_verified_at()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select least(max(state.last_publication_complete_at), pg_catalog.now())
  from public.auction_source_state state
  where state.last_publication_complete_at is not null;
$function$;

comment on function app_private.get_public_catalogue_verified_at() is
  'Date de la dernière collecte réussie (la plus récente last_publication_complete_at des sources), ramenée à now() si elle est dans le futur ; NULL si aucune. Seule la date sort de la base.';

revoke all on function app_private.get_public_catalogue_verified_at()
  from public, anon, authenticated;
grant execute on function app_private.get_public_catalogue_verified_at()
  to anon, authenticated, service_role;

create or replace function public.get_public_catalogue_verified_at()
returns timestamptz
language sql
stable
set search_path = ''
as $function$
  select app_private.get_public_catalogue_verified_at();
$function$;

revoke all on function public.get_public_catalogue_verified_at() from public;
grant execute on function public.get_public_catalogue_verified_at()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
