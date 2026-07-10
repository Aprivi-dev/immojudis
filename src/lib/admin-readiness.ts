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

export type AiDescriptionReadiness = {
  status: ReadinessStatus;
  promptVersion: string;
  activeUpcomingCount: number | null;
  coveredCurrentCount: number | null;
  missingCurrentCount: number | null;
  missingSourceCount: number | null;
  recentFailureCount: number | null;
  detail: string;
};

export type AdminOperationalReadinessResponse = {
  checkedAt: string;
  status: ReadinessStatus;
  items: ReadinessItem[];
  migrations: MigrationReadiness;
  aiDescriptions: AiDescriptionReadiness;
  webhookUrl: string | null;
};

export const EXPECTED_LATEST_MIGRATION_VERSION = "20260710083858";
export const EXPECTED_LLM_PROMPT_VERSION = "auction_llm_v6_display";

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
  const [migrations, aiDescriptions] = await Promise.all([
    readMigrationReadiness(process.env),
    readAiDescriptionReadiness(process.env),
  ]);
  const items = [...envItems, migrationItem(migrations), aiDescriptionItem(aiDescriptions)];
  const origin = appOrigin(process.env);

  return {
    checkedAt: new Date().toISOString(),
    status: overallStatus(items),
    items,
    migrations,
    aiDescriptions,
    webhookUrl: origin ? `${origin}/api/stripe/webhook` : null,
  };
}

