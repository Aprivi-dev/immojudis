begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères » (point 16 du compte-rendu du 23/10/2026, validé par le propriétaire) : les cinq
-- tranches de mise à prix (moins de 20 k€, 20-50 k€, 50-100 k€, 100-200 k€, 200 k€ et plus) créaient des effets de
-- seuil : un lot à 49 000 € et un lot à 21 000 € étaient comparés, un lot à 51 000 € et un lot à 99 000 € aussi.
-- La grille passe à SEPT tranches :
--
--   1  moins de 20 000 €
--   2  de 20 000 à 35 000 €
--   3  de 35 000 à 50 000 €
--   4  de 50 000 à 75 000 €
--   5  de 75 000 à 100 000 €
--   6  de 100 000 à 200 000 €
--   7  200 000 € et plus
--
-- Pourquoi sept et pas dix : mesuré en production le 23/10/2026 en lecture seule (cliché de 3 783 lots, trois
-- ans, mise à prix d'au moins 1 000 €), la part des lots dont le tribunal a au moins 10 / au moins 30 ventes
-- comparables dans sa tranche est de 92,3 % / 72,2 % avec la grille à 5 tranches, 89,3 % / 58,6 % avec cette
-- grille à 7 tranches, 85,8 % / 46,6 % avec une grille à 10 tranches. Les effectifs nationaux par tranche fine
-- sont tous d'au moins 184, loin du seuil de 30 ventes nationales.
--
-- Ce qui change : la seule fonction app_private.starting_price_band. Les fonctions qui l'appellent
-- (court_auction_scenarios dans ses deux signatures, public.get_court_auction_scenarios) la résolvent à chaque
-- exécution (langage sql, sans « begin atomic ») : elles n'ont pas à être redéfinies et gardent leur dernière
-- définition (20261101120100), donc :
--   * le seuil national de 30 ventes comparables (aucun chiffre en dessous) ;
--   * le repli sur le taux national sous 10 ventes du tribunal, le lissage au poids 15 à partir de 10, la fourchette
--     de prix du tribunal à partir de 20, les niveaux de fiabilité (30 / 10) ;
--   * la nature du bien, l'absence de scénario sous 1 000 €, la forme du JSON
-- sont inchangés. Seul le contenu de la clé « band » (1 à 7 au lieu de 1 à 5) et la composition des échantillons
-- comparés changent. Aucune table ni vue ne stocke la tranche (le cliché garde les prix, la tranche se calcule
-- à la lecture).
--
-- Droits identiques à ceux de 20261031100600, conservés tels quels : service_role seul (la fonction appelante n'est
-- pas security definer). Le code (src/lib/auction-scenarios.ts, STARTING_PRICE_BAND_UPPER_BOUNDS) reprend ces bornes ; un test
-- vitest compare les deux. Mise en production : appliquer la migration puis déployer le code dans la foulée. Entre
-- les deux, l'ancien code envoie ses prix de référence (20 000, 50 000, 100 000, 200 000 €) à la nouvelle grille et
-- affiche donc, pour quelques minutes, des libellés de l'ancienne grille ; le nouveau code lit un cache sous une
-- nouvelle clé (« v2 ») : aucune réponse de l'ancienne grille ne lui est resservie.

create or replace function app_private.starting_price_band(p_starting_price numeric)
returns smallint
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_starting_price is null or p_starting_price <= 0 then null
    when p_starting_price < 20000 then 1
    when p_starting_price < 35000 then 2
    when p_starting_price < 50000 then 3
    when p_starting_price < 75000 then 4
    when p_starting_price < 100000 then 5
    when p_starting_price < 200000 then 6
    else 7
  end::smallint;
$function$;

-- Les droits ne sont pas rejoués : « create or replace » garde la liste d'accès posée par 20261031100600
-- (service_role seul), que le test pgTAP 715 vérifie.

-- Garde : la définition qui vient d'être posée rend bien les sept tranches, bornes comprises. Une faute de
-- frappe annule toute la migration plutôt que de fausser les comparaisons.
do $guard$
begin
  if app_private.starting_price_band(null) is not null
     or app_private.starting_price_band(0) is not null
     or app_private.starting_price_band(-1) is not null
     or app_private.starting_price_band(1000) is distinct from 1
     or app_private.starting_price_band(19999.99) is distinct from 1
     or app_private.starting_price_band(20000) is distinct from 2
     or app_private.starting_price_band(34999.99) is distinct from 2
     or app_private.starting_price_band(35000) is distinct from 3
     or app_private.starting_price_band(49999.99) is distinct from 3
     or app_private.starting_price_band(50000) is distinct from 4
     or app_private.starting_price_band(74999.99) is distinct from 4
     or app_private.starting_price_band(75000) is distinct from 5
     or app_private.starting_price_band(99999.99) is distinct from 5
     or app_private.starting_price_band(100000) is distinct from 6
     or app_private.starting_price_band(199999.99) is distinct from 6
     or app_private.starting_price_band(200000) is distinct from 7
     or app_private.starting_price_band(5000000) is distinct from 7 then
    raise exception 'starting_price_band: the seven-band grid is not the expected one';
  end if;
end;
$guard$;

notify pgrst, 'reload schema';

commit;
