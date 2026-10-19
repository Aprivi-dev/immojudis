import type { MetadataRoute } from "next";
import { RESOURCE_ARTICLES, resourceLastModified } from "@/lib/resource-articles";
import { resolveSiteOrigin } from "@/lib/site-url";

// `/ressources/sitemap.xml`: the articles of the blog. The index page `/ressources` and the pillar
// guide are listed in `/sitemap.xml` with the other pages. Read on request so that the origin
// (SITE_URL) is the one of the running deployment, not the one of the build.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return RESOURCE_ARTICLES.map((article) => ({
    url: `${origin}${article.href}`,
    lastModified: resourceLastModified(article),
  }));
}
