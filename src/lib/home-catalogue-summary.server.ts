import "server-only";
import { loadInitialCatalogue, type InitialCatalogue } from "@/lib/public-catalogue.server";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * Les deux éléments de la ligne « N ventes à venir · données vérifiées le … » de l'accueil, calculés
 * sur nos données :
 * - `count` : le total que /sales affiche pour une recherche sans filtre (même fonction, même
 *   cache de 5 minutes que la première page du catalogue) ;
 * - `verifiedAt` : la date de la dernière collecte réussie d'une source (la plus récente
 *   `last_publication_complete_at`, lue par `get_public_catalogue_verified_at` : une ligne agrégée,
 *   sans relire les ventes). Ce n'est PAS la date de modification d'une fiche : la colonne
 *   `updated_at` des ventes bouge à chaque passage de la collecte, même sans changement visible, et la
 *   ligne ne prétend pas qu'une annonce a changé ce jour-là. `null` quand la date manque.
 */
export type HomeCatalogueSummary = {
  count: number;
  verifiedAt: string | null;
};

export type HomeCatalogueSummaryDependencies = {
  catalogue?: () => Promise<InitialCatalogue | null>;
  /** Date de la dernière collecte réussie (ISO), ou `null` si aucune. */
  verifiedAt?: () => Promise<string | null>;
  now?: Date;
  timeoutMs?: number;
};

const SUMMARY_TIMEOUT_MS = 4_000;
/** Une date du futur (horloge ou donnée fausse) n'est pas affichée. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

type VerifiedAtClient = {
  rpc: (fn: "get_public_catalogue_verified_at") => PromiseLike<{ data: unknown; error: unknown }>;
};

/** Lecture minimale : une fonction publique qui rend une seule date. */
async function defaultVerifiedAt(): Promise<string | null> {
  const client = createPublicSupabaseClient() as unknown as VerifiedAtClient | null;
  if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
  const { data, error } = await client.rpc("get_public_catalogue_verified_at");
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Délai dépassé pour le résumé du catalogue.")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Date ISO exploitable (lisible, pas dans le futur), ou `null`. */
export function usableVerifiedAt(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now.getTime() + FUTURE_TOLERANCE_MS) return null;
  return new Date(time).toISOString();
}

/**
 * Chiffres de l'accueil. Retourne `null` quand le total est inconnu, nul ou que la base répond mal :
 * l'accueil n'affiche alors aucune ligne (jamais de chiffre inventé, jamais d'erreur). Une date
 * introuvable (fonction pas encore posée, aucune collecte réussie) laisse le total seul.
 */
export async function loadHomeCatalogueSummary(
  dependencies: HomeCatalogueSummaryDependencies = {},
): Promise<HomeCatalogueSummary | null> {
  const timeoutMs = dependencies.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const now = dependencies.now ?? new Date();
  try {
    const catalogue = await withTimeout(
      (dependencies.catalogue ?? (() => loadInitialCatalogue({})))(),
      timeoutMs,
    );
    const count = catalogue?.count;
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;

    let verifiedAt: string | null = null;
    try {
      verifiedAt = usableVerifiedAt(
        await withTimeout((dependencies.verifiedAt ?? defaultVerifiedAt)(), timeoutMs),
        now,
      );
    } catch (error) {
      console.warn(
        "[accueil] Date de la dernière collecte indisponible:",
        error instanceof Error ? error.message : error,
      );
    }
    return { count: Math.round(count), verifiedAt };
  } catch (error) {
    console.warn(
      "[accueil] Chiffres du catalogue indisponibles:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
