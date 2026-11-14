import { z } from "zod";

/**
 * Environment variables of the application (P4-14): the server variables are declared, validated
 * and normalised here, and a new server variable is declared here. Not every read goes through
 * this module yet:
 * - browser variables (`NEXT_PUBLIC_*`: Mapbox, Street View, legal identity, offer label…) are
 *   read where they are used, by static member accesses that Next.js inlines at build time;
 * - functions that take their source as a parameter (`env = process.env`) read the source they
 *   are given, `process.env` being only the default;
 * - build and runtime flags (`NODE_ENV`, `NEXT_PHASE`, `VERCEL_*`) and a few server variables not
 *   declared here yet (email diagnostics of the admin, Géorisques token, DVF base URL…).
 *
 * - `publicEnv()` is safe in browser code: it reads ONLY `process.env.NEXT_PUBLIC_*`
 *   through static member accesses, which Next.js inlines at build time. Never add a
 *   dynamic `process.env[name]` access to it, nor a non-public variable: they would be
 *   `undefined` in the browser. It does not use zod (bundle budget: the Supabase client
 *   imports this module in every page).
 * - `serverEnv()` is for server code (route handlers, server components, jobs, tests),
 *   validated and normalised by a zod schema. It reads from `process.env` by default or
 *   from an explicit source, which is how the unit tests inject a configuration.
 *
 * The canonical public origin is `SITE_URL`, with `NEXT_PUBLIC_APP_URL` and the other legacy
 * aliases as fallbacks (`siteUrl` below): it is validated by `resolveSiteOrigin` (site-url.ts).
 *
 * Every value is trimmed and a blank value counts as unset, exactly like the eight
 * `firstFilledEnv` copies this module replaces. Fallback chains keep the historical
 * name and order of each reader (they differ on purpose, see the `supabase` group).
 *
 * DEPRECATED `VITE_*` NAMES: production still defines only `VITE_SUPABASE_URL` and
 * `VITE_SUPABASE_PUBLISHABLE_KEY`. They are mapped onto `NEXT_PUBLIC_SUPABASE_*` at build
 * time by the `env` block of `next.config.ts` (which stays in place) and are read here as
 * the last fallback of the server chains. Do NOT remove them before the `NEXT_PUBLIC_*`
 * variables exist in Vercel and the site has been redeployed: the site would lose its
 * database connection.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** A blank value is unset; anything else is trimmed. */
function filled(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** First non-blank value, trimmed. */
export function firstFilled(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const result = filled(value);
    if (result) return result;
  }
  return undefined;
}

/**
 * Positive integer read from a variable (taille de lot, plafond d'envoi). A blank, non-numeric,
 * zero or negative value counts as unset and gives `fallback`; a decimal is rounded down; `max`
 * caps the value.
 */
