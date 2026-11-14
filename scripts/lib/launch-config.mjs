/**
 * Launch guards shared by the production build (`verify-required-env.mjs`).
 *
 * A production deployment must not go out with the legal notice left on its
 * "À renseigner" fallback, with the admin second factor optional, with a
 * canonical origin that is only the throw-away `VERCEL_URL`, or with a Stripe
 * key that is not a live one.
 *
 * `ALLOW_INCOMPLETE_LAUNCH_CONFIG=true` turns the legal and MFA errors into loud
 * warnings, so a deployment is not blocked before the owner has the values. A
 * missing or unusable canonical origin (see `blockingLaunchProblems`) and a Stripe
 * key that is not a live one (see `stripeKeyModeProblems`) always block.
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

/**
 * Same test as `firstFilled` in src/lib/env.ts (`siteUrl`), which `resolveSiteOrigin` uses to pick the
 * canonical origin: the first variable (in `EXPLICIT_SITE_URL_ENV_NAMES` order) whose value is
 * not blank. The guard must judge exactly the value the site will resolve, so a test compares
 * both. (The script is plain .mjs and cannot import the TypeScript module.)
 */
function isFilled(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** The raw value `resolveSiteOrigin` would use in production, with the variable it comes from. */
export function explicitSiteUrl(env) {
  const name = EXPLICIT_SITE_URL_ENV_NAMES.find((candidate) => isFilled(env[candidate]));
  return name ? { name, raw: env[name].trim() } : null;
}

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

  return problems;
}

/**
 * Mode of a Stripe secret key from its prefix (`sk_`/`rk_` then `live_` or `test_`), or null.
 * Same rule as `stripeKeyMode` in src/lib/analysis-checkout-readiness.ts (tested).
 */
export function stripeKeyMode(key) {
  const match = /^[sr]k_(live|test)_/.exec(String(key ?? "").trim());
  return match ? match[1] : null;
}

/**
 * The production build requires a live key (C3, 14/11), as the checkout guard does at run time. A
 * test key would let Analyse be obtained with Stripe's test card, without paying; a key whose mode
 * cannot be read (neither `sk_` nor `rk_` followed by `live_` or `test_`) is refused as well. Not
 * covered by the launch escape hatch: it is a wrong value, not a missing one. An absent key is not a
 * problem here (the checkout then stays closed on its own).
 */
export function stripeKeyModeProblems(env) {
  const key = String(env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) return [];
  const mode = stripeKeyMode(key);
  if (mode === "live") return [];
  return [
    mode === "test"
      ? "STRIPE_SECRET_KEY est une clé de test (sk_test_… ou rk_test_…) : en production, l'offre Analyse s'obtiendrait avec la carte de test de Stripe, sans payer. Poser la clé du mode réel (sk_live_…)."
      : "STRIPE_SECRET_KEY n'a pas la forme d'une clé Stripe du mode réel (sk_live_… ou rk_live_…) : son mode ne se lit pas. Poser la clé du mode réel.",
  ];
}

/** Billed price of the Analyse subscription. Keep in sync with src/lib/analysis-offer.ts (tested). */
export const ANALYSIS_RECURRING_PRICE_CENTS = 5_900;
export const ANALYSIS_OFFER_LABEL_ENV = "NEXT_PUBLIC_ANALYSIS_OFFER_LABEL";

const LABEL_AMOUNT = String.raw`\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?`;
const LABEL_CURRENCY = String.raw`(?:€|eur(?:os?)?)`;

/** Same parsing as `analysisOfferLabelAmountsCents` in src/lib/analysis-offer.ts (tested). */
export function analysisOfferLabelAmountsCents(label) {
  const pattern = new RegExp(
    `(${LABEL_AMOUNT})\\s*${LABEL_CURRENCY}(?![\\p{L}])|${LABEL_CURRENCY}\\s*(${LABEL_AMOUNT})`,
    "giu",
  );
  return Array.from(String(label).matchAll(pattern), (match) => {
    const raw = (match[1] ?? match[2] ?? "").replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
    return Math.round(Number.parseFloat(raw) * 100);
  });
}

/**
 * The public price label is only copy; the amount charged is the Stripe Price (5 900 cents).
 * A label that states another amount, or none, would advertise a price that is not billed:
 * the build is refused. An unset (blank) label falls back to the approved default label.
 * Not covered by the launch escape hatch: it is a wrong price, not a missing value.
 */
