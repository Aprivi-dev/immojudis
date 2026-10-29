begin;

set local lock_timeout = '5s';

-- Retrait de Vench (décision du propriétaire, 29/10/2026) : ses annonces sont rarement exploitables et sa
-- collecte échoue depuis le 26/10 (minuteur de sécurité à chaque run). On pose l'interrupteur de
-- 20261021110000 :
--   - la collecte s'arrête (enabled = false ; le planificateur ne la lance plus et l'alerte de retard se ferme) ;
--   - une vente dont Vench est la seule source reçoit la quarantaine « source_withdrawn » et quitte le
--     catalogue (16 ventes au 29/10, dont 14 à venir) ;
--   - une vente fusionnée avec une autre source reste visible ; le site masque ses liens, photos et pièces
--     hébergés par vench.fr (src/lib/withdrawn-sources.ts).
-- Aucune ligne n'est supprimée. Pour revenir en arrière :
--   select public.set_catalogue_source_withdrawal('vench', false);

do $migration$
begin
  if exists (select 1 from public.auction_source_state where source_name = 'vench') then
    perform public.set_catalogue_source_withdrawal(
      'vench',
      true,
      'Retirée le 29/10/2026 : annonces rarement exploitables, collecte en échec depuis le 26/10.'
    );
  end if;
end;
$migration$;

commit;
