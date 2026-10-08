import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site-url";
import { RESOURCE_ARTICLES } from "@/lib/resource-articles";

const PUBLIC_ROUTES = [
  ["", "weekly", 1],
  ["/sales", "daily", 0.95],
  ["/avocats", "weekly", 0.85],
  ["/accompagnement", "monthly", 0.75],
  ["/comment-ca-marche", "monthly", 0.75],
  ["/ressources", "weekly", 0.8],
  ["/ventes-immobilieres-judiciaires", "monthly", 0.7],
  ["/a-propos", "monthly", 0.55],
  ["/contact", "monthly", 0.5],
  ["/legal", "yearly", 0.35],
  ["/conditions-generales", "yearly", 0.35],
  ["/privacy", "yearly", 0.35],
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return [
    ...PUBLIC_ROUTES.map(([path, changeFrequency, priority]) => ({
      url: `${origin}${path}`,
      changeFrequency,
      priority,
    })),
    ...RESOURCE_ARTICLES.map((article) => ({
      url: `${origin}${article.href}`,
      lastModified: article.publishedAt,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
