import { isProductionRuntime } from "@/lib/runtime-phase";

/**
 * `/sales` sans paramètre, servi depuis le cache (ISR) par une réécriture du proxy.
 *
 * Le catalogue filtré (`/sales?city=Pau`, …) est rendu à la demande par `src/app/sales/page.tsx` :
 * il lit `searchParams`. L'adresse nue `/sales` est la même pour tous les visiteurs (première page
 * du catalogue public, déjà en cache 5 minutes) ; `src/proxy.ts` la réécrit vers
 * `SALES_DEFAULT_PATH`, une page statique régénérée toutes les 5 minutes
 * (`src/app/sales/defaut/page.tsx`). Le navigateur et les robots continuent de voir `/sales`.
 *
 * Il en va de même pour `?page=2` et `?page=3` sans autre paramètre (`SALES_ISR_PAGES`) : le proxy
 * les réécrit vers `/sales/defaut/2` et `/sales/defaut/3` (`src/app/sales/defaut/[page]/page.tsx`,
 * même cache de 5 minutes). Leur HTML ne dépend d'aucun visiteur (ni cookie ni en-tête lu), il se
 * partage donc entre tous au lieu d'être rendu à chaque requête.
 *
 * Paramètres de suivi (`utm_*`, `gclid`, `fbclid`) : `/sales?utm_source=x` reste rendu à la
 * demande, il n'est pas servi par la variante statique. La page statique est rendue pour une
 * adresse sans paramètre (`useSearchParams()` vide) ; la servir à une adresse qui en porte donnerait
 * au navigateur un `useSearchParams()` différent de celui du HTML et une hydratation incohérente.
 * Retirer ces paramètres côté proxy ou les ignorer à la lecture est un autre chantier.
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

/**
 * Pages du catalogue servies par une variante statique, en plus de la première : `?page=2` et
 * `?page=3`, celles que les robots et les liens partagés visitent le plus. Au-delà, ou avec un
 * filtre, la page reste rendue à la demande. Cette liste est lue par la variante
 * (`generateStaticParams`) et par le proxy : un seul endroit.
 */
export const SALES_ISR_PAGES: readonly number[] = [2, 3];

/** Motif de la route des variantes de pages (pour `revalidatePath(…, "page")`). */
export const SALES_PAGE_VARIANTS_ROUTE = `${SALES_DEFAULT_PATH}/[page]`;

/** Variante statique de la page `page` du catalogue ; jamais liée, jamais dans le plan du site. */
export function salesPageVariantPath(page: number): string {
  return `${SALES_DEFAULT_PATH}/${page}`;
}

/**
 * Chemin de la variante statique qui sert cette requête pour `?page=N` (N dans `SALES_ISR_PAGES`),
 * ou `null`. Il faut `/sales` en lecture seule et, pour toute l'adresse, exactement `?page=N` :
 * un autre paramètre (filtre, `view`, `utm_*`) ou une autre écriture (`?page=02`) reste rendu à la
 * demande, car la variante ne connaît que le `useSearchParams()` de cette adresse-là.
 */
export function salesPageVariantFor(request: {
  method: string;
  pathname: string;
  search: string;
}): string | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (request.pathname !== SALES_PATH) return null;
  const match = /^\?page=([1-9][0-9]*)$/.exec(request.search);
  const page = match ? Number(match[1]) : Number.NaN;
  return SALES_ISR_PAGES.includes(page) ? salesPageVariantPath(page) : null;
}

/**
 * Adresse publique d'une variante demandée en direct quand le proxy ne réécrit pas (CSP à nonce) :
 * `/sales/defaut` devient `/sales`, `/sales/defaut/N` devient `/sales?page=N`.
 */
export function publicSalesAddress(pathname: string, search: string): string {
  const page = /^\/sales\/defaut\/([1-9][0-9]*)$/.exec(pathname)?.[1];
  return page ? `${SALES_PATH}?page=${page}` : `${SALES_PATH}${search}`;
}

/**
 * Chemin de l'adresse publique : la variante interne (`/sales/defaut`, `/sales/defaut/N`) se
 * présente comme `/sales`.
 */
export function publicPathname(pathname: string): string {
  return pathname === SALES_DEFAULT_PATH || /^\/sales\/defaut\/[1-9][0-9]*$/.test(pathname)
    ? SALES_PATH
    : pathname;
}

/**
 * Vrai quand la variante statique doit REFUSER de se régénérer sans la liste : en production, hors
 * `next build`. Si la base est en panne ou trop lente pendant une régénération ISR, la page rendue
 * sans annonces serait mise en cache 5 minutes à la place de la dernière bonne page. Lever l'erreur
 * fait l'inverse : « If an error is thrown while attempting to revalidate data, the last
 * successfully generated data will continue to be served from the cache » et la régénération est
 * retentée à la requête suivante (guide ISR de Next.js).
 *
 * Faux pendant `next build` (sans base, comme dans l'environnement factice de la CI, le build ne
 * doit pas échouer : la page est alors produite sans liste, le navigateur charge les annonces) et
 * en développement ou en test (pas de page précédente à conserver). `NEXT_PHASE` n'est positionné
 * par Next.js que pendant le build : à l'exécution il est absent.
 */
export function mustSeedStaticCatalogue(
  env: { NODE_ENV?: string; NEXT_PHASE?: string } = process.env,
): boolean {
  return isProductionRuntime(env);
}
