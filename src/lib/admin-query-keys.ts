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
 * Diagnostic opérationnel (alertes ouvertes comprises) : accueil, Opérations > Alertes et diagnostic
 * des services.
 */
export const READINESS_QUERY_KEY = ["admin-readiness"] as const;
/** Demandes RGPD : vue Conformité et accueil (la première page est la même requête). */
export const PRIVACY_REQUESTS_QUERY_KEY = ["admin-privacy-requests"] as const;
/** Annonces des professionnels : vue Publications et compteur de l'accueil. */
export const PUBLICATION_REQUESTS_QUERY_KEY = ["admin-publication-requests"] as const;
/** Abonnements : vue Clients, rafraîchie aussi par la prolongation d'essais des inscriptions. */
export const SUBSCRIPTIONS_QUERY_KEY = ["admin-subscriptions"] as const;
