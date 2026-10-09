import type { MetadataRoute } from "next";
import {
  loadSitemapSales,
  loadSitemapSaleTotal,
  overflowSitemapCount,
  ROOT_SITEMAP_SALE_CAPACITY,
  SITEMAP_URL_LIMIT,
} from "@/lib/public-sitemap.server";
import { resolveSiteOrigin } from "@/lib/site-url";

// Sales beyond the first ROOT_SITEMAP_SALE_CAPACITY (which `/sitemap.xml` lists)
// are split in files of SITEMAP_URL_LIMIT URLs: /sales/sitemap/0.xml, 1.xml…
// While the catalogue fits in `/sitemap.xml`, no file is generated here.
export const dynamic = "force-dynamic";

export async function generateSitemaps() {
  try {
    const count = overflowSitemapCount(await loadSitemapSaleTotal());
    return Array.from({ length: count }, (_, id) => ({ id }));
  } catch {
    return [];
  }
}

export default async function sitemap(props: {
  id: Promise<string>;
}): Promise<MetadataRoute.Sitemap> {
  const index = Number(await props.id);
  if (!Number.isInteger(index) || index < 0) return [];
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const start = ROOT_SITEMAP_SALE_CAPACITY + index * SITEMAP_URL_LIMIT;
  const sales = await loadSitemapSales(start, start + SITEMAP_URL_LIMIT);
  return sales.map((sale) => ({
    url: `${origin}/sales/${sale.id}`,
    ...(sale.lastModified ? { lastModified: sale.lastModified } : {}),
    changeFrequency: "daily" as const,
    priority: 0.6,
  }));
}
