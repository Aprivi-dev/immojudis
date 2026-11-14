/**
 * Clés de requête de l'administration lues par plusieurs vues. Une clé qui ne sert qu'à un
 * panneau reste dans ce panneau, qui l'exporte pour la page qui l'affiche : comme
 * `query-keys.ts`, ce module est copié entier dans chaque chunk qui le lit.
 */

/** Tableau de bord : runs (accueil et opérations) et comptages, rafraîchis ensemble par préfixe. */
export const DASHBOARD_QUERY_KEY = ["admin-dashboard"] as const;
export const DASHBOARD_RUNS_QUERY_KEY = [...DASHBOARD_QUERY_KEY, "runs"] as const;
/** Supervision du pipeline : vue Opérations et réglages. */
export const PIPELINE_QUERY_KEY = ["admin-pipeline"] as const;
/**
 * Diagnostic opérationnel (alertes ouvertes comprises) : accueil, Opérations > Alertes, Conformité et
 * Configuration > Services.
 */
export const READINESS_QUERY_KEY = ["admin-readiness"] as const;
/** Abonnements : vue Clients, rafraîchie aussi par la prolongation d'essais des inscriptions. */
export const SUBSCRIPTIONS_QUERY_KEY = ["admin-subscriptions"] as const;
