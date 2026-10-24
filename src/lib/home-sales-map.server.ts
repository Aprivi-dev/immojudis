import "server-only";
import { unstable_cache } from "next/cache";
import { projectOnFranceMap } from "@/lib/home-france-map";
import { readAllPublicSales } from "@/lib/department-pages.server";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import { runPreviewSearch, type PreviewRpcClient } from "@/lib/search/preview-search";
import { isInMetropolitanFrance } from "@/lib/search/map-framing";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import type { AuctionSale } from "@/lib/types";

/**
 * Les ventes à venir posées sur la carte de l'accueil, et deux chiffres tirés des mêmes lignes.
 *
 * La recherche publique du catalogue (la même que /sales pour un visiteur) est lue en entier, par
 * pages de 100, une fois par heure, comme pour les pages de département. Les ventes sont regroupées
 * en cases d'environ 35 km (`CELL_DEGREES`) ; chaque case est posée au centre de ses ventes, arrondi
 * à 5 km environ : la carte montre où sont les ventes, jamais une adresse. Seules les cases sont
 * gardées en cache et envoyées à la page.
 */
export type HomeSalesMapCell = {
  /** Position du centre de la case, en unités du `viewBox` de la carte (arrondie au dixième). */
  x: number;
  y: number;
  count: number;
};

export type HomeSalesMap = {
  cells: HomeSalesMapCell[];
  /** Plus petite mise à prix connue parmi les ventes lues (euros), ou `null`. */
  lowestStartingPrice: number | null;
  /** Nombre de lieux de vente présents : tribunal, notaire, État. */
  venueTypes: number;
};

export type HomeSalesMapDependencies = {
  client?: PreviewRpcClient | null;
  timeoutMs?: number;
};

const CELL_DEGREES = 0.35;
const POSITION_DEGREES = 0.05;
const LOAD_TIMEOUT_MS = 8_000;
export const HOME_SALES_MAP_REVALIDATE_SECONDS = 3_600;
const KNOWN_VENUE_TYPES = new Set(["tribunal", "notary", "state"]);

/** Regroupe les ventes en cases ; les plus fournies d'abord (elles apparaissent les premières). */
export function homeSalesMapFromSales(sales: readonly AuctionSale[]): HomeSalesMap {
  const cells = new Map<string, { latitudeSum: number; longitudeSum: number; count: number }>();
  let lowestStartingPrice: number | null = null;
  const venues = new Set<string>();
  for (const sale of sales) {
    const price = sale.starting_price_eur;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      lowestStartingPrice =
        lowestStartingPrice === null ? price : Math.min(lowestStartingPrice, price);
    }
    if (sale.sale_venue_type && KNOWN_VENUE_TYPES.has(sale.sale_venue_type)) {
      venues.add(sale.sale_venue_type);
    }
    const { latitude, longitude } = sale;
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;
    if (!isInMetropolitanFrance(latitude, longitude)) continue;
    const key = `${Math.round(latitude / CELL_DEGREES)}:${Math.round(longitude / CELL_DEGREES)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.latitudeSum += latitude;
      cell.longitudeSum += longitude;
      cell.count += 1;
    } else {
      cells.set(key, { latitudeSum: latitude, longitudeSum: longitude, count: 1 });
    }
  }
  // Le point d'un secteur est au centre de ses ventes, arrondi à 0,05° (5 km environ) : une case
  // d'une seule vente ne montre donc pas sa position exacte.
  const blur = (value: number) => Math.round(value / POSITION_DEGREES) * POSITION_DEGREES;
  const tenth = (value: number) => Math.round(value * 10) / 10;
  return {
    cells: [...cells.values()]
      .map(({ latitudeSum, longitudeSum, count }) => ({
        latitude: blur(latitudeSum / count),
        longitude: blur(longitudeSum / count),
        count,
      }))
      .sort((a, b) => b.count - a.count || b.latitude - a.latitude || a.longitude - b.longitude)
      .map(({ latitude, longitude, count }) => {
        const { x, y } = projectOnFranceMap(latitude, longitude);
        return { x: tenth(x), y: tenth(y), count };
      }),
    lowestStartingPrice,
    venueTypes: venues.size,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Délai dépassé pour la carte de l'accueil.")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Même lecture que les pages de département : toutes les pages de la liste publique. */
async function readAllUpcomingSales(client: PreviewRpcClient): Promise<AuctionSale[]> {
  return readAllPublicSales(async (page) => {
    const response = await runPreviewSearch(client, { sort: "sale_date_asc", limit: 100, page });
    return {
      items: excludeHomepageExampleSales(response.items),
      count: response.count,
      fetched: response.items.length,
    };
  }, "home-map");
}

async function readHomeSalesMap(): Promise<HomeSalesMap> {
  const client = createPublicSupabaseClient() as unknown as PreviewRpcClient | null;
  if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
  return homeSalesMapFromSales(await readAllUpcomingSales(client));
}

const cachedHomeSalesMap = unstable_cache(readHomeSalesMap, ["home-sales-map", "v2"], {
  revalidate: HOME_SALES_MAP_REVALIDATE_SECONDS,
});

/**
 * Carte de l'accueil, ou `null` si la base répond mal ou ne rend aucune vente placée : l'accueil
 * montre alors le contour seul, sans point ni chiffre inventé.
 */
export async function loadHomeSalesMap(
  dependencies: HomeSalesMapDependencies = {},
): Promise<HomeSalesMap | null> {
  try {
    const map = await withTimeout(
      dependencies.client !== undefined
        ? dependencies.client
          ? readAllUpcomingSales(dependencies.client).then(homeSalesMapFromSales)
          : Promise.reject(new Error("Supabase n'est pas configuré côté serveur."))
        : cachedHomeSalesMap(),
      dependencies.timeoutMs ?? LOAD_TIMEOUT_MS,
    );
    return map.cells.length ? map : null;
  } catch (error) {
    console.warn(
      "[accueil] Carte des ventes indisponible:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
