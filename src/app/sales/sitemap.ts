import type { MetadataRoute } from "next";
import {
  loadSitemapSales,
  loadSitemapSaleTotal,
  salesSitemapCount,
  SITEMAP_URL_LIMIT,
} from "@/lib/public-sitemap.server";
import { resolveSiteOrigin } from "@/lib/site-url";

// The public, indexable sales (thin pages are left out by the database function) in files of
// SITEMAP_URL_LIMIT URLs: /sales/sitemap/0.xml, 1.xml… robots.txt lists every file. A file is
// generated per started block of 5 000 sales, none while the catalogue is empty.
export const dynamic = "force-dynamic";

export async function generateSitemaps() {
  try {
    const count = salesSitemapCount(await loadSitemapSaleTotal());
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
  const start = index * SITEMAP_URL_LIMIT;
  const sales = await loadSitemapSales(start, start + SITEMAP_URL_LIMIT);
  return sales.map((sale) => ({
    url: `${origin}/sales/${sale.id}`,
    ...(sale.lastModified ? { lastModified: sale.lastModified } : {}),
  }));
}
