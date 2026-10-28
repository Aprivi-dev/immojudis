export const RESOURCES_PATH = "/ressources";
export const OFFERS_PATH = "/offres";

export type SiteLink = { readonly href: string; readonly label: string };

/**
 * Pages rendues à la demande (elles lisent les paramètres de la requête ou la date du jour) :
 * les liens globaux (en-tête, menu, pied de page, accueil) qui y mènent ne les préchargent pas,
 * sinon chaque page vue déclenche autant d'appels serveur que de liens à l'écran. La page se
 * charge au clic, comme avant.
 */
const DYNAMIC_PAGE_PATHS: ReadonlySet<string> = new Set(["/sales", "/annonce-exemple"]);

/**
 * Pages juridiques qui placent `CloudBackgroundPreload` : leur contenu précharge `cloud-background.webp`
 * (52 Ko, priorité haute). Préchargées par les liens du pied de page, elles faisaient télécharger
 * cette image depuis l'accueil, où aucune section ne l'utilise. Elles se chargent au clic.
 */
const CLOUD_BACKGROUND_PAGE_PATHS: ReadonlySet<string> = new Set([
  "/legal",
  "/conditions-generales",
  "/privacy",
]);

/**
 * Valeur de la propriété `prefetch` de `<Link>` : `false` pour une page dynamique ou à fond de
 * nuages (l'ancre `#…` d'un lien n'entre pas en compte), sinon le défaut.
 */
export function linkPrefetch(href: string): false | undefined {
  const path = href.split("#")[0];
  return DYNAMIC_PAGE_PATHS.has(path) || CLOUD_BACKGROUND_PAGE_PATHS.has(path) ? false : undefined;
}

/** Les cinq entrées de l'en-tête, identiques sur toutes les pages. */
export const SITE_NAV_LINKS: readonly SiteLink[] = [
  { href: "/sales", label: "Ventes" },
  { href: "/tribunaux", label: "Tribunaux" },
  { href: "/avocats", label: "Avocats" },
  { href: RESOURCES_PATH, label: "Ressources" },
  { href: OFFERS_PATH, label: "Offres" },
];

/** Pages d'information, reprises dans le menu mobile. */
export const SITE_INFO_LINKS: readonly SiteLink[] = [
  { href: "/comment-ca-marche", label: "Comment ça marche" },
  { href: "/a-propos", label: "À propos" },
  { href: "/contact", label: "Contact" },
];

export const SITE_LEGAL_LINKS: readonly SiteLink[] = [
  { href: "/legal", label: "Mentions légales" },
  { href: "/conditions-generales", label: "Conditions générales" },
  { href: "/privacy", label: "Confidentialité" },
  { href: "/classement-des-annonces", label: "Classement des annonces" },
  { href: "/mes-droits", label: "Mes droits" },
];

export const UNLOCKED_SALES_PATH = "/compte/ventes-debloquees";

/** `hideForAnalysis` : l'entrée n'a de sens que pour un compte qui débloque ses ventes une à une. */
export type AccountLink = SiteLink & { readonly hideForAnalysis?: boolean };

export const ACCOUNT_LINKS: readonly AccountLink[] = [
  { href: "/favoris", label: "Mes favoris" },
  { href: "/alertes", label: "Mes alertes" },
  { href: UNLOCKED_SALES_PATH, label: "Mes ventes débloquées", hideForAnalysis: true },
  { href: "/comparaisons", label: "Mes comparaisons" },
  { href: "/compte", label: "Mon compte" },
];

/**
 * Les entrées du menu « Mon compte » à afficher. « Mes ventes débloquées » n'apparaît que pour un
 * compte dont l'offre est connue et n'ouvre pas déjà toutes les ventes (`false`, pas `undefined`).
 */
export function visibleAccountLinks(
  links: readonly AccountLink[],
  hasAnalysisAccess: boolean | undefined,
): SiteLink[] {
  return links
    .filter((link) => !link.hideForAnalysis || hasAnalysisAccess === false)
    .map(({ href, label }) => ({ href, label }));
}

export function accountLinksFor(hasAnalysisAccess: boolean | undefined): SiteLink[] {
  return visibleAccountLinks(ACCOUNT_LINKS, hasAnalysisAccess);
}

/**
 * Pourquoi la personne arrive sur la page de connexion : sert au bandeau d'explication.
 * `mes-favoris` et `mes-alertes` : une page de l'espace personnel demandée sans être connecté
 * (à la différence de `favori` et `alerte`, qui suivent un clic sur un cœur ou une cloche).
 */
export const LOGIN_REASONS = [
  "alerte",
  "favori",
  "export",
  "offre",
  "ouverture",
  "fiche",
  "mes-favoris",
  "mes-alertes",
] as const;
export type LoginReason = (typeof LOGIN_REASONS)[number];

export function loginReason(value: unknown): LoginReason | undefined {
  return LOGIN_REASONS.find((reason) => reason === value);
}

/**
 * Adresse de connexion qui ramène la personne sur la page d'où elle vient. Elle ouvre par défaut
 * « Créer un compte » (`mode=investor`) : un visiteur qui touche un cœur ou une cloche n'a pas
 * encore de compte. `reason` explique l'action qui a déclenché le détour.
 */
export function loginPathWithRedirect(
  returnTo: string | null | undefined,
  options: { mode?: LoginPageMode; reason?: LoginReason } = {},
): string {
  const { mode = "investor", reason } = options;
  const query = new URLSearchParams();
  const isSameSitePath = (path: string) => path.startsWith("/") && !path.startsWith("//");
  const isLoginPage = (path: string) => path === "/login" || path.startsWith("/login?");
  if (returnTo && isSameSitePath(returnTo) && !isLoginPage(returnTo)) {
    query.set("redirect", returnTo);
  }
  if (mode !== "login") query.set("mode", mode);
  if (reason) query.set("reason", reason);
  const serialized = query.toString();
  return serialized ? `/login?${serialized}` : "/login";
}

