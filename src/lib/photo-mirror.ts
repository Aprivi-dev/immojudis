import { publicEnv } from "@/lib/env";
import { shouldRejectPropertyImageSize } from "@/lib/sale-media";
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
/** Délai au-delà duquel on affiche les photos des sources plutôt que d'attendre les copies. */
export const PHOTO_MIRROR_TIMEOUT_MS = 300;
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

/**
 * Un seul appel pour toutes les URL (au plus 100 distinctes). Ne lève jamais : interrupteur éteint,
 * erreur, réponse inattendue ou délai dépassé donnent une table vide et une ligne de journal.
 */
export async function fetchPhotoMirrors(
  client: PhotoMirrorClient | null | undefined,
  urls: Iterable<string>,
  options: { timeoutMs?: number; enabled?: boolean } = {},
): Promise<Map<string, SaleMediaMirror>> {
  const mirrors = new Map<string, SaleMediaMirror>();
  if (!client || !(options.enabled ?? isPhotoMirrorEnabled())) return mirrors;

  const distinct = [...new Set(urls)]
    .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
    .slice(0, PHOTO_MIRROR_MAX_URLS);
  if (!distinct.length) return mirrors;

  const timeoutMs = options.timeoutMs ?? PHOTO_MIRROR_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`délai de ${timeoutMs} ms dépassé`)), timeoutMs);
    });
    const { data, error } = await Promise.race([
      Promise.resolve(client.rpc("sale_photo_mirrors", { p_source_urls: distinct })),
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
  } catch (error) {
    console.warn(
      "[photos] Copies indisponibles, photos des sources affichées:",
      errorMessage(error),
    );
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ajoute `mirror` aux photos des ventes qui ont une copie, avec un seul appel pour la page.
 * `first` : la 1re photo de chaque vente (cartes de liste). `all` : toutes (fiche d'une vente).
 * Ne modifie rien : renvoie la même liste si aucune copie n'est trouvée.
 */
export async function withPhotoMirrors<T extends { media?: AuctionSale["media"] }>(
  sales: T[],
  client: PhotoMirrorClient | null | undefined,
  options: { scope?: "first" | "all"; timeoutMs?: number } = {},
): Promise<T[]> {
  if (!client || !sales.length || !isPhotoMirrorEnabled()) return sales;

  const scope = options.scope ?? "first";
  const mediaOf = (sale: T): SaleMedia[] => {
    const media = Array.isArray(sale?.media) ? sale.media : [];
    return scope === "first" ? media.slice(0, 1) : media;
  };
  const urls: string[] = [];
  for (const sale of sales) {
    for (const item of mediaOf(sale)) if (typeof item?.url === "string") urls.push(item.url);
  }

  const mirrors = await fetchPhotoMirrors(client, urls, { timeoutMs: options.timeoutMs });
  if (!mirrors.size) return sales;

  let changed = false;
  const enriched = sales.map((sale) => {
    const targets = new Set(mediaOf(sale));
    if (!Array.isArray(sale?.media) || !sale.media.some((item) => targets.has(item))) return sale;
    let touched = false;
    const media = sale.media.map((item) => {
      const mirror = targets.has(item) ? mirrors.get(item.url) : undefined;
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

/** Même chose pour une seule vente (fiche) : toutes ses photos sont cherchées. */
export async function withPhotoMirror<T extends { media?: AuctionSale["media"] }>(
  sale: T,
  client: PhotoMirrorClient | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const [enriched] = await withPhotoMirrors([sale], client, { ...options, scope: "all" });
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
