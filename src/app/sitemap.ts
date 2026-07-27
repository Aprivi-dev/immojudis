import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site-url";

const PUBLIC_ROUTES = [
  ["", "weekly", 1],
  ["/sales", "daily", 0.95],
  ["/avocats", "weekly", 0.85],
  ["/annonce-exemple", "monthly", 0.8],
  ["/accompagnement", "monthly", 0.75],
  ["/ressources", "weekly", 0.75],
  ["/ventes-immobilieres-judiciaires", "monthly", 0.7],
  ["/a-propos", "monthly", 0.55],
  ["/contact", "monthly", 0.5],
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const lastModified = new Date();
  return PUBLIC_ROUTES.map(([path, changeFrequency, priority]) => ({
    url: `${origin}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
