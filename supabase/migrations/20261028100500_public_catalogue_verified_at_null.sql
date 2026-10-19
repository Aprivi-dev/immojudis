begin;

set local lock_timeout = '5s';

-- Correctif de 20261028100400 : LEAST ignore les NULL en PostgreSQL, donc
-- least(max(last_publication_complete_at), now()) rendait l'heure courante quand AUCUNE collecte n'avait
-- réussi, au lieu de NULL : l'accueil aurait affiché « données vérifiées » à la date du jour. Le NULL est
-- maintenant testé avant de ramener une date future à l'heure courante. Même signature, mêmes droits.

create or replace function app_private.get_public_catalogue_verified_at()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when latest.at is null then null
    else least(latest.at, pg_catalog.now())
  end
  from (
    select max(state.last_publication_complete_at) as at
    from public.auction_source_state state
  ) latest;
$function$;

revoke all on function app_private.get_public_catalogue_verified_at()
  from public, anon, authenticated;
grant execute on function app_private.get_public_catalogue_verified_at()
  to anon, authenticated, service_role;

commit;
