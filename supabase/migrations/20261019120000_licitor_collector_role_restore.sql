begin;

set local lock_timeout = '5s';

-- Incident du 12/10/2026 : la collecte Licitor posait « set role licitor_collector »
-- au niveau de la session, à travers le pooler en mode transaction. Le rôle restait
-- sur la connexion serveur partagée et d'autres collectes ont reçu « permission
-- denied » (vench, lecture des pièces). Le droit SET a été retiré à chaud pour
-- arrêter la fuite. Le code pose désormais le rôle avec « set local role », dans
-- chaque transaction (licitor_history_refresh.CollectorRoleConnection). Le
-- propriétaire a validé le rétablissement du droit le 12/10/2026.
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'licitor_collector') then
    execute 'grant licitor_collector to postgres with set true, inherit false';
  end if;
exception
  when insufficient_privilege then
    raise notice 'licitor_collector: SET option not granted (%), the refresh will report it', sqlerrm;
end;
$grant$;

commit;