export type LoginPageMode = "login" | "investor" | "professional";

export function loginPageMode(value: unknown): LoginPageMode {
  return value === "investor" || value === "professional" ? value : "login";
}

const RETURN_BASE = "http://immojudis.local";

/**
 * Pages privées ou de liste, sans paramètre, d'où l'on ouvre une fiche et où « Retour » ramène.
 * La page du tribunal (`/tribunaux/<code>`) est reconnue à part (voir `TRIBUNAL_RETURN_PATH`).
 */
const FIXED_RETURN_PATHS: ReadonlySet<string> = new Set([
  "/favoris",
  "/alertes",
  "/comparaisons",
  "/audiences-a-venir",
]);

/** Code du tribunal en adresse : minuscules, chiffres et tirets (voir `tribunalCodeSlug`). */
const TRIBUNAL_RETURN_PATH = /^\/tribunaux\/[a-z0-9][a-z0-9-]*$/;

/**
 * Origine acceptée pour le « Retour » d'une fiche (`?from=`). Validation stricte : le catalogue
 * (`/sales`, avec sa recherche) ou l'une des pages listées ci-dessus, rien d'autre (ni autre
 * origine, ni ancre, ni paramètre sur les pages hors catalogue). Une adresse reconstruite à partir
 * de l'URL analysée est rendue, jamais la chaîne reçue.
 */
export function safeSalesReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;

  const url = new URL(value, RETURN_BASE);
  if (url.origin !== RETURN_BASE || url.hash) return undefined;
  if (url.pathname === "/sales") return `${url.pathname}${url.search}`;
  if (url.search) return undefined;
  if (FIXED_RETURN_PATHS.has(url.pathname) || TRIBUNAL_RETURN_PATH.test(url.pathname)) {
    return url.pathname;
  }
  return undefined;
}

/**
 * Libellé du lien « Retour » d'une fiche selon la page d'origine : la carte quand la recherche
 * d'origine l'affichait (`map=true`), sinon la liste. Une origine inconnue ou refusée donne le
 * libellé par défaut.
 */
export function salesReturnLabel(returnTo: string | null | undefined): string {
  const safe = returnTo ? safeSalesReturnTo(returnTo) : undefined;
  if (!safe) return "Retour aux ventes";
  const url = new URL(safe, RETURN_BASE);
  if (url.pathname === "/favoris") return "Retour à mes favoris";
  if (url.pathname === "/alertes") return "Retour à mes alertes";
  if (url.pathname === "/comparaisons") return "Retour à mes comparaisons";
  if (url.pathname === "/audiences-a-venir") return "Retour aux audiences";
  if (TRIBUNAL_RETURN_PATH.test(url.pathname)) return "Retour au tribunal";
  const map = url.searchParams.get("map");
  return map === "true" || map === "1" ? "Retour à la carte" : "Retour aux ventes";
}

export function saleDetailPath(saleId: string, returnTo?: string): string {
  const path = `/sales/${encodeURIComponent(saleId)}`;
  const safeReturnTo = safeSalesReturnTo(returnTo);
  // The plain catalogue is where "back" leads by default: a `?from=/sales` on every card would
  // only multiply the URLs of each sale for crawlers (and for the cache).
  if (!safeReturnTo || safeReturnTo === "/sales") return path;

  const search = new URLSearchParams({ from: safeReturnTo });
  return `${path}?${search.toString()}`;
}

/** Préfixe de l'ancre d'une carte du catalogue : `id="sale-card-<id>"` (voir `SearchResults`). */
export const SALE_CARD_ANCHOR_PREFIX = "sale-card-";

/**
 * Adresse du lien « Retour aux ventes » d'une fiche : la recherche d'origine, ouverte sur la carte
 * de cette vente (ancre `#sale-card-<id>`). Le catalogue y défile une fois la liste affichée (voir
 * `useRestoreSaleCard`). L'identifiant de la fiche est celui de la carte : rien d'autre n'est à
 * transmettre dans l'origine (`?from=`). Une origine qui n'est pas une recherche du catalogue (page
 * d'exemple, par exemple) est rendue telle quelle ; une page d'origine acceptée hors catalogue
 * (favoris, tribunal, audiences…) l'est sans ancre.
 */
export function salesReturnHref(returnTo: string | null | undefined, saleId: string): string {
  const base = returnTo ? safeSalesReturnTo(returnTo) : "/sales";
  if (!base) return returnTo ?? "/sales";
  // Les autres pages d'origine (favoris, tribunal…) n'ont pas de carte de vente à retrouver.
  if (base !== "/sales" && !base.startsWith("/sales?")) return base;
  return `${base}#${SALE_CARD_ANCHOR_PREFIX}${encodeURIComponent(saleId)}`;
}

export type SearchValue = string | number | boolean | null | undefined;

/**
 * Adds a query string to a path. Empty values (`undefined`, `null`, `""`) are left out, so a
 * filter that is not set never shows up in the URL.
 */
export function pathWithSearch(path: string, search?: Record<string, SearchValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

/**
 * Reads a query string into a plain record. When a key is repeated the last value wins, the
 * same rule the server pages apply to `searchParams`. Values stay strings: validators own the
 * numeric conversion, so postal codes and department numbers keep their leading zero.
 */
export function searchParamsToRecord(searchParams: {
  forEach(callback: (value: string, key: string) => void): void;
}): Record<string, string> {
  const record: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
