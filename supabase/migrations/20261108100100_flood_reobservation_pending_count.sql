begin;

set local lock_timeout = '5s';

-- « Inconnu » mêle deux choses : une position trop imprécise (état stable) et une panne de la source (transitoire, qui
-- doit se résorber) (compte-rendu du 27/10/2026, n° 41). Le nombre de ventes à venir EN ATTENTE DE RÉOBSERVATION
-- (une tentative a échoué : failure_count > 0) dit où en est la résorption, sans nouveau verdict : la page
-- /admin/pepites l'affiche, et la règle v2 peut être déclarée prête quand il est nul.
--
-- La table auction_sale_flood_risk est privée (service_role seul) et son nom ne sort pas de son magasin
-- (invariant de sécurité) : l'administration lit ce nombre par cette fonction, comme elle lit les pépites par
-- admin_list_sale_pepites. Service_role seul, jamais anon ni authenticated ; ne rend qu'un nombre.
--
-- DÉPLOIEMENT : le code s'arrête proprement sans cette fonction (le compteur est alors « non mesuré »).
-- RETOUR ARRIÈRE : drop function public.admin_count_flood_reobservation_pending(timestamptz).
create or replace function public.admin_count_flood_reobservation_pending(
  p_now timestamptz default now()
)
returns integer
language sql
stable
security invoker
set search_path = ''
as $function$
  select count(*)::integer
  from public.auction_sale_flood_risk risk
  join public.auction_sales sale on sale.id = risk.sale_id
  where risk.failure_count > 0
    and sale.status = 'upcoming'
    and sale.sale_date > p_now;
$function$;

revoke all on function public.admin_count_flood_reobservation_pending(timestamptz)
from public, anon, authenticated;
grant execute on function public.admin_count_flood_reobservation_pending(timestamptz) to service_role;

comment on function public.admin_count_flood_reobservation_pending(timestamptz) is
  'Nombre de ventes à venir dont la dernière observation d''inondation a échoué (failure_count > 0). Service_role seul ; ne rend qu''un nombre.';

notify pgrst, 'reload schema';

commit;
