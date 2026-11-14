import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { CRON_JOB_NAMES } from "@/lib/scheduled-jobs";
import postgres from "postgres";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
import { resolveEmailAlertDeliveryConfig } from "@/lib/email-alerts";
import { firstFilled, serverEnv } from "@/lib/env";
import { formatPercent } from "@/lib/format/numbers";
import { resolveSiteOrigin } from "@/lib/site-url";
import { legalConfigurationStatus } from "@/lib/legal-documents";
import { resolveExpectedLatestMigrationVersion } from "@/lib/migration-manifest";
import { operationalAlertLabels } from "@/lib/operational-alert-labels";

export type ReadinessStatus = "ready" | "warning" | "blocked";
type ReadinessArea =
  | "billing"
  | "cron"
  | "database"
  | "access"
  | "email"
  | "pipeline"
  | "operations"
  | "compliance";

export type ReadinessItem = {
  key: string;
  area: ReadinessArea;
  label: string;
  status: ReadinessStatus;
  detail: string;
  action: string | null;
};

type MigrationReadiness = {
  status: ReadinessStatus;
  expectedLatestVersion: string;
  latestAppliedVersion: string | null;
  appliedCount: number | null;
  detail: string;
};

type OperationalAlertRow = {
  key: string;
  category: string;
  severity: "warning" | "critical";
  status: "open" | "resolved";
  deliveryStatus: "pending" | "processing" | "delivered" | "failed";
  lastSeenAt: string;
};
/** Une alerte et ses libellés, mis en forme ici : le navigateur ne charge pas la table des libellés. */
type OperationalAlertSummary = OperationalAlertRow & ReturnType<typeof operationalAlertLabels>;

export function operationalAlertSummary(alert: OperationalAlertRow): OperationalAlertSummary {
  return { ...alert, ...operationalAlertLabels(alert) };
}

export type OperationalHealthReadiness = {
  status: ReadinessStatus;
  schedulerActive: boolean;
  schedulerSchedule: string | null;
  sloTargetPercent: number;
  sloWindowDays: number;
  successfulRunCount: number | null;
  failedRunCount: number | null;
  totalRunCount: number | null;
  successRatePercent: number | null;
  openAlertCount: number | null;
  criticalOpenAlertCount: number | null;
  pendingDeliveryCount: number | null;
  failedDeliveryCount: number | null;
  lastHealthRunAt: string | null;
  /** Dernière mesure de santé réussie de moins de 30 minutes (la surveillance tourne). */
  lastHealthRunFresh: boolean;
  alerts: OperationalAlertSummary[];
  detail: string;
};

export type AdminOperationalReadinessResponse = {
  checkedAt: string;
  status: ReadinessStatus;
  items: ReadinessItem[];
  migrations: MigrationReadiness;
  operations: OperationalHealthReadiness;
  webhookUrl: string | null;
};
const OPERATIONAL_HEALTH_SLO_TARGET_PERCENT = 99.5;
const OPERATIONAL_HEALTH_SLO_WINDOW_DAYS = 30;

export async function getAdminOperationalReadiness(
  authToken: string,
): Promise<AdminOperationalReadinessResponse> {
  await assertAdminAuth(authToken);
  const envItems = buildEnvironmentReadiness(process.env);
  const [migrations, operations] = await Promise.all([
    readMigrationReadiness(process.env),
    readOperationalHealthReadiness(process.env),
  ]);
  const items = [...envItems, migrationItem(migrations), operationalHealthItem(operations)];
  const origin = resolveSiteOrigin(process.env);

  return {
    checkedAt: new Date().toISOString(),
    status: overallStatus(items),
    items,
    migrations,
    operations,
    webhookUrl: origin ? `${origin}/api/stripe/webhook` : null,
  };
}

