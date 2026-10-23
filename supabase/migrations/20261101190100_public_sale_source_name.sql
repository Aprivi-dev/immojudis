begin;

set local lock_timeout = '5s';

-- Fiche publique d'une vente : le nom de la source d'origine de l'annonce.
--
-- La fiche sans compte montre des faits (type, surface, date, tribunal, mise à prix) sans dire d'où ils
-- viennent. Revue du 23/10/2026 : « sources non nommées ». Le nom de la source d'origine est déjà connu
-- en base (auction_sales.source_name) et déjà montré aux comptes (« Source : … »). Cette fonction le
-- rend pour une vente du catalogue public, et rien d'autre : ni l'adresse de l'annonce d'origine
-- (source_url), ni les autres adresses de la vente (source_urls), ni le contenu brut.
--
-- Fonction séparée plutôt qu'une colonne de plus dans get_public_sale_summary : la fiche la lit comme
-- la bande d'écart au marché (enrichissement), et une base sans la fonction laisse la fiche telle
-- qu'elle est. L'application ne nomme que les sources qu'elle connaît (src/lib/sale-source-links.ts)
-- et jamais une source retirée du catalogue (src/lib/withdrawn-sources.ts).
--
-- Même prédicat de visibilité que la bande : app_private.auction_sale_is_publicly_visible.

create or replace function app_private.get_public_sale_source_name(p_sale_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select s.source_name
  from public.auction_sales s
  where s.id = p_sale_id
    and app_private.auction_sale_is_publicly_visible(s.id);
$function$;

revoke all on function app_private.get_public_sale_source_name(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_source_name(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_source_name(p_sale_id uuid)
returns text
language sql
stable
set search_path = ''
as $function$
  select app_private.get_public_sale_source_name(p_sale_id);
$function$;

revoke all on function public.get_public_sale_source_name(uuid) from public;
grant execute on function public.get_public_sale_source_name(uuid)
  to anon, authenticated, service_role;

comment on function public.get_public_sale_source_name(uuid) is
  'Nom de la source d''origine (source_name) d''une vente du catalogue public ; rien d''autre (ni adresse d''annonce, ni contenu brut).';

notify pgrst, 'reload schema';

commit;
