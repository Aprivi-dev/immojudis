import type { MetadataRoute } from "next";
import { loadSitemapSales, ROOT_SITEMAP_SALE_CAPACITY } from "@/lib/public-sitemap.server";
import { RESOURCE_ARTICLES } from "@/lib/resource-articles";
import { resolveSiteOrigin } from "@/lib/site-url";

// Rebuilt on request from the data cache (refreshed every hour), never frozen at
// build time: a sale published today must be listed today.
export const dynamic = "force-dynamic";

/**
 * Last real content change of each static page (not "now": a date that moves on
 * every request teaches crawlers to ignore it). Update the date when the page's
 * content changes materially.
 */
const PUBLIC_ROUTES = [
  ["", "weekly", 1, "2026-10-08"],
  ["/sales", "daily", 0.95, null], // the catalogue changes with the newest sale
  ["/avocats", "weekly", 0.85, "2026-10-08"],
  ["/accompagnement", "monthly", 0.75, "2026-10-08"],
  ["/comment-ca-marche", "monthly", 0.75, "2026-10-08"],
  ["/ressources", "weekly", 0.8, "2026-10-08"],
  ["/tribunaux", "weekly", 0.75, "2026-10-08"],
  ["/annonce-exemple", "monthly", 0.6, "2026-10-09"],
  ["/ventes-immobilieres-judiciaires", "monthly", 0.7, "2026-10-08"],
  ["/a-propos", "monthly", 0.55, "2026-09-13"],
  ["/contact", "monthly", 0.5, "2026-10-08"],
  ["/legal", "yearly", 0.35, "2026-10-08"],
  ["/conditions-generales", "yearly", 0.35, "2026-10-08"],
  ["/privacy", "yearly", 0.35, "2026-10-08"],
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;

  // The sales are an enrichment: if the database cannot be read right now the
  // static pages are still served, and the next request tries again.
  let sales: Awaited<ReturnType<typeof loadSitemapSales>> = [];
  try {
    sales = await loadSitemapSales(0, ROOT_SITEMAP_SALE_CAPACITY);
  } catch (error) {
    console.error(
      "[sitemap] Ventes indisponibles, sitemap limité aux pages statiques:",
      error instanceof Error ? error.message : error,
    );
  }

  const newestSale = sales.reduce<string | null>(
    (newest, sale) =>
      sale.lastModified && (!newest || sale.lastModified > newest) ? sale.lastModified : newest,
    null,
  );

  return [
    ...PUBLIC_ROUTES.map(([path, changeFrequency, priority, modified]) => {
      const lastModified = path === "/sales" ? newestSale : modified;
      return {
        url: `${origin}${path}`,
        ...(lastModified ? { lastModified } : {}),
        changeFrequency,
        priority,
      };
    }),
    ...RESOURCE_ARTICLES.map((article) => ({
      url: `${origin}${article.href}`,
      lastModified: article.publishedAt,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...sales.map((sale) => ({
      url: `${origin}/sales/${sale.id}`,
      ...(sale.lastModified ? { lastModified: sale.lastModified } : {}),
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
  ];
}
