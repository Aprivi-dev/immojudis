begin;

set local lock_timeout = '5s';

-- Pages /tribunaux/[slug] : le référentiel public des tribunaux.
--
-- Les adresses des pages tribunal viennent désormais du code du tribunal (stable), et non plus du
-- nom parmi les seuls tribunaux qui ont des ventes à venir. Pour servir la page d'un tribunal connu
-- qui n'a plus de vente à venir (message « aucune vente à venir », hors index) au lieu d'un 404, la
-- page doit connaître tous les tribunaux : la table public.tribunals n'est lisible que par les
-- comptes connectés, cette fonction en rend la partie publique (code, nom, ville, département) à un
-- visiteur sans compte. Aucune donnée de vente ni personnelle.

create or replace function app_private.get_public_tribunal_directory()
returns table (
  code text,
  canonical_name text,
  city text,
  department text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select t.code, t.canonical_name, t.city, t.department
  from public.tribunals t
  order by t.code;
$function$;

revoke all on function app_private.get_public_tribunal_directory()
  from public, anon, authenticated;
grant execute on function app_private.get_public_tribunal_directory()
  to anon, authenticated, service_role;

create or replace function public.get_public_tribunal_directory()
returns table (
  code text,
  canonical_name text,
  city text,
  department text
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_tribunal_directory();
$function$;

revoke all on function public.get_public_tribunal_directory() from public;
grant execute on function public.get_public_tribunal_directory()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
