import { publicEnv } from "@/lib/env";
import { propertyImages, shouldRejectPropertyImageSize } from "@/lib/sale-media";
import type { AuctionSale, SaleMedia, SaleMediaMirror } from "@/lib/types";

/**
 * Copies hébergées des photos principales (test d'hébergement). Le pipeline copie la photo en WebP
 * 640 px et 1600 px dans le bucket public `sale-photos` et la fonction `sale_photo_mirrors` les
 * retrouve à partir de l'URL d'ORIGINE.
 *
 * Règle d'or : `SaleMedia.url` reste l'URL d'origine. La copie (`SaleMedia.mirror`) ne sert qu'à
 * l'affichage ; tout le reste (source retirée, doublons, crédit, repli) continue de lire l'origine.
 * Sans copie, interrupteur éteint, erreur ou délai dépassé : la page est celle d'avant.
 */
export const PHOTO_MIRROR_BUCKET = "sale-photos";
/**
 * Délai du rendu serveur au-delà duquel on affiche les photos des sources plutôt que d'attendre les
 * copies : la page n'attend personne.
 */
export const PHOTO_MIRROR_TIMEOUT_MS = 300;
/**
 * Même délai côté navigateur (recherche, fiche) : l'appel part de chez l'internaute, vers la base,
 * et ne bloque aucun rendu serveur. Un délai de 300 ms y ferait perdre la copie sur un réseau lent.
 */
export const PHOTO_MIRROR_BROWSER_TIMEOUT_MS = 1_500;
/** Photos d'une fiche dont on cherche la copie : celles que l'écran montre en premier. */
export const PHOTO_MIRROR_DETAIL_PHOTOS = 3;
/** Copies déjà connues du navigateur (URL d'origine vers copie), au plus. */
export const PHOTO_MIRROR_MEMORY_MAX = 500;
/** La fonction SQL ignore tout ce qui dépasse. */
export const PHOTO_MIRROR_MAX_URLS = 100;

/** `NEXT_PUBLIC_PHOTO_MIRROR=on` : sinon le site ignore les copies. */
export function isPhotoMirrorEnabled(
  flag: string | undefined = process.env.NEXT_PUBLIC_PHOTO_MIRROR,
): boolean {
  return flag === "on";
}

