begin;

set local lock_timeout = '5s';

-- Chantier W9, point 51 du compte-rendu du 20/10/2026 : la politique de lecture des comptes connectés sur
-- public.auction_sales (auction_sales_authenticated_read, dernière définition : 20261027100200) appelle
-- public.is_admin() et public.has_analysis_access() dans son prédicat. PostgreSQL évalue un appel de
-- fonction de ce genre pour CHAQUE ligne examinée (chacune lit user_profiles / user_subscriptions) ; encapsulé
-- dans un sous-select scalaire sans lien avec la ligne, l'appel devient un InitPlan : une seule évaluation
-- par requête. Les deux fonctions sont STABLE et ne dépendent que de la session (auth.uid()), le résultat est
-- donc le même pour toutes les lignes d'une requête : la politique est strictement équivalente.
--
-- Seuls changent les deux appels. Rien d'autre : même commande (SELECT), mêmes rôles (authenticated), même
-- nature (permissive), mêmes conditions de disponibilité, de quarantaine et d'accès Premium.
-- Le test pgTAP 598 vérifie l'équivalence ligne à ligne pour un visiteur anonyme, un compte gratuit, un
-- compte Analyse et un administrateur.
--
-- ALTER POLICY ne réécrit aucune ligne. À appliquer hors collecte comme toute migration qui touche
-- auction_sales (voir supabase/README.md) : lock_timeout (5 s) la fait échouer sans effet si le verrou de
-- la table n'est pas obtenu ; il suffit de la relancer.
alter policy auction_sales_authenticated_read on public.auction_sales
using (
  (select public.is_admin())
  or (
    (select public.has_analysis_access())
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
    and coalesce(status, 'unknown') <> 'quarantined'
    and not catalogue_quarantined
  )
);

commit;
