import postgres from "postgres";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { hasAdminRole } from "@/lib/account";
import { resolveEmailAlertDeliveryConfig } from "@/lib/email-alerts";

export type ReadinessStatus = "ready" | "warning" | "blocked";
export type ReadinessArea = "billing" | "cron" | "database" | "access" | "email" | "pipeline";

export type ReadinessItem = {
  key: string;
  area: ReadinessArea;
  label: string;
  status: ReadinessStatus;
  detail: string;
  action: string | null;
};

export type MigrationReadiness = {
  status: ReadinessStatus;
  expectedLatestVersion: string;
  latestAppliedVersion: string | null;
  appliedCount: number | null;
  detail: string;
};

export type AdminOperationalReadinessResponse = {
  checkedAt: string;
  status: ReadinessStatus;
  items: ReadinessItem[];
  migrations: MigrationReadiness;
  webhookUrl: string | null;
};

export const EXPECTED_LATEST_MIGRATION_VERSION = "20260707083431";

const EXPECTED_CRONS = [
  "/api/cron/smart-alerts",
  "/api/cron/alert-notifications",
  "/api/cron/sale-change-monitor",
] as const;

export async function getAdminOperationalReadiness(
  authToken: string,
): Promise<AdminOperationalReadinessResponse> {
  await assertAdminAuth(authToken);
  const envItems = buildEnvironmentReadiness(process.env);
  const migrations = await readMigrationReadiness(process.env);
  const items = [...envItems, migrationItem(migrations)];
  const origin = appOrigin(process.env);

  return {
    checkedAt: new Date().toISOString(),
    status: overallStatus(items),
    items,
    migrations,
    webhookUrl: origin ? `${origin}/api/stripe/webhook` : null,
  };
}

export function buildEnvironmentReadiness(env: Pick<NodeJS.ProcessEnv, string>): ReadinessItem[] {
  const appUrl = appOrigin(env);
  const stripeSecret = env.STRIPE_SECRET_KEY;
  const analysePrice = env.STRIPE_ANALYSE_PRICE_ID;
  const investorPrice = env.STRIPE_INVESTISSEUR_PRICE_ID;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const emailConfig = resolveEmailAlertDeliveryConfig(env);
  const instantPipelineDispatch = firstFilledEnv(
    env.GITHUB_SCROLL_TOKEN,
    env.IMMOJUDIS_GITHUB_ACTIONS_TOKEN,
    env.GITHUB_ACTIONS_DISPATCH_TOKEN,
    env.SCROLL_WEBHOOK_URL,
    env.IMMOJUDIS_SCROLL_WEBHOOK_URL,
  );
  const replicateToken = firstFilledEnv(env.REPLICATE_API_TOKEN);

  return [
    {
      key: "billing.checkout.analyse",
      area: "billing",
      label: "Checkout Analyse",
      status: stripeSecret && analysePrice && appUrl ? "ready" : "blocked",
      detail:
        stripeSecret && analysePrice && appUrl
          ? "Le checkout Analyse peut créer des abonnements Stripe."
          : "Le checkout Analyse attend encore sa clé Stripe, son Price ID et l'URL canonique.",
      action:
        stripeSecret && analysePrice && appUrl
          ? null
          : "Configurer STRIPE_SECRET_KEY, STRIPE_ANALYSE_PRICE_ID et NEXT_PUBLIC_APP_URL.",
    },
    {
      key: "billing.checkout.investisseur",
      area: "billing",
      label: "Checkout Investisseur",
      status: stripeSecret && investorPrice && appUrl ? "ready" : "blocked",
      detail:
        stripeSecret && investorPrice && appUrl
          ? "Le checkout Investisseur peut créer des abonnements Stripe."
          : "Le checkout Investisseur attend encore sa clé Stripe, son Price ID et l'URL canonique.",
      action:
        stripeSecret && investorPrice && appUrl
          ? null
          : "Configurer STRIPE_SECRET_KEY, STRIPE_INVESTISSEUR_PRICE_ID et NEXT_PUBLIC_APP_URL.",
    },
    {
      key: "billing.webhook",
      area: "billing",
      label: "Webhook Stripe",
      status: stripeSecret && webhookSecret ? "ready" : "blocked",
      detail:
        stripeSecret && webhookSecret
          ? "Le webhook peut synchroniser les statuts d'abonnement."
          : "La synchronisation automatique des abonnements Stripe n'est pas encore active.",
      action: stripeSecret && webhookSecret ? null : "Configurer STRIPE_WEBHOOK_SECRET.",
    },
    {
      key: "access.manual_grants",
      area: "access",
      label: "Attribution manuelle",
      status: "ready",
      detail: "Les admins peuvent activer Analyse ou Investisseur sans Stripe live.",
      action: null,
    },
    {
      key: "email.alert_delivery",
      area: "email",
      label: "Envoi des alertes email",
      status: emailConfig.configured ? "ready" : "blocked",
      detail: emailConfig.configured
        ? "Les notifications email consenties peuvent être expédiées par le cron."
        : "Les alertes email restent en file tant que le fournisseur d'envoi n'est pas configuré.",
      action: emailConfig.configured
        ? null
        : `Configurer ${emailConfig.missing.join(", ")} dans Vercel Production.`,
    },
    {
      key: "cron.smart_alerts",
      area: "cron",
      label: "Crons alertes",
      status: env.CRON_SECRET ? "ready" : "blocked",
      detail: env.CRON_SECRET
        ? `${EXPECTED_CRONS.length} routes cron sont protégées par CRON_SECRET.`
        : "Les routes cron refusent les exécutions planifiées sans CRON_SECRET.",
      action: env.CRON_SECRET ? null : "Configurer CRON_SECRET dans Vercel Production.",
    },
    {
      key: "pipeline.dispatch",
      area: "pipeline",
      label: "Déclenchement pipeline",
      status: instantPipelineDispatch ? "ready" : "warning",
      detail: instantPipelineDispatch
        ? "L'admin peut déclencher immédiatement le workflow de collecte/backfill."
        : "L'admin peut créer une demande en file, mais le lancement dépend du worker GitHub planifié.",
      action: instantPipelineDispatch
        ? null
        : "Configurer GITHUB_SCROLL_TOKEN ou SCROLL_WEBHOOK_URL pour un lancement immédiat.",
    },
    {
      key: "pipeline.llm_backfill",
      area: "pipeline",
      label: "Backfill synthèses IA",
      status: replicateToken ? "ready" : "warning",
      detail: replicateToken
        ? "Un token Replicate est lisible côté runtime pour les synthèses IA."
        : "Le token Replicate n'est pas lisible côté Vercel; vérifier aussi le secret GitHub Actions REPLICATE_API_TOKEN.",
      action: replicateToken
        ? null
        : "Configurer REPLICATE_API_TOKEN dans l'environnement du runner qui exécute le backfill.",
    },
  ];
}

