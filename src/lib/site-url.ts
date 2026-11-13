import { ConfigurationError } from "@/lib/api-errors";
import { serverEnv, type EnvSource } from "@/lib/env";

// Compared with `EXPLICIT_SITE_URL_ENV_NAMES` by scripts/verify-required-env.test.mjs.
export { SITE_URL_ENV_NAMES } from "@/lib/env";

type SiteUrlEnv = EnvSource;

/**
 * Vrai pour un déploiement Vercel qui n'est pas la production (aperçu, développement) :
 * `VERCEL_ENV` est défini et différent de `production`. Hors Vercel (poste local, CI), la
 * variable est absente et le résultat est faux. Ces déploiements ne doivent pas être indexés.
 */
export function isNonProductionVercelDeployment(env: SiteUrlEnv = process.env): boolean {
  const vercelEnv = env.VERCEL_ENV?.trim();
  return Boolean(vercelEnv) && vercelEnv !== "production";
}

export function resolveSiteOrigin(
  env: SiteUrlEnv = process.env,
  fallback: string | null = null,
): string | null {
  // `VERCEL_URL` est l'adresse propre au déploiement (xxx.vercel.app), jamais le domaine public :
  // en production elle ne compte pas (voir `siteUrl` dans env.ts). Le domaine doit y être déclaré
  // explicitement (`SITE_URL`).
  const rawValue = serverEnv(env).siteUrl ?? fallback;
  if (!rawValue) return null;
  const raw = rawValue.trim();

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigurationError(`Invalid canonical URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ConfigurationError(`Canonical URL not allowed: ${raw}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigurationError(`Canonical URL must be an origin without a path: ${raw}`);
  }
  return url.origin;
}

/**
 * Origine publique utilisée par les pages, les sitemaps et robots.txt. Sans adresse configurée
 * (poste local, CI), `http://localhost:3000`.
 */
export function siteOrigin(): string {
  return resolveSiteOrigin(process.env, "http://localhost:3000")!;
}
