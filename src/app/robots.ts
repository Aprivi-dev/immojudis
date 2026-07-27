import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/", "/login", "/publish", "/reports/shared/"],
    },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
