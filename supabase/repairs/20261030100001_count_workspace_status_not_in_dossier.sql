-- COMPTAGE MANUEL, PAS UNE MIGRATION DE SCHEMA. Ne pas placer ce fichier dans supabase/migrations.
-- Procedure : supabase/repairs/README.md.
--
-- Point 36 (2026-10-20) : « Mon dossier » (user_favorites.personal_status, bid_ceiling_eur) devient la
-- source unique du statut et du plafond ; le dossier de travail Analyse (sale_workspaces) les lit.
--
-- NON LANCE : a relire, puis a lancer par le proprietaire du projet avec psql :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261030100001_count_workspace_status_not_in_dossier.sql
--
-- COMPTAGE SEULEMENT : aucune ecriture, la transaction est annulee (rollback). Il n'existe pas de mode
-- application : aucun rattrapage n'est decide. Le comptage dit seulement si des statuts ou des plafonds
-- saisis dans l'ancien dossier de travail n'ont pas leur pendant dans « Mon dossier » ; la decision de
-- les reprendre (ou non) revient au proprietaire apres lecture.
--
-- Constat : jusqu'ici le statut (sale_workspaces.tracking_status, defaut 'watching') et le « Prix
-- envisage » / plafond (sale_workspaces.user_max_bid_eur, private_notes.professionalDossier.priceEur)
-- se saisissaient dans le dossier de travail. Ils ne sont pas reportes dans user_favorites.

begin;
set local lock_timeout = '5s';

-- Comptes ayant un dossier de travail ET la meme vente en favori, ou « Mon dossier » n'a pas de statut
-- alors que le dossier de travail en porte un autre que la valeur par defaut.
select count(*) as statuts_du_dossier_de_travail_absents_de_mon_dossier
from public.sale_workspaces workspace
join public.user_favorites favorite
  on favorite.user_id = workspace.user_id
 and favorite.sale_id = workspace.sale_id
where favorite.personal_status is null
  and workspace.tracking_status is distinct from 'watching';

-- Idem pour le plafond : un montant saisi dans le dossier de travail, rien dans « Mon dossier ».
select count(*) as plafonds_du_dossier_de_travail_absents_de_mon_dossier
from public.sale_workspaces workspace
join public.user_favorites favorite
  on favorite.user_id = workspace.user_id
 and favorite.sale_id = workspace.sale_id
where (favorite.bid_ceiling_eur is null or favorite.bid_ceiling_eur <= 0)
  and coalesce(workspace.user_max_bid_eur, 0) > 0;

-- Dossiers de travail dont la vente n'est pas en favori : leur statut n'a nulle part ou aller (le PUT
-- exige desormais que la vente soit suivie).
select count(*) as dossiers_de_travail_sur_une_vente_non_suivie
from public.sale_workspaces workspace
where not exists (
  select 1
  from public.user_favorites favorite
  where favorite.user_id = workspace.user_id
    and favorite.sale_id = workspace.sale_id
);

rollback;
