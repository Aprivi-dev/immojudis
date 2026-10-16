import "server-only";
import { loadInitialCatalogue, type InitialCatalogue } from "@/lib/public-catalogue.server";
import {
  loadSitemapSaleTotal,
  loadSitemapSales,
  type SitemapSale,
} from "@/lib/public-sitemap.server";

/**
 * Les deux chiffres de la ligne « N ventes à venir · mises à jour le … » de l'accueil, calculés sur
 * nos données :
 * - `count` : le total que /sales affiche pour une recherche sans filtre (même fonction, même
 *   cache de 5 minutes que la première page du catalogue) ;
 * - `updatedAt` : la mise à jour la plus récente parmi les ventes publiques (la colonne
 *   `updated_at` que lit aussi le sitemap, cache d'une heure). `null` quand elle manque.
 */
export type HomeCatalogueSummary = {
  count: number;
  updatedAt: string | null;
};

export type HomeCatalogueSummaryDependencies = {
  catalogue?: () => Promise<InitialCatalogue | null>;
  /** Ventes publiques avec leur dernière mise à jour. */
  sales?: () => Promise<SitemapSale[]>;
  now?: Date;
  timeoutMs?: number;
};

const SUMMARY_TIMEOUT_MS = 4_000;
/** Une mise à jour datée du futur (horloge ou donnée fausse) n'est pas affichée. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

async function defaultSales(): Promise<SitemapSale[]> {
  const total = await loadSitemapSaleTotal();
  return loadSitemapSales(0, total);
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

/** Date ISO la plus récente, ou `null` si aucune n'est exploitable. */
export function latestUpdate(sales: SitemapSale[], now: Date): string | null {
  const limit = now.getTime() + FUTURE_TOLERANCE_MS;
  let latest: number | null = null;
  for (const { lastModified } of sales) {
    if (!lastModified) continue;
    const time = Date.parse(lastModified);
    if (!Number.isFinite(time) || time > limit) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * Chiffres de l'accueil. Retourne `null` quand le total est inconnu, nul ou que la base répond mal :
 * l'accueil n'affiche alors aucune ligne (jamais de chiffre inventé, jamais d'erreur). Une date
 * introuvable laisse le total seul.
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

    let updatedAt: string | null = null;
    try {
      updatedAt = latestUpdate(
        await withTimeout((dependencies.sales ?? defaultSales)(), timeoutMs),
        now,
      );
    } catch (error) {
      console.warn(
        "[accueil] Date de mise à jour indisponible:",
        error instanceof Error ? error.message : error,
      );
    }
    return { count: Math.round(count), updatedAt };
  } catch (error) {
    console.warn(
      "[accueil] Chiffres du catalogue indisponibles:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
