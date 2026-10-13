import type { MetadataRoute } from "next";
import { loadSitemapSaleTotal, overflowSitemapCount } from "@/lib/public-sitemap.server";
import { isNonProductionVercelDeployment, resolveSiteOrigin } from "@/lib/site-url";

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
  // A preview or development deployment is never a page to index (the same decision is sent as
  // an `X-Robots-Tag` header by next.config.ts), and it must not advertise a sitemap.
  if (isNonProductionVercelDeployment()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // `/login` is not listed: a blocked page cannot be crawled, so its `noindex` would never
      // be seen. The page itself carries `robots: noindex`.
      disallow: ["/admin/", "/api/", "/publish", "/reports/shared/"],
    },
    sitemap: [`${origin}/sitemap.xml`, ...(await overflowSitemaps(origin))],
  };
}
