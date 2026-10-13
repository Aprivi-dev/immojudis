export const SITE_URL_ENV_NAMES = [
  "SITE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "APP_URL",
  "VERCEL_URL",
] as const;

type SiteUrlEnv = Readonly<Record<string, string | undefined>>;

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
  // en production elle ne doit pas devenir l'origine canonique. Le domaine doit y être déclaré
  // explicitement (`SITE_URL`).
  const names = SITE_URL_ENV_NAMES.filter(
    (name) => name !== "VERCEL_URL" || env.VERCEL_ENV?.trim() !== "production",
  );
  const configured = names.map((name) => env[name]).find(isFilled);
  const rawValue = configured ?? fallback;
  if (!rawValue) return null;
  const raw = rawValue.trim();

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`URL canonique invalide: ${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`URL canonique non autorisée: ${raw}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`L'URL canonique doit être une origine sans chemin: ${raw}`);
  }
  return url.origin;
}

function isFilled(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
