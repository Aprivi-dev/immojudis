import type { MetadataRoute } from "next";
import { loadSitemapSales, ROOT_SITEMAP_SALE_CAPACITY } from "@/lib/public-sitemap.server";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { RESOURCE_ARTICLES } from "@/lib/resource-articles";
import { resolveSiteOrigin } from "@/lib/site-url";

// Rebuilt on request from the data cache (refreshed every hour), never frozen at
// build time: a sale published today must be listed today.
export const dynamic = "force-dynamic";

/**
 * Last real content change of each static page (not "now": a date that moves on
 * every request teaches crawlers to ignore it). Update the date when the page's
 * content changes materially.
 *
 * Every path must answer 200 itself: the test of this file checks that none of them is the
 * source of a redirect of `next.config.ts` (the offers page lives at `/offres`).
 */
const PUBLIC_ROUTES = [
  ["", "2026-10-08"],
  ["/sales", null], // the catalogue changes with the newest sale
  ["/avocats", "2026-10-08"],
  ["/offres", "2026-10-08"],
  ["/comment-ca-marche", "2026-10-13"],
  ["/ressources", "2026-10-08"],
  ["/tribunaux", "2026-10-08"],
  ["/annonce-exemple", "2026-10-09"],
  ["/ventes-immobilieres-judiciaires", "2026-10-13"],
  ["/simulateur-frais-encheres", "2026-10-13"],
  ["/a-propos", "2026-10-13"],
  ["/contact", "2026-10-08"],
  ["/legal", "2026-10-08"],
  ["/conditions-generales", "2026-10-08"],
  ["/privacy", "2026-10-14"],
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;

  // A database error is not hidden behind a shorter sitemap: it would tell crawlers that the
  // sales are gone. The request fails (5xx), crawlers retry later, and the data cache never
  // stores a thrown error. `loadPublicTribunalActivity` is the exception: it reports an
  // unavailable database as an error result, and `/tribunaux` then stays listed (only a
  // successful read that finds no court removes it).
  const [sales, tribunals] = await Promise.all([
    loadSitemapSales(0, ROOT_SITEMAP_SALE_CAPACITY),
    loadPublicTribunalActivity(),
  ]);

  const newestSale = sales.reduce<string | null>(
    (newest, sale) =>
      sale.lastModified && (!newest || sale.lastModified > newest) ? sale.lastModified : newest,
    null,
  );

  return [
    ...PUBLIC_ROUTES
      // The courts page has nothing to list (and is not indexed) while no court is listed.
      // A read error is not "no court": the page stays in the sitemap.
      .filter(
        ([path]) =>
          path !== "/tribunaux" || tribunals.status === "error" || tribunals.items.length > 0,
      )
      .map(([path, modified]) => {
        const lastModified = path === "/sales" ? newestSale : modified;
        return { url: `${origin}${path}`, ...(lastModified ? { lastModified } : {}) };
      }),
    ...RESOURCE_ARTICLES.map((article) => ({
      url: `${origin}${article.href}`,
      lastModified: article.publishedAt,
    })),
    ...sales.map((sale) => ({
      url: `${origin}/sales/${sale.id}`,
      ...(sale.lastModified ? { lastModified: sale.lastModified } : {}),
    })),
  ];
}
