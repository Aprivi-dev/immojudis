import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import {
  fetchPhotoMirrorsStrict,
  photoMirrorLookupUrls,
  PHOTO_MIRROR_TIMEOUT_MS,
  type PhotoMirrorClient,
} from "@/lib/photo-mirror";
import type { SaleMediaMirror } from "@/lib/types";

/** Les copies trouvées sont gardées 5 minutes, comme la première page et la fiche. */
export const PHOTO_MIRROR_REVALIDATE_SECONDS = 300;
export const PHOTO_MIRROR_CACHE_TAG = "photo-mirrors";
export const PHOTO_MIRROR_CACHE_KEY = ["photo-mirrors", "v1"] as const;

/** Empreinte de l'ensemble des URL cherchées, quel que soit leur ordre. */
export function photoMirrorUrlsHash(urls: string[]): string {
  return createHash("sha256")
    .update([...new Set(urls)].sort().join("\n"))
    .digest("hex");
}

/** Rien de positif à garder : lancé pour que le cache n'enregistre pas une réponse vide. */
class NothingToCache extends Error {}

/**
 * Lecture des copies avec le cache de données de Next : une clé par ensemble d'URL (empreinte des
 * URL triées), 5 minutes. Seuls les résultats POSITIFS sont gardés. Une erreur, une réponse
 * inattendue, un délai dépassé ou l'absence de copie font lever la fonction mise en cache, ce
 * qu'`unstable_cache` n'enregistre pas : la page suivante réessaie. Le serveur affiche alors les
 * photos des sources, comme sans copie (jamais d'erreur visible).
 *
 * Renvoie une fonction compatible avec l'option `fetchMirrors` de `withPhotoMirrors`.
 */
export function cachedPhotoMirrorFetcher(
  client: PhotoMirrorClient | null | undefined,
  options: {
    timeoutMs?: number;
    /**
     * Appelée quand la lecture a ÉCHOUÉ (erreur, réponse inattendue, délai dépassé) et que la table
     * rendue est vide pour cette raison. Pas appelée quand la base répond qu'aucune copie n'existe
     * : cette réponse-là est exacte. Permet à une réponse publique de ne pas figer l'échec dans le CDN.
     */
    onUnavailable?: () => void;
  } = {},
): (urls: string[]) => Promise<Map<string, SaleMediaMirror>> {
  return async (urls) => {
    const lookupUrls = photoMirrorLookupUrls(urls).sort();
    if (!client || !lookupUrls.length) return new Map();

    try {
      const entries = await unstable_cache(
        async (): Promise<Array<[string, SaleMediaMirror]>> => {
          const mirrors = await fetchPhotoMirrorsStrict(client, lookupUrls, {
            timeoutMs: options.timeoutMs ?? PHOTO_MIRROR_TIMEOUT_MS,
          });
          if (!mirrors.size) throw new NothingToCache();
          return [...mirrors];
        },
        [...PHOTO_MIRROR_CACHE_KEY, photoMirrorUrlsHash(lookupUrls)],
        { revalidate: PHOTO_MIRROR_REVALIDATE_SECONDS, tags: [PHOTO_MIRROR_CACHE_TAG] },
      )();
      return new Map(entries);
    } catch (error) {
      if (!(error instanceof NothingToCache)) {
        options.onUnavailable?.();
        console.warn(
          "[photos] Copies indisponibles, photos des sources affichées:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return new Map();
    }
  };
}
