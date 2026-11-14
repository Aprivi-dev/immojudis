/**
 * Clés de requête de la vue Avocats, lues par la page (onglets, Actualiser) et par ses panneaux. À part
 * des panneaux : la page charge « Réseau référencé » et « Relevé mensuel » à la demande, et ne doit pas
 * les importer pour lire une clé.
 */
export const REFERENCED_LAWYERS_QUERY_KEY = ["admin-referenced-lawyers"] as const;
export const LAWYER_STATEMENT_QUERY_KEY = ["admin-lawyer-statement"] as const;
