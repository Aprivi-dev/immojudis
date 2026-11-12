begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2c, étape C4 : OUVERTURE DES DROITS (validée par le propriétaire le 12/11/2026).
-- C'est la bascule : après cette migration, un administrateur connecté peut écrire une décision du registre.
--
-- Les quatre fonctions publiques de décision deviennent exécutables par le rôle « authenticated », et par lui
-- SEUL : ni « anon », ni PUBLIC, ni « service_role ». L'auteur d'une décision est lu dans le jeton de la requête
-- par app_private.decide_auction_fact_claim, qui exige public.is_admin() avant tout :
--   * un utilisateur connecté qui n'est pas administrateur reçoit 42501 « admin_required » ;
--   * le rôle de service n'a pas d'auteur : il n'a pas le droit d'exécution, et l'aurait-il qu'il recevrait
--     42501 « admin_required » ;
--   * « anon » n'a pas le droit d'exécution.
-- La fonction de décision elle-même (app_private) reste sans aucun droit : les quatre fonctions publiques, en
-- SECURITY DEFINER, l'appellent au nom du propriétaire de la base.
--
-- RIEN D'AUTRE N'EST OUVERT. L'écran de relecture lit par le serveur, avec le rôle de service : la vue
-- public.v_auction_fact_claims_read_model, public.review_auction_fact_claim et les colonnes de auction_sales qu'il
-- affiche. Ces droits existent déjà et ne changent pas ; aucune table du registre, ni la vue, ne s'ouvre à un
-- rôle du navigateur.
--
-- État des réglages à l'ouverture (20261119100100) : second facteur non exigé, plafonds non appliqués, relance
-- planifiée fermée. RISQUE ACCEPTÉ PAR LE PROPRIÉTAIRE : un mot de passe d'administrateur volé permet un nombre
-- illimité de décisions, dont des oppositions et des retraits définitifs, que personne ne peut défaire.
--
-- Verrous : aucun sur une table. GRANT ne touche que le catalogue des fonctions. Possible pendant un import.
--
-- Retour arrière, par une nouvelle migration (referme la bascule ; les décisions déjà écrites restent) :
--   revoke execute on function public.accept_auction_fact_claim(uuid, text, text, uuid) from authenticated;
--   revoke execute on function public.reject_auction_fact_claim(uuid, text) from authenticated;
--   revoke execute on function public.withdraw_auction_fact_claim(uuid, text) from authenticated;
--   revoke execute on function public.oppose_auction_fact_claim(uuid, text) from authenticated;
-- Sans migration, par le propriétaire, pour durcir sans refermer :
--   select app_private.set_fact_registry_decisions_second_factor(true);
--   select app_private.set_fact_registry_decision_rate_limits(true);

grant execute on function public.accept_auction_fact_claim(uuid, text, text, uuid) to authenticated;
grant execute on function public.reject_auction_fact_claim(uuid, text) to authenticated;
grant execute on function public.withdraw_auction_fact_claim(uuid, text) to authenticated;
grant execute on function public.oppose_auction_fact_claim(uuid, text) to authenticated;

comment on function public.accept_auction_fact_claim(uuid, text, text, uuid) is
  'Registre des pièces : un administrateur accepte une observation (rattachement au lot obligatoire ; une nouvelle acceptation nomme la décision qu''elle remplace). L''auteur est celui du jeton. Exécutable par authenticated seul ; la fonction de décision exige un administrateur.';
comment on function public.reject_auction_fact_claim(uuid, text) is
  'Registre des pièces : un administrateur rejette une observation (motif d''une liste fermée). L''auteur est celui du jeton. Exécutable par authenticated seul ; la fonction de décision exige un administrateur.';
comment on function public.withdraw_auction_fact_claim(uuid, text) is
  'Registre des pièces : un administrateur retire une observation acceptée (motif d''une liste fermée) ; la valeur de l''annonce revient. L''auteur est celui du jeton. Exécutable par authenticated seul ; la fonction de décision exige un administrateur.';
comment on function public.oppose_auction_fact_claim(uuid, text) is
  'Registre des pièces : un administrateur enregistre l''opposition d''un professionnel à l''affichage d''une observation ; elle ne peut plus être acceptée. L''auteur est celui du jeton. Exécutable par authenticated seul ; la fonction de décision exige un administrateur.';

notify pgrst, 'reload schema';

commit;
