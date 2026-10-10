import { z } from "zod";

/**
 * Single place where the application reads its environment variables (P4-14).
 *
 * - `publicEnv()` is safe in browser code: it reads ONLY `process.env.NEXT_PUBLIC_*`
 *   through static member accesses, which Next.js inlines at build time. Never add a
 *   dynamic `process.env[name]` access to it, nor a non-public variable: they would be
 *   `undefined` in the browser.
 * - `serverEnv()` is for server code (route handlers, server components, jobs, tests).
 *   It reads from `process.env` by default or from an explicit source, which is how the
 *   unit tests inject a configuration.
 *
 * The canonical public origin is `SITE_URL`, with `NEXT_PUBLIC_APP_URL` and the other legacy
 * aliases as fallbacks: it is resolved and validated by `resolveSiteOrigin` (site-url.ts).
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

const text = z
  .string()
  .optional()
  .transform((value) => filled(value));

function textShape<const Keys extends readonly string[]>(keys: Keys) {
  return Object.fromEntries(keys.map((key) => [key, text])) as Record<Keys[number], typeof text>;
}

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
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "CRON_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "REPLICATE_API_TOKEN",
  "LLM_PROMPT_VERSION",
  "RESEND_API_KEY",
  "ALERT_EMAIL_FROM",
  "RESEND_FROM_EMAIL",
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
  "VERCEL_ENV",
  "NODE_ENV",
] as const;

const publicSchema = z.object(textShape(PUBLIC_KEYS));
const serverSchema = z.object(textShape(SERVER_KEYS));

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
  const raw = publicSchema.parse(
    source
      ? {
          NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        }
      : {
          // Static accesses on purpose: Next.js replaces them at build time.
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        },
  );
  return {
    supabaseUrl: raw.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: firstFilled(
      raw.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      raw.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
  };
}

/**
 * Server-side variables with their canonical name and fallback chain.
 * Without argument the source is `process.env`; the public Supabase variables are then
 * read statically so that the build-time inlining (VITE_ -> NEXT_PUBLIC_ mapping of
 * next.config.ts) also applies on the server.
 */
export function serverEnv(source?: EnvSource) {
  const env = serverSchema.parse(source ?? processEnvWithInlinedPublicValues());

  return {
    supabase: {
      /** Anonymous server client (public pages, sitemap): historical order, VITE_ last. */
      publicUrl: firstFilled(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL, env.VITE_SUPABASE_URL),
      publishableKey: firstFilled(
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        env.VITE_SUPABASE_PUBLISHABLE_KEY,
      ),
      /** Service-role client: `SUPABASE_URL` wins over the public URL. */
      adminUrl: firstFilled(env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL, env.VITE_SUPABASE_URL),
      serviceRoleKey: firstFilled(env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SECRET_KEY),
      /** Direct Postgres connection used by the readiness checks. */
      databaseUrl: firstFilled(env.SUPABASE_DB_URL, env.POSTGRES_URL_NON_POOLING, env.POSTGRES_URL),
    },
    cronSecret: env.CRON_SECRET,
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    },
    replicateApiToken: env.REPLICATE_API_TOKEN,
    llmPromptVersion: env.LLM_PROMPT_VERSION,
    email: {
      resendApiKey: env.RESEND_API_KEY,
      from: firstFilled(env.ALERT_EMAIL_FROM, env.RESEND_FROM_EMAIL),
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