export function buildEnvironmentReadiness(env: Pick<NodeJS.ProcessEnv, string>): ReadinessItem[] {
  const appUrl = appOrigin(env);
  const stripeSecret = env.STRIPE_SECRET_KEY;
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
      status: stripeSecret && appUrl ? "ready" : "blocked",
      detail:
        stripeSecret && appUrl
          ? "Le checkout Analyse peut encaisser 29 € et ouvrir 30 jours d'accès."
          : "Le checkout Analyse attend encore sa clé Stripe et l'URL canonique.",
      action:
        stripeSecret && appUrl ? null : "Configurer STRIPE_SECRET_KEY et NEXT_PUBLIC_APP_URL.",
    },
    {
      key: "billing.webhook",
      area: "billing",
      label: "Webhook Stripe",
      status: stripeSecret && webhookSecret ? "ready" : "blocked",
      detail:
        stripeSecret && webhookSecret
          ? "Le webhook peut attribuer les accès Analyse de façon idempotente."
          : "L'attribution automatique des 30 jours d'accès n'est pas encore active.",
      action: stripeSecret && webhookSecret ? null : "Configurer STRIPE_WEBHOOK_SECRET.",
    },
    {
      key: "access.manual_grants",
      area: "access",
      label: "Attribution manuelle",
      status: "ready",
      detail: "Les admins peuvent activer Découverte ou Analyse sans Stripe live.",
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
  const dbUrl = databaseUrl(env);

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

async function readAiDescriptionReadiness(
  env: Pick<NodeJS.ProcessEnv, string>,
): Promise<AiDescriptionReadiness> {
  const dbUrl = databaseUrl(env);
  const promptVersion = firstFilledEnv(env.LLM_PROMPT_VERSION) ?? EXPECTED_LLM_PROMPT_VERSION;

  if (!dbUrl) {
    return {
      status: "warning",
      promptVersion,
      activeUpcomingCount: null,
      coveredCurrentCount: null,
      missingCurrentCount: null,
      missingSourceCount: null,
      recentFailureCount: null,
      detail: "Impossible de vérifier la couverture IA sans URL Postgres lisible au runtime.",
    };
  }

  const sql = postgres(dbUrl, {
    max: 1,
    ssl: env.POSTGRES_SSL === "disable" ? false : "require",
  });

  try {
    const [coverage] = await sql<AiCoverageRow[]>`
      with scoped as (
        select
          description,
          raw_text,
          raw_payload,
          nullif(raw_payload->>'llm_display_description', '') as display_description,
          raw_payload->>'llm_prompt_version' as prompt_version,
          nullif(raw_payload->>'llm_display_error_at', '') as error_at,
          raw_payload->>'llm_display_error_prompt_version' as error_prompt_version
        from public.auction_sales
        where status in ('active', 'upcoming')
      ),
      classified as (
        select
          *,
          display_description is not null
            and prompt_version = ${promptVersion} as covered_current,
          nullif(description, '') is null
            and nullif(raw_text, '') is null
            and nullif(raw_payload->>'source_description', '') is null as missing_source,
          error_prompt_version = ${promptVersion}
            and error_at is not null
            and error_at::timestamptz > now() - interval '24 hours' as recent_failure
        from scoped
      )
      select
        count(*)::int as active_upcoming_count,
        count(*) filter (where covered_current)::int as covered_current_count,
        count(*) filter (where not covered_current)::int as missing_current_count,
        count(*) filter (where missing_source)::int as missing_source_count,
        count(*) filter (where recent_failure)::int as recent_failure_count
      from classified
    `;

    const activeUpcomingCount = coverage?.active_upcoming_count ?? 0;
    const coveredCurrentCount = coverage?.covered_current_count ?? 0;
    const missingCurrentCount = coverage?.missing_current_count ?? 0;
    const missingSourceCount = coverage?.missing_source_count ?? 0;
    const recentFailureCount = coverage?.recent_failure_count ?? 0;
    const status: ReadinessStatus =
      activeUpcomingCount === 0 ? "warning" : missingCurrentCount === 0 ? "ready" : "blocked";

    return {
      status,
      promptVersion,
      activeUpcomingCount,
      coveredCurrentCount,
      missingCurrentCount,
      missingSourceCount,
      recentFailureCount,
      detail: aiDescriptionDetail({
        status,
        activeUpcomingCount,
        coveredCurrentCount,
        missingCurrentCount,
        missingSourceCount,
        recentFailureCount,
        promptVersion,
      }),
    };
  } catch (error) {
    return {
      status: "warning",
      promptVersion,
      activeUpcomingCount: null,
      coveredCurrentCount: null,
      missingCurrentCount: null,
      missingSourceCount: null,
      recentFailureCount: null,
      detail:
        error instanceof Error
          ? `Vérification synthèses IA impossible: ${error.message}`
          : "Vérification synthèses IA impossible.",
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

export function aiDescriptionItem(readiness: AiDescriptionReadiness): ReadinessItem {
  return {
    key: "pipeline.ai_description_coverage",
    area: "pipeline",
    label: "Couverture synthèses IA",
    status: readiness.status,
    detail: readiness.detail,
    action:
      readiness.status === "ready"
        ? null
        : readiness.activeUpcomingCount == null
          ? "Configurer SUPABASE_DB_URL ou POSTGRES_URL_NON_POOLING pour auditer la couverture."
          : readiness.missingCurrentCount && readiness.missingCurrentCount > 0
            ? "Lancer un backfill IA depuis l'admin ou GitHub Actions, puis vérifier les erreurs récentes."
            : "Vérifier qu'il existe des annonces actives ou à venir à auditer.",
  };
}

type AiCoverageRow = {
  active_upcoming_count: number;
  covered_current_count: number;
  missing_current_count: number;
  missing_source_count: number;
  recent_failure_count: number;
};

function aiDescriptionDetail({
  status,
  activeUpcomingCount,
  coveredCurrentCount,
  missingCurrentCount,
  missingSourceCount,
  recentFailureCount,
  promptVersion,
}: {
  status: ReadinessStatus;
  activeUpcomingCount: number;
  coveredCurrentCount: number;
  missingCurrentCount: number;
  missingSourceCount: number;
  recentFailureCount: number;
  promptVersion: string;
}): string {
  if (activeUpcomingCount === 0) {
    return `Aucune annonce active ou à venir à auditer pour ${promptVersion}.`;
  }
  if (status === "ready") {
    return `${coveredCurrentCount}/${activeUpcomingCount} annonces actives ou à venir ont une synthèse IA au prompt ${promptVersion}.`;
  }
  const details = [
    `${missingCurrentCount}/${activeUpcomingCount} annonces n'ont pas de synthèse IA courante`,
    missingSourceCount ? `${missingSourceCount} sans description source exploitable` : null,
    recentFailureCount ? `${recentFailureCount} en quarantaine après échec récent` : null,
  ].filter(Boolean);
  return `${details.join(" ; ")}.`;
}

function databaseUrl(env: Pick<NodeJS.ProcessEnv, string>): string | null {
  return (
    firstFilledEnv(env.SUPABASE_DB_URL, env.POSTGRES_URL_NON_POOLING, env.POSTGRES_URL) ?? null
  );
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
