import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import type { PlanLimits } from "@/lib/plans";

export type UsageEventKey =
  | "property_report.created"
  | "property_report.pdf_exported"
  | "sales.csv_exported"
  | "sales.api_feed_requested"
  | "sale_history.viewed"
  | "market.analytics_viewed"
  | "dpe.explorer_viewed"
  | "sales.favorite_added"
  | "sales.favorite_removed"
  | "sales.statistics_viewed"
  | "bid_ceiling.calculated"
  | "dvf.comparables_viewed"
  | "valuation.backtest_viewed"
  | "valuation.estimated"
  | "workspace.audience_tracking_viewed"
  | "sale_changes.monitored"
  | "lawyer.referral_requested"
  | "data_refresh.requested";

export type UsageLimitState = {
  eventKey: UsageEventKey;
  label: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
};

export type PlanUsageSummary = {
  periodStart: string;
  periodEnd: string;
  limits: UsageLimitState[];
};

type UsagePlanLike = {
  label: string;
  limits: Pick<PlanLimits, "propertyReportsPerMonth" | "pdfExportsPerMonth">;
};

export function currentMonthUsageWindow(now = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

export function buildUsageLimitState({
  eventKey,
  label,
  used,
  limit,
  periodStart,
  periodEnd,
}: {
  eventKey: UsageEventKey;
  label: string;
  used: number;
  limit: number | null;
  periodStart: string;
  periodEnd: string;
}): UsageLimitState {
  return {
    eventKey,
    label,
    used,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - used),
    periodStart,
    periodEnd,
  };
}

export async function getPlanUsageSummary({
  auth,
  plan,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  plan: UsagePlanLike;
  now?: Date;
}): Promise<PlanUsageSummary> {
  const { periodStart, periodEnd } = currentMonthUsageWindow(now);
  const [reportCreations, pdfExports] = await Promise.all([
    getUsageQuantity({
      auth,
      eventKey: "property_report.created",
      periodStart,
      periodEnd,
    }),
    getUsageQuantity({
      auth,
      eventKey: "property_report.pdf_exported",
      periodStart,
      periodEnd,
    }),
  ]);

  return {
    periodStart,
    periodEnd,
    limits: [
      buildUsageLimitState({
        eventKey: "property_report.created",
        label: "Rapports générés",
        used: reportCreations,
        limit: plan.limits.propertyReportsPerMonth,
        periodStart,
        periodEnd,
      }),
      buildUsageLimitState({
        eventKey: "property_report.pdf_exported",
        label: "Exports PDF",
        used: pdfExports,
        limit: plan.limits.pdfExportsPerMonth,
        periodStart,
        periodEnd,
      }),
    ],
  };
}

export async function assertUsageLimitAvailable({
  auth,
  eventKey,
  limit,
  label,
  planLabel,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  eventKey: UsageEventKey;
  limit: number | null;
  label: string;
  planLabel: string;
  now?: Date;
}) {
  if (limit == null) return;

  const { periodStart, periodEnd } = currentMonthUsageWindow(now);
  const used = await getUsageQuantity({ auth, eventKey, periodStart, periodEnd });
  if (used >= limit) {
    throw new Error(
      `Quota ${label} atteint pour le plan ${planLabel}. Passez au plan Analyse pour continuer sans limite.`,
    );
  }
}

export async function recordFeatureUsageEvent({
  auth,
  eventKey,
  quantity = 1,
  subjectType,
  subjectId,
  metadata,
}: {
  auth: SupabaseAuthContext;
  eventKey: UsageEventKey;
  quantity?: number;
  subjectType?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const { error } = await supabaseAdmin.from("feature_usage_events").insert({
    user_id: auth.userId,
    event_key: eventKey,
    quantity: Math.max(1, Math.floor(quantity)),
    subject_type: subjectType ?? null,
    subject_id: subjectId ?? null,
    metadata: asJson(metadata ?? {}),
  });
  if (error) throw error;
}

async function getUsageQuantity({
  auth,
  eventKey,
  periodStart,
  periodEnd,
}: {
  auth: SupabaseAuthContext;
  eventKey: UsageEventKey;
  periodStart: string;
  periodEnd: string;
}): Promise<number> {
  const { data, error } = await auth.supabase
    .from("feature_usage_events")
    .select("quantity")
    .eq("user_id", auth.userId)
    .eq("event_key", eventKey)
    .gte("created_at", periodStart)
    .lt("created_at", periodEnd);

  if (error) throw error;
  return (data ?? []).reduce((sum, event) => sum + event.quantity, 0);
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
