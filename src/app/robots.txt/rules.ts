import { isSiteIndexable } from "@/lib/seo-indexing";
import { isNonProductionVercelDeployment, siteOrigin } from "@/lib/site-url";
import { generateSitemaps as salesSitemaps } from "../sales/sitemap";

/** What `/robots.txt` says: one group of rules for every crawler, and the sitemaps when the site is open. */
export interface RobotsRules {
  rules: { userAgent: string; allow?: string; disallow: string | string[] };
  sitemap?: string[];
}

/** Lists the three kinds of sitemap: the pages, the articles and the sales files. */
export async function robotsRules(): Promise<RobotsRules> {
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

  const origin = siteOrigin();
  return {
    rules,
    sitemap: [
      `${origin}/sitemap.xml`,
      `${origin}/ressources/sitemap.xml`,
      // Exactly the files that /sales/sitemap/[id].xml generates (none while the database cannot
      // be read: the other sitemaps stay listed).
      ...(await salesSitemaps()).map(({ id }) => `${origin}/sales/sitemap/${id}.xml`),
    ],
  };
}

/** The text of `/robots.txt` for these rules (Robots Exclusion Standard). */
export function robotsTxt({ rules, sitemap = [] }: RobotsRules): string {
  const lines = [
    `User-Agent: ${rules.userAgent}`,
    ...(rules.allow ? [`Allow: ${rules.allow}`] : []),
    ...[rules.disallow].flat().map((path) => `Disallow: ${path}`),
    "",
    ...sitemap.map((url) => `Sitemap: ${url}`),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