export type PhotoMirrorClient = {
  rpc: (
    fn: "sale_photo_mirrors",
    args: { p_source_urls: string[] },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type MirrorRow = {
  source_url?: unknown;
  path_640?: unknown;
  path_1600?: unknown;
  width?: unknown;
  height?: unknown;
};

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function safePath(value: unknown): string | null {
  return typeof value === "string" && SAFE_PATH.test(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Copie utilisable d'une ligne de la fonction, ou `null`. Une copie dont l'original serait écarté
 * par le filtre des photos (logo, bannière, trop petite) n'est pas gardée : la photo de la source
 * suit alors le chemin habituel, qui la rejette comme avant. Dimensions inconnues : pas de copie.
 */
export function mirrorFromRow(row: MirrorRow): SaleMediaMirror | null {
  const path640 = safePath(row.path_640);
  const width = positiveNumber(row.width);
  const height = positiveNumber(row.height);
  if (!path640 || !width || !height) return null;
  if (shouldRejectPropertyImageSize(width, height)) return null;
  return { path640, path1600: safePath(row.path_1600), width, height };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** URL distinctes, http(s), au plus 100 : ce que la fonction SQL accepte. */
export function photoMirrorLookupUrls(urls: Iterable<string>): string[] {
  return [...new Set(urls)]
    .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
    .slice(0, PHOTO_MIRROR_MAX_URLS);
}

/**
 * Un seul appel pour toutes les URL. LÈVE en cas d'erreur, de réponse inattendue ou de délai
 * dépassé : c'est ce qui permet au cache serveur de ne jamais garder un échec. Pour l'affichage,
 * utiliser `fetchPhotoMirrors`.
 */
export async function fetchPhotoMirrorsStrict(
  client: PhotoMirrorClient,
  urls: string[],
  options: { timeoutMs?: number } = {},
): Promise<Map<string, SaleMediaMirror>> {
  const mirrors = new Map<string, SaleMediaMirror>();
  const timeoutMs = options.timeoutMs ?? PHOTO_MIRROR_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`délai de ${timeoutMs} ms dépassé`)), timeoutMs);
    });
    const { data, error } = await Promise.race([
      Promise.resolve(client.rpc("sale_photo_mirrors", { p_source_urls: urls })),
      timeout,
    ]);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("réponse inattendue");
    for (const row of data as MirrorRow[]) {
      if (typeof row?.source_url !== "string") continue;
      const mirror = mirrorFromRow(row);
      if (mirror) mirrors.set(row.source_url, mirror);
    }
    return mirrors;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Un seul appel pour toutes les URL (au plus 100 distinctes). Ne lève jamais : interrupteur éteint,
 * erreur, réponse inattendue ou délai dépassé donnent une table vide et une ligne de journal.
 */
export async function fetchPhotoMirrors(
  client: PhotoMirrorClient | null | undefined,
  urls: Iterable<string>,
  options: { timeoutMs?: number; enabled?: boolean } = {},
): Promise<Map<string, SaleMediaMirror>> {
  if (!client || !(options.enabled ?? isPhotoMirrorEnabled())) return new Map();

  const distinct = photoMirrorLookupUrls(urls);
  if (!distinct.length) return new Map();

  try {
    return await fetchPhotoMirrorsStrict(client, distinct, { timeoutMs: options.timeoutMs });
  } catch (error) {
    console.warn(
      "[photos] Copies indisponibles, photos des sources affichées:",
      errorMessage(error),
    );
    return new Map();
  }
}

/**
 * Copies déjà vues par ce navigateur. Un rafraîchissement qui revient sans copie (délai dépassé,
 * panne, copie momentanément absente) ne doit pas faire changer l'image d'une carte : on garde la
 * copie connue pour la même URL d'origine. Si elle a disparu pour de bon, l'image affichée échoue
 * et la carte retombe sur la photo de la source. Réservé au navigateur (`remember`) : sur le
 * serveur, ce cache serait partagé entre visiteurs.
 */
const rememberedMirrors = new Map<string, SaleMediaMirror>();

function remember(url: string, mirror: SaleMediaMirror) {
  rememberedMirrors.delete(url);
  rememberedMirrors.set(url, mirror);
  while (rememberedMirrors.size > PHOTO_MIRROR_MEMORY_MAX) {
    const oldest = rememberedMirrors.keys().next().value;
    if (oldest === undefined) break;
    rememberedMirrors.delete(oldest);
  }
}

/** Pour les tests. */
export function forgetRememberedPhotoMirrors() {
  rememberedMirrors.clear();
}

export type PhotoMirrorOptions = {
  /**
   * Nombre de photos par vente dont on cherche la copie, dans l'ordre où l'écran les montre
   * (`propertyImages`). 1 par défaut : la vignette d'une carte, seule photo copiée.
   */
  photos?: number;
  timeoutMs?: number;
  /** Navigateur seulement : garde les copies connues d'un appel à l'autre (voir ci-dessus). */
  remember?: boolean;
  /** Remplace l'appel direct (cache serveur) ; reçoit les URL à chercher et ne doit pas lever. */
  fetchMirrors?: (urls: string[]) => Promise<Map<string, SaleMediaMirror>>;
};

/**
 * Ajoute `mirror` aux photos des ventes qui ont une copie, avec un seul appel pour la page.
 * Les photos cherchées sont celles que l'écran montre : les `photos` premières de `propertyImages`
 * (la 1re par défaut, celle de la carte), pas `media[0]`. Ne modifie rien : renvoie la même liste
 * si aucune copie n'est trouvée.
 */
export async function withPhotoMirrors<T extends { media?: AuctionSale["media"] }>(
  sales: T[],
  client: PhotoMirrorClient | null | undefined,
  options: PhotoMirrorOptions = {},
): Promise<T[]> {
  if (!client || !sales.length || !isPhotoMirrorEnabled()) return sales;

  const mirrors = await photoMirrorsFor(sales, client, options);
  return applyPhotoMirrors(sales, mirrors, options);
}

/** Photos dont on cherche la copie, dans l'ordre où l'écran les montre. */
function mirrorTargets<T extends { media?: AuctionSale["media"] }>(
  sale: T,
  photos: number | undefined,
): SaleMedia[] {
  return propertyImages(sale?.media).slice(0, Math.max(1, photos ?? 1));
}

async function photoMirrorsFor<T extends { media?: AuctionSale["media"] }>(
  sales: T[],
  client: PhotoMirrorClient,
  options: PhotoMirrorOptions,
): Promise<ReadonlyMap<string, SaleMediaMirror>> {
  const urls: string[] = [];
  for (const sale of sales) {
    for (const item of mirrorTargets(sale, options.photos)) urls.push(item.url);
  }
  const lookupUrls = photoMirrorLookupUrls(urls);
  if (!lookupUrls.length) return new Map<string, SaleMediaMirror>();
  return options.fetchMirrors
    ? await options.fetchMirrors(lookupUrls)
    : await fetchPhotoMirrors(client, lookupUrls, { timeoutMs: options.timeoutMs });
}

/**
 * Pose les copies déjà connues (URL d'origine vers copie) sur les photos que l'écran montre, sans
 * appel réseau. C'est la seconde moitié de `withPhotoMirrors`, pour une réponse qui apporte déjà
 * les copies (route `/api/catalogue/preview`). Ne modifie rien : renvoie la même liste si aucune
 * copie ne s'applique.
 */
export function applyPhotoMirrors<T extends { media?: AuctionSale["media"] }>(
  sales: T[],
  mirrors: ReadonlyMap<string, SaleMediaMirror>,
  options: Pick<PhotoMirrorOptions, "photos" | "remember"> = {},
): T[] {
  const mediaOf = (sale: T): SaleMedia[] => mirrorTargets(sale, options.photos);
  // Jamais sur le serveur, même si l'appelant le demande : la mémoire y serait commune à tous.
  const keepKnown = Boolean(options.remember) && typeof window !== "undefined";
  if (keepKnown) {
    for (const [url, mirror] of mirrors) remember(url, mirror);
  }
  const mirrorOf = (url: string) =>
    mirrors.get(url) ?? (keepKnown ? rememberedMirrors.get(url) : undefined);

  let changed = false;
  const enriched = sales.map((sale) => {
    const targets = new Set(mediaOf(sale));
    if (!Array.isArray(sale?.media) || !sale.media.some((item) => targets.has(item))) return sale;
    let touched = false;
    const media = sale.media.map((item) => {
      const mirror = targets.has(item) ? mirrorOf(item.url) : undefined;
      if (!mirror) return item;
      touched = true;
      return { ...item, mirror };
    });
    if (!touched) return sale;
    changed = true;
    return { ...sale, media };
  });
  return changed ? enriched : sales;
}

/**
 * Table URL d'origine vers copie des photos qui en portent une (`media[].mirror`). Sert à garder les
 * copies d'une liste déjà rendue (liste publique du serveur) quand une autre liste, qui arrive sans
 * copie, la remplace : voir `applyPhotoMirrors` avec `remember`.
 */
export function mirrorsFromSales(
  sales: ReadonlyArray<{ media?: AuctionSale["media"] }>,
): Map<string, SaleMediaMirror> {
  const mirrors = new Map<string, SaleMediaMirror>();
  for (const sale of sales) {
    if (!Array.isArray(sale?.media)) continue;
    for (const item of sale.media) {
      if (item?.mirror && typeof item.url === "string") mirrors.set(item.url, item.mirror);
    }
  }
  return mirrors;
}

/**
 * Même chose pour une seule vente (fiche) : les 3 premières photos affichées sont cherchées (seule
 * la photo principale est copiée aujourd'hui ; les autres ne coûtent qu'une URL de plus).
 */
export async function withPhotoMirror<T extends { media?: AuctionSale["media"] }>(
  sale: T,
  client: PhotoMirrorClient | null | undefined,
  options: PhotoMirrorOptions = {},
): Promise<T> {
  const [enriched] = await withPhotoMirrors([sale], client, {
    photos: PHOTO_MIRROR_DETAIL_PHOTOS,
    ...options,
  });
  return enriched ?? sale;
}

/** Ce que l'on met dans `src` / `srcSet` d'une `<img>` pour afficher la copie. */
export type PhotoMirrorDisplay = { src: string; srcSet?: string };

function storageBase(): string | null {
  const base = publicEnv().supabaseUrl?.trim().replace(/\/+$/, "");
  return base && /^https?:\/\//i.test(base)
    ? `${base}/storage/v1/object/public/${PHOTO_MIRROR_BUCKET}/`
    : null;
}

/**
 * Origine du stockage des copies (`https://<projet>.supabase.co`), pour `preconnect` ; `null` si
 * l'interrupteur est éteint ou si Supabase n'est pas configuré (aucune connexion à préparer).
 */
export function photoMirrorOrigin(): string | null {
  if (!isPhotoMirrorEnabled()) return null;
  const base = storageBase();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** URL publique d'un fichier du bucket, ou `null` si le chemin ou la configuration est invalide. */
export function photoMirrorUrl(path: string | null | undefined): string | null {
  const base = storageBase();
  const safe = safePath(path);
  return base && safe ? `${base}${safe}` : null;
}

/** `true` si l'URL est celle d'une copie hébergée (et non celle d'une source). */
export function isPhotoMirrorUrl(url: string | null | undefined): boolean {
  const base = storageBase();
  return Boolean(base && url && url.startsWith(base));
}

/** Vignette de carte : la copie 640 px, servie telle quelle (déjà en WebP à la bonne taille). */
export function photoMirrorForCard(mirror: SaleMediaMirror | null | undefined) {
  const src = photoMirrorUrl(mirror?.path640);
  return src ? ({ src } satisfies PhotoMirrorDisplay) : null;
}

/** Fiche : `srcset` 640w / 1600w, la grande copie par défaut. */
export function photoMirrorForDetail(
  mirror: SaleMediaMirror | null | undefined,
): PhotoMirrorDisplay | null {
  const small = photoMirrorUrl(mirror?.path640);
  if (!small) return null;
  const large = photoMirrorUrl(mirror?.path1600);
  if (!large) return { src: small };
  return { src: large, srcSet: `${small} 640w, ${large} 1600w` };
}
