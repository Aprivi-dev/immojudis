begin;

set local lock_timeout = '5s';

-- Ouverture des pépites (décision du fondateur, 26/10/2026) : le mode passe de « shadow » à « on ». Les fonctions
-- publiques (get_public_sale_pepite, list_public_pepite_sale_ids) rendent dès lors les pépites publiables, avec
-- les gardes à la lecture de 20261104100000. Une vente n'est publiable qu'après deux évaluations favorables
-- espacées de 12 h (règle de stabilité de pepite-v1) : rien n'apparaît avant ce délai.
--
-- Seul un mode « shadow » est ouvert : un mode « off » ou une suspension posée entre-temps (arrêt d'urgence,
-- public.suspend_sale_pepites) n'est pas défait par cette migration.
--
-- RETOUR ARRIÈRE : l'arrêt d'urgence de /admin/pepites (ou public.suspend_sale_pepites) repasse en « shadow ».
update app_private.sale_pepite_settings settings
   set mode = 'on',
       updated_by = null,
       updated_at = statement_timestamp()
 where settings.singleton
   and settings.mode = 'shadow';

commit;