export function analysisOfferLabelProblems(env) {
  const label = String(env[ANALYSIS_OFFER_LABEL_ENV] ?? "").trim();
  if (!label) return [];
  const amounts = analysisOfferLabelAmountsCents(label);
  if (amounts.length && amounts.every((amount) => amount === ANALYSIS_RECURRING_PRICE_CENTS)) {
    return [];
  }
  return [
    `${ANALYSIS_OFFER_LABEL_ENV} vaut « ${label} » mais l'abonnement Analyse est facturé ${ANALYSIS_RECURRING_PRICE_CENTS / 100} € par mois : corriger ou supprimer la variable.`,
  ];
}

/** Host names that only exist on the machine that serves them. */
function isLocalHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Problems the escape hatch cannot waive. Without a usable explicit origin, canonical URLs,
 * robots.txt and the sitemap of production would point to localhost, to a placeholder or to
 * plain http. The value judged is the one `resolveSiteOrigin` resolves (first non-blank
 * variable), not "any variable that looks valid": `SITE_URL=placeholder` with a valid
 * `APP_URL` makes the site use `https://placeholder`.
 */
export function blockingLaunchProblems(env) {
  const configured = explicitSiteUrl(env);
  if (!configured) {
    return [
      `Aucune origine canonique explicite : définir ${EXPLICIT_SITE_URL_ENV_NAMES.join(", ")} (VERCEL_URL ne compte pas : elle change à chaque déploiement).`,
    ];
  }
  const { name, raw } = configured;
  if (isMissingValue(raw)) {
    return [
      `Origine canonique fictive : ${name} vaut « ${raw} » et c'est cette valeur que le site utiliserait (les variables suivantes sont ignorées).`,
    ];
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return [`Origine canonique invalide : ${name} vaut « ${raw} ».`];
  }
  const problems = [];
  if (isLocalHostname(url.hostname)) {
    problems.push(
      `Origine canonique locale : ${name} vaut « ${raw} » ; la production ne peut pas publier des URL en localhost.`,
    );
  }
  if (url.protocol !== "https:") {
    problems.push(
      `Origine canonique en ${url.protocol.replace(":", "")} : ${name} vaut « ${raw} » ; la production doit être en https://.`,
    );
  }
  return problems;
}

/** Valeurs reconnues de SALE_REMINDERS_MODE (src/lib/email-feature-mode.ts). */
const SALE_REMINDERS_MODE_VALUES = ["off", "internal", "on"];

/**
 * Avertissement (jamais bloquant) quand SALE_REMINDERS_MODE a une valeur que le site ne reconnaît
 * pas : il la traite comme « off », donc aucun rappel ne partirait alors que le propriétaire croit
 * l'avoir ouvert. Variable absente ou vide : mode « off » voulu, rien à dire.
 */
export function saleRemindersModeAdvisories(env) {
  const raw = String(env.SALE_REMINDERS_MODE ?? "").trim();
  if (!raw || SALE_REMINDERS_MODE_VALUES.includes(raw.toLowerCase())) return [];
  return [
    `[env] SALE_REMINDERS_MODE vaut « ${raw} », valeur inconnue : les rappels d'audience restent fermés (off). Valeurs reconnues : ${SALE_REMINDERS_MODE_VALUES.join(", ")}.`,
  ];
}

/**
 * Applies the guards to a production build. Returns the process exit code and
 * the lines to print, so the caller (and the tests) decide how to emit them.
 */
export function evaluateProductionLaunchConfig(env) {
  if (!isProductionBuild(env)) return { exitCode: 0, errors: [], warnings: [] };
  const advisories = saleRemindersModeAdvisories(env);
  const originProblems = blockingLaunchProblems(env);
  const stripeProblems = stripeKeyModeProblems(env);
  const blocking = [...originProblems, ...stripeProblems];
  const problems = [...productionLaunchProblems(env), ...blocking];
  if (!problems.length) return { exitCode: 0, errors: [], warnings: advisories };

  if (launchEscapeHatchEnabled(env) && !blocking.length) {
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
        ...advisories,
      ],
    };
  }

  return {
    exitCode: 1,
    errors: [
      "[env] Configuration de lancement incomplète : le build de production est bloqué.",
      ...problems.map((problem) => `[env]   - ${problem}`),
      ...(originProblems.length
        ? [
            `[env] L'origine canonique ne peut pas être contournée par ${ESCAPE_HATCH} : définir SITE_URL (https, domaine public) dans Vercel.`,
          ]
        : []),
      ...(stripeProblems.length
        ? [
            `[env] Une clé Stripe qui n'est pas du mode réel ne peut pas être contournée par ${ESCAPE_HATCH} : poser la clé du mode réel dans Vercel (cible Production).`,
          ]
        : []),
      ...(blocking.length
        ? []
        : [
            `[env] Renseigner ces variables dans Vercel, ou définir ${ESCAPE_HATCH}=true pour ne recevoir que des avertissements (déploiement non conforme).`,
          ]),
    ],
    warnings: advisories,
  };
}
