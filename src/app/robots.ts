import type { MetadataRoute } from "next";
import { loadSitemapSaleTotal, salesSitemapCount } from "@/lib/public-sitemap.server";
import { isSiteIndexable } from "@/lib/seo-indexing";
import { isNonProductionVercelDeployment, resolveSiteOrigin } from "@/lib/site-url";

// Lists the three kinds of sitemap: the pages, the articles and the sales files.
export const dynamic = "force-dynamic";

async function salesSitemaps(origin: string): Promise<string[]> {
  try {
    const count = salesSitemapCount(await loadSitemapSaleTotal());
    return Array.from({ length: count }, (_, id) => `${origin}/sales/sitemap/${id}.xml`);
  } catch {
    // A database error must not remove the robots.txt: the other sitemaps stay listed.
    return [];
  }
}

export default async function robots(): Promise<MetadataRoute.Robots> {
  // A preview or development deployment is never a page to index (the same decision is sent as
  // an `X-Robots-Tag` header by src/proxy.ts), and it must not advertise a sitemap.
  if (isNonProductionVercelDeployment()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  const rules = {
    userAgent: "*",
    allow: "/",
    // `/login` is not listed: a blocked page cannot be crawled, so its `noindex` would never
    // be seen. The page itself carries `robots: noindex`.
    disallow: ["/admin/", "/api/", "/publish", "/reports/shared/"],
  };

  // Indexing closed (SEO_INDEXING_ENABLED is not "true"): no sitemap is advertised and every
  // response carries `X-Robots-Tag: noindex` (src/proxy.ts). The site is deliberately NOT
  // blocked with `Disallow: /`: a crawler that may not fetch a page never reads its `noindex`,
  // and a URL that is already known (a link, an earlier crawl) can stay listed without a
  // snippet. Letting the crawler in is what lets the `noindex` take effect and drop the URL.
  if (!isSiteIndexable()) return { rules };

  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return {
    rules,
    sitemap: [
      `${origin}/sitemap.xml`,
      `${origin}/ressources/sitemap.xml`,
      ...(await salesSitemaps(origin)),
    ],
  };
}
