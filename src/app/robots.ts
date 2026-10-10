import type { MetadataRoute } from "next";
import { loadSitemapSaleTotal, overflowSitemapCount } from "@/lib/public-sitemap.server";
import { resolveSiteOrigin } from "@/lib/site-url";

// Lists the extra sales sitemaps when the catalogue outgrows `/sitemap.xml`.
export const dynamic = "force-dynamic";

async function overflowSitemaps(origin: string): Promise<string[]> {
  try {
    const count = overflowSitemapCount(await loadSitemapSaleTotal());
    return Array.from({ length: count }, (_, id) => `${origin}/sales/sitemap/${id}.xml`);
  } catch {
    return [];
  }
}

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/", "/login", "/publish", "/reports/shared/"],
    },
    sitemap: [`${origin}/sitemap.xml`, ...(await overflowSitemaps(origin))],
    host: origin,
  };
}
