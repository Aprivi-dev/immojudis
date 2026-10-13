/**
 * Launch guards shared by the production build (`verify-required-env.mjs`).
 *
 * A production deployment must not go out with the legal notice left on its
 * "À renseigner" fallback, with the admin second factor optional, or with a
 * canonical origin that is only the throw-away `VERCEL_URL`.
 *
 * `ALLOW_INCOMPLETE_LAUNCH_CONFIG=true` turns these errors into loud warnings,
 * so a deployment is never blocked before the owner has the values.
 */

/** Keep in sync with REQUIRED_PUBLISHER_FIELDS in src/lib/legal-documents.ts (tested). */
export const LEGAL_ENV_NAMES = [
  "NEXT_PUBLIC_LEGAL_ENTITY_NAME",
  "NEXT_PUBLIC_LEGAL_ENTITY_FORM",
  "NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS",
  "NEXT_PUBLIC_LEGAL_REGISTRATION",
  "NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR",
  "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL",
  "NEXT_PUBLIC_LEGAL_CONTACT_PHONE",
  "NEXT_PUBLIC_LEGAL_MEDIATOR_NAME",
  "NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS",
  "NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE",
];

/** Explicit canonical origins. `VERCEL_URL` is deliberately absent: it changes per deployment. */
export const EXPLICIT_SITE_URL_ENV_NAMES = [
  "SITE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "APP_URL",
];

export const ESCAPE_HATCH = "ALLOW_INCOMPLETE_LAUNCH_CONFIG";

export function isMissingValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("your-") ||
    ["changeme", "placeholder", "todo", "null", "undefined"].includes(normalized)
  );
}

export function isProductionBuild(env) {
  return [env.VERCEL_ENV, env.VERCEL_TARGET_ENV].includes("production");
}

export function launchEscapeHatchEnabled(env) {
  return (
    String(env[ESCAPE_HATCH] || "")
      .trim()
      .toLowerCase() === "true"
  );
}

/** One human-readable problem per missing guard; empty when the launch config is complete. */
export function productionLaunchProblems(env) {
  const problems = [];

  const missingLegal = LEGAL_ENV_NAMES.filter((name) => isMissingValue(env[name]));
  if (missingLegal.length) {
    problems.push(
      `Mentions légales manquantes (le site afficherait « À renseigner avant commercialisation ») : ${missingLegal.join(", ")}`,
    );
  }

  if (
    String(env.ADMIN_MFA_REQUIRED || "")
      .trim()
      .toLowerCase() !== "true"
  ) {
    problems.push(
      "ADMIN_MFA_REQUIRED doit valoir « true » : sans cela, l'administration reste accessible sans second facteur.",
    );
  }

  if (!EXPLICIT_SITE_URL_ENV_NAMES.some((name) => !isMissingValue(env[name]))) {
    problems.push(
      `Aucune origine canonique explicite : définir ${EXPLICIT_SITE_URL_ENV_NAMES.join(", ")} (VERCEL_URL ne compte pas : elle change à chaque déploiement).`,
    );
  }

  return problems;
}

/**
 * Applies the guards to a production build. Returns the process exit code and
 * the lines to print, so the caller (and the tests) decide how to emit them.
 */
export function evaluateProductionLaunchConfig(env) {
  if (!isProductionBuild(env)) return { exitCode: 0, errors: [], warnings: [] };
  const problems = productionLaunchProblems(env);
  if (!problems.length) return { exitCode: 0, errors: [], warnings: [] };

  if (launchEscapeHatchEnabled(env)) {
    const bar = "!".repeat(78);
    return {
      exitCode: 0,
      errors: [],
      warnings: [
        bar,
        `[env] ATTENTION : ${ESCAPE_HATCH}=true — build de PRODUCTION avec une configuration de lancement INCOMPLÈTE.`,
        ...problems.map((problem) => `[env]   - ${problem}`),
        `[env] Ce déploiement n'est pas conforme. Retirer ${ESCAPE_HATCH} dès que les valeurs sont fournies.`,
        bar,
      ],
    };
  }

  return {
    exitCode: 1,
    errors: [
      "[env] Configuration de lancement incomplète : le build de production est bloqué.",
      ...problems.map((problem) => `[env]   - ${problem}`),
      `[env] Renseigner ces variables dans Vercel, ou définir ${ESCAPE_HATCH}=true pour ne recevoir que des avertissements (déploiement non conforme).`,
    ],
    warnings: [],
  };
}