async function assertAdminAuth(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!hasAdminRole(auth.claims)) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }
}

async function readMigrationReadiness(
  env: Pick<NodeJS.ProcessEnv, string>,
): Promise<MigrationReadiness> {
  const dbUrl = firstFilledEnv(env.SUPABASE_DB_URL, env.POSTGRES_URL_NON_POOLING, env.POSTGRES_URL);

  if (!dbUrl) {
    return {
      status: "warning",
      expectedLatestVersion: EXPECTED_LATEST_MIGRATION_VERSION,
      latestAppliedVersion: null,
      appliedCount: null,
      detail: "Impossible de vérifier les migrations sans URL Postgres lisible au runtime.",
    };
  }

  const sql = postgres(dbUrl, {
    max: 1,
    ssl: env.POSTGRES_SSL === "disable" ? false : "require",
  });

  try {
    const [latest] = await sql<{ version: string }[]>`
      select version
      from supabase_migrations.schema_migrations
      order by version desc
      limit 1
    `;
    const [count] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from supabase_migrations.schema_migrations
    `;
    const latestVersion = latest?.version ?? null;
    const ready = Boolean(latestVersion && latestVersion >= EXPECTED_LATEST_MIGRATION_VERSION);

    return {
      status: ready ? "ready" : "blocked",
      expectedLatestVersion: EXPECTED_LATEST_MIGRATION_VERSION,
      latestAppliedVersion: latestVersion,
      appliedCount: count?.count ?? null,
      detail: ready
        ? "Les migrations requises pour la nouvelle offre sont appliquées."
        : "La base ne semble pas avoir reçu la dernière migration attendue.",
    };
  } catch (error) {
    return {
      status: "warning",
      expectedLatestVersion: EXPECTED_LATEST_MIGRATION_VERSION,
      latestAppliedVersion: null,
      appliedCount: null,
      detail:
        error instanceof Error
          ? `Vérification migrations impossible: ${error.message}`
          : "Vérification migrations impossible.",
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function migrationItem(migrations: MigrationReadiness): ReadinessItem {
  return {
    key: "database.migrations",
    area: "database",
    label: "Migrations Supabase",
    status: migrations.status,
    detail: migrations.detail,
    action:
      migrations.status === "ready"
        ? null
        : `Vérifier que ${EXPECTED_LATEST_MIGRATION_VERSION} est appliquée.`,
  };
}

function overallStatus(items: ReadinessItem[]): ReadinessStatus {
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "warning")) return "warning";
  return "ready";
}

function appOrigin(env: Pick<NodeJS.ProcessEnv, string>): string | null {
  const rawOrigin =
    env.NEXT_PUBLIC_APP_URL || env.APP_URL || env.NEXT_PUBLIC_SITE_URL || env.VERCEL_URL;
  if (!rawOrigin) return null;
  const origin = /^https?:\/\//i.test(rawOrigin) ? rawOrigin : `https://${rawOrigin}`;
  return origin.replace(/\/+$/, "");
}

function firstFilledEnv(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