export function positiveInteger(
  value: string | undefined,
  options: { fallback: number; max?: number },
): number;
export function positiveInteger(
  value: string | undefined,
  options?: { max?: number },
): number | undefined;
export function positiveInteger(
  value: string | undefined,
  { fallback, max }: { fallback?: number; max?: number } = {},
): number | undefined {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

/**
 * Canonical public origin, then its legacy aliases, in this order. `VERCEL_URL` (the address of
 * one deployment) only counts outside production (see `siteUrl`). Read by `resolveSiteOrigin`;
 * `scripts/lib/launch-config.mjs` checks the same list without `VERCEL_URL`.
 */
export const SITE_URL_ENV_NAMES = [
  "SITE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "APP_URL",
  "VERCEL_URL",
] as const;

const PUBLIC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

const SERVER_KEYS = [
  ...PUBLIC_KEYS,
  // Deprecated fallbacks, see the header of this file.
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "CRON_SECRET",
  "PIPELINE_CALLBACK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_ANALYSIS_PRICE_ID",
  "STRIPE_ANALYSIS_LEGACY_PRICE_IDS",
  "STRIPE_ANALYSIS_SALES_OPEN",
  "REPLICATE_API_TOKEN",
  "LLM_PROMPT_VERSION",
  "RESEND_API_KEY",
  "ALERT_EMAIL_FROM",
  "RESEND_FROM_EMAIL",
  "SALE_REMINDERS_MODE",
  "WEEKLY_DIGEST_MODE",
  "TRIAL_END_EMAIL_MODE",
  "SALE_RESULTS_MODE",
  "ALERT_NOTIFICATIONS_MODE",
  "REPLIES_REVIEW_DIGEST_MODE",
  "PEPITE_RULE_V2_ENABLED",
  "SALE_FLOOD_RISK_BATCH_LIMIT",
  "SALE_FLOOD_RISK_RUNNER",
  "SALE_PEPITES_BATCH_LIMIT",
  "LISTING_COMPLETENESS_BATCH_LIMIT",
  "VALUATION_PRECOMPUTE_BATCH_LIMIT",
  "ALERT_NOTIFICATION_CRON_LIMIT",
  "COMMERCIAL_CONFIRMATION_CRON_LIMIT",
  "SALE_CHANGE_CRON_USER_LIMIT",
  "SMART_ALERT_CRON_SALE_LIMIT",
  "GITHUB_SCROLL_TOKEN",
  "IMMOJUDIS_GITHUB_ACTIONS_TOKEN",
  "GITHUB_ACTIONS_DISPATCH_TOKEN",
  "GITHUB_SCROLL_REPOSITORY",
  "GITHUB_SCROLL_WORKFLOW",
  "GITHUB_SCROLL_REF",
  "SCROLL_WEBHOOK_URL",
  "IMMOJUDIS_SCROLL_WEBHOOK_URL",
  "SCROLL_WEBHOOK_SECRET",
  "IMMOJUDIS_SCROLL_WEBHOOK_SECRET",
  "OPERATIONS_ALERT_WEBHOOK_URL",
  "OPERATIONS_ALERT_WEBHOOK_SECRET",
  "OPERATIONS_ALERT_GITHUB_REPOSITORY",
  "OPERATIONS_ALERT_GITHUB_WORKFLOW",
  "OPERATIONS_ALERT_GITHUB_REF",
  "OPERATIONS_ALERT_EMAIL_TO",
  "OPERATIONS_ALERT_DELIVERY_LIMIT",
  "VERCEL_ENV",
  "NODE_ENV",
  "CEILING_FEE_REGIMES_OPEN",
  "ALERT_RENT_BASIS_SWITCH_AT",
  "TRANSACTIONAL_EMAIL_FROM",
  "NOREPLY_EMAIL_FROM",
  "RATE_LIMIT_IP_SALT",
  ...SITE_URL_ENV_NAMES,
  "ADJUDICATION_PRICE_STATISTICS_ENABLED",
  "ADJUDICATION_PRICE_STATISTICS_BUILD_ID",
  "CONTACT_EMAIL_TO",
  "CONTACT_EMAIL_FROM",
] as const;

/**
 * Variables lues telles quelles, sans le « vide = absent » des autres : pour elles, une valeur vide
 * n'est pas une valeur absente. `CEILING_FEE_REGIMES_OPEN` absente ouvre tous les régimes de frais ;
 * présente et vide, elle ferme les régimes notariaux (arrêt d'urgence).
 * `ADJUDICATION_PRICE_STATISTICS_ENABLED` n'ouvre que sur la chaîne exacte `true` (ni espaces, ni
 * `TRUE`, ni `1`) : elle n'est donc pas nettoyée.
 */
const VERBATIM_KEYS: ReadonlySet<string> = new Set([
  "CEILING_FEE_REGIMES_OPEN",
  "ADJUDICATION_PRICE_STATISTICS_ENABLED",
]);

/**
 * zod schema of the server variables, built on first use. It is kept out of module scope
 * (and `publicEnv()` does not use zod at all) so that the browser bundle, which imports
 * this module through the Supabase client, does not pay for zod nor for the server names:
 * bundlers drop the unused `serverEnv()` and everything it alone references.
 */
function buildServerSchema() {
  const text = z
    .string()
    .optional()
    .transform((value) => filled(value));
  const verbatim = z.string().optional();
  return z.object(
    Object.fromEntries(
      SERVER_KEYS.map((key) => [key, VERBATIM_KEYS.has(key) ? verbatim : text]),
    ) as Record<(typeof SERVER_KEYS)[number], typeof text>,
  );
}

let serverSchemaCache: ReturnType<typeof buildServerSchema> | undefined;

const DEFAULT_PIPELINE_REPOSITORY = "Aprivi-dev/immojudis";
const DEFAULT_PIPELINE_WORKFLOW = "data-pipeline.yml";
const DEFAULT_PIPELINE_REF = "main";
const DEFAULT_OPERATIONAL_ALERT_WORKFLOW = "operational-alert.yml";

type PublicEnv = {
  /** `NEXT_PUBLIC_SUPABASE_URL` (the VITE_ fallback is applied at build time by next.config.ts). */
  supabaseUrl: string | undefined;
  /** `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, then the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`. */
  supabasePublishableKey: string | undefined;
};

/**
 * Browser-safe variables. Called without argument it reads `process.env.NEXT_PUBLIC_*`
 * statically so that Next.js can inline them; a source can be injected for tests.
 */
export function publicEnv(source?: EnvSource): PublicEnv {
  const raw = source
    ? {
        url: source.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        anonKey: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      }
    : {
        // Static accesses on purpose: Next.js replaces them at build time.
        url: process.env.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      };
  return {
    supabaseUrl: filled(raw.url),
    supabasePublishableKey: firstFilled(raw.publishableKey, raw.anonKey),
  };
}

/**
 * Server-side variables with their canonical name and fallback chain.
 * Without argument the source is `process.env`; the public Supabase variables are then
 * read statically so that the build-time inlining (VITE_ -> NEXT_PUBLIC_ mapping of
 * next.config.ts) also applies on the server.
 */
export function serverEnv(source?: EnvSource) {
  serverSchemaCache ??= buildServerSchema();
  const env = serverSchemaCache.parse(source ?? processEnvWithInlinedPublicValues());

  return {
    supabase: {
      /** Anonymous server client (public pages, sitemap): historical order, VITE_ last. */
      publicUrl: firstFilled(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL, env.VITE_SUPABASE_URL),
      publishableKey: firstFilled(
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        env.VITE_SUPABASE_PUBLISHABLE_KEY,
      ),
      /**
       * Service-role client and user-session client (`requireSupabaseAuthContext`): `SUPABASE_URL`
       * wins over the public URL.
       */
      adminUrl: firstFilled(env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL, env.VITE_SUPABASE_URL),
      /** Publishable key of the user-session client: `SUPABASE_PUBLISHABLE_KEY` first. */
      sessionPublishableKey: firstFilled(
        env.SUPABASE_PUBLISHABLE_KEY,
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        env.VITE_SUPABASE_PUBLISHABLE_KEY,
      ),
      serviceRoleKey: firstFilled(env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SECRET_KEY),
      /** Direct Postgres connection used by the readiness checks. */
      databaseUrl: firstFilled(env.SUPABASE_DB_URL, env.POSTGRES_URL_NON_POOLING, env.POSTGRES_URL),
    },
    /** Public origin before validation (`resolveSiteOrigin`): first filled `SITE_URL_ENV_NAMES`. */
    siteUrl: firstFilled(
      ...SITE_URL_ENV_NAMES.filter(
        (name) => name !== "VERCEL_URL" || env.VERCEL_ENV !== "production",
      ).map((name) => env[name]),
    ),
    /** Sel de l'empreinte des adresses IP du limiteur de débit ; absent : sel par défaut. */
    rateLimitIpSalt: env.RATE_LIMIT_IP_SALT,
    /**
     * Interrupteur d'arrêt des statistiques de prix d'adjudication (`ADJUDICATION_PRICE_STATISTICS_ENABLED`),
     * fermé par défaut : ouvert seulement sur la chaîne exacte `true`. Seule lecture de la variable.
     */
    adjudicationPriceStatisticsEnabled: env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true",
    /** Construction épinglée des statistiques de prix d'adjudication (UUID) ; absente : la dernière publiée. */
    adjudicationPriceStatisticsBuildId: env.ADJUDICATION_PRICE_STATISTICS_BUILD_ID,
    cronSecret: env.CRON_SECRET,
    /** Secret dédié aux rappels du pipeline (`/api/pipeline/revalidate-sale`) ; absent : repli sur `cronSecret`. */
    pipelineCallbackSecret: env.PIPELINE_CALLBACK_SECRET,
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      /** Price des nouveaux abonnements Analyse, tel quel : `analysisPriceId` en vérifie la forme. */
      analysisPriceId: env.STRIPE_ANALYSIS_PRICE_ID,
      /** Anciens Price encore facturés à des abonnés, séparés par des virgules. */
      legacyAnalysisPriceIds: env.STRIPE_ANALYSIS_LEGACY_PRICE_IDS,
      /** Interrupteur de vente, tel quel : `analysisSalesOpen` (absent : vente ouverte). */
      analysisSalesOpen: env.STRIPE_ANALYSIS_SALES_OPEN,
    },
    replicateApiToken: env.REPLICATE_API_TOKEN,
    llmPromptVersion: env.LLM_PROMPT_VERSION,
    email: {
      resendApiKey: env.RESEND_API_KEY,
      from: firstFilled(env.ALERT_EMAIL_FROM, env.RESEND_FROM_EMAIL),
      /** Expéditeur des messages liés au contrat (facturation, acceptation) ; absent : `from`. */
      transactionalFrom: env.TRANSACTIONAL_EMAIL_FROM,
      /** Expéditeur « ne pas répondre » des emails automatiques (alertes, rappels…) ; absent : l'expéditeur actuel. */
      noReplyFrom: env.NOREPLY_EMAIL_FROM,
      /** Formulaire de contact : destinataire (absent : l'adresse de contact légale) et expéditeur. */
      contactTo: env.CONTACT_EMAIL_TO,
      contactFrom: env.CONTACT_EMAIL_FROM,
    },
    saleReminders: {
      /** Valeur brute de `SALE_REMINDERS_MODE` ; `saleRemindersMode()` la ramène à off, internal ou on. */
      mode: env.SALE_REMINDERS_MODE,
    },
    weeklyDigest: {
      /** Valeur brute de `WEEKLY_DIGEST_MODE` ; `weeklyDigestMode()` la ramène à off, internal ou on. */
      mode: env.WEEKLY_DIGEST_MODE,
    },
    trialEndEmail: {
      /** Valeur brute de `TRIAL_END_EMAIL_MODE` ; `trialEndEmailMode()` la ramène à off, internal ou on. */
      mode: env.TRIAL_END_EMAIL_MODE,
    },
    saleResults: {
      /** Valeur brute de `SALE_RESULTS_MODE` ; `saleResultsMode()` la ramène à off, internal ou on. */
      mode: env.SALE_RESULTS_MODE,
    },
    alertNotifications: {
      /** Valeur brute de `ALERT_NOTIFICATIONS_MODE` ; `alertNotificationsMode()` la ramène à off, internal ou on. */
      mode: env.ALERT_NOTIFICATIONS_MODE,
    },
    repliesReviewDigest: {
      /** Valeur brute de `REPLIES_REVIEW_DIGEST_MODE` ; `repliesReviewDigestMode()` la ramène à off, preview ou on. */
      mode: env.REPLIES_REVIEW_DIGEST_MODE,
    },
    pepiteRule: {
      /** Valeur brute de `PEPITE_RULE_V2_ENABLED` ; `pepiteV2EnabledFromEnv()` la ramène à vrai ou faux. */
      v2Enabled: env.PEPITE_RULE_V2_ENABLED,
    },
    /**
     * Tailles de lot des traitements planifiés ; absentes, chaque traitement applique sa propre
     * valeur par défaut (écrite dans sa bibliothèque, jamais ici ni dans la route).
     */
    batchLimits: {
      /** `SALE_FLOOD_RISK_BATCH_LIMIT` : ventes observées par passe du traitement d'inondation. */
      saleFloodRisk: positiveInteger(env.SALE_FLOOD_RISK_BATCH_LIMIT),
      /** `SALE_PEPITES_BATCH_LIMIT` : ventes (ré)évaluées par passe du calcul des pépites. */
      salePepites: positiveInteger(env.SALE_PEPITES_BATCH_LIMIT),
      /** `LISTING_COMPLETENESS_BATCH_LIMIT` : ventes recalculées par passe de la complétude. */
      listingCompleteness: positiveInteger(env.LISTING_COMPLETENESS_BATCH_LIMIT),
      /** `VALUATION_PRECOMPUTE_BATCH_LIMIT` : estimations pré-calculées par passe. */
      valuationPrecompute: positiveInteger(env.VALUATION_PRECOMPUTE_BATCH_LIMIT),
      /** `ALERT_NOTIFICATION_CRON_LIMIT` : notifications d'alerte envoyées par passe. */
      alertNotifications: positiveInteger(env.ALERT_NOTIFICATION_CRON_LIMIT),
      /** `COMMERCIAL_CONFIRMATION_CRON_LIMIT` : confirmations commerciales relancées par passe. */
      commercialConfirmations: positiveInteger(env.COMMERCIAL_CONFIRMATION_CRON_LIMIT),
      /** `SALE_CHANGE_CRON_USER_LIMIT` : comptes examinés par passe du suivi des changements. */
      saleChangeUsers: positiveInteger(env.SALE_CHANGE_CRON_USER_LIMIT),
      /** `SMART_ALERT_CRON_SALE_LIMIT` : ventes évaluées par passe des alertes. */
      smartAlertSales: positiveInteger(env.SMART_ALERT_CRON_SALE_LIMIT),
    },
    saleFloodRisk: {
      /**
       * Valeur brute de `SALE_FLOOD_RISK_RUNNER` : `vercel` fait les appels depuis la route ; toute autre valeur
       * (défaut) déclenche le workflow GitHub `sale-flood-risk.yml`, Géorisques refusant les appels de Vercel.
       */
      runner: env.SALE_FLOOD_RISK_RUNNER,
    },
    ceilingFeeRegimes: {
      /**
       * Valeur brute de `CEILING_FEE_REGIMES_OPEN`, SANS la règle « vide = absent » : `undefined`
       * (variable absente) ouvre tous les régimes, une chaîne même vide n'ouvre que ceux qu'elle liste
       * (voir `parseOpenFeeRegimes`).
       */
      open: env.CEILING_FEE_REGIMES_OPEN,
    },
    alertRentBasis: {
      /** Valeur brute de `ALERT_RENT_BASIS_SWITCH_AT` (date ISO du passage aux loyers ANIL). */
      switchAt: env.ALERT_RENT_BASIS_SWITCH_AT,
    },
    pipeline: {
      githubToken: firstFilled(
        env.GITHUB_SCROLL_TOKEN,
        env.IMMOJUDIS_GITHUB_ACTIONS_TOKEN,
        env.GITHUB_ACTIONS_DISPATCH_TOKEN,
      ),
      repository: firstFilled(env.GITHUB_SCROLL_REPOSITORY) ?? DEFAULT_PIPELINE_REPOSITORY,
      workflow: firstFilled(env.GITHUB_SCROLL_WORKFLOW) ?? DEFAULT_PIPELINE_WORKFLOW,
      ref: firstFilled(env.GITHUB_SCROLL_REF) ?? DEFAULT_PIPELINE_REF,
      webhookUrl: firstFilled(env.SCROLL_WEBHOOK_URL, env.IMMOJUDIS_SCROLL_WEBHOOK_URL),
      webhookSecret: firstFilled(env.SCROLL_WEBHOOK_SECRET, env.IMMOJUDIS_SCROLL_WEBHOOK_SECRET),
    },
    alerts: {
      webhookUrl: env.OPERATIONS_ALERT_WEBHOOK_URL,
      webhookSecret: env.OPERATIONS_ALERT_WEBHOOK_SECRET,
      githubRepository:
        firstFilled(env.OPERATIONS_ALERT_GITHUB_REPOSITORY, env.GITHUB_SCROLL_REPOSITORY) ??
        DEFAULT_PIPELINE_REPOSITORY,
      githubWorkflow:
        firstFilled(env.OPERATIONS_ALERT_GITHUB_WORKFLOW) ?? DEFAULT_OPERATIONAL_ALERT_WORKFLOW,
      githubRef:
        firstFilled(env.OPERATIONS_ALERT_GITHUB_REF, env.GITHUB_SCROLL_REF) ?? DEFAULT_PIPELINE_REF,
      /** Second channel: the owner's address(es), comma separated. Unset: no incident email at all. */
      emailTo: env.OPERATIONS_ALERT_EMAIL_TO,
      /** Alerts claimed per delivery pass (`OPERATIONS_ALERT_DELIVERY_LIMIT`): 10 by default, 20 at most. */
      deliveryLimit: positiveInteger(env.OPERATIONS_ALERT_DELIVERY_LIMIT, {
        fallback: 10,
        max: 20,
      }),
      /** Deployment label attached to alert payloads. */
      environment: firstFilled(env.VERCEL_ENV, env.NODE_ENV) ?? "unknown",
    },
  };
}

/**
 * `process.env` plus static reads of the public Supabase variables. Static reads are
 * replaced at build time (including by the VITE_ -> NEXT_PUBLIC_ mapping declared in
 * next.config.ts), whereas `process.env[name]` is not.
 */
function processEnvWithInlinedPublicValues(): EnvSource {
  return {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}
