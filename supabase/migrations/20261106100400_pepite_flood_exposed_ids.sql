begin;

set local lock_timeout = '5s';

-- Pépites « exposées » : parmi les pépites publiables, celles dont le bien est dans le périmètre d'un plan de
-- prévention des risques d'inondation (verdict « exposed » de la règle pepite-v2, enregistré dans
-- auction_sale_pepites.details.flood.verdict). C'est un fait PUBLIC, sans montant : la mention courte « zonage à
-- vérifier » s'affiche partout où le badge Pépite apparaît (cartes de liste, carte, fiche). Décision du fondateur
-- relayée par le chef d'orchestre le 26/10/2026 (relecture juridique).
--
-- Même schéma que list_public_pepite_sale_ids (20261104100000) : la logique est une fonction SECURITY DEFINER
-- d'app_private, la fonction de public est une enveloppe SECURITY INVOKER (une fonction SECURITY DEFINER de public
-- exécutable par anon est refusée par supabase/tests/441_function_privileges.sql). Elle ne rend que des
-- identifiants, et seulement ceux que get_public_sale_pepite publie À L'INSTANT de l'appel (mode « on », vente
-- publique et à venir, mise à prix et estimation inchangées, évaluation de moins de 36 heures) : jamais le détail
-- privé, jamais un montant. Sous la règle pepite-v1 (interrupteur fermé), details.flood est absent : liste vide.
--
-- DÉPLOIEMENT : le code applicatif fonctionne avant cette migration (la route /api/catalogue/pepites traite
-- « fonction absente » comme « aucune pépite exposée »).
--
-- RETOUR ARRIÈRE : drop function public.list_public_pepite_flood_exposed_ids() puis
-- app_private.list_public_pepite_flood_exposed_ids().

create or replace function app_private.list_public_pepite_flood_exposed_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select p.sale_id
  from public.auction_sale_pepites p
  -- Le mode est lu une fois (sous-requête évaluée une seule fois) ; la garde par vente reste dans
  -- get_public_sale_pepite, qui le relit : une seule garde interne.
  where (select app_private.sale_pepite_mode()) = 'on'
    and p.is_pepite
    and p.details #>> '{flood,verdict}' = 'exposed'
    and app_private.get_public_sale_pepite(p.sale_id)
  order by p.sale_id
  limit 5000;
$function$;

revoke all on function app_private.list_public_pepite_flood_exposed_ids() from public, anon, authenticated;
grant execute on function app_private.list_public_pepite_flood_exposed_ids() to anon, authenticated, service_role;

create or replace function public.list_public_pepite_flood_exposed_ids()
returns setof uuid
language sql
stable
set search_path = ''
as $function$
  select app_private.list_public_pepite_flood_exposed_ids();
$function$;

revoke all on function public.list_public_pepite_flood_exposed_ids() from public;
grant execute on function public.list_public_pepite_flood_exposed_ids() to anon, authenticated, service_role;

comment on function public.list_public_pepite_flood_exposed_ids() is
  'Identifiants des pépites publiables dont le bien est dans le périmètre d''un PPRi (mention « zonage à vérifier »), 5 000 au plus. Mode « on » seulement, mêmes gardes que get_public_sale_pepite. Aucun montant, aucun détail.';

notify pgrst, 'reload schema';

commit;
