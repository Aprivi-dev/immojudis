-- Instantanés d'une vente suivie : le prix d'adjudication n'est copié que pour un droit durable.
--
-- 20261028190100 (snapshot_followed_sale_before_delete) copie le prix d'adjudication dans
-- l'instantané d'un compte quand app_private.has_active_analysis_access(user_id) est vrai. Pendant
-- l'offre de lancement, c'est vrai de tout compte confirmé : le prix, copié dans une table qui garde
-- l'instantané six mois, reste lisible après la coupure de l'offre, par un compte qui n'a jamais eu
-- d'abonnement. Le prix d'adjudication est une donnée de l'offre Analyse (le compte gratuit n'a que
-- « prix réservé ») : la copie doit suivre le droit DURABLE du compte, non l'offre.
--
-- Cette migration ne redéfinit PAS snapshot_followed_sale_before_delete (une autre migration la
-- redéfinit en parallèle) : elle ajoute seulement la fonction que le déclencheur doit appeler.
-- app_private.snapshot_price_access(user_id) = abonnement actif, compte premium ou administrateur,
-- sans l'offre de lancement (app_private.has_standing_analysis_access, 20261029110100).
--
-- À faire dans le déclencheur (dernière définition de snapshot_followed_sale_before_delete), une seule
-- ligne : dans le `cross join lateral`, remplacer
--     select app_private.has_active_analysis_access(followed.user_id) as granted
-- par
--     select app_private.snapshot_price_access(followed.user_id) as granted
-- Les instantanés déjà créés sous l'offre gardent leur prix : les corriger est une réparation de
-- données, hors migration.
begin;

set local lock_timeout = '5s';

create or replace function app_private.snapshot_price_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select app_private.has_standing_analysis_access(p_user_id);
$function$;

revoke all on function app_private.snapshot_price_access(uuid) from public, anon, authenticated;
grant execute on function app_private.snapshot_price_access(uuid) to service_role;

comment on function app_private.snapshot_price_access(uuid) is
  'Le compte a-t-il un droit Analyse durable (abonnement, premium, administrateur) ? Décide si le prix d''adjudication est copié dans l''instantané d''une vente suivie : jamais sous la seule offre de lancement.';

commit;
