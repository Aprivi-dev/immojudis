begin;

set local lock_timeout = '5s';

-- Retrait de Petites Affiches (décision du propriétaire, 30/10/2026), sur le modèle de Vench (20261109153217) :
--   - même catalogue que Vench : 368 des 375 ventes à venir observées sur Petites Affiches portent le numéro
--     de lot d'une vente Vench ;
--   - collecte cassée depuis le changement de présentation du site : les listes sont relues (#338) mais
--     aucune fiche ne donne sa commune, et chaque fiche est rejetée comme « identité non concordante » ;
--   - chaque collecte mettait en quarantaine 180 à 408 ventes fusionnées (dont 209 à venir qui ont une
--     autre source, Licitor, Avoventes…) que les collectes suivantes remettaient en ligne.
-- L'interrupteur arrête la collecte et masque les ventes dont Petites Affiches (et Vench, déjà retirée)
-- sont les seules sources : 155 ventes à venir, dont une seule était visible. Rien n'est supprimé. Pour
-- revenir en arrière :
--   select public.set_catalogue_source_withdrawal('petites_affiches', false);

do $migration$
begin
  if exists (select 1 from public.auction_source_state where source_name = 'petites_affiches') then
    perform public.set_catalogue_source_withdrawal(
      'petites_affiches',
      true,
      'Retirée le 30/10/2026 : même catalogue que Vench, fiches illisibles depuis le changement de présentation.'
    );
  end if;
end;
$migration$;

commit;