export function buildEnvironmentReadiness(env: Pick<NodeJS.ProcessEnv, string>): ReadinessItem[] {
  const config = serverEnv(env);
  const stripeSecret = config.stripe.secretKey;
  const webhookSecret = config.stripe.webhookSecret;
  // Définition unique de « paiements ouverts », partagée avec le checkout et /offres.
  const checkoutReadiness = analysisCheckoutReadiness(env);
  const cronSecret = config.cronSecret;
  const emailConfig = resolveEmailAlertDeliveryConfig(env);
  const instantPipelineDispatch = firstFilled(
    config.pipeline.githubToken,
    config.pipeline.webhookUrl,
  );
  const externalAlertChannel = firstFilled(config.alerts.webhookUrl, config.pipeline.githubToken);
  const legalStatus = legalConfigurationStatus(env);

  return [
    {
      key: "compliance.publisher",
      area: "compliance",
      label: "Identité légale et médiation",
      status: legalStatus.ready ? "ready" : "blocked",
      detail: legalStatus.ready
        ? "L’éditeur, les contacts et le médiateur sont publiables dans les documents contractuels."
        : `${legalStatus.missing.length} mention(s) obligatoire(s) restent à configurer ; le checkout est suspendu.`,
      action: legalStatus.ready ? null : `Configurer ${legalStatus.missing.join(", ")}.`,
    },
    {
      key: "billing.checkout.analyse",
      area: "billing",
      label: "Checkout Analyse",
      status: checkoutReadiness.open ? "ready" : "blocked",
      detail: checkoutReadiness.open
        ? "Le checkout Analyse peut ouvrir l’abonnement récurrent, sans essai (l’essai gratuit est accordé à l’inscription), tout en conservant la preuve contractuelle."
        : checkoutReadiness.missing.length > 0
          ? "Le checkout Analyse attend Stripe, un Price récurrent Analyse valide, le secret du webhook, son URL canonique, ses mentions juridiques ou le canal de confirmation contractuelle."
          : checkoutReadiness.keyModeMismatch
            ? "La clé Stripe n’est pas du mode de ce déploiement (clé de test en production, ou clé réelle hors production) : le checkout est suspendu."
            : "La vente Analyse est fermée par STRIPE_ANALYSIS_SALES_OPEN : le checkout est suspendu ; les abonnés gardent leur accès, le webhook et le rapprochement continuent.",
      action: checkoutReadiness.open
        ? null
        : [
            ...(checkoutReadiness.missing.length > 0
              ? [
                  `Configurer ${checkoutReadiness.missing.join(", ")} (Price récurrent valide, Resend, SITE_URL et variables NEXT_PUBLIC_LEGAL_*).`,
                ]
              : []),
            ...(checkoutReadiness.keyModeMismatch
              ? [
                  "Poser la clé STRIPE_SECRET_KEY du bon mode (sk_live_… en Production, sk_test_… en Preview), puis redéployer.",
                ]
              : []),
            ...(checkoutReadiness.salesClosed
              ? ["Pour rouvrir la vente : retirer STRIPE_ANALYSIS_SALES_OPEN, puis redéployer."]
              : []),
          ].join(" "),
    },
    {
      key: "billing.webhook",
      area: "billing",
      label: "Webhook Stripe",
      status: stripeSecret && webhookSecret ? "ready" : "blocked",
      detail:
        stripeSecret && webhookSecret
          ? "Le webhook peut réconcilier les accès Analyse et leurs abonnements de façon idempotente."
          : "La réconciliation automatique des accès Analyse n'est pas encore active.",
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
      status: cronSecret ? "ready" : "blocked",
      detail: cronSecret
        ? `${CRON_JOB_NAMES.length} routes cron sont protégées par CRON_SECRET.`
        : "Les routes cron refusent les exécutions planifiées sans CRON_SECRET.",
      action: cronSecret ? null : "Configurer CRON_SECRET dans Vercel Production.",
    },
    {
      key: "pipeline.dispatch",
      area: "pipeline",
      label: "Déclenchement pipeline",
      status: instantPipelineDispatch ? "ready" : "blocked",
      detail: instantPipelineDispatch
        ? "L'admin peut déclencher immédiatement le workflow de collecte."
        : "Aucun runner de collecte n'est configuré : l'admin ne peut pas lancer de collecte.",
      action: instantPipelineDispatch
        ? null
        : "Configurer GITHUB_SCROLL_TOKEN ou SCROLL_WEBHOOK_URL pour un lancement immédiat.",
    },
    {
      key: "operations.external_alerts",
      area: "operations",
      label: "Alertes opérationnelles externes",
      status: externalAlertChannel ? "ready" : "blocked",
      detail: externalAlertChannel
        ? "Les incidents opérationnels peuvent sortir de Supabase vers un canal externe."
        : "Les incidents restent en base sans canal externe actif.",
      action: externalAlertChannel
        ? null
        : "Configurer OPERATIONS_ALERT_WEBHOOK_URL ou GITHUB_SCROLL_TOKEN.",
    },
  ];
}

