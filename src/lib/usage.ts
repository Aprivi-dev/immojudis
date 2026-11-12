import "server-only";
import { after } from "next/server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/error-detail-for-log";
import { parisMonthWindow } from "@/lib/paris-month";
import type { PlanLimits } from "@/lib/plans";
import { asJson } from "@/lib/supabase-json";

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
  | "tribunal.statistics_viewed"
  | "bid_ceiling.calculated"
  | "dvf.comparables_viewed"
  | "valuation.backtest_viewed"
  | "valuation.estimated"
  | "outcome_graph.viewed"
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
  // Mois civil de l'heure de Paris : remise à zéro le 1er à 00 h 00 (Europe/Paris), pas en UTC.
  const { periodStart, periodEnd } = parisMonthWindow(now);
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

export type FeatureUsageEvent = {
  auth: Pick<SupabaseAuthContext, "userId">;
  eventKey: UsageEventKey;
  quantity?: number;
  subjectType?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Records one usage event without ever delaying or failing the caller: the measurement must not
 * undo an answer or a write that succeeded. Inside a request the insert runs once the response is
 * sent (`after()`); elsewhere (scripts, tests) it starts at once. A failed insert is logged.
 */
export function recordFeatureUsageEvent(event: FeatureUsageEvent): void {
  const write = () =>
    insertFeatureUsageEvent(event).catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          scope: "feature-usage",
          event: "record_failed",
          eventKey: event.eventKey,
          error: errorDetailForLog(error),
        }),
      );
    });
  try {
    after(write);
  } catch {
    // Outside a request scope `after()` throws: the insert runs now, still without being awaited.
    void write();
  }
}

async function insertFeatureUsageEvent({
  auth,
  eventKey,
  quantity = 1,
  subjectType,
  subjectId,
  metadata,
}: FeatureUsageEvent): Promise<void> {
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
