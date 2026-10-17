/**
 * `/sales` sans paramètre, servi depuis le cache (ISR) par une réécriture du proxy.
 *
 * Le catalogue filtré ou paginé (`/sales?page=2`, …) est rendu à la demande par
 * `src/app/sales/page.tsx` : il lit `searchParams`. L'adresse nue `/sales` est la même pour tous
 * les visiteurs (première page du catalogue public, déjà en cache 5 minutes) ; `src/proxy.ts` la
 * réécrit vers `SALES_DEFAULT_PATH`, une page statique régénérée toutes les 5 minutes
 * (`src/app/sales/defaut/page.tsx`). Le navigateur et les robots continuent de voir `/sales`.
 *
 * Piège : pour une page réécrite, Next.js rend `usePathname()` côté serveur avec le chemin de la
 * page cible, pas celui de l'adresse demandée. Le HTML de la page statique dirait donc
 * `/sales/defaut`, le navigateur `/sales` : liens de pagination et de retour faux, en-tête du site
 * affiché à tort, erreur d'hydratation. `publicPathname` ramène la variante interne à `/sales` ;
 * tout composant rendu sur `/sales` lit le chemin par `usePublicPathname`
 * (`src/hooks/use-public-pathname.ts`), jamais par `usePathname` (un test le garantit).
 */
export const SALES_PATH = "/sales";

/** Page statique interne ; jamais liée, jamais dans le plan du site. */
export const SALES_DEFAULT_PATH = "/sales/defaut";

/**
 * Vrai pour une requête que la variante statique peut servir : `/sales`, lecture seule, et aucun
 * paramètre d'adresse. Next.js retire lui-même `_rsc` (et les en-têtes Flight) avant le proxy ;
 * un `?` vide ne compte pas. Toute autre adresse (filtre, page, `utm_*`, …) reste rendue à la
 * demande, comme aujourd'hui.
 */
export function isUnfilteredSalesRequest(request: {
  method: string;
  pathname: string;
  search: string;
}): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.pathname === SALES_PATH &&
    request.search === ""
  );
}

/** Vrai pour la variante interne elle-même (ou un fichier qui en dépend : `.rsc`, `.segments`). */
export function isSalesDefaultPath(pathname: string): boolean {
  return (
    pathname === SALES_DEFAULT_PATH ||
    pathname.startsWith(`${SALES_DEFAULT_PATH}/`) ||
    pathname.startsWith(`${SALES_DEFAULT_PATH}.`)
  );
}

/** Chemin de l'adresse publique : la variante interne se présente comme `/sales`. */
export function publicPathname(pathname: string): string {
  return pathname === SALES_DEFAULT_PATH ? SALES_PATH : pathname;
}