async function readMigrationReadiness(
  env: Pick<NodeJS.ProcessEnv, string>,
): Promise<MigrationReadiness> {
  const expectedLatestVersion = resolveExpectedLatestMigrationVersion(env);
  const dbUrl = databaseUrl(env);

  if (!dbUrl) {
    return {
      status: "warning",
      expectedLatestVersion,
      latestAppliedVersion: null,
      appliedCount: null,
      detail: "Impossible de vérifier les migrations sans URL Postgres lisible au runtime.",
    };
  }

  const sql = postgres(dbUrl, {
    max: 1,
    // Une base injoignable ne doit pas immobiliser la route jusqu'au délai de 30 s.
    connect_timeout: 8,
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
    const ready = Boolean(latestVersion && latestVersion >= expectedLatestVersion);

    return {
      status: ready ? "ready" : "blocked",
      expectedLatestVersion,
      latestAppliedVersion: latestVersion,
      appliedCount: count?.count ?? null,
      detail: ready
        ? "Les migrations requises pour la nouvelle offre sont appliquées."
        : "La base ne semble pas avoir reçu la dernière migration attendue.",
    };
  } catch (error) {
    return {
      status: "warning",
      expectedLatestVersion,
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

async function readOperationalHealthReadiness(
  env: Pick<NodeJS.ProcessEnv, string>,
): Promise<OperationalHealthReadiness> {
  const dbUrl = databaseUrl(env);
  if (!dbUrl) return unavailableOperationalHealth("URL Postgres absente au runtime.");

  const sql = postgres(dbUrl, {
    max: 1,
    // Une base injoignable ne doit pas immobiliser la route jusqu'au délai de 30 s.
    connect_timeout: 8,
    ssl: env.POSTGRES_SSL === "disable" ? false : "require",
  });

  try {
    const [scheduler] = await sql<{ schedule: string; active: boolean }[]>`
      select schedule, active
      from cron.job
      where jobname = 'immojudis-operational-health'
      limit 1
    `;
    const [counts] = await sql<
      Array<{
        open_alert_count: number;
        critical_open_alert_count: number;
        pending_delivery_count: number;
        failed_delivery_count: number;
      }>
    >`
      select
        count(*) filter (where status = 'open')::int as open_alert_count,
        count(*) filter (where status = 'open' and severity = 'critical')::int
          as critical_open_alert_count,
        count(*) filter (where notification_status in ('pending', 'processing'))::int
          as pending_delivery_count,
        count(*) filter (where notification_status = 'failed')::int
          as failed_delivery_count
      from public.operational_alerts
    `;
    // Dernière mesure RÉUSSIE : une surveillance qui tourne mais échoue à chaque passage n'est pas fraîche.
    const [latestRun] = await sql<{ latest_at: string | null }[]>`
      select max(finished_at)::text as latest_at
      from public.operational_job_runs
      where job_name = 'operational-health'
        and status = 'success'
    `;
    const [slo] = await sql<
      Array<{
        successful_run_count: number;
        failed_run_count: number;
        total_run_count: number;
      }>
    >`
      select
        count(*) filter (where status = 'success')::int as successful_run_count,
        count(*) filter (where status = 'failed')::int as failed_run_count,
        count(*) filter (where status in ('success', 'failed'))::int as total_run_count
      from public.operational_job_runs
      where job_name = 'operational-health'
        and started_at >= now() - interval '30 days'
    `;
    const alertRows = await sql<
      Array<{
        alert_key: string;
        category: string;
        severity: "warning" | "critical";
        status: "open" | "resolved";
        notification_status: "pending" | "processing" | "delivered" | "failed";
        last_seen_at: string;
      }>
    >`
      select
        alert_key,
        category,
        severity,
        status,
        notification_status,
        last_seen_at::text
      from public.operational_alerts
      where status = 'open' or notification_status in ('pending', 'processing', 'failed')
      order by
        case status when 'open' then 0 else 1 end,
        case severity when 'critical' then 0 else 1 end,
        last_seen_at desc
      limit 20
    `;

    const schedulerActive = Boolean(scheduler?.active && scheduler.schedule === "*/15 * * * *");
    const openAlertCount = counts?.open_alert_count ?? 0;
    const criticalOpenAlertCount = counts?.critical_open_alert_count ?? 0;
    const pendingDeliveryCount = counts?.pending_delivery_count ?? 0;
    const failedDeliveryCount = counts?.failed_delivery_count ?? 0;
    const successfulRunCount = slo?.successful_run_count ?? 0;
    const failedRunCount = slo?.failed_run_count ?? 0;
    const totalRunCount = slo?.total_run_count ?? 0;
    const successRatePercent =
      totalRunCount > 0 ? Number(((successfulRunCount / totalRunCount) * 100).toFixed(3)) : null;
    const sloMet =
      successRatePercent != null && successRatePercent >= OPERATIONAL_HEALTH_SLO_TARGET_PERCENT;
    const lastHealthRunAt = latestRun?.latest_at ?? null;
    const lastRunFresh = Boolean(
      lastHealthRunAt && Date.now() - new Date(lastHealthRunAt).getTime() <= 30 * 60 * 1000,
    );
    const status: ReadinessStatus =
      !schedulerActive || failedDeliveryCount > 0 || criticalOpenAlertCount > 0
        ? "blocked"
        : openAlertCount > 0 || pendingDeliveryCount > 0 || !lastRunFresh || !sloMet
          ? "warning"
          : "ready";

    return {
      status,
      schedulerActive,
      schedulerSchedule: scheduler?.schedule ?? null,
      sloTargetPercent: OPERATIONAL_HEALTH_SLO_TARGET_PERCENT,
      sloWindowDays: OPERATIONAL_HEALTH_SLO_WINDOW_DAYS,
      successfulRunCount,
      failedRunCount,
      totalRunCount,
      successRatePercent,
      openAlertCount,
      criticalOpenAlertCount,
      pendingDeliveryCount,
      failedDeliveryCount,
      lastHealthRunAt,
      lastHealthRunFresh: lastRunFresh,
      alerts: alertRows.map((alert) =>
        operationalAlertSummary({
          key: alert.alert_key,
          category: alert.category,
          severity: alert.severity,
          status: alert.status,
          deliveryStatus: alert.notification_status,
          lastSeenAt: alert.last_seen_at,
        }),
      ),
      detail: operationalHealthDetail({
        schedulerActive,
        openAlertCount,
        criticalOpenAlertCount,
        pendingDeliveryCount,
        failedDeliveryCount,
        lastRunFresh,
        successRatePercent,
        sloTargetPercent: OPERATIONAL_HEALTH_SLO_TARGET_PERCENT,
      }),
    };
  } catch (error) {
    return unavailableOperationalHealth(
      error instanceof Error ? error.message : "Diagnostic opérationnel indisponible.",
    );
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
        : `Vérifier que ${migrations.expectedLatestVersion} est appliquée.`,
  };
}

export function operationalHealthItem(readiness: OperationalHealthReadiness): ReadinessItem {
  return {
    key: "operations.health",
    area: "operations",
    label: "Santé et SLO",
    status: readiness.status,
    detail: readiness.detail,
    action:
      readiness.status === "ready"
        ? null
        : readiness.failedDeliveryCount
          ? "Réparer le canal externe puis relancer /api/cron/operational-health."
          : readiness.criticalOpenAlertCount
            ? "Consulter les incidents ouverts et appliquer le runbook correspondant."
            : readiness.successRatePercent == null ||
                readiness.successRatePercent < readiness.sloTargetPercent
              ? "Analyser les exécutions en échec sur 30 jours et confirmer le retour au SLO."
              : "Vérifier le scheduler Supabase et la dernière exécution du contrôle de santé.",
  };
}

function databaseUrl(env: Pick<NodeJS.ProcessEnv, string>): string | null {
  return serverEnv(env).supabase.databaseUrl ?? null;
}

function unavailableOperationalHealth(detail: string): OperationalHealthReadiness {
  return {
    status: "warning",
    schedulerActive: false,
    schedulerSchedule: null,
    sloTargetPercent: OPERATIONAL_HEALTH_SLO_TARGET_PERCENT,
    sloWindowDays: OPERATIONAL_HEALTH_SLO_WINDOW_DAYS,
    successfulRunCount: null,
    failedRunCount: null,
    totalRunCount: null,
    successRatePercent: null,
    openAlertCount: null,
    criticalOpenAlertCount: null,
    pendingDeliveryCount: null,
    failedDeliveryCount: null,
    lastHealthRunAt: null,
    lastHealthRunFresh: false,
    alerts: [],
    detail,
  };
}

function operationalHealthDetail({
  schedulerActive,
  openAlertCount,
  criticalOpenAlertCount,
  pendingDeliveryCount,
  failedDeliveryCount,
  lastRunFresh,
  successRatePercent,
  sloTargetPercent,
}: {
  schedulerActive: boolean;
  openAlertCount: number;
  criticalOpenAlertCount: number;
  pendingDeliveryCount: number;
  failedDeliveryCount: number;
  lastRunFresh: boolean;
  successRatePercent: number | null;
  sloTargetPercent: number;
}): string {
  if (!schedulerActive) return "Le contrôle de santé toutes les 15 minutes est absent ou inactif.";
  if (failedDeliveryCount > 0) {
    return `${failedDeliveryCount} notification(s) externe(s) sont en échec et seront retentées.`;
  }
  if (criticalOpenAlertCount > 0) {
    return `${criticalOpenAlertCount} incident(s) critique(s) sur ${openAlertCount} alerte(s) ouverte(s).`;
  }
  if (openAlertCount > 0) return `${openAlertCount} alerte(s) opérationnelle(s) restent ouvertes.`;
  if (pendingDeliveryCount > 0) {
    return `${pendingDeliveryCount} notification(s) externe(s) attendent leur livraison.`;
  }
  if (!lastRunFresh) return "La dernière mesure de santé date de plus de 30 minutes.";
  if (successRatePercent == null) return "Le SLO ne peut pas encore être calculé sans exécution.";
  if (successRatePercent < sloTargetPercent) {
    return `Le contrôle de santé atteint ${formatPercent(successRatePercent, 3, 3)} sur 30 jours, sous le SLO de ${formatPercent(sloTargetPercent, 3)}.`;
  }
  return `Le scheduler, le canal externe et le SLO (${formatPercent(successRatePercent, 3, 3)} sur 30 jours) sont opérationnels.`;
}

function overallStatus(items: ReadinessItem[]): ReadinessStatus {
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "warning")) return "warning";
  return "ready";
}
